import { syncEnvelopeSchema } from '../domain/schema';
import type { Revision, SyncEnvelope } from '../domain/types';
import { compareBySortKey } from '../domain/sort';
import type { AdapterStatus } from './adapter';
import type { CommitSyncAdapter, PublishCommitInput, PublishReceipt, RemoteHeadSummary } from './commit-adapter';
import { maximalHeads, type DeviceHead, type RemoteReplicaGraph, type SyncCommit } from './commit-graph';
import { base64ToBytes, bytesToBase64, canonicalStringify, gunzipJson, gzipJson, sha256 } from './codec';
import { type GoogleDriveClient, type GoogleDriveCreateMetadata, type GoogleDriveFile, type GoogleDriveListResult, type GoogleDriveUpdateMetadata, GoogleDriveRestClient } from './google-drive-client';

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
type DriveRecordKind = 'object' | 'head' | 'ack';

const MIME = 'application/json';
const PROTOCOL = '2';
const PREFIX = 'isu-v2';

/** V2 commit graph stored as private files in Google Drive's appDataFolder. */
export class GoogleDriveCommitSyncAdapter implements CommitSyncAdapter {
  readonly providerId = 'google-drive';
  private enabled = true;
  private status: AdapterStatus = { state: 'idle' };
  private index = new Map<string, GoogleDriveFile>();
  private records: GoogleDriveFile[] = [];
  private validatedObjects = new Set<string>();

  constructor(private readonly drive: GoogleDriveClient = new GoogleDriveRestClient()) {}

  async enable(): Promise<void> { this.enabled = true; this.status = { state: 'idle' }; }
  async disable(): Promise<void> { this.enabled = false; this.status = { state: 'disabled' }; }

  async probeHeads(): Promise<RemoteHeadSummary> {
    return this.withStatus(async () => {
      const files = await this.listRecords((pageToken) => this.drive.listHeads(pageToken));
      if (!files.length) return { commitIds: [] };
      const heads = await Promise.all(files.map(async (file) => this.parseHead(file, await this.readJson(file))));
      const datasetIds = new Set(heads.map((head) => head.datasetId));
      const generations = new Set(heads.map((head) => head.generation));
      if (datasetIds.size !== 1 || generations.size !== 1) throw new Error('REMOTE_GRAPH_CORRUPT');
      return {
        commitIds: heads.map((head) => head.commitId).sort(),
        datasetId: heads[0]!.datasetId,
        generation: heads[0]!.generation,
      };
    });
  }

  async discover(): Promise<RemoteReplicaGraph | null> {
    return this.withStatus(async () => {
      await this.refreshIndex();
      const heads = await Promise.all(this.records.filter((file) => recordKind(file) === 'head').map(async (file) => this.parseHead(file, await this.readJson(file))));
      if (!heads.length) return null;
      const datasetIds = new Set(heads.map((head) => head.datasetId));
      const generations = new Set(heads.map((head) => head.generation));
      if (datasetIds.size !== 1 || generations.size !== 1) throw new Error('REMOTE_GRAPH_CORRUPT');
      const commits: Record<string, SyncCommit> = {};
      for (const head of heads) await this.loadCommit(head.commitId, commits, new Set());
      const resolvedHeads = heads.map((head) => commits[head.commitId]).filter((commit): commit is SyncCommit => Boolean(commit));
      const graph: RemoteReplicaGraph = {
        datasetId: heads[0]!.datasetId,
        generation: heads[0]!.generation,
        heads: maximalHeads(commits, resolvedHeads),
        commits,
      };
      if (!graph.heads.length || graph.heads.some((head) => head.datasetId !== graph.datasetId || head.generation !== graph.generation)) throw new Error('REMOTE_GRAPH_CORRUPT');
      return graph;
    });
  }

