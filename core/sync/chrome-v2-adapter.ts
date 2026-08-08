import { syncEnvelopeSchema } from '../domain/schema';
import type { Revision, SyncEnvelope } from '../domain/types';
import { compareBySortKey } from '../domain/sort';
import type { AdapterStatus } from './adapter';
import { ChromeSyncAdapter, CHROME_ITEM_TARGET_BYTES, CHROME_STOP_BYTES, CHROME_WARNING_BYTES, type SyncStorageArea } from './chrome-adapter';
import type { PublishCommitInput, PublishReceipt, CommitSyncAdapter } from './commit-adapter';
import { compareCommit, maximalHeads, type DeviceHead, type RemoteReplicaGraph, type SyncCommit } from './commit-graph';
import { base64ToBytes, bytesToBase64, canonicalStringify, gunzipJson, gzipJson, sha256 } from './codec';

const V2_PREFIX = 'isu/v2/';
const OBJECT_PREFIX = `${V2_PREFIX}object/`;
const HEAD_PREFIX = `${V2_PREFIX}head/`;
const ACK_PREFIX = `${V2_PREFIX}ack/`;

type StorageValues = Record<string, unknown>;
type BucketKind = 'settings' | 'groups' | 'shortcuts' | 'pieces' | 'tombstones';
type BucketPayload = { kind: BucketKind; items: unknown[] };
type ObjectKind = 'bucket' | 'root' | 'commit';
type StoredObject = { protocolVersion: 2; kind: ObjectKind; hash: string; data: string };
type RootPayload = {
  schemaVersion: 2;
  datasetId: string;
  generation: number;
  revision: Revision;
  configUpdatedAt: string;
  envelopeHash: string;
  buckets: Array<{ id: string; hash: string }>;
};
type CommitPayload = Omit<SyncCommit, 'id'>;

/**
 * Chrome Sync V2: immutable content-addressed objects plus one head per
 * device. No operation depends on a global, last-writer-wins head pointer.
 */
export class ChromeCommitSyncAdapter implements CommitSyncAdapter {
  readonly providerId = 'chrome';
  private enabled = true;
  private status: AdapterStatus = { state: 'idle' };

  constructor(private readonly storage: SyncStorageArea = chrome.storage.sync) {}

  async enable(): Promise<void> {
    this.enabled = true;
    this.status = { state: 'idle' };
  }

  async disable(): Promise<void> {
    this.enabled = false;
    this.status = { state: 'disabled' };
  }

  async discover(): Promise<RemoteReplicaGraph | null> {
    const values = await this.storage.get(null);
    const heads = Object.entries(values)
      .filter(([key]) => key.startsWith(HEAD_PREFIX))
      .map(([key, value]) => this.parseHead(key, value));
    if (!heads.length) return null;
    const datasetIds = new Set(heads.map((head) => head.datasetId));
    const generations = new Set(heads.map((head) => head.generation));
    if (datasetIds.size !== 1 || generations.size !== 1) throw new Error('REMOTE_GRAPH_CORRUPT');
    const commits: Record<string, SyncCommit> = {};
    for (const head of heads) await this.loadCommit(values, head.commitId, commits, new Set());
    const resolvedHeads = heads.map((head) => commits[head.commitId]).filter((commit): commit is SyncCommit => Boolean(commit));
    const graph: RemoteReplicaGraph = {
      datasetId: heads[0]!.datasetId,
      generation: heads[0]!.generation,
      heads: maximalHeads(commits, resolvedHeads),
      commits,
    };
    if (!graph.heads.length || graph.heads.some((head) => head.datasetId !== graph.datasetId || head.generation !== graph.generation)) {
      throw new Error('REMOTE_GRAPH_CORRUPT');
    }
    return graph;
  }

  async readSnapshot(commitId: string): Promise<SyncEnvelope> {
    const values = await this.storage.get(null);
    const record = await this.readObject(values, commitId, 'commit');
    const payload = this.decodeObject<CommitPayload>(record);
    const commit: SyncCommit = { ...payload, id: commitId };
    const rootRecord = await this.readObject(values, commit.rootManifestId, 'root');
    const root = this.decodeObject<RootPayload>(rootRecord);
    if (root.datasetId !== commit.datasetId || root.generation !== commit.generation || root.envelopeHash !== commit.rootHash) {
      throw new Error('REMOTE_ENVELOPE_CORRUPT');
    }
    const payloads: BucketPayload[] = [];
    for (const pointer of root.buckets) {
      const bucketRecord = await this.readObject(values, pointer.id, 'bucket');
      if (bucketRecord.hash !== pointer.hash) throw new Error('REMOTE_BUCKET_CORRUPT');
      payloads.push(this.decodeObject<BucketPayload>(bucketRecord));
    }
    const envelope = normalizeEnvelope(assembleEnvelope(payloads, root));
    if (await sha256(canonicalStringify(envelope)) !== root.envelopeHash) throw new Error('REMOTE_ENVELOPE_CORRUPT');
    return normalizeEnvelope(syncEnvelopeSchema.parse(envelope) as SyncEnvelope);
  }

