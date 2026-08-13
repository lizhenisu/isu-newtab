import { applySyncProjection, bootstrapMerge, createEnvelope, envelopeContainsRevision, mergeThreeWay } from './engine';
import { base64ToBytes, bytesToBase64, canonicalStringify, gunzipJson, gzipJson, sha256 } from './codec';
import { findLowestCommonAncestor, type RemoteReplicaGraph, type SyncCommit } from './commit-graph';
import type { CommitSyncAdapter, RemoteHeadSummary } from './commit-adapter';
import { createUnboundReplica, enterRecovery, replicaFromEnvelope, type SyncRecoveryCode, type SyncReplica } from './replica';
import type { AppConfig, DeviceIdentity, ProviderCursor, SyncEnvelope, SyncMode } from '../domain/types';
import type { SyncRepository } from '../storage/ports';
import type { SyncStatusRecord, SyncStatusStore } from './status-store';

export type SyncCoordinatorDependencies = {
  adapter: CommitSyncAdapter;
  repository: SyncRepository;
  statusStore: SyncStatusStore;
  providerMode: Exclude<SyncMode, 'local'>;
  refreshWallpaper(config: AppConfig): Promise<void>;
  /** Provider-specific local edit debounce. Chrome keeps its existing default. */
  scheduleDelayMs?: number;
};

type RemoteResolution = { envelope: SyncEnvelope; commitId?: string; heads: SyncCommit[] };

/** Coordinates a provider-local binding with the immutable V2 commit graph. */
export class SyncCoordinator {
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private rerun = false;

  constructor(private readonly dependencies: SyncCoordinatorDependencies) {}