  async readSnapshot(commitId: string): Promise<SyncEnvelope> {
    return this.withStatus(async () => {
      if (!this.index.size) await this.refreshIndex();
      const record = await this.readObject(commitId, 'commit');
      const payload = decodeObject<CommitPayload>(record);
      const commit: SyncCommit = { ...payload, id: commitId };
      const root = decodeObject<RootPayload>(await this.readObject(commit.rootManifestId, 'root'));
      if (root.datasetId !== commit.datasetId || root.generation !== commit.generation || root.envelopeHash !== commit.rootHash) throw new Error('REMOTE_ENVELOPE_CORRUPT');
      const payloads: BucketPayload[] = [];
      for (const pointer of root.buckets) {
        const bucket = await this.readObject(pointer.id, 'bucket');
        if (bucket.hash !== pointer.hash) throw new Error('REMOTE_BUCKET_CORRUPT');
        payloads.push(decodeObject<BucketPayload>(bucket));
      }
      const envelope = normalizeEnvelope(assembleEnvelope(payloads, root));
      if (await sha256(canonicalStringify(envelope)) !== root.envelopeHash) throw new Error('REMOTE_ENVELOPE_CORRUPT');
      return normalizeEnvelope(syncEnvelopeSchema.parse(envelope) as SyncEnvelope);
    });
  }

