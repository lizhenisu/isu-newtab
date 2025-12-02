import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, getDatabase } from '../../core/storage/database';
import { AppRepository } from '../../core/storage/repository';
import { buildDesktopSnapshot, desktopItems, desktopPlacements, type DesktopItem } from '../../core/domain/desktop';
import type { DesktopCollisionGeometry } from '../../core/domain/desktop-collision';
import { piecePositionsOverlap } from '../../core/domain/pieces';
import { planFolderShortcutDesktopDrop } from '../../core/layout/folder-shortcut-desktop-drop';

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

  it('keeps only search visible by default and persists add-shortcut visibility changes', async () => {
    const repository = new AppRepository();
    const config = await repository.initialize();
    expect(config.appearance.widgetLayout.value.filter((item) => item.enabled).map((item) => item.id)).toEqual(['search']);
    expect((await repository.getPieces()).filter((piece) => piece.container.kind === 'desktop').map((piece) => piece.payloadRef)).toEqual(['search']);

    await repository.setWidgetEnabled('addShortcut', true);
    expect((await repository.getConfig()).appearance.widgetLayout.value.find((item) => item.id === 'addShortcut')).toMatchObject({ enabled: true });
    expect((await repository.getPieces()).find((piece) => piece.id === 'piece:add-shortcut')).toMatchObject({ container: { kind: 'desktop' } });

    await repository.setWidgetEnabled('addShortcut', false);
    expect((await repository.getPieces()).find((piece) => piece.id === 'piece:add-shortcut')).toMatchObject({ container: { kind: 'hidden' } });
  });

  it('enables widgets in the nearest vacant slot without moving existing pieces', async () => {
    const repository = new AppRepository();
    await repository.initialize();
    const before = await repository.getConfig();
    const searchBefore = before.appearance.widgetLayout.value.find((item) => item.id === 'search')!.position;

    await repository.setWidgetEnabled('clock', true);

    const config = await repository.getConfig();
    const clock = config.appearance.widgetLayout.value.find((item) => item.id === 'clock')!;
    const search = config.appearance.widgetLayout.value.find((item) => item.id === 'search')!;
    const clockPiece = (await repository.getPieces()).find((piece) => piece.id === 'piece:widget:clock')!;
    const desktop = (await repository.getPieces()).filter((piece) => piece.container.kind === 'desktop' && piece.position);

    expect(search.position).toEqual(searchBefore);
    expect(clock.position).toEqual({ column: clockPiece.position!.x + 24, row: clockPiece.position!.y, width: clockPiece.position!.width, height: clockPiece.position!.height, gridVersion: 3 });
    expect(desktop.some((piece, index) => desktop.slice(index + 1).some((other) => piecePositionsOverlap(piece.position!, other.position!)))).toBe(false);

    const clockPosition = clock.position;
    await repository.setWidgetEnabled('clock', false);
    expect((await repository.getPieces()).find((piece) => piece.id === 'piece:widget:clock')).toMatchObject({ container: { kind: 'hidden' } });
    await repository.setWidgetEnabled('clock', true);
    expect((await repository.getConfig()).appearance.widgetLayout.value.find((item) => item.id === 'clock')?.position).toEqual(clockPosition);
  });

  it('enables the add shortcut tile in a vacant slot when its default slot is occupied', async () => {
    const repository = new AppRepository();
    const initial = await repository.initialize();
    const shortcut = await repository.addShortcut({
      name: 'Occupies add tile',
      url: 'https://example.com',
      groupId: initial.groups[0]!.id,
      position: { column: 34, row: 24, width: 4, height: 3, gridVersion: 3 },
    });
    const shortcutBefore = (await repository.getConfig()).shortcuts.find((item) => item.id === shortcut.id)!.position;

    await repository.setWidgetEnabled('addShortcut', true);

    const config = await repository.getConfig();
    const addShortcut = config.appearance.widgetLayout.value.find((item) => item.id === 'addShortcut')!;
    const addPiece = (await repository.getPieces()).find((piece) => piece.id === 'piece:add-shortcut')!;
    const desktop = (await repository.getPieces()).filter((piece) => piece.container.kind === 'desktop' && piece.position);

    expect(config.shortcuts.find((item) => item.id === shortcut.id)?.position).toEqual(shortcutBefore);
    expect(addShortcut.position).toEqual({ column: addPiece.position!.x + 24, row: addPiece.position!.y, width: addPiece.position!.width, height: addPiece.position!.height, gridVersion: 3 });
    expect(desktop.some((piece, index) => desktop.slice(index + 1).some((other) => piecePositionsOverlap(piece.position!, other.position!)))).toBe(false);
  });

  it('persists a local Bing quality preference and inherits the quality of legacy Bing wallpapers', async () => {
    const repository = new AppRepository();
    await repository.initialize();
    expect(await repository.getBingWallpaperQuality()).toBe('1080p');

    await repository.setBingWallpaperQuality('4k');
    expect(await repository.getBingWallpaperQuality()).toBe('4k');

    const database = await getDatabase();
    const config = await repository.getConfig();
    config.appearance.wallpaper.value = {
      type: 'bing',
      imageUrl: 'https://www.bing.com/th?id=OHR.Test_1920x1080.jpg&pid=hp',
      sourceUrl: 'https://www.bing.com/search?q=test',
      date: '20260826',
      quality: '1440p',
    };
    await database.put('config', config, 'current');
    await database.delete('settings', 'bingWallpaperQuality');
    expect(await repository.getBingWallpaperQuality()).toBe('1440p');
    expect(await database.get('settings', 'bingWallpaperQuality')).toBe('1440p');

    await database.put('settings', 'invalid' as never, 'bingWallpaperQuality');
    expect(await repository.getBingWallpaperQuality()).toBe('1080p');
  });

  it('migrates the synchronized wallpaper startup fade with a normal appearance outbox update', async () => {
    const repository = new AppRepository();
    await repository.initialize();
    const database = await getDatabase();
    const config = await repository.getConfig();
    const legacy = structuredClone(config) as { appearance: Record<string, unknown> };
    delete legacy.appearance.wallpaperStartupFadeMs;
    await database.put('config', legacy as never, 'current');
    await database.clear('outbox');

    const migrated = await repository.initialize();
    expect(migrated.appearance.wallpaperStartupFadeMs.value).toBe(600);
    expect((await repository.getOutbox())).toContainEqual(expect.objectContaining({ entityType: 'appearance', entityId: 'wallpaperStartupFadeMs', changeType: 'upsert' }));
  });

  it('promotes a prepared random image atomically and removes its next slot', async () => {
    const repository = new AppRepository();
    await repository.initialize();
    await repository.saveRandomWallpaperState({
      imageUrl: 'https://w.wallhaven.cc/full/ol/wallhaven-old.jpg', sourceUrl: 'https://wallhaven.cc/w/old', wallpaperId: 'old', interval: '1h', updatedAt: '2026-08-23T00:00:00.000Z', nextRefreshAt: '2026-08-23T01:00:00.000Z',
    }, new Blob(['old'], { type: 'image/png' }));
    await repository.savePreparedRandomWallpaperState({
      imageUrl: 'https://w.wallhaven.cc/full/ne/wallhaven-new.jpg', sourceUrl: 'https://wallhaven.cc/w/new', wallpaperId: 'new', currentWallpaperId: 'old', interval: '1h', preparedAt: '2026-08-23T00:30:00.000Z',
    }, new Blob(['new'], { type: 'image/png' }));
    const promoted = await repository.promotePreparedRandomWallpaperState(new Date('2026-08-23T01:00:00.000Z'));
    expect(promoted?.wallpaperId).toBe('new');
    expect(await repository.getPreparedRandomWallpaperState()).toBeUndefined();
    expect(await repository.getAsset('wallpaper/random-next')).toBeUndefined();
    expect((await repository.getAssetRecord('wallpaper/random-current'))?.sourceUrl).toBe('https://w.wallhaven.cc/full/ne/wallhaven-new.jpg');
  });

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

  it('removes a shortcut icon cache in the same deletion transaction', async () => {
    const repository = new AppRepository();
    const initial = await repository.initialize();
    const shortcut = await repository.addShortcut({ name: 'Example', url: 'example.com', groupId: initial.groups[0]!.id });
    await repository.putShortcutIcon(shortcut.id, new Blob(['icon'], { type: 'image/png' }), 'https://example.com/icon.png');
    await repository.deleteShortcut(shortcut.id);
    expect(await repository.getShortcutIcon(shortcut.id)).toBeUndefined();
  });

  it('clears a cached icon atomically when its shortcut URL changes', async () => {
    const repository = new AppRepository();
    const initial = await repository.initialize();
    const shortcut = await repository.addShortcut({ name: 'Example', url: 'https://example.com', groupId: initial.groups[0]!.id });
    await repository.putShortcutIcon(shortcut.id, new Blob(['icon'], { type: 'image/png' }), 'https://example.com/icon.png');
    await repository.updateShortcut(shortcut.id, { name: shortcut.name, url: 'https://new.example.com', groupId: shortcut.groupId });
    expect(await repository.getShortcutIcon(shortcut.id)).toBeUndefined();
  });

  it('removes legacy remote icons at initialization and publishes the cleanup without deleting local uploads', async () => {
    const repository = new AppRepository();
    const initial = await repository.initialize();
    const shortcut = await repository.addShortcut({ name: 'Example', url: 'https://example.com', groupId: initial.groups[0]!.id });
    await repository.putShortcutIcon(shortcut.id, new Blob(['icon'], { type: 'image/svg+xml' }), 'local-upload');
    const database = await getDatabase();
    const config = await repository.getConfig();
    const legacyConfig = {
      ...config,
      shortcuts: config.shortcuts.map((item) => item.id === shortcut.id ? { ...item, icon: 'https://example.com/icon.png' } : item),
    };
    await database.put('config', legacyConfig as never, 'current');
    await database.clear('outbox');

    const migrated = await repository.initialize();
    const migratedShortcut = migrated.shortcuts.find((item) => item.id === shortcut.id)!;
    expect(migratedShortcut).not.toHaveProperty('icon');
    expect(migratedShortcut.revision.counter).toBeGreaterThan(shortcut.revision.counter);
    expect((await repository.getOutbox())).toContainEqual(expect.objectContaining({ entityType: 'shortcut', entityId: shortcut.id, changeType: 'upsert', revision: migratedShortcut.revision }));
    expect(await repository.getShortcutIcon(shortcut.id)).toBeTruthy();
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

  it('serializes rapid folder-member desktop moves and keeps all pieces aligned', async () => {
    const repository = new AppRepository();
    await repository.initialize();
    const folder = await repository.addGroup('Folder');
    const first = await repository.addShortcut({ name: 'First', url: 'https://example.com/first', groupId: folder.id });
    const second = await repository.addShortcut({ name: 'Second', url: 'https://example.com/second', groupId: folder.id });
    const third = await repository.addShortcut({ name: 'Third', url: 'https://example.com/third', groupId: folder.id });
    const target = { column: 0, row: 0, width: 4, height: 3, gridVersion: 3 as const };

    const snapshots = await Promise.all([
      repository.moveShortcut(first.id, 'default', undefined, undefined, target),
      repository.moveShortcut(second.id, 'default', undefined, undefined, target),
      repository.moveShortcut(third.id, 'default', undefined, undefined, target),
    ]);

    for (const [index, shortcutId] of [first.id, second.id, third.id].entries()) {
      const member = snapshots[index]!.config.shortcuts.find((shortcut) => shortcut.id === shortcutId);
      const piece = snapshots[index]!.pieces.find((item) => item.id === `piece:shortcut:${shortcutId}`);
      expect(member?.groupId).toBe('default');
      expect(piece?.container.kind).toBe('desktop');
    }

    const config = await repository.getConfig();
    const pieces = await repository.getPieces();
    const moved = [first.id, second.id, third.id].map((id) => config.shortcuts.find((shortcut) => shortcut.id === id)!);
    expect(moved.every((shortcut) => shortcut.groupId === 'default' && Boolean(shortcut.position))).toBe(true);
    const movedPieces = moved.map((shortcut) => pieces.find((piece) => piece.id === `piece:shortcut:${shortcut.id}`)!);
    expect(movedPieces.every((piece) => piece.container.kind === 'desktop' && Boolean(piece.position))).toBe(true);
    expect(movedPieces.map((piece) => piece.position)).toEqual(moved.map((shortcut) => ({ x: shortcut.position!.column - 24, y: shortcut.position!.row, width: shortcut.position!.width, height: shortcut.position!.height })));

    const desktop = pieces.filter((piece) => piece.container.kind === 'desktop' && piece.position);
    expect(desktop.some((piece, index) => desktop.slice(index + 1).some((other) => piecePositionsOverlap(piece.position!, other.position!)))).toBe(false);
  });

  it('safely recomputes an expired folder-to-desktop plan before committing it', async () => {
    const repository = new AppRepository();
    await repository.initialize();
    const folder = await repository.addGroup('Folder');
    const member = await repository.addShortcut({ name: 'Member', url: 'https://example.com/member', groupId: folder.id });
    const target = { column: 0, row: 0, width: 4, height: 3, gridVersion: 3 as const };
    const stalePlan = planFolderShortcutDesktopDrop(await repository.getConfig(), member.id, target);
    await repository.addShortcut({ name: 'Changed after planning', url: 'https://example.com/changed', groupId: 'default', position: target });

    await repository.moveShortcut(member.id, 'default', undefined, undefined, target, stalePlan);

    const config = await repository.getConfig();
    const pieces = await repository.getPieces();
    expect(config.shortcuts.find((item) => item.id === member.id)).toMatchObject({ groupId: 'default' });
    expect(pieces.find((piece) => piece.id === `piece:shortcut:${member.id}`)).toMatchObject({ container: { kind: 'desktop' } });
    const desktop = pieces.filter((piece) => piece.container.kind === 'desktop' && piece.position);
    expect(desktop.some((piece, index) => desktop.slice(index + 1).some((other) => piecePositionsOverlap(piece.position!, other.position!)))).toBe(false);
  });

  it('repairs a historical folder-config and desktop-piece split in favor of the desktop piece', async () => {
    const repository = new AppRepository();
    await repository.initialize();
    const folder = await repository.addGroup('Folder');
    const shortcut = await repository.addShortcut({ name: 'Member', url: 'https://example.com/member', groupId: folder.id });
    const database = await getDatabase();
    const transaction = database.transaction(['config', 'pieces'], 'readwrite');
    const config = await transaction.objectStore('config').get('current');
    const piece = await transaction.objectStore('pieces').get(`piece:shortcut:${shortcut.id}`);
    if (!config || !piece) throw new Error('TEST_FIXTURE_MISSING');
    piece.container = { kind: 'desktop' };
    piece.position = { x: -8, y: 9, width: 4, height: 3 };
    await transaction.objectStore('pieces').put(piece);
    await transaction.objectStore('config').put(config, 'current');
    await transaction.done;

    const repaired = new AppRepository();
    const repairedConfig = await repaired.initialize();
    const repairedShortcut = repairedConfig.shortcuts.find((item) => item.id === shortcut.id)!;
    const repairedPiece = (await repaired.getPieces()).find((item) => item.id === `piece:shortcut:${shortcut.id}`)!;
    expect(repairedShortcut).toMatchObject({ groupId: 'default', position: { column: 16, row: 9, width: 4, height: 3 } });
    expect(repairedPiece).toMatchObject({ container: { kind: 'desktop' }, position: { x: -8, y: 9, width: 4, height: 3 } });
  });

  it('reads config, pieces, and sync mode as one post-move application snapshot', async () => {
    const repository = new AppRepository();
    await repository.initialize();
    const folder = await repository.addGroup('Folder');
    const shortcut = await repository.addShortcut({ name: 'Member', url: 'https://example.com/member', groupId: folder.id });
    const target = { column: 12, row: 6, width: 4, height: 3, gridVersion: 3 as const };

    const snapshot = await repository.moveShortcut(shortcut.id, 'default', undefined, undefined, target);
    const member = snapshot.config.shortcuts.find((item) => item.id === shortcut.id)!;
    const piece = snapshot.pieces.find((item) => item.id === `piece:shortcut:${shortcut.id}`)!;
    expect(member).toMatchObject({ groupId: 'default', position: target });
    expect(piece).toMatchObject({ container: { kind: 'desktop' }, position: { x: -12, y: 6, width: 4, height: 3 } });
    expect(snapshot.syncMode).toBe('chrome');
  });

  it('keeps oversized notes local and resumes their outbox when shortened', async () => {
    const repository = new AppRepository();
    await repository.initialize();
    await repository.updateQuickNote('x'.repeat(10_241));
    expect((await repository.getConfig()).quickNote?.value).toHaveLength(10_241);
    expect((await repository.getOutbox()).some((entry) => entry.entityType === 'quickNote')).toBe(false);
    await repository.updateQuickNote('short note');
    expect((await repository.getOutbox()).some((entry) => entry.entityType === 'quickNote')).toBe(true);
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
    await setup.putShortcutIcon(shortcut.id, new Blob(['icon'], { type: 'image/png' }), 'https://example.com/icon.png');
    const repository = new AppRepository((operation, transaction) => {
      if (operation === 'deleteShortcut') transaction.abort();
    });
    await expect(repository.deleteShortcut(shortcut.id)).rejects.toThrow();
    expect((await repository.getConfig()).shortcuts.some((item) => item.id === shortcut.id)).toBe(true);
    expect((await repository.getMetadata()).tombstones).toHaveLength(0);
    expect((await repository.getOutbox()).some((entry) => entry.entityId === shortcut.id && entry.changeType === 'delete')).toBe(false);
    expect(await repository.getShortcutIcon(shortcut.id)).toBeTruthy();
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
    await repository.setWidgetEnabled('greeting', true);
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
    await repository.setWidgetEnabled('addShortcut', true);
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