  schedule(delay = this.dependencies.scheduleDelayMs ?? 3_000): void {
    if (this.running) {
      this.rerun = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.run(); }, delay);
  }

  async run(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = this.perform().finally(() => {
      this.running = undefined;
      if (this.rerun) {
        this.rerun = false;
        this.schedule(0);
      }
    });
    return this.running;
  }

  async setMode(mode: SyncMode, force = false): Promise<void> {
    const { adapter, repository, statusStore, providerMode } = this.dependencies;
    const current = await repository.getSyncMode();
    if (mode === current) return;
    if (mode === 'local' && force) {
      await repository.createCheckpoint();
      await repository.setSyncMode('local');
      await adapter.disable();
      await this.setStatus({ state: 'disabled', message: 'LOCAL_WITH_RECONCILIATION_REQUIRED' });
      return;
    }
    if (this.running) await this.running;
    await adapter.enable();
    if (mode === 'local') await this.run(); else await this.perform(true);
    const status = await statusStore.get();
    if (!status || ['error', 'conflict', 'syncing', 'auth-required'].includes(status.state)) {
      if (mode === 'local') throw new Error('FINAL_SYNC_REQUIRED');
      throw new Error(status?.message ?? 'SYNC_ACTIVATION_FAILED');
    }
    await repository.createCheckpoint();
    await repository.setSyncMode(mode);
    if (mode === 'local') {
      await adapter.disable();
      await this.setStatus({ state: 'disabled' });
    }
  }

  /** Explicit recovery only; normal first bind never asks the user to choose. */
  async resolveConflict(choice: 'local-overwrite' | 'remote-replace' | 'external-import'): Promise<void> {
    const { adapter, repository, providerMode } = this.dependencies;
    await repository.initialize();
    const identity = await repository.getDeviceIdentity();
    const local = await this.localEnvelope(identity);
    let graph: RemoteReplicaGraph | null;
    try {
      graph = await adapter.discover();
    } catch (error) {
      if (choice !== 'local-overwrite') throw error;
      await adapter.resetRemoteForRecovery?.();
      graph = null;
    }
    if (choice === 'remote-replace') {
      if (!graph) throw new Error('REMOTE_DATA_MISSING');
      await this.adoptRemote(await this.resolveRemote(graph, identity), identity, true);
    } else if (choice === 'external-import') {
      if (!graph) throw new Error('REMOTE_DATA_MISSING');
      const remote = await this.resolveRemote(graph, identity);
      await this.applyMergedAndPublish(bootstrapMerge(local, remote.envelope, identity), remote.heads.map((head) => head.id), identity);
    } else {
      await this.publishAndConfirm(local, graph?.heads.map((head) => head.id) ?? [], identity);
    }
    await this.dependencies.statusStore.clearConflict();
    await repository.setSyncMode(providerMode);
    this.schedule(0);
  }

  private async perform(ignoreMode = false): Promise<void> {
    const { adapter, repository } = this.dependencies;
    await repository.initialize();
    if (!ignoreMode && await repository.getSyncMode() === 'local') {
      await this.setStatus({ state: 'disabled' });
      return;
    }
    await this.setStatus({ state: 'syncing' });
    try {
      const identity = await repository.getDeviceIdentity();
      const local = await this.localEnvelope(identity);
      const replica = await repository.getSyncReplica(adapter.providerId) ?? createUnboundReplica(adapter.providerId);
      if (replica.state === 'recovery-required') {
        await this.reportRecovery(replica, local, null);
        return;
      }
      const outbox = await repository.getOutbox();
      if (await this.hasUnchangedRemoteHeads(adapter, replica)) {
        if (outbox.length) await this.publishAndConfirm(local, [replica.baseCommitId!], identity);
        else await this.setAdapterStatus();
        return;
      }
      const graph = await adapter.discover();
      if (!graph) {
        const legacy = await adapter.readLegacy?.();
        if (legacy) {
          await this.bootstrapFromRemote(replica, local, legacy, identity, []);
        } else if (replica.state === 'bound') {
          await this.reportRecovery(enterRecovery(replica, 'REMOTE_ENVELOPE_CORRUPT'), local, null);
        } else {
          await this.publishAndConfirm(local, [], identity);
        }
        return;
      }
      if (replica.state === 'unbound' || replica.state === 'bootstrapping') {
        const remote = await this.resolveRemote(graph, identity);
        await this.bootstrapFromRemote(replica, local, remote.envelope, identity, remote.heads.map((head) => head.id));
        return;
      }
      if (replica.datasetId !== graph.datasetId) {
        await this.reportRecovery(enterRecovery(replica, 'REMOTE_DATASET_CHANGED'), local, null);
        return;
      }
      if (replica.generation !== graph.generation) {
        await this.reportRecovery(enterRecovery(replica, 'REMOTE_GENERATION_CHANGED'), local, null);
        return;
      }
      await this.reconcileBound(replica, local, graph, identity);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const replica = await repository.getSyncReplica(adapter.providerId) ?? createUnboundReplica(adapter.providerId);
      if (message.startsWith('REMOTE_') || message.includes('BASELINE')) {
        await this.reportRecovery(enterRecovery(replica, recoveryCode(message)), await this.localEnvelope(await repository.getDeviceIdentity()), null);
      } else if (message === 'GOOGLE_DRIVE_AUTH_REQUIRED') {
        await this.setStatus({ state: 'auth-required', message });
      } else {
        await this.setStatus({ state: 'error', message });
      }
    }
  }

  private async bootstrapFromRemote(replica: SyncReplica, local: SyncEnvelope, remote: SyncEnvelope, identity: DeviceIdentity, parents: string[]): Promise<void> {
    const pristine = isPristineInstallation(local, await this.dependencies.repository.getOutbox());
    if (pristine && parents.length === 1) {
      await this.adoptRemote({ envelope: remote, commitId: parents[0], heads: [] }, identity, true);
      return;
    }
    if (pristine && !parents.length) {
      // V1 has no commit identity. Preserve it exactly, then make it the first
      // V2 commit so future installations can bind without a dataset conflict.
      await this.applyRemoteSnapshot(remote, identity, true);
      await this.publishAndConfirm(await this.localEnvelope(identity), [], identity);
      return;
    }
    await this.applyMergedAndPublish(bootstrapMerge(local, remote, identity), parents, identity);
  }

  private async reconcileBound(replica: SyncReplica, local: SyncEnvelope, graph: RemoteReplicaGraph, identity: DeviceIdentity): Promise<void> {
    const { adapter, repository } = this.dependencies;
    const remote = await this.resolveRemote(graph, identity);
    const outbox = await repository.getOutbox();
    const ownHead = graph.heads.find((head) => head.authorDeviceId === identity.deviceId && sameRevision(head.revision, local.revision));
    if (ownHead && canonicalStringify(await adapter.readSnapshot(ownHead.id)) === canonicalStringify(local)) {
      await this.confirmEnvelope(local, ownHead.id, identity, outbox);
      return;
    }
    const base = await this.readReplicaBase(replica);
    if (!base) {
      await this.reportRecovery(enterRecovery(replica, 'BASELINE_CORRUPT'), local, remote.envelope);
      return;
    }
    const remoteEqualsBase = remote.heads.length === 1 && remote.heads[0]?.id === replica.baseCommitId;
    if (remoteEqualsBase) {
      if (outbox.length) await this.publishAndConfirm(local, [replica.baseCommitId!], identity);
      else await this.setAdapterStatus();
      return;
    }
    if (!outbox.length && remote.commitId) {
      await this.adoptRemote(remote, identity, true);
      return;
    }
    let baseline = base;
    if (remote.commitId && replica.baseCommitId) {
      const lca = findLowestCommonAncestor(graph.commits, replica.baseCommitId, remote.commitId);
      if (lca) baseline = await adapter.readSnapshot(lca);
    }
    await this.applyMergedAndPublish(mergeThreeWay(baseline, local, remote.envelope, identity), remote.heads.map((head) => head.id), identity);
  }

  /**
   * Drive has no push notification. A matching, validated head set is enough to
   * prove that the bound baseline is still current, so avoid downloading the
   * commit graph and five content buckets on idle checks.
   */
  private async hasUnchangedRemoteHeads(adapter: CommitSyncAdapter, replica: SyncReplica): Promise<boolean> {
    if (!adapter.probeHeads || replica.state !== 'bound' || !replica.baseCommitId || !replica.datasetId || replica.generation === undefined) return false;
    let probe: RemoteHeadSummary;
    try {
      probe = await adapter.probeHeads();
    } catch (error) {
      // A malformed head must still go through the full graph validator, while
      // auth/network failures preserve their existing user-visible status.
      if (error instanceof Error && error.message.startsWith('REMOTE_')) return false;
      throw error;
    }
    return probe.datasetId === replica.datasetId
      && probe.generation === replica.generation
      && sameHeadIds(probe.commitIds, replica.lastSeenHeads);
  }

  private async resolveRemote(graph: RemoteReplicaGraph, identity: DeviceIdentity): Promise<RemoteResolution> {
    const { adapter } = this.dependencies;
    const heads = graph.heads.slice().sort((left, right) => left.id.localeCompare(right.id));
    let envelope = await adapter.readSnapshot(heads[0]!.id);
    let mergedHead = heads[0]!;
    for (const head of heads.slice(1)) {
      const next = await adapter.readSnapshot(head.id);
      const baseId = findLowestCommonAncestor(graph.commits, mergedHead.id, head.id);
      envelope = baseId ? mergeThreeWay(await adapter.readSnapshot(baseId), envelope, next, identity) : bootstrapMerge(envelope, next, identity);
      mergedHead = head;
    }
    return { envelope, commitId: heads.length === 1 ? heads[0]!.id : undefined, heads };
  }

  private async adoptRemote(remote: RemoteResolution, identity: DeviceIdentity, discardOutbox: boolean): Promise<void> {
    if (!remote.commitId) throw new Error('REMOTE_GRAPH_REQUIRES_CONSOLIDATION');
    await this.applyRemoteSnapshot(remote.envelope, identity, discardOutbox, remote.commitId);
  }

  private async applyRemoteSnapshot(remote: SyncEnvelope, identity: DeviceIdentity, discardOutbox: boolean, commitId?: string): Promise<void> {
    const { adapter, repository, refreshWallpaper } = this.dependencies;
    identity.counter = Math.max(identity.counter, remote.revision.counter);
    identity.epoch = remote.epoch;
    const config = applySyncProjection(await repository.getConfig(), remote.config);
    const hash = await sha256(canonicalStringify(remote));
    const replica = commitId
      ? replicaFromEnvelope(adapter.providerId, commitId, remote, bytesToBase64(gzipJson(remote)), hash)
      : { ...createUnboundReplica(adapter.providerId), state: 'bootstrapping' as const, datasetId: remote.datasetId, generation: remote.epoch };
    await repository.createCheckpoint();
    await repository.replaceFromSync(config, remote.metadata, identity, await cursorFrom(remote, adapter.providerId), {
      discardOutbox,
      pieces: remote.pieces,
      replica,
    });
    await refreshWallpaper(config);
    if (commitId) await adapter.acknowledge(identity.deviceId, commitId, remote.epoch);
    await this.setAdapterStatus();
  }

  private async applyMergedAndPublish(merged: SyncEnvelope, parents: string[], identity: DeviceIdentity): Promise<void> {
    const { adapter, repository, refreshWallpaper } = this.dependencies;
    const config = applySyncProjection(await repository.getConfig(), merged.config);
    const previous = await repository.getSyncReplica(adapter.providerId) ?? createUnboundReplica(adapter.providerId);
    await repository.createCheckpoint();
    await repository.replaceFromSync(config, merged.metadata, identity, await cursorFrom(merged, adapter.providerId), {
      pendingRevision: merged.revision,
      pieces: merged.pieces,
      replica: { ...previous, state: 'bootstrapping', pendingCommitId: undefined },
    });
    await refreshWallpaper(config);
    await this.publishAndConfirm(merged, parents, identity);
  }

  private async publishAndConfirm(envelope: SyncEnvelope, parents: string[], identity: DeviceIdentity): Promise<void> {
    const { adapter, repository } = this.dependencies;
    const receipt = await adapter.publish({ envelope, parents, deviceId: identity.deviceId });
    await this.confirmEnvelope(envelope, receipt.commit.id, identity, await repository.getOutbox());
  }

  private async confirmEnvelope(envelope: SyncEnvelope, commitId: string, identity: DeviceIdentity, outbox: Awaited<ReturnType<SyncRepository['getOutbox']>>): Promise<void> {
    const { adapter, repository, statusStore } = this.dependencies;
    const hash = await sha256(canonicalStringify(envelope));
    const replica = replicaFromEnvelope(adapter.providerId, commitId, envelope, bytesToBase64(gzipJson(envelope)), hash);
    const confirmed = outbox.filter((entry) => envelopeContainsRevision(envelope, entry.entityType, entry.entityId, entry.revision)).map((entry) => entry.opId);
    await adapter.acknowledge(identity.deviceId, commitId, envelope.epoch);
    // Device heads are mutable and one remains per device. Persist their small
    // observed set after a successful write so later probes do not confuse an
    // ancestor head from another device with a new concurrent edit.
    if (adapter.probeHeads) {
      try {
        const heads = await adapter.probeHeads();
        if (heads.datasetId === envelope.datasetId && heads.generation === envelope.epoch) replica.lastSeenHeads = heads.commitIds;
      } catch {
        // The write and its verification already succeeded. Falling back to the
        // new commit merely causes the next run to use the conservative path.
      }
    }
    await repository.confirmSyncReplica(replica, confirmed, await cursorFrom(envelope, adapter.providerId));
    await statusStore.clearConflict();
    await this.setAdapterStatus();
  }

  private async readReplicaBase(replica: SyncReplica): Promise<SyncEnvelope | undefined> {
    if (!replica.compressedBaseSnapshot || !replica.baseSnapshotHash) return undefined;
    try {
      const base = gunzipJson<SyncEnvelope>(base64ToBytes(replica.compressedBaseSnapshot));
      return await sha256(canonicalStringify(base)) === replica.baseSnapshotHash ? base : undefined;
    } catch {
      return undefined;
    }
  }

  private async localEnvelope(identity: DeviceIdentity): Promise<SyncEnvelope> {
    const { repository } = this.dependencies;
    return createEnvelope(await repository.getConfig(), await repository.getMetadata(), { counter: identity.counter, deviceId: identity.deviceId }, identity.epoch, await repository.getPieces());
  }

  private async reportRecovery(replica: SyncReplica, local: SyncEnvelope, remote: SyncEnvelope | null): Promise<void> {
    const { repository, statusStore } = this.dependencies;
    await repository.putSyncReplica(replica);
    const reason = replica.recovery?.code ?? 'SYNC_RECOVERY_REQUIRED';
    await statusStore.setConflict({
      reason,
      local: { datasetId: local.datasetId, groups: local.config.groups.length, shortcuts: local.config.shortcuts.length },
      remote: remote ? { datasetId: remote.datasetId, groups: remote.config.groups.length, shortcuts: remote.config.shortcuts.length } : null,
    });
    await this.setStatus({ state: 'conflict', message: reason });
  }

  private async setAdapterStatus(): Promise<void> {
    const status = this.dependencies.adapter.getStatus();
    await this.setStatus({ state: status.state, message: status.message, usedBytes: status.usedBytes });
  }

  private async setStatus(status: Omit<SyncStatusRecord, 'updatedAt'>): Promise<void> {
    await this.dependencies.statusStore.set(status);
  }
}