  async publish(input: PublishCommitInput): Promise<PublishReceipt> {
    if (!this.enabled) throw new Error('SYNC_DISABLED');
    this.status = { state: 'syncing' };
    return this.withStatus(async () => {
      if (!this.index.size) await this.refreshIndex();
      const normalized = normalizeEnvelope(input.envelope);
      const buckets = await buildBucketObjects(normalized);
      const rootPayload: RootPayload = {
        schemaVersion: 2,
        datasetId: normalized.datasetId,
        generation: normalized.epoch,
        revision: normalized.revision,
        configUpdatedAt: normalized.config.updatedAt,
        envelopeHash: await sha256(canonicalStringify(normalized)),
        buckets: buckets.map((object) => ({ id: object.hash, hash: object.hash })),
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
      for (const object of [...buckets, root, commit]) await this.writeImmutable(object);
      // A head is the only mutable visibility pointer, so it is deliberately last.
      const head: DeviceHead = { protocolVersion: 2, datasetId: normalized.datasetId, generation: normalized.epoch, deviceId: input.deviceId, commitId: commit.hash, updatedAt: new Date().toISOString() };
      const published = await this.writeMutable('head', input.deviceId, head);
      const visibleHead = this.parseHead(published.file, published.value);
      if (visibleHead.commitId !== commit.hash) throw new Error('REMOTE_COMMIT_NOT_DISCOVERABLE');
      this.status = { state: 'idle' };
      return { commit: { ...commitPayload, id: commit.hash } };
    });
  }

  async acknowledge(deviceId: string, commitId: string, generation: number): Promise<void> {
    await this.withStatus(async () => {
      if (!this.index.size) await this.refreshIndex();
      const current = this.index.get(recordKey('ack', deviceId));
      if (current) {
        const previous = await this.readJson(current) as Partial<{ protocolVersion: number; commitId: string; generation: number; lastSeen: string }>;
        const lastSeen = previous.lastSeen ? Date.parse(previous.lastSeen) : 0;
        if (previous.protocolVersion === 2 && previous.commitId === commitId && previous.generation === generation && Number.isFinite(lastSeen) && Date.now() - lastSeen < 24 * 60 * 60 * 1_000) return;
      }
      await this.writeMutable('ack', deviceId, { protocolVersion: 2, commitId, generation, lastSeen: new Date().toISOString() });
    });
  }

  async removeV2(): Promise<void> {
    await this.withStatus(async () => {
      await this.refreshIndex();
      await Promise.all(this.records.map((file) => this.drive.remove(file.id)));
      this.records = [];
      this.index.clear();
      this.validatedObjects.clear();
    });
  }

  async resetRemoteForRecovery(): Promise<void> { await this.removeV2(); }
  getStatus(): AdapterStatus { return { ...this.status }; }

  private async refreshIndex(): Promise<void> {
    const records = await this.listRecords((pageToken) => this.drive.list(pageToken));
    records.sort((left, right) => left.id.localeCompare(right.id));
    const index = new Map<string, GoogleDriveFile>();
    for (const file of records) {
      const kind = recordKind(file);
      const id = file.appProperties?.isuSyncId;
      if (!kind || !id) throw new Error('REMOTE_GRAPH_CORRUPT');
      const key = recordKey(kind, id);
      if (index.has(key)) throw new Error('REMOTE_GRAPH_CORRUPT');
      index.set(key, file);
    }
    this.records = records;
    this.index = index;
    this.validatedObjects.clear();
  }

  private async listRecords(list: (pageToken?: string) => Promise<GoogleDriveListResult>): Promise<GoogleDriveFile[]> {
    const records: GoogleDriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const page = await list(pageToken);
      records.push(...page.files.filter(isRecord));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return records;
  }

  private async writeImmutable(object: StoredObject): Promise<void> {
    const key = recordKey('object', object.hash);
    const existing = this.index.get(key);
    if (existing) {
      if (!this.validatedObjects.has(object.hash)) await this.readObject(object.hash, object.kind);
      return;
    }
    const file = await this.drive.create(createMetadata('object', object.hash), canonicalStringify(object));
    this.index.set(key, file);
    this.records.push(file);
    await this.readObject(object.hash, object.kind);
  }

  private async writeMutable(kind: 'head' | 'ack', id: string, value: unknown): Promise<{ file: GoogleDriveFile; value: unknown }> {
    const key = recordKey(kind, id);
    const existing = this.index.get(key);
    const content = canonicalStringify(value);
    const file = existing
      ? await this.drive.update(existing.id, updateMetadata(kind, id), content)
      : await this.drive.create(createMetadata(kind, id), content);
    this.index.set(key, file);
    if (existing) this.records = this.records.map((record) => record.id === existing.id ? file : record);
    else this.records.push(file);
    const verified = await this.readJson(file);
    if (canonicalStringify(verified) !== content) throw new Error('REMOTE_WRITE_VERIFICATION_FAILED');
    return { file, value: verified };
  }

  private async readObject(hash: string, kind: ObjectKind): Promise<StoredObject> {
    const file = this.index.get(recordKey('object', hash));
    if (!file) throw new Error('REMOTE_OBJECT_MISSING');
    const value = await this.readJson(file);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('REMOTE_OBJECT_CORRUPT');
    const record = value as StoredObject;
    if (record.protocolVersion !== 2 || record.kind !== kind || record.hash !== hash) throw new Error('REMOTE_OBJECT_CORRUPT');
    if (await objectHash(record.kind, decodeObject<unknown>(record)) !== hash) throw new Error('REMOTE_OBJECT_CORRUPT');
    this.validatedObjects.add(hash);
    return record;
  }

  private async readJson(file: GoogleDriveFile): Promise<unknown> {
    try { return JSON.parse(await this.drive.download(file.id)); } catch { throw new Error('REMOTE_OBJECT_CORRUPT'); }
  }

  private async loadCommit(id: string, commits: Record<string, SyncCommit>, path: Set<string>): Promise<void> {
    if (commits[id]) return;
    if (path.has(id)) throw new Error('REMOTE_GRAPH_CORRUPT');
    path.add(id);
    const payload = decodeObject<CommitPayload>(await this.readObject(id, 'commit'));
    if (payload.protocolVersion !== 2 || !payload.datasetId || !Number.isInteger(payload.generation) || !Array.isArray(payload.parents) || !payload.rootManifestId || !payload.rootHash || !payload.authorDeviceId) throw new Error('REMOTE_GRAPH_CORRUPT');
    const commit: SyncCommit = { ...payload, id };
    commits[id] = commit;
    for (const parent of commit.parents) await this.loadCommit(parent, commits, path);
    path.delete(id);
  }

  private parseHead(file: GoogleDriveFile, value: unknown): DeviceHead {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('REMOTE_HEAD_CORRUPT');
    const head = value as Partial<DeviceHead>;
    const deviceId = file.appProperties?.isuSyncId;
    if (head.protocolVersion !== 2 || head.deviceId !== deviceId || !head.datasetId || !head.commitId || !Number.isInteger(head.generation) || !head.updatedAt) throw new Error('REMOTE_HEAD_CORRUPT');
    return head as DeviceHead;
  }

  private async withStatus<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.status = { state: message === 'GOOGLE_DRIVE_AUTH_REQUIRED' ? 'auth-required' : 'error', message };
      throw error;
    }
  }
}

