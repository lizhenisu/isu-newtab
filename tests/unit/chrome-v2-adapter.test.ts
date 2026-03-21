import { describe, expect, it } from 'vitest';
import { createInitialConfig } from '../../core/domain/defaults';
import type { DeviceIdentity } from '../../core/domain/types';
import type { SyncStorageArea } from '../../core/sync/chrome-adapter';
import { ChromeCommitSyncAdapter } from '../../core/sync/chrome-v2-adapter';
import { createEnvelope } from '../../core/sync/engine';

class MemoryStorage implements SyncStorageArea {
  values: Record<string, unknown> = {};
  writes: string[][] = [];
  async get(keys: string | string[] | null = null) {
    if (keys === null || keys === undefined) return structuredClone(this.values);
    const list = typeof keys === 'string' ? [keys] : keys;
    return Object.fromEntries(list.filter((key) => key in this.values).map((key) => [key, structuredClone(this.values[key])]));
  }
  async set(items: Record<string, unknown>) { this.writes.push(Object.keys(items)); Object.assign(this.values, structuredClone(items)); }
  async remove(keys: string | string[]) { for (const key of typeof keys === 'string' ? [keys] : keys) delete this.values[key]; }
  async clear() { this.values = {}; }
}

function source(deviceId = 'device-a') {
  const identity: DeviceIdentity = { deviceId, counter: 0, epoch: 0 };
  const config = createInitialConfig(identity);
  config.shortcuts.push({ id: `${deviceId}-shortcut`, groupId: 'default', name: 'Example', url: 'https://example.com/', sortKey: 'a0', revision: { counter: 2, deviceId } });
  return createEnvelope(config, { tombstones: [] }, { counter: 2, deviceId }, 0, []);
}

describe('ChromeCommitSyncAdapter', () => {
  it('publishes immutable objects and a device-scoped head', async () => {
    const storage = new MemoryStorage();
    const adapter = new ChromeCommitSyncAdapter(storage);
    const envelope = source();
    const receipt = await adapter.publish({ envelope, parents: [], deviceId: 'device-a' });

    expect(await adapter.readSnapshot(receipt.commit.id)).toEqual(envelope);
    expect(storage.values['isu/v2/head/device-a']).toMatchObject({ commitId: receipt.commit.id });
    expect(storage.values['sync/activeHead']).toBeUndefined();
  });

  it('retains independent heads instead of overwriting another device', async () => {
    const storage = new MemoryStorage();
    const adapter = new ChromeCommitSyncAdapter(storage);
    const first = await adapter.publish({ envelope: source('device-a'), parents: [], deviceId: 'device-a' });
    const second = source('device-b');
    second.datasetId = first.commit.datasetId;
    second.config.datasetId = first.commit.datasetId;
    const next = await adapter.publish({ envelope: second, parents: [first.commit.id], deviceId: 'device-b' });
    const graph = await adapter.discover();

    expect(graph?.heads.map((head) => head.id)).toEqual([next.commit.id]);
    expect(storage.values['isu/v2/head/device-a']).toBeDefined();
    expect(storage.values['isu/v2/head/device-b']).toBeDefined();
  });

  it('rejects a corrupt immutable object before returning a snapshot', async () => {
    const storage = new MemoryStorage();
    const adapter = new ChromeCommitSyncAdapter(storage);
    const receipt = await adapter.publish({ envelope: source(), parents: [], deviceId: 'device-a' });
    const objectKey = Object.keys(storage.values).find((key) => key.startsWith('isu/v2/object/'))!;
    (storage.values[objectKey] as { data: string }).data = 'invalid';
    await expect(adapter.readSnapshot(receipt.commit.id)).rejects.toThrow('REMOTE_OBJECT_CORRUPT');
  });

  it('does not rewrite an unchanged acknowledgement in a tight sync loop', async () => {
    const storage = new MemoryStorage();
    const adapter = new ChromeCommitSyncAdapter(storage);
    const receipt = await adapter.publish({ envelope: source(), parents: [], deviceId: 'device-a' });
    storage.writes = [];

    await adapter.acknowledge('device-a', receipt.commit.id, 0);
    await adapter.acknowledge('device-a', receipt.commit.id, 0);

    expect(storage.writes).toEqual([['isu/v2/ack/device-a']]);
  });
});