  async publish(input: PublishCommitInput): Promise<PublishReceipt> {
    if (!this.enabled) throw new Error('SYNC_DISABLED');
    this.status = { state: 'syncing' };
    try {
      const normalized = normalizeEnvelope(input.envelope);
      const values = await this.storage.get(null);
      const bucketObjects = await buildBucketObjects(normalized);
      const rootPayload: RootPayload = {
        schemaVersion: 2,
        datasetId: normalized.datasetId,
        generation: normalized.epoch,
        revision: normalized.revision,
        configUpdatedAt: normalized.config.updatedAt,
        envelopeHash: await sha256(canonicalStringify(normalized)),
        buckets: bucketObjects.map((object) => ({ id: object.hash, hash: object.hash })),
      };
      const root = await makeObject('root', rootPayload);
      const commitPayload: CommitPayload = {
        protocolVersion: 2,
        datasetId: normalized.datasetId,
        generation: normalized.epoch,
        parents: [...new Set(input.parents)].sort(),
        rootManifestId: root.hash,
        rootHash: rootPayload.envelopeHash,
        revision: normalized.revision,
        authorDeviceId: input.deviceId,
        createdAt: new Date().toISOString(),
      };
      const commit = await makeObject('commit', commitPayload);
      const head: DeviceHead = {
        protocolVersion: 2,
        datasetId: normalized.datasetId,
        generation: normalized.epoch,
        deviceId: input.deviceId,
        commitId: commit.hash,
        updatedAt: new Date().toISOString(),
      };
      const objects = [...bucketObjects, root, commit];
      const missing = Object.fromEntries(objects
        .filter((object) => canonicalStringify(values[objectKey(object.hash)]) !== canonicalStringify(object))
        .map((object) => [objectKey(object.hash), object]));
      const predicted = predictedBytes(values, { ...missing, [headKey(input.deviceId)]: head });
      if (predicted >= CHROME_STOP_BYTES) {
        this.status = { state: 'error', message: 'QUOTA_SAFETY_LIMIT', usedBytes: predicted };
        throw new Error('CHROME_SYNC_CAPACITY_EXCEEDED');
      }
      if (Object.keys(missing).length) {
        await this.storage.set(missing);
        await verifyValues(this.storage, missing);
      }
      // The device-scoped head is deliberately written last. A failed publish
      // only leaves unreachable immutable objects, never a partial visible commit.
      await this.storage.set({ [headKey(input.deviceId)]: head });
      await verifyValues(this.storage, { [headKey(input.deviceId)]: head });
      this.status = predicted >= CHROME_WARNING_BYTES
        ? { state: 'warning', message: 'QUOTA_WARNING', usedBytes: predicted }
        : { state: 'idle', usedBytes: predicted };
      return { commit: { ...commitPayload, id: commit.hash } };
    } catch (error) {
      if (this.status.state !== 'error') this.status = { state: 'error', message: errorMessage(error) };
      throw error;
    }
  }

  async acknowledge(deviceId: string, commitId: string, generation: number): Promise<void> {
    const key = `${ACK_PREFIX}${deviceId}`;
    const current = (await this.storage.get(key))[key] as { protocolVersion?: number; commitId?: string; generation?: number; lastSeen?: string } | undefined;
    const lastSeen = current?.lastSeen ? Date.parse(current.lastSeen) : 0;
    // Acks are liveness hints, not a heartbeat. Rewriting the same value after
    // every local storage notification creates a feedback loop that exhausts
    // Chrome Sync's MAX_WRITE_OPERATIONS_PER_MINUTE quota.
    if (current?.protocolVersion === 2 && current.commitId === commitId && current.generation === generation
      && Number.isFinite(lastSeen) && Date.now() - lastSeen < 24 * 60 * 60 * 1_000) return;
    await this.storage.set({ [key]: { protocolVersion: 2, commitId, generation, lastSeen: new Date().toISOString() } });
  }