function writableMetadata(kind: DriveRecordKind, id: string) {
  return { name: `${PREFIX}-${kind}-${id}.json`, mimeType: MIME, appProperties: { isuSyncProtocol: PROTOCOL, isuSyncKind: kind, isuSyncId: id } };
}
function createMetadata(kind: DriveRecordKind, id: string): GoogleDriveCreateMetadata {
  return { ...writableMetadata(kind, id), parents: ['appDataFolder'] };
}
function updateMetadata(kind: DriveRecordKind, id: string): GoogleDriveUpdateMetadata {
  return writableMetadata(kind, id);
}
function recordKey(kind: DriveRecordKind, id: string) { return `${kind}:${id}`; }
function recordKind(file: GoogleDriveFile): DriveRecordKind | undefined {
  const kind = file.appProperties?.isuSyncKind;
  return kind === 'object' || kind === 'head' || kind === 'ack' ? kind : undefined;
}
function isRecord(file: GoogleDriveFile): boolean { return file.appProperties?.isuSyncProtocol === PROTOCOL && Boolean(recordKind(file)) && Boolean(file.appProperties?.isuSyncId); }

async function buildBucketObjects(envelope: SyncEnvelope): Promise<StoredObject[]> {
  const payloads: BucketPayload[] = [
    { kind: 'settings', items: [{ config: { schemaVersion: envelope.config.schemaVersion, datasetId: envelope.config.datasetId, appearance: envelope.config.appearance } }] },
    { kind: 'groups', items: envelope.config.groups },
    { kind: 'shortcuts', items: envelope.config.shortcuts },
    { kind: 'pieces', items: envelope.pieces ?? [] },
    { kind: 'tombstones', items: envelope.metadata.tombstones },
  ];
  return Promise.all(payloads.map((payload) => makeObject('bucket', payload)));
}
async function makeObject(kind: ObjectKind, payload: unknown): Promise<StoredObject> { return { protocolVersion: 2, kind, hash: await objectHash(kind, payload), data: bytesToBase64(gzipJson(payload)) }; }
function objectHash(kind: ObjectKind, payload: unknown): Promise<string> { return sha256(canonicalStringify({ protocolVersion: 2, kind, payload })); }
function decodeObject<T>(record: StoredObject): T { try { return gunzipJson<T>(base64ToBytes(record.data)); } catch { throw new Error('REMOTE_OBJECT_CORRUPT'); } }
function assembleEnvelope(payloads: BucketPayload[], root: RootPayload): SyncEnvelope {
  const settings = payloads.find((payload) => payload.kind === 'settings')?.items[0] as { config: Pick<SyncEnvelope['config'], 'schemaVersion' | 'datasetId' | 'appearance'> } | undefined;
  if (!settings) throw new Error('REMOTE_SETTINGS_MISSING');
  const items = (kind: BucketKind) => payloads.filter((payload) => payload.kind === kind).flatMap((payload) => payload.items);
  return { schemaVersion: 1, datasetId: root.datasetId, epoch: root.generation, revision: root.revision, config: { ...settings.config, updatedAt: root.configUpdatedAt, groups: items('groups') as SyncEnvelope['config']['groups'], shortcuts: items('shortcuts') as SyncEnvelope['config']['shortcuts'] }, pieces: items('pieces') as SyncEnvelope['pieces'], metadata: { tombstones: items('tombstones') as SyncEnvelope['metadata']['tombstones'] } };
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
