import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../core/storage/database';
import { AppRepository } from '../../core/storage/repository';
import { buildDesktopSnapshot, desktopItems, desktopPlacements, type DesktopItem } from '../../core/domain/desktop';
import type { DesktopCollisionGeometry } from '../../core/domain/desktop-collision';

async function resetDatabase() {
  await closeDatabase();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('isu-newtab');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

describe('repository', () => {
  beforeEach(resetDatabase);
  afterEach(resetDatabase);

  it('deletes a shortcut from business data and records a separate tombstone atomically', async () => {
    const repository = new AppRepository();
    const initial = await repository.initialize();
    const shortcut = await repository.addShortcut({ name: 'Example', url: 'example.com', groupId: initial.groups[0]!.id });
    await repository.deleteShortcut(shortcut.id);
    expect((await repository.getConfig()).shortcuts).toHaveLength(0);
    expect((await repository.getMetadata()).tombstones).toEqual([
      expect.objectContaining({ entityType: 'shortcut', entityId: shortcut.id }),
    ]);
    expect((await repository.getOutbox()).some((entry) => entry.entityId === shortcut.id && entry.changeType === 'delete')).toBe(true);
  });

  it('rejects deletion of a non-empty folder', async () => {
    const repository = new AppRepository();
    await repository.initialize();
    const group = await repository.addGroup('Temporary');
    const shortcut = await repository.addShortcut({ name: 'Example', url: 'https://example.com', groupId: group.id });
    await expect(repository.deleteGroup(group.id)).rejects.toThrow('FOLDER_NOT_EMPTY');
    const config = await repository.getConfig();
    expect(config.shortcuts.find((item) => item.id === shortcut.id)?.groupId).toBe(group.id);
    expect(config.groups.some((item) => item.id === group.id)).toBe(true);
  });

  it('deletes an empty folder without compacting the desktop', async () => {
    const repository = new AppRepository();
    await repository.initialize();
    const group = await repository.addGroup('Empty');
    const before = desktopItems(buildDesktopSnapshot(await repository.getConfig())).filter((item) => item.key !== `folder:${group.id}`);
    await repository.deleteGroup(group.id);
    const after = desktopItems(buildDesktopSnapshot(await repository.getConfig()));
    expect(after.map((item) => [item.key, item.position])).toEqual(before.map((item) => [item.key, item.position]));
  });

  it('moves a shortcut into a folder without moving unrelated desktop nodes', async () => {
    const repository = new AppRepository();
    const initial = await repository.initialize();
    const shortcut = await repository.addShortcut({ name: 'Desktop', url: 'https://example.com', groupId: initial.groups[0]!.id });
    const group = await repository.addGroup('Folder');
    const before = desktopItems(buildDesktopSnapshot(await repository.getConfig())).filter((item) => item.key !== `shortcut:${shortcut.id}`);
    await repository.moveShortcut(shortcut.id, group.id);
    const config = await repository.getConfig();
    const movedShortcut = config.shortcuts.find((item) => item.id === shortcut.id);
    expect(movedShortcut?.groupId).toBe(group.id);
    expect(movedShortcut?.position).toBeUndefined();
    const after = desktopItems(buildDesktopSnapshot(config));
    expect(after.map((item) => [item.key, item.position])).toEqual(before.map((item) => [item.key, item.position]));
  });

  it('does not create a remote outbox operation for a local uploaded wallpaper', async () => {
    const repository = new AppRepository();
    await repository.initialize();
    await repository.setWallpaper({ type: 'upload', assetKey: 'wallpaper/upload' });
    expect((await repository.getOutbox()).filter((entry) => entry.entityId === 'wallpaper')).toHaveLength(0);
  });

  it('preserves the selected solid color while other wallpaper modes are active', async () => {
    const repository = new AppRepository();
    await repository.initialize();
    await repository.setSolidWallpaper('#4a7098');
    await repository.setWallpaper({ type: 'builtin', assetId: 'ocean' });
    expect((await repository.getConfig()).appearance.solidColor.value).toBe('#4a7098');

    await repository.setSolidWallpaper('#4a7098');
    const config = await repository.getConfig();
    expect(config.appearance.wallpaper.value).toEqual({ type: 'solid', color: '#4a7098' });
    expect((await repository.getOutbox()).some((entry) => entry.entityType === 'appearance' && entry.entityId === 'solidColor')).toBe(true);
  });

  it('restores business data, tombstones, outbox, and cursor from a safety checkpoint', async () => {
    const repository = new AppRepository();
    const initial = await repository.initialize();
    await repository.createCheckpoint();
    await repository.addShortcut({ name: 'Later', url: 'https://example.com', groupId: initial.groups[0]!.id });
    expect((await repository.getConfig()).shortcuts).toHaveLength(1);
    expect(await repository.restoreLatestCheckpoint()).toBe(true);
    expect((await repository.getConfig()).shortcuts).toHaveLength(0);
  });

  it('rolls back entity deletion, tombstone, and outbox when the IndexedDB transaction aborts', async () => {
    const setup = new AppRepository();
    const initial = await setup.initialize();
    const shortcut = await setup.addShortcut({ name: 'Keep me', url: 'https://example.com', groupId: initial.groups[0]!.id });
    const repository = new AppRepository((operation, transaction) => {
      if (operation === 'deleteShortcut') transaction.abort();
    });
    await expect(repository.deleteShortcut(shortcut.id)).rejects.toThrow();
    expect((await repository.getConfig()).shortcuts.some((item) => item.id === shortcut.id)).toBe(true);
    expect((await repository.getMetadata()).tombstones).toHaveLength(0);
    expect((await repository.getOutbox()).some((entry) => entry.entityId === shortcut.id && entry.changeType === 'delete')).toBe(false);
  });

  it('recovers pending outbox operations after the database connection restarts', async () => {
    const repository = new AppRepository();
    const initial = await repository.initialize();
    const shortcut = await repository.addShortcut({ name: 'Pending', url: 'https://example.com', groupId: initial.groups[0]!.id });
    await closeDatabase();
    const restarted = new AppRepository();
    await restarted.initialize();
    expect((await restarted.getOutbox()).some((entry) => entry.entityId === shortcut.id)).toBe(true);
  });

  it('commits displaced entities and the system layout in one desktop transaction', async () => {
    const repository = new AppRepository();
    const initial = await repository.initialize();
    const shortcut = await repository.addShortcut({ name: 'Desktop', url: 'https://example.com', groupId: initial.groups[0]!.id });
    const before = await repository.getConfig();
    const snapshot = buildDesktopSnapshot(before);
    const changed = desktopItems(snapshot).map((item) => item.kind === 'shortcut' && item.entity.id === shortcut.id
      ? { ...item, position: { column: 4, row: 30, width: 4, height: 3, gridVersion: 3 } } as DesktopItem
      : item.kind === 'system-widget' && item.id === 'greeting'
        ? { ...item, sizePreset: 'large' as const, position: { column: 12, row: 28, width: 16, height: 3, gridVersion: 3 } } as DesktopItem
        : item);
    await repository.commitDesktopResult({ fingerprint: snapshot.fingerprint, placements: desktopPlacements(changed) });
    const config = await repository.getConfig();
    expect(config.shortcuts.find((item) => item.id === shortcut.id)?.position?.column).toBe(4);
    expect(config.appearance.widgetLayout.value.find((item) => item.id === 'greeting')).toMatchObject({ sizePreset: 'large', position: { column: 12, row: 28, width: 16, height: 3 } });
    const outbox = await repository.getOutbox();
    expect(outbox.some((entry) => entry.entityType === 'shortcut' && entry.entityId === shortcut.id)).toBe(true);
    expect(outbox.some((entry) => entry.entityType === 'appearance' && entry.entityId === 'widgetLayout')).toBe(true);
  });

  it('uses runtime collision geometry only for validation, never for persisted data', async () => {
    const repository = new AppRepository();
    const initial = await repository.initialize();
    const shortcut = await repository.addShortcut({ name: 'Measured', url: 'https://example.com', groupId: initial.groups[0]!.id });
    const snapshot = buildDesktopSnapshot(await repository.getConfig());
    const changed = desktopItems(snapshot).map((item) => item.kind === 'shortcut' && item.entity.id === shortcut.id
      ? { ...item, position: { column: 0, row: 100, width: 4, height: 3, gridVersion: 3 } } as DesktopItem
      : item);
    const collisionGeometry: DesktopCollisionGeometry = {
      boardLeft: 0,
      boardTop: 0,
      columnWidth: 10,
      rowHeight: 40,
      nodes: Object.fromEntries(desktopItems(snapshot).map((item) => [item.key, { width: 1, height: 1, offsetX: 0, offsetY: 0 }])),
    };
    await repository.commitDesktopResult({ fingerprint: snapshot.fingerprint, placements: desktopPlacements(changed), collisionGeometry });
    expect(JSON.stringify(await repository.getConfig())).not.toContain('collisionGeometry');
    expect(JSON.stringify(await repository.getOutbox())).not.toContain('collisionGeometry');
  });

  it('rolls back every displaced desktop item when the transaction aborts', async () => {
    const setup = new AppRepository();
    const initial = await setup.initialize();
    const shortcut = await setup.addShortcut({ name: 'Stable', url: 'https://example.com', groupId: initial.groups[0]!.id });
    const before = await setup.getConfig();
    const repository = new AppRepository((operation, transaction) => {
      if (operation === 'commitDesktopResult') transaction.abort();
    });
    const snapshot = buildDesktopSnapshot(before);
    const changed = desktopItems(snapshot).map((item) => item.kind === 'shortcut' && item.entity.id === shortcut.id
      ? { ...item, position: { column: 8, row: 34, width: 4, height: 3, gridVersion: 3 } } as DesktopItem
      : item.kind === 'system-widget' && item.id === 'clock'
        ? { ...item, sizePreset: 'small' as const, position: { column: 0, row: 34, width: 8, height: 3, gridVersion: 3 } } as DesktopItem
        : item);
    await expect(repository.commitDesktopResult({ fingerprint: snapshot.fingerprint, placements: desktopPlacements(changed) })).rejects.toThrow();
    const after = await repository.getConfig();
    expect(after.shortcuts.find((item) => item.id === shortcut.id)?.position).toEqual(before.shortcuts.find((item) => item.id === shortcut.id)?.position);
    expect(after.appearance.widgetLayout).toEqual(before.appearance.widgetLayout);
  });

  it('rejects a desktop commit created from a stale snapshot', async () => {
    const repository = new AppRepository();
    const initial = await repository.initialize();
    const snapshot = buildDesktopSnapshot(initial);
    await repository.setWidgetEnabled('search', false);
    await expect(repository.commitDesktopResult({ fingerprint: snapshot.fingerprint, placements: desktopPlacements(desktopItems(snapshot)) }))
      .rejects.toThrow('DESKTOP_STALE');
  });

  it('creates a shortcut at the movable add tile and moves the tile away', async () => {
    const repository = new AppRepository();
    const initial = await repository.initialize();
    const snapshot = buildDesktopSnapshot(await repository.getConfig());
    const moved = desktopItems(snapshot).map((item) => item.kind === 'add-shortcut'
      ? { ...item, position: { column: 0, row: 30, width: 4, height: 3, gridVersion: 3 } } as DesktopItem : item);
    await repository.commitDesktopResult({ fingerprint: snapshot.fingerprint, placements: desktopPlacements(moved) });
    await repository.addShortcut({ name: 'Elsewhere', url: 'https://example.com', groupId: initial.groups[0]!.id });
    const config = await repository.getConfig();
    expect(config.shortcuts[0]?.position).toEqual({ column: 0, row: 30, width: 4, height: 3, gridVersion: 3 });
    expect(config.appearance.widgetLayout.value.find((item) => item.id === 'addShortcut')?.position).not.toEqual({ column: 0, row: 30, width: 4, height: 3, gridVersion: 3 });
  });
});