  async removeV2(): Promise<void> {
    const values = await this.storage.get(null);
    const keys = Object.keys(values).filter((key) => key.startsWith(V2_PREFIX));
    if (keys.length) await this.storage.remove(keys);
  }

  async resetRemoteForRecovery(): Promise<void> {
    await this.removeV2();
    // V1 is only removed after an explicit "use this device to rebuild the
    // remote" recovery choice. This is deliberately not part of migration or
    // normal synchronization.
    await new ChromeSyncAdapter(this.storage).remove();
  }

  getStatus(): AdapterStatus {
    return { ...this.status };
  }

  /** Read-only bridge for a non-destructive V1 to V2 migration. */
  async readLegacy(): Promise<SyncEnvelope | null> {
    const legacy = new ChromeSyncAdapter(this.storage);
    return legacy.pull();
  }

  private parseHead(key: string, value: unknown): DeviceHead {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('REMOTE_HEAD_CORRUPT');
    const head = value as Partial<DeviceHead>;
    const deviceId = key.slice(HEAD_PREFIX.length);
    if (head.protocolVersion !== 2 || head.deviceId !== deviceId || !head.datasetId || !head.commitId
      || !Number.isInteger(head.generation) || !head.updatedAt) throw new Error('REMOTE_HEAD_CORRUPT');
    return head as DeviceHead;
  }

  private async loadCommit(values: StorageValues, id: string, commits: Record<string, SyncCommit>, path: Set<string>): Promise<void> {
    if (commits[id]) return;
    if (path.has(id)) throw new Error('REMOTE_GRAPH_CORRUPT');
    path.add(id);
    const record = await this.readObject(values, id, 'commit');
    const payload = this.decodeObject<CommitPayload>(record);
    if (payload.protocolVersion !== 2 || !payload.datasetId || !Number.isInteger(payload.generation)
      || !Array.isArray(payload.parents) || !payload.rootManifestId || !payload.rootHash || !payload.authorDeviceId) {
      throw new Error('REMOTE_GRAPH_CORRUPT');
    }
    const commit: SyncCommit = { ...payload, id };
    commits[id] = commit;
    for (const parent of commit.parents) await this.loadCommit(values, parent, commits, path);
    path.delete(id);
  }

  private async readObject(values: StorageValues, hash: string, kind: ObjectKind): Promise<StoredObject> {
    const record = values[objectKey(hash)] as StoredObject | undefined;
    if (!record) throw new Error('REMOTE_OBJECT_MISSING');
    if (record.protocolVersion !== 2 || record.kind !== kind || record.hash !== hash) throw new Error('REMOTE_OBJECT_CORRUPT');
    const payload = this.decodeObject<unknown>(record);
    if (await objectHash(record.kind, payload) !== hash) throw new Error('REMOTE_OBJECT_CORRUPT');
    return record;
  }

  private decodeObject<T>(record: StoredObject): T {
    try {
      return gunzipJson<T>(base64ToBytes(record.data));
    } catch {
      throw new Error('REMOTE_OBJECT_CORRUPT');
    }
  }
}

async function buildBucketObjects(envelope: SyncEnvelope): Promise<StoredObject[]> {
  const settings: BucketPayload = { kind: 'settings', items: [{ config: {
    schemaVersion: envelope.config.schemaVersion,
    datasetId: envelope.config.datasetId,
    appearance: envelope.config.appearance,
  } }] };
  const payloads = [
    settings,
    ...await partition('groups', envelope.config.groups),
    ...await partition('shortcuts', envelope.config.shortcuts),
    ...await partition('pieces', envelope.pieces ?? [], (item) => String((item as { id: string }).id)),
    ...await partition('tombstones', envelope.metadata.tombstones, (item) => `${(item as { entityType: string; entityId: string }).entityType}/${(item as { entityId: string }).entityId}`),
  ];
  return Promise.all(payloads.map((payload) => makeObject('bucket', payload)));
}

