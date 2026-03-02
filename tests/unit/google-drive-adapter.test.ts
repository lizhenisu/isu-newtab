import { describe, expect, it } from 'vitest';
import { createInitialConfig } from '../../core/domain/defaults';
import type { DeviceIdentity } from '../../core/domain/types';
import { GoogleDriveCommitSyncAdapter } from '../../core/sync/google-drive-v2-adapter';
import type { GoogleDriveClient, GoogleDriveCreateMetadata, GoogleDriveFile, GoogleDriveListResult, GoogleDriveUpdateMetadata } from '../../core/sync/google-drive-client';
import { createEnvelope } from '../../core/sync/engine';

class MemoryDrive implements GoogleDriveClient {
  files = new Map<string, { metadata: GoogleDriveCreateMetadata; content: string }>();
  events: string[] = [];
  updateMetadata: GoogleDriveUpdateMetadata[] = [];
  calls = { list: 0, listHeads: 0, download: 0, create: 0, update: 0 };
  private nextId = 0;

  async list(pageToken?: string): Promise<GoogleDriveListResult> {
    this.calls.list += 1;
    return this.page(this.fileList(), pageToken);
  }
  async listHeads(pageToken?: string): Promise<GoogleDriveListResult> {
    this.calls.listHeads += 1;
    return this.page(this.fileList().filter((file) => file.appProperties?.isuSyncKind === 'head'), pageToken);
  }
  private fileList(): GoogleDriveFile[] {
    return [...this.files.entries()].map(([id, value]) => ({ id, name: value.metadata.name, mimeType: value.metadata.mimeType, appProperties: value.metadata.appProperties }));
  }
  private page(all: GoogleDriveFile[], pageToken?: string): GoogleDriveListResult {
    if (!pageToken) return { files: all.slice(0, 2), nextPageToken: all.length > 2 ? '2' : undefined };
    return { files: all.slice(Number(pageToken)) };
  }
  async download(id: string) { this.calls.download += 1; return this.files.get(id)?.content ?? Promise.reject(new Error('missing')); }
  async create(metadata: GoogleDriveCreateMetadata, content: string): Promise<GoogleDriveFile> {
    this.calls.create += 1;
    const id = `file-${++this.nextId}`;
    this.events.push(`create:${metadata.appProperties?.isuSyncKind}`);
    this.files.set(id, { metadata: structuredClone(metadata), content });
    return { id, name: metadata.name, mimeType: metadata.mimeType, appProperties: metadata.appProperties };
  }
  async update(id: string, metadata: GoogleDriveUpdateMetadata, content: string): Promise<GoogleDriveFile> {
    this.calls.update += 1;
    const existing = this.files.get(id);
    if (!existing) throw new Error('missing');
    this.events.push(`update:${metadata.appProperties?.isuSyncKind}`);
    this.updateMetadata.push(structuredClone(metadata));
    const completeMetadata: GoogleDriveCreateMetadata = { ...structuredClone(metadata), parents: existing.metadata.parents };
    this.files.set(id, { metadata: completeMetadata, content });
    return { id, name: metadata.name, mimeType: metadata.mimeType, appProperties: metadata.appProperties };
  }
  async remove(id: string) { this.files.delete(id); }
}

function envelope(deviceId = 'device-a') {
  const identity: DeviceIdentity = { deviceId, counter: 0, epoch: 0 };
  const config = createInitialConfig(identity);
  config.shortcuts.push({ id: `${deviceId}-shortcut`, groupId: 'default', name: 'Example', url: 'https://example.com/', sortKey: 'a0', revision: { counter: 2, deviceId } });
  return createEnvelope(config, { tombstones: [] }, { counter: 2, deviceId }, 0, []);
}

function envelopeWithShortcuts(count: number, deviceId = 'device-a') {
  const value = envelope(deviceId);
  for (let index = 1; index < count; index += 1) {
    value.config.shortcuts.push({
      id: `${deviceId}-shortcut-${index}`,
      groupId: 'default',
      name: `Shortcut ${index}`,
      url: `https://example.com/${index}`,
      sortKey: `a${String(index).padStart(3, '0')}`,
      revision: { counter: 2, deviceId },
    });
  }
  return value;
}

