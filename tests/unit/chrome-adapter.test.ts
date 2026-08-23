import { describe, expect, it } from 'vitest';
import { createInitialConfig } from '../../core/domain/defaults';
import type { DeviceIdentity } from '../../core/domain/types';
import { ChromeSyncAdapter, type SyncStorageArea } from '../../core/sync/chrome-adapter';
import { createEnvelope } from '../../core/sync/engine';

class MemoryStorage implements SyncStorageArea {
  values: Record<string, unknown> = {};
  writes: string[][] = [];
  reads: Array<string | string[] | null> = [];
  async get(keys: string | string[] | null = null) {
    this.reads.push(keys);
    if (keys === null || keys === undefined) return structuredClone(this.values);
    const list = typeof keys === 'string' ? [keys] : keys;
    return Object.fromEntries(list.filter((key) => key in this.values).map((key) => [key, structuredClone(this.values[key])]));
  }
  async set(items: Record<string, unknown>) { this.writes.push(Object.keys(items)); Object.assign(this.values, structuredClone(items)); }
  async remove(keys: string | string[]) { for (const key of typeof keys === 'string' ? [keys] : keys) delete this.values[key]; }
  async clear() { this.values = {}; }
}

function envelope() {
  const identity: DeviceIdentity = { deviceId: 'device-a', counter: 0, epoch: 0 };
  const config = createInitialConfig(identity);
  config.shortcuts.push({ id: 'shortcut-a', groupId: 'default', name: 'Example', url: 'https://example.com/', sortKey: 'a0', revision: { counter: 2, deviceId: 'device-a' } });
  return createEnvelope(config, { tombstones: [] }, { counter: 2, deviceId: 'device-a' }, 0);
}

