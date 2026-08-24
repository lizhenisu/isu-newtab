import { describe, expect, it } from 'vitest';
import { createInitialConfig } from '../../core/domain/defaults';
import type { DeviceIdentity, SyncEnvelope } from '../../core/domain/types';
import { applySyncProjection, createEnvelope, mergeEnvelopes, mergeThreeWay } from '../../core/sync/engine';

function identity(deviceId: string, counter = 0): DeviceIdentity {
  return { deviceId, counter, epoch: 0 };
}

describe('sync engine', () => {
  it('never projects a local uploaded wallpaper', () => {
    const device = identity('a');
    const config = createInitialConfig(device);
    config.appearance.wallpaper = { value: { type: 'upload', assetKey: 'secret-local-blob' }, revision: { counter: 2, deviceId: 'a' } };
    const envelope = createEnvelope(config, { tombstones: [] }, { counter: 2, deviceId: 'a' }, 0);
    expect(envelope.config.appearance.wallpaper).toBeUndefined();
    expect(JSON.stringify(envelope)).not.toContain('secret-local-blob');
  });

  it('syncs only the latest Wallhaven original URL', () => {
    const device = identity('a');
    const config = createInitialConfig(device);
    config.appearance.wallpaper = {
      value: { type: 'wallhaven', imageUrl: 'https://w.wallhaven.cc/full/ab/wallhaven-abcd.jpg', sourceUrl: 'https://wallhaven.cc/w/abcd', wallpaperId: 'abcd' },
      revision: { counter: 2, deviceId: 'a' },
    };
    const envelope = createEnvelope(config, { tombstones: [] }, { counter: 2, deviceId: 'a' }, 0);
    expect(envelope.config.appearance.wallpaper?.value).toEqual({ type: 'wallhaven', imageUrl: 'https://w.wallhaven.cc/full/ab/wallhaven-abcd.jpg' });
    expect(JSON.stringify(envelope)).not.toContain('wallpaperId');
  });

  it('syncs random mode and interval without a device-local random image', () => {
    const config = createInitialConfig(identity('a'));
    config.appearance.wallpaper = { value: { type: 'wallhaven-random', interval: '5h' }, revision: { counter: 2, deviceId: 'a' } };
    const envelope = createEnvelope(config, { tombstones: [] }, { counter: 2, deviceId: 'a' }, 0);

    expect(envelope.config.appearance.wallpaper?.value).toEqual({ type: 'wallhaven-random', interval: '5h' });
    expect(JSON.stringify(envelope)).not.toContain('random-current');
  });

  it('syncs Unsplash hotlink and attribution without API credentials', () => {
    const device = identity('a');
    const config = createInitialConfig(device);
    config.appearance.wallpaper = {
      value: {
        type: 'unsplash',
        imageUrl: 'https://images.unsplash.com/photo-a?ixid=value',
        sourceUrl: 'https://unsplash.com/photos/photo-a?utm_source=isu_new_tab',
        photoId: 'photo-a',
        photographerName: 'Photographer',
        photographerUrl: 'https://unsplash.com/@photographer?utm_source=isu_new_tab',
      },
      revision: { counter: 2, deviceId: 'a' },
    };

    const envelope = createEnvelope(config, { tombstones: [] }, { counter: 2, deviceId: 'a' }, 0);

    expect(envelope.config.appearance.wallpaper?.value).toEqual(config.appearance.wallpaper.value);
    expect(JSON.stringify(envelope)).not.toContain('access-key');
  });

  it('does not replace a device-local upload with a remote wallpaper projection', () => {
    const localIdentity = identity('a');
    const local = createInitialConfig(localIdentity);
    local.appearance.wallpaper = { value: { type: 'upload', assetKey: 'wallpaper/upload' }, revision: { counter: 3, deviceId: 'a' } };
    const remoteIdentity = identity('b');
    const remote = createInitialConfig(remoteIdentity);
    remote.appearance.wallpaper = { value: { type: 'solid', color: '#ffffff' }, revision: { counter: 5, deviceId: 'b' } };
    const projected = createEnvelope(remote, { tombstones: [] }, { counter: 5, deviceId: 'b' }, 0).config;
    expect(applySyncProjection(local, projected).appearance.wallpaper.value).toEqual({ type: 'upload', assetKey: 'wallpaper/upload' });
  });

  it('keeps a tombstone over an older entity and repairs orphan shortcuts', () => {
    const leftIdentity = identity('a');
    const config = createInitialConfig(leftIdentity);
    const base = createEnvelope(config, { tombstones: [] }, { counter: 1, deviceId: 'a' }, 0);
    const local = structuredClone(base);
    const remote = structuredClone(base);
    remote.config.groups.push({ id: 'deleted', name: 'Deleted', collapsed: false, sortKey: 'b0', revision: { counter: 2, deviceId: 'b' } });
    remote.config.shortcuts.push({ id: 'child', groupId: 'deleted', name: 'New child', url: 'https://example.com/', sortKey: 'a0', revision: { counter: 4, deviceId: 'b' } });
    local.metadata.tombstones.push({ entityType: 'group', entityId: 'deleted', revision: { counter: 3, deviceId: 'a' } });
    local.revision = { counter: 3, deviceId: 'a' };
    remote.revision = { counter: 4, deviceId: 'b' };

    const merged = mergeEnvelopes(local, remote, identity('c', 4));
    expect(merged.config.groups.some((group) => group.id === 'deleted')).toBe(false);
    expect(merged.config.shortcuts.find((item) => item.id === 'child')?.groupId).toBe('default');
  });

  it('rejects merge across datasets', () => {
    const device = identity('a');
    const config = createInitialConfig(device);
    const local = createEnvelope(config, { tombstones: [] }, { counter: 1, deviceId: 'a' }, 0);
    const remote = structuredClone(local) as SyncEnvelope;
    remote.datasetId = 'other';
    expect(() => mergeEnvelopes(local, remote, device)).toThrow('DATASET_MISMATCH');
  });

  it('uses the provider baseline so a one-sided edit wins without timestamp heuristics', () => {
    const device = identity('a');
    const config = createInitialConfig(device);
    config.shortcuts.push({ id: 'item', groupId: 'default', name: 'Base', url: 'https://example.com/', sortKey: 'a0', revision: { counter: 2, deviceId: 'a' } });
    const base = createEnvelope(config, { tombstones: [] }, { counter: 2, deviceId: 'a' }, 0);
    const local = structuredClone(base);
    const remote = structuredClone(base);
    remote.config.shortcuts[0]!.name = 'Remote edit';
    remote.config.shortcuts[0]!.revision = { counter: 3, deviceId: 'b' };
    remote.revision = { counter: 3, deviceId: 'b' };
    const merged = mergeThreeWay(base, local, remote, identity('c', 3));
    expect(merged.config.shortcuts[0]!.name).toBe('Remote edit');
  });

  it('merges search preferences while keeping device-local history outside the envelope', () => {
    const device = identity('a');
    const base = createEnvelope(createInitialConfig(device), { tombstones: [] }, { counter: 1, deviceId: 'a' }, 0);
    const local = structuredClone(base);
    const remote = structuredClone(base);
    remote.config.appearance.search = {
      value: { ...remote.config.appearance.search.value, widthPercent: 70, backgroundOpacity: 40 },
      revision: { counter: 3, deviceId: 'b' },
    };
    remote.revision = { counter: 3, deviceId: 'b' };
    const merged = mergeThreeWay(base, local, remote, identity('c', 3));
    expect(merged.config.appearance.search.value).toMatchObject({ widthPercent: 70, backgroundOpacity: 40 });
    expect(JSON.stringify(merged)).not.toContain('searchHistory');
  });
});
