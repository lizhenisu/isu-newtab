import type { SyncEnvelope } from '../../core/domain/types';
import type { AdapterStatus, RemoteMetadata, SyncAdapter } from '../../core/sync/adapter';
import { canonicalStringify, sha256 } from '../../core/sync/codec';
import type { CommitSyncAdapter, PublishCommitInput, PublishReceipt, RemoteHeadSummary } from '../../core/sync/commit-adapter';
import type { RemoteReplicaGraph, SyncCommit } from '../../core/sync/commit-graph';

export class MemorySyncAdapter implements SyncAdapter {
  readonly providerId: string;
  readonly capabilities = { conditionalWrite: true, incremental: false };
  private envelope: SyncEnvelope | null = null;
  private enabled = false;

  constructor(providerId: string) {
    this.providerId = providerId;
  }

  async enable() { this.enabled = true; }
  async disable() { this.enabled = false; }
  async getRemoteMetadata(): Promise<RemoteMetadata | null> {
    if (!this.envelope) return null;
    return {
      datasetId: this.envelope.datasetId,
      revision: this.envelope.revision,
      hash: await sha256(canonicalStringify(this.envelope)),
      epoch: this.envelope.epoch,
      version: `${this.envelope.revision.counter}:${this.envelope.revision.deviceId}`,
    };
  }
  async pull() { return this.envelope ? structuredClone(this.envelope) : null; }
  async push(envelope: SyncEnvelope) {
    if (!this.enabled) throw new Error('SYNC_DISABLED');
    this.envelope = structuredClone(envelope);
    return (await this.getRemoteMetadata())!;
  }
  async remove() { this.envelope = null; }
  getStatus(): AdapterStatus { return { state: this.enabled ? 'idle' : 'disabled' }; }
}

/** Small immutable graph provider used by coordinator V2 tests. */
export class MemoryCommitSyncAdapter implements CommitSyncAdapter {
  readonly providerId: string;
  private enabled = false;
  private commits: Record<string, SyncCommit> = {};
  private snapshots = new Map<string, SyncEnvelope>();
  private heads = new Map<string, string>();
  probeCalls = 0;
  discoverCalls = 0;
  readSnapshotCalls = 0;
  publishCalls = 0;

  constructor(providerId: string) { this.providerId = providerId; }
  async enable() { this.enabled = true; }
  async disable() { this.enabled = false; }
  async probeHeads(): Promise<RemoteHeadSummary> {
    this.probeCalls += 1;
    const heads = [...this.heads.values()].map((id) => this.commits[id]!).filter(Boolean);
    return {
      commitIds: heads.map((head) => head.id).sort(),
      datasetId: heads[0]?.datasetId,
      generation: heads[0]?.generation,
    };
  }
  async discover(): Promise<RemoteReplicaGraph | null> {
    this.discoverCalls += 1;
    const headCommits = [...this.heads.values()].map((id) => this.commits[id]!).filter(Boolean);
    if (!headCommits.length) return null;
    return {
      datasetId: headCommits[0]!.datasetId,
      generation: headCommits[0]!.generation,
      heads: headCommits.slice().sort((a, b) => a.id.localeCompare(b.id)),
      commits: structuredClone(this.commits),
    };
  }
  async readSnapshot(commitId: string) {
    this.readSnapshotCalls += 1;
    const snapshot = this.snapshots.get(commitId);
    if (!snapshot) throw new Error('REMOTE_OBJECT_MISSING');
    return structuredClone(snapshot);
  }
  async publish(input: PublishCommitInput): Promise<PublishReceipt> {
    this.publishCalls += 1;
    if (!this.enabled) throw new Error('SYNC_DISABLED');
    const id = await sha256(canonicalStringify({ envelope: input.envelope, parents: input.parents, deviceId: input.deviceId }));
    const commit: SyncCommit = {
      protocolVersion: 2,
      id,
      datasetId: input.envelope.datasetId,
      generation: input.envelope.epoch,
      parents: [...input.parents],
      rootManifestId: id,
      rootHash: await sha256(canonicalStringify(input.envelope)),
      revision: structuredClone(input.envelope.revision),
      authorDeviceId: input.deviceId,
      createdAt: new Date().toISOString(),
    };
    this.commits[id] = commit;
    this.snapshots.set(id, structuredClone(input.envelope));
    this.heads.set(input.deviceId, id);
    return { commit };
  }
  async acknowledge() {}
  async removeV2() { this.commits = {}; this.snapshots.clear(); this.heads.clear(); }
  getStatus(): AdapterStatus { return { state: this.enabled ? 'idle' : 'disabled' }; }
}

export class LegacyMemoryCommitSyncAdapter extends MemoryCommitSyncAdapter {
  constructor(providerId: string, private readonly legacyEnvelope: SyncEnvelope) { super(providerId); }
  async readLegacy() { return structuredClone(this.legacyEnvelope); }
}