describe('GoogleDriveCommitSyncAdapter', () => {
  it('publishes private immutable records before the device head and restores the envelope', async () => {
    const drive = new MemoryDrive();
    const adapter = new GoogleDriveCommitSyncAdapter(drive);
    await adapter.enable();
    const source = envelope();

    const receipt = await adapter.publish({ envelope: source, parents: [], deviceId: 'device-a' });

    expect(await adapter.readSnapshot(receipt.commit.id)).toEqual(source);
    expect(drive.events.at(-1)).toBe('create:head');
    expect([...drive.files.values()].every((file) => file.metadata.parents?.[0] === 'appDataFolder')).toBe(true);
  });

  it('retains a distinct head for each device', async () => {
    const drive = new MemoryDrive();
    const adapter = new GoogleDriveCommitSyncAdapter(drive);
    await adapter.enable();
    const first = await adapter.publish({ envelope: envelope('device-a'), parents: [], deviceId: 'device-a' });
    const second = envelope('device-b');
    second.datasetId = first.commit.datasetId;
    second.config.datasetId = first.commit.datasetId;
    await adapter.publish({ envelope: second, parents: [first.commit.id], deviceId: 'device-b' });

    expect([...drive.files.values()].filter((file) => file.metadata.appProperties?.isuSyncKind === 'head')).toHaveLength(2);
  });

  it('paginates a head-only listing without loading immutable records', async () => {
    const drive = new MemoryDrive();
    const adapter = new GoogleDriveCommitSyncAdapter(drive);
    await adapter.enable();
    const first = await adapter.publish({ envelope: envelope('device-a'), parents: [], deviceId: 'device-a' });
    for (const deviceId of ['device-b', 'device-c']) {
      const next = envelope(deviceId);
      next.datasetId = first.commit.datasetId;
      next.config.datasetId = first.commit.datasetId;
      await adapter.publish({ envelope: next, parents: [first.commit.id], deviceId });
    }
    drive.calls = { list: 0, listHeads: 0, download: 0, create: 0, update: 0 };

    await expect(adapter.probeHeads()).resolves.toMatchObject({ commitIds: expect.any(Array) });

    expect(drive.calls).toMatchObject({ list: 0, listHeads: 2, download: 3 });
  });

  it('updates an existing device head without resubmitting its appDataFolder parent', async () => {
    const drive = new MemoryDrive();
    const adapter = new GoogleDriveCommitSyncAdapter(drive);
    await adapter.enable();
    const first = await adapter.publish({ envelope: envelope(), parents: [], deviceId: 'device-a' });
    const next = envelope();
    next.datasetId = first.commit.datasetId;
    next.config.datasetId = first.commit.datasetId;
    next.revision = { counter: 3, deviceId: 'device-a' };

    const receipt = await adapter.publish({ envelope: next, parents: [first.commit.id], deviceId: 'device-a' });

    expect(drive.events).toContain('update:head');
    expect(drive.updateMetadata).toEqual([expect.not.objectContaining({ parents: expect.anything() })]);
    await expect(adapter.readSnapshot(receipt.commit.id)).resolves.toEqual(next);
  });

  it('checks only paged heads and reuses validated immutable objects in a warm session', async () => {
    const drive = new MemoryDrive();
    const adapter = new GoogleDriveCommitSyncAdapter(drive);
    await adapter.enable();
    const first = await adapter.publish({ envelope: envelope(), parents: [], deviceId: 'device-a' });

    drive.calls = { list: 0, listHeads: 0, download: 0, create: 0, update: 0 };
    await expect(adapter.probeHeads()).resolves.toMatchObject({ commitIds: [first.commit.id] });
    expect(drive.calls).toMatchObject({ list: 0, listHeads: 1, download: 1 });

    drive.calls = { list: 0, listHeads: 0, download: 0, create: 0, update: 0 };
    const next = envelope();
    next.datasetId = first.commit.datasetId;
    next.config.datasetId = first.commit.datasetId;
    next.revision = { counter: 3, deviceId: 'device-a' };
    await adapter.publish({ envelope: next, parents: [first.commit.id], deviceId: 'device-a' });

    expect(drive.calls.list).toBe(0);
    expect(drive.calls.download).toBe(3); // new root, commit, and verified head
    expect(drive.calls).toMatchObject({ create: 2, update: 1 });
  });

  it('keeps a 101st shortcut warm publish bounded instead of reading the 100-shortcut graph', async () => {
    const drive = new MemoryDrive();
    const adapter = new GoogleDriveCommitSyncAdapter(drive);
    await adapter.enable();
    const firstEnvelope = envelopeWithShortcuts(100);
    const first = await adapter.publish({ envelope: firstEnvelope, parents: [], deviceId: 'device-a' });
    const next = envelopeWithShortcuts(101);
    next.datasetId = first.commit.datasetId;
    next.config.datasetId = first.commit.datasetId;
    next.revision = { counter: 3, deviceId: 'device-a' };
    drive.calls = { list: 0, listHeads: 0, download: 0, create: 0, update: 0 };

    await adapter.publish({ envelope: next, parents: [first.commit.id], deviceId: 'device-a' });

    const remoteCalls = Object.values(drive.calls).reduce((total, count) => total + count, 0);
    expect(drive.calls).toMatchObject({ list: 0, listHeads: 0, create: 3, update: 1, download: 4 });
    expect(remoteCalls).toBeLessThanOrEqual(12);
  });

  it('rejects corrupt remote objects and exposes an authorization-needed state', async () => {
    const drive = new MemoryDrive();
    const adapter = new GoogleDriveCommitSyncAdapter(drive);
    await adapter.enable();
    const receipt = await adapter.publish({ envelope: envelope(), parents: [], deviceId: 'device-a' });
    const object = [...drive.files.entries()].find(([, file]) => file.metadata.appProperties?.isuSyncKind === 'object')!;
    object[1].content = '{}';
    await expect(adapter.readSnapshot(receipt.commit.id)).rejects.toThrow('REMOTE_OBJECT_CORRUPT');

    const unavailable = new GoogleDriveCommitSyncAdapter({ list: async () => { throw new Error('GOOGLE_DRIVE_AUTH_REQUIRED'); }, listHeads: async () => { throw new Error('GOOGLE_DRIVE_AUTH_REQUIRED'); }, download: async () => '', create: async () => { throw new Error('unused'); }, update: async () => { throw new Error('unused'); }, remove: async () => undefined });
    await unavailable.enable();
    await expect(unavailable.discover()).rejects.toThrow('GOOGLE_DRIVE_AUTH_REQUIRED');
    expect(unavailable.getStatus().state).toBe('auth-required');
  });
});