describe('ChromeSyncAdapter', () => {
  it('commits immutable buckets and reads back a complete envelope', async () => {
    const storage = new MemoryStorage();
    const adapter = new ChromeSyncAdapter(storage);
    const source = envelope();
    await adapter.push(source);
    expect(await adapter.pull()).toEqual(source);
    expect(storage.writes.at(-1)).toEqual(['sync/activeHead']);
    expect(Object.keys(storage.values).some((key) => key.startsWith('sync/manifest/'))).toBe(true);
  });

  it('hashes the canonical entity order after buckets reorder multiple records', async () => {
    const storage = new MemoryStorage();
    const adapter = new ChromeSyncAdapter(storage);
    const source = envelope();
    for (let index = 1; index < 12; index += 1) {
      source.config.shortcuts.push({
        id: `ordered-shortcut-${index}`,
        groupId: 'default',
        name: `Shortcut ${index}`,
        url: `https://example.com/${index}`,
        sortKey: `b${String(index).padStart(2, '0')}`,
        revision: { counter: index + 2, deviceId: 'device-a' },
      });
    }
    source.revision = { counter: 20, deviceId: 'device-a' };

    await adapter.push(source);

    expect(await adapter.pull()).toEqual(source);
  });

  it('accepts a legacy manifest whose total hash used pre-bucket array order', async () => {
    const storage = new MemoryStorage();
    const adapter = new ChromeSyncAdapter(storage);
    const source = envelope();
    await adapter.push(source);
    const head = storage.values['sync/activeHead'] as { manifestKey: string };
    const manifest = storage.values[head.manifestKey] as { envelopeHashMode?: string };
    delete manifest.envelopeHashMode;
    const { sha256, canonicalStringify } = await import('../../core/sync/codec');
    const legacyManifestKey = `sync/manifest/${await sha256(canonicalStringify(manifest))}`;
    storage.values[legacyManifestKey] = manifest;
    head.manifestKey = legacyManifestKey;

    expect(await adapter.pull()).toEqual(source);
  });

  it('validates an older remote hash before adding the default component layout', async () => {
    const storage = new MemoryStorage();
    const adapter = new ChromeSyncAdapter(storage);
    const source = envelope();
    const legacySource = structuredClone(source) as unknown as { config: { appearance: Record<string, unknown> } };
    delete legacySource.config.appearance.widgetLayout;
    await adapter.push(legacySource as unknown as typeof source);

    const pulled = await adapter.pull();

    expect(pulled?.config.appearance.widgetLayout.value.map((item) => item.id)).toEqual([
      'clock', 'greeting', 'focusTimer', 'search', 'quickNote', 'weather', 'dailyQuote', 'addShortcut',
    ]);
  });

  it('writes acknowledgements outside the envelope without changing head', async () => {
    const storage = new MemoryStorage();
    const adapter = new ChromeSyncAdapter(storage);
    const source = envelope();
    await adapter.push(source);
    const head = structuredClone(storage.values['sync/activeHead']);
    await adapter.writeAck('device-a', source.revision, 0);
    expect(storage.values['sync/activeHead']).toEqual(head);
    expect(storage.values['ack/device-a']).toBeDefined();
  });

  it('reads only lightweight head metadata when checking an unchanged remote', async () => {
    const storage = new MemoryStorage();
    const adapter = new ChromeSyncAdapter(storage);
    await adapter.push(envelope());
    storage.reads = [];
    await adapter.getRemoteMetadata();
    expect(storage.reads.flatMap((value) => value ?? []).some((key) => String(key).startsWith('sync/bucket/'))).toBe(false);
  });

  it('writes only the changed entity bucket before the new manifest and head', async () => {
    const storage = new MemoryStorage();
    const adapter = new ChromeSyncAdapter(storage);
    const source = envelope();
    await adapter.push(source);
    storage.writes = [];
    source.config.shortcuts[0]!.name = 'Changed';
    source.config.shortcuts[0]!.revision = { counter: 3, deviceId: 'device-a' };
    source.config.updatedAt = new Date(Date.parse(source.config.updatedAt) + 1_000).toISOString();
    source.revision = { counter: 3, deviceId: 'device-a' };
    await adapter.push(source);
    expect(storage.writes[0]).toHaveLength(1);
    expect(storage.writes[0]![0]).toContain('sync/bucket/shortcuts/');
    expect(storage.writes.at(-1)).toEqual(['sync/activeHead']);
  });

  it('removes expired acknowledgement controls', async () => {
    const storage = new MemoryStorage();
    storage.values['ack/old'] = { revision: { counter: 1, deviceId: 'old' }, epoch: 0, lastSeen: '2020-01-01T00:00:00.000Z' };
    const adapter = new ChromeSyncAdapter(storage);
    expect(await adapter.removeExpiredAcks(Date.parse('2021-01-01T00:00:00.000Z'))).toEqual(['ack/old']);
    expect(storage.values['ack/old']).toBeUndefined();
  });

  it('keeps every encoded item below the 7400 byte target', async () => {
    const storage = new MemoryStorage();
    const adapter = new ChromeSyncAdapter(storage);
    const source = envelope();
    for (let index = 0; index < 120; index += 1) {
      source.config.shortcuts.push({
        id: `shortcut-${index}`,
        groupId: 'default',
        name: `${index}-${crypto.randomUUID()}-${crypto.randomUUID()}`,
        url: `https://example.com/${index}/${crypto.randomUUID()}`,
        sortKey: `b${String(index).padStart(4, '0')}`,
        revision: { counter: index + 3, deviceId: 'device-a' },
      });
    }
    source.revision = { counter: 200, deviceId: 'device-a' };
    await adapter.push(source);
    for (const [key, value] of Object.entries(storage.values)) {
      expect(new TextEncoder().encode(key + JSON.stringify(value)).byteLength).toBeLessThanOrEqual(7_400);
    }
  });

  it('stops remote writes before the 95 KB safety boundary', async () => {
    const storage = new MemoryStorage();
    const adapter = new ChromeSyncAdapter(storage);
    const source = envelope();
    for (let index = 0; index < 900; index += 1) {
      source.config.shortcuts.push({
        id: crypto.randomUUID(),
        groupId: 'default',
        name: `${crypto.randomUUID()}-${crypto.randomUUID()}`,
        url: `https://example.com/${crypto.randomUUID()}/${crypto.randomUUID()}`,
        sortKey: `c${String(index).padStart(5, '0')}`,
        revision: { counter: index + 3, deviceId: 'device-a' },
      });
    }
    source.revision = { counter: 1_000, deviceId: 'device-a' };
    await expect(adapter.push(source)).rejects.toThrow('CHROME_SYNC_CAPACITY_EXCEEDED');
    expect(storage.values['sync/activeHead']).toBeUndefined();
  });

  it('does not switch head when another writer wins before the final switch', async () => {
    const storage = new MemoryStorage();
    const adapter = new ChromeSyncAdapter(storage);
    const source = envelope();
    await adapter.push(source);
    const originalSet = storage.set.bind(storage);
    let raced = false;
    storage.set = async (items) => {
      await originalSet(items);
      if (!raced && Object.keys(items).some((key) => key.startsWith('sync/manifest/'))) {
        raced = true;
        storage.values['sync/activeHead'] = { manifestKey: 'sync/manifest/concurrent', version: '99:other' };
      }
    };
    source.config.shortcuts[0]!.name = 'Changed';
    source.config.shortcuts[0]!.revision = { counter: 3, deviceId: 'device-a' };
    source.revision = { counter: 3, deviceId: 'device-a' };
    await expect(adapter.push(source)).rejects.toThrow('ACTIVE_HEAD_CHANGED');
    expect(storage.values['sync/activeHead']).toEqual({ manifestKey: 'sync/manifest/concurrent', version: '99:other' });
  });

  it('rejects a corrupt remote bucket instead of applying partial data', async () => {
    const storage = new MemoryStorage();
    const adapter = new ChromeSyncAdapter(storage);
    await adapter.push(envelope());
    const bucketKey = Object.keys(storage.values).find((key) => key.startsWith('sync/bucket/'))!;
    const bucket = storage.values[bucketKey] as { data: string };
    bucket.data = `${bucket.data[0] === 'A' ? 'B' : 'A'}${bucket.data.slice(1)}`;
    await expect(adapter.pull()).rejects.toThrow();
  });

  it('keeps a manifest referenced by an active device acknowledgement until it advances', async () => {
    const storage = new MemoryStorage();
    const adapter = new ChromeSyncAdapter(storage);
    const source = envelope();
    await adapter.push(source);
    const firstManifest = (storage.values['sync/activeHead'] as { manifestKey: string }).manifestKey;
    await adapter.writeAck('offline-device', source.revision, source.epoch);
    source.config.shortcuts[0]!.name = 'Revision two';
    source.revision = source.config.shortcuts[0]!.revision = { counter: 3, deviceId: 'device-a' };
    await adapter.push(source);
    source.config.shortcuts[0]!.name = 'Revision three';
    source.revision = source.config.shortcuts[0]!.revision = { counter: 4, deviceId: 'device-a' };
    await adapter.push(source);
    await adapter.collectGarbage(true);
    expect(storage.values[firstManifest]).toBeDefined();
    await adapter.writeAck('offline-device', source.revision, source.epoch);
    await adapter.collectGarbage(true);
    expect(storage.values[firstManifest]).toBeUndefined();
  });
});
