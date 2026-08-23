import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { createInitialConfig } from '../../core/domain/defaults';
import type { DeviceIdentity } from '../../core/domain/types';
import { createBackup, readBackup } from '../../core/import-export/backup';

function identity(deviceId: string): DeviceIdentity {
  return { deviceId, counter: 0, epoch: 0 };
}

describe('backup import', () => {
  it('reassigns entity IDs and keeps the local dataset ID', async () => {
    const sourceIdentity = identity('source');
    const source = createInitialConfig(sourceIdentity);
    source.groups.push({ id: 'source-group', name: 'Group', collapsed: false, sortKey: 'b0', revision: { counter: 2, deviceId: 'source' } });
    source.shortcuts.push({ id: 'source-shortcut', groupId: 'source-group', name: 'Example', url: 'https://example.com/', sortKey: 'a0', revision: { counter: 3, deviceId: 'source' } });
    const target = createInitialConfig(identity('target'));
    const backup = await createBackup(source);
    const imported = await readBackup(backup, target, identity('target-import'));
    expect(imported.config.datasetId).toBe(target.datasetId);
    expect(imported.config.groups.some((group) => group.id === 'source-group')).toBe(false);
    expect(imported.config.shortcuts.some((shortcut) => shortcut.id === 'source-shortcut')).toBe(false);
  });

  it('rejects paths and extra entries', async () => {
    const archive = zipSync({
      'config.json': strToU8('{}'),
      '../evil.txt': strToU8('evil'),
    });
    const target = createInitialConfig(identity('target'));
    await expect(readBackup(new Blob([archive as BlobPart]), target, identity('import'))).rejects.toThrow('IMPORT_ENTRY_NOT_ALLOWED');
  });

  it('migrates a legacy configuration before assigning new IDs', async () => {
    const legacy = {
      exportVersion: 1,
      exportedAt: new Date().toISOString(),
      config: { schemaVersion: 0, shortcuts: [{ id: 'old', name: 'Legacy', url: 'example.com' }] },
    };
    const archive = zipSync({ 'config.json': strToU8(JSON.stringify(legacy)) });
    const target = createInitialConfig(identity('target'));
    const imported = await readBackup(new Blob([archive as BlobPart]), target, identity('import'));
    expect(imported.config.shortcuts[0]).toEqual(expect.objectContaining({ name: 'Legacy', url: 'https://example.com/' }));
    expect(imported.config.shortcuts[0]!.id).not.toBe('old');
  });

  it('defaults a missing search engine in older backups to Google', async () => {
    const source = createInitialConfig(identity('source'));
    delete (source.appearance.search.value as Partial<typeof source.appearance.search.value>).engine;
    const target = createInitialConfig(identity('target'));
    const imported = await readBackup(await createBackup(source), target, identity('import'));
    expect(imported.config.appearance.search.value.engine).toBe('google');
  });

  it('exports only business configuration and the optional wallpaper', async () => {
    const source = createInitialConfig(identity('source'));
    const archive = new Uint8Array(await (await createBackup(source)).arrayBuffer());
    const files = unzipSync(archive);
    expect(Object.keys(files)).toEqual(['config.json']);
    const payload = JSON.parse(strFromU8(files['config.json']!));
    expect(payload).not.toHaveProperty('metadata');
    expect(JSON.stringify(payload)).not.toContain('tombstones');
  });

  it('rejects a ZIP entry marked as a symbolic link', async () => {
    const archive = zipSync({
      'config.json': [strToU8('{}'), { os: 3, attrs: 0o120777 << 16 }],
    });
    const target = createInitialConfig(identity('target'));
    await expect(readBackup(new Blob([archive as BlobPart]), target, identity('import'))).rejects.toThrow('IMPORT_SYMLINK_NOT_ALLOWED');
  });
});