function isPristineInstallation(envelope: SyncEnvelope, outbox: Awaited<ReturnType<SyncRepository['getOutbox']>>): boolean {
  return envelope.config.groups.length === 1
    && envelope.config.groups[0]?.id === 'default'
    && envelope.config.shortcuts.length === 0
    && outbox.every((entry) => entry.entityType === 'piece' && entry.revision.counter <= 9);
}

function sameRevision(left: SyncEnvelope['revision'], right: SyncEnvelope['revision']): boolean {
  return left.counter === right.counter && left.deviceId === right.deviceId;
}

function sameHeadIds(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((id, index) => id === sortedRight[index]);
}

function recoveryCode(message: string): SyncRecoveryCode {
  if (message.includes('GRAPH')) return 'REMOTE_GRAPH_CORRUPT';
  if (message.includes('BASELINE')) return 'BASELINE_CORRUPT';
  return 'REMOTE_ENVELOPE_CORRUPT';
}

async function cursorFrom(envelope: SyncEnvelope, providerId: string): Promise<ProviderCursor> {
  const hash = await sha256(canonicalStringify(envelope));
  return {
    providerId,
    datasetId: envelope.datasetId,
    baseRevision: envelope.revision,
    baseSnapshotHash: hash,
    compressedBaseline: bytesToBase64(gzipJson(envelope)),
    remoteVersion: `${envelope.revision.counter}:${envelope.revision.deviceId}`,
    lastSyncedAt: new Date().toISOString(),
    needsReconciliation: false,
  };
}