async function partition<T>(kind: BucketKind, items: T[], identity: (item: T) => string = (item) => String((item as { id?: string }).id ?? '')): Promise<BucketPayload[]> {
  if (!items.length) return [{ kind, items: [] }];
  const hashed = await Promise.all(items.map(async (item) => ({ item, hash: await sha256(identity(item)) })));
  hashed.sort((left, right) => left.hash.localeCompare(right.hash));
  const result: BucketPayload[] = [];
  const visit = async (entries: typeof hashed, depth: number): Promise<void> => {
    const payload: BucketPayload = { kind, items: entries.map(({ item }) => item) };
    const object = await makeObject('bucket', payload);
    if (encodedItemBytes(objectKey(object.hash), object) <= CHROME_ITEM_TARGET_BYTES) {
      result.push(payload);
      return;
    }
    if (entries.length === 1 || depth >= 64) throw new Error('CHROME_SYNC_ENTITY_TOO_LARGE');
    const groups = new Map<string, typeof hashed>();
    for (const entry of entries) {
      const prefix = entry.hash.slice(0, depth + 1);
      groups.set(prefix, [...(groups.get(prefix) ?? []), entry]);
    }
    if (groups.size === 1) throw new Error('CHROME_SYNC_ENTITY_TOO_LARGE');
    for (const group of [...groups.values()].sort((left, right) => left[0]!.hash.localeCompare(right[0]!.hash))) await visit(group, depth + 1);
  };
  await visit(hashed, 0);
  return result;
}

async function makeObject(kind: ObjectKind, payload: unknown): Promise<StoredObject> {
  const hash = await objectHash(kind, payload);
  const record: StoredObject = { protocolVersion: 2, kind, hash, data: bytesToBase64(gzipJson(payload)) };
  if (encodedItemBytes(objectKey(hash), record) > CHROME_ITEM_TARGET_BYTES) {
    throw new Error(kind === 'root' ? 'CHROME_SYNC_MANIFEST_TOO_LARGE' : 'CHROME_SYNC_ITEM_TOO_LARGE');
  }
  return record;
}

function objectHash(kind: ObjectKind, payload: unknown): Promise<string> {
  return sha256(canonicalStringify({ protocolVersion: 2, kind, payload }));
}

function objectKey(hash: string): string { return `${OBJECT_PREFIX}${hash}`; }
function headKey(deviceId: string): string { return `${HEAD_PREFIX}${deviceId}`; }

function predictedBytes(current: StorageValues, writes: StorageValues): number {
  return Object.entries({ ...current, ...writes }).reduce((total, [key, value]) => total + encodedItemBytes(key, value), 0);
}

async function verifyValues(storage: SyncStorageArea, expected: StorageValues): Promise<void> {
  const actual = await storage.get(Object.keys(expected));
  for (const [key, value] of Object.entries(expected)) {
    if (canonicalStringify(actual[key]) !== canonicalStringify(value)) throw new Error('REMOTE_WRITE_VERIFICATION_FAILED');
  }
}

function assembleEnvelope(payloads: BucketPayload[], root: RootPayload): SyncEnvelope {
  const settings = payloads.find((payload) => payload.kind === 'settings')?.items[0] as { config: Pick<SyncEnvelope['config'], 'schemaVersion' | 'datasetId' | 'appearance'> } | undefined;
  if (!settings) throw new Error('REMOTE_SETTINGS_MISSING');
  const items = (kind: BucketKind) => payloads.filter((payload) => payload.kind === kind).flatMap((payload) => payload.items);
  return {
    schemaVersion: 1,
    datasetId: root.datasetId,
    epoch: root.generation,
    revision: root.revision,
    config: { ...settings.config, updatedAt: root.configUpdatedAt, groups: items('groups') as SyncEnvelope['config']['groups'], shortcuts: items('shortcuts') as SyncEnvelope['config']['shortcuts'] },
    pieces: items('pieces') as SyncEnvelope['pieces'],
    metadata: { tombstones: items('tombstones') as SyncEnvelope['metadata']['tombstones'] },
  };
}

function normalizeEnvelope(envelope: SyncEnvelope): SyncEnvelope {
  const normalized = structuredClone(envelope);
  normalized.pieces ??= [];
  normalized.pieces.sort((left, right) => left.id.localeCompare(right.id));
  normalized.config.groups.sort(compareBySortKey);
  normalized.config.shortcuts.sort(compareBySortKey);
  normalized.metadata.tombstones.sort((left, right) => left.entityType.localeCompare(right.entityType) || left.entityId.localeCompare(right.entityId) || left.revision.counter - right.revision.counter || left.revision.deviceId.localeCompare(right.revision.deviceId));
  return normalized;
}

function encodedItemBytes(key: string, value: unknown): number { return new TextEncoder().encode(key + JSON.stringify(value)).byteLength; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'UNKNOWN_SYNC_ERROR'; }
