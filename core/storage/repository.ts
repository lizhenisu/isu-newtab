import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import { createDeviceIdentity, createInitialConfig } from '../domain/defaults';
import { nextRevision } from '../domain/revision';
import { normalizeShortcutUrl } from '../domain/url';
import { shortcutIconAssetKey } from '../domain/shortcut-icons';
import {
  DEFAULT_GROUP_ID,
  type AppConfig,
  type AssetRecord,
  type DeviceIdentity,
  type OutboxEntry,
  type ProviderCursor,
  type Shortcut,
  type ShortcutInput,
  type ShortcutGroup,
  type SyncCheckpoint,
  type SyncMetadata,
  type SyncMode,
  type Wallpaper,
} from '../domain/types';
import { getDatabase } from './database';
import { legacyShortcutIconIds, migrateAppConfig } from '../domain/migration';
import { compareBySortKey } from '../domain/sort';
import {
  buildDesktopSnapshot,
  desktopLayoutFingerprint,
  desktopItems,
  desktopPlacements,
  migrateDesktopPositions,
  samePosition,
  validateDesktopItems,
  type DesktopCommit,
  type DesktopPlacement,
} from '../domain/desktop';
import { executePieceDesktopCommand, nearestPieceDesktopVacancy } from '../layout/piece-desktop-adapter';
import type { FolderShortcutDesktopDropPlan } from '../layout/folder-shortcut-desktop-drop';
import { applyDesktopPlacementsToPieces } from '../layout/piece-placement-projection';
import { collisionRectFor, collisionRectsOverlap, type DesktopCollisionGeometry } from '../layout/desktop-collision';
import { resolveAddShortcutLayout, SYSTEM_WIDGET_IDS, WIDGET_SIZE_PRESETS, type ConfigurableWidgetId, type SystemWidgetId, type WidgetPosition } from '../domain/widgets';
import { createDefaultPieces, isPiecePositionValid, pieceFingerprint, piecePositionForWidget, piecePositionsOverlap, searchPercentToPieceWidth, type Piece, type PiecePosition, type PieceSnapshot } from '../domain/pieces';
import type { PreparedRandomWallpaperState, RandomWallpaperState } from '../wallpaper/random';
import { isPreparedRandomWallpaperState, isRandomWallpaperState, nextRandomWallpaperState, RANDOM_WALLPAPER_ASSET_KEY, RANDOM_WALLPAPER_NEXT_ASSET_KEY } from '../wallpaper/random';
import { BING_DAILY_ASSET_KEY, DEFAULT_BING_WALLPAPER_QUALITY, normalizeBingDailyState, type BingDailyState } from '../wallpaper/bing';
import type { SyncReplica } from '../sync/replica';
import type { AppStateSnapshot, AppUnitOfWork, AssetRepository, BackupRepository, ConfigRepository, SyncRepository } from './ports';

type Listener = () => void;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function outboxEntry(
  entityType: OutboxEntry['entityType'],
  entityId: string,
  revision: OutboxEntry['revision'],
  changeType: OutboxEntry['changeType'],
): OutboxEntry {
  return {
    opId: crypto.randomUUID(),
    entityType,
    entityId,
    revision,
    changeType,
    createdAt: new Date().toISOString(),
  };
}

/**
 * IndexedDB unit of work for mutations that must atomically update business data,
 * tombstones, outbox entries, device revisions, and safety checkpoints.
 */
export class IndexedDbUnitOfWork implements AppUnitOfWork {
  private readonly listeners = new Set<Listener>();
  private readonly channel?: BroadcastChannel;
  /** Serializes compound shortcut moves so one full-config transaction cannot overwrite another. */
  private shortcutMoveTail: Promise<void> = Promise.resolve();

  constructor(private readonly faultInjector?: (operation: string, transaction: { abort(): void }) => void) {
    if (typeof BroadcastChannel !== 'undefined' && globalThis.location?.protocol === 'chrome-extension:') {
      this.channel = new BroadcastChannel('isu-newtab:repository');
      this.channel.onmessage = () => this.notifyListeners();
    }
  }

  async initialize(): Promise<AppConfig> {
    const database = await getDatabase();
    const transaction = database.transaction(['config', 'metadata', 'outbox', 'settings', 'assets', 'cursors', 'checkpoints', 'pieces', 'syncReplicas'], 'readwrite');
    let identity = await transaction.objectStore('settings').get('deviceIdentity') as DeviceIdentity | undefined;
    let config = await transaction.objectStore('config').get('current');
    const existingPieces = await transaction.objectStore('pieces').getAll();
    if (!identity) {
      identity = createDeviceIdentity();
      await transaction.objectStore('settings').put(identity, 'deviceIdentity');
    }
    const destructiveReset = Boolean(config && existingPieces.length === 0);
    if (!config || destructiveReset) {
      const preservedDatasetId = config?.datasetId;
      if (destructiveReset) {
        await transaction.objectStore('metadata').clear();
        await transaction.objectStore('outbox').clear();
        await transaction.objectStore('assets').clear();
        await transaction.objectStore('cursors').clear();
        await transaction.objectStore('checkpoints').clear();
        await transaction.objectStore('syncReplicas').clear();
        for (const key of ['searchHistory', 'searchHistorySource', 'appLanguage', 'weatherPreferences', 'weatherCache', 'randomWallpaper', 'randomWallpaperNext', 'bingDailyWallpaper', 'bingWallpaperQuality', 'syncMode'] as const) {
          await transaction.objectStore('settings').delete(key);
        }
        identity.epoch += 1;
      }
      config = createInitialConfig(identity);
      if (preservedDatasetId) config.datasetId = preservedDatasetId;
      await transaction.objectStore('config').put(config, 'current');
      await transaction.objectStore('settings').put(identity, 'deviceIdentity');
      const pieceRevision = { counter: ++identity.counter, deviceId: identity.deviceId };
      for (const piece of createDefaultPieces(pieceRevision, config.appearance.search.value.widthPercent)) {
        await transaction.objectStore('pieces').put(piece);
      }
    } else {
      const removedRemoteIconIds = legacyShortcutIconIds(config);
      const needsWallpaperStartupFadeMigration = !hasWallpaperStartupFade(config);
      const previousWidgetLayout = JSON.stringify(config.appearance.widgetLayout.value);
      config = migrateAppConfig(config);
      const widgetDefaultsChanged = previousWidgetLayout !== JSON.stringify(config.appearance.widgetLayout.value);
      const migration = migrateDesktopPositions(config);
      config = migration.config;
      for (const id of migration.changedShortcuts) {
        const shortcut = config.shortcuts.find((item) => item.id === id)!;
        shortcut.revision = nextRevision(identity, shortcut.revision);
        await transaction.objectStore('outbox').put(outboxEntry('shortcut', id, shortcut.revision, 'upsert'));
      }
      for (const id of removedRemoteIconIds) {
        const shortcut = config.shortcuts.find((item) => item.id === id);
        if (!shortcut) continue;
        shortcut.revision = nextRevision(identity, shortcut.revision);
        await transaction.objectStore('outbox').put(outboxEntry('shortcut', id, shortcut.revision, 'upsert'));
      }
      for (const id of migration.changedGroups) {
        const group = config.groups.find((item) => item.id === id)!;
        group.revision = nextRevision(identity, group.revision);
        await transaction.objectStore('outbox').put(outboxEntry('group', id, group.revision, 'upsert'));
      }
      if (migration.widgetLayoutChanged || widgetDefaultsChanged) {
        config.appearance.widgetLayout.revision = nextRevision(identity, config.appearance.widgetLayout.revision);
        await transaction.objectStore('outbox').put(outboxEntry('appearance', 'widgetLayout', config.appearance.widgetLayout.revision, 'upsert'));
      }
      if (needsWallpaperStartupFadeMigration) {
        config.appearance.wallpaperStartupFadeMs.revision = nextRevision(identity, config.appearance.wallpaperStartupFadeMs.revision);
        await transaction.objectStore('outbox').put(outboxEntry('appearance', 'wallpaperStartupFadeMs', config.appearance.wallpaperStartupFadeMs.revision, 'upsert'));
      }
      if (removedRemoteIconIds.length || needsWallpaperStartupFadeMigration) config.updatedAt = new Date().toISOString();
      await transaction.objectStore('config').put(config, 'current');
    }
    await ensureBusinessPieces(transaction.objectStore('pieces'), config);
    for (const entry of await reconcileDesktopShortcutContainers(transaction.objectStore('pieces'), config, identity)) {
      await transaction.objectStore('outbox').put(entry);
    }
    await transaction.objectStore('config').put(config, 'current');
    for (const entry of await ensureSystemPieces(transaction.objectStore('pieces'), config, identity)) {
      await transaction.objectStore('outbox').put(entry);
    }
    let metadata = await transaction.objectStore('metadata').get('current');
    if (!metadata) {
      metadata = { tombstones: [] };
      await transaction.objectStore('metadata').put(metadata, 'current');
    }
    const observedCounters = [
      ...config.groups.map((item) => item.revision.counter),
      ...config.shortcuts.map((item) => item.revision.counter),
      ...Object.values(config.appearance).map((item) => item.revision.counter),
      ...metadata.tombstones.map((item) => item.revision.counter),
    ];
    identity.counter = Math.max(identity.counter, ...observedCounters);
    await transaction.objectStore('settings').put(identity, 'deviceIdentity');
    if (!await transaction.objectStore('settings').get('syncMode')) {
      await transaction.objectStore('settings').put('chrome', 'syncMode');
    }
    await transaction.done;
    return clone(config);
  }

  async getPieces(): Promise<Piece[]> {
    return clone(await (await getDatabase()).getAll('pieces'));
  }

  async getSyncReplica(providerId: string): Promise<SyncReplica | undefined> {
    const replica = await (await getDatabase()).get('syncReplicas', providerId);
    return replica ? clone(replica) : undefined;
  }

  async putSyncReplica(replica: SyncReplica): Promise<void> {
    await (await getDatabase()).put('syncReplicas', clone(replica));
    this.emit();
  }

  async putPieces(pieces: Piece[]): Promise<void> {
    validatePieceSet(pieces);
    const database = await getDatabase();
    const transaction = database.transaction(['pieces', 'outbox', 'settings', 'config'], 'readwrite');
    const identity = await this.requireIdentity(transaction.objectStore('settings'));
    const config = await this.requireConfig(transaction.objectStore('config'));
    const current = await transaction.objectStore('pieces').getAll();
    const currentById = new Map(current.map((piece) => [piece.id, piece]));
    await transaction.objectStore('pieces').clear();
    for (const original of pieces) {
      const previous = currentById.get(original.id);
      const piece = clone(original);
      if (!previous || JSON.stringify(previous.position) !== JSON.stringify(piece.position) || JSON.stringify(previous.container) !== JSON.stringify(piece.container) || previous.sizePreset !== piece.sizePreset) {
        piece.revision = nextRevision(identity, previous?.revision ?? piece.revision);
        await transaction.objectStore('outbox').put(outboxEntry('piece', piece.id, piece.revision, 'upsert'));
      }
      await transaction.objectStore('pieces').put(piece);
    }
    mirrorPiecePositions(config, pieces);
    config.updatedAt = new Date().toISOString();
    await transaction.objectStore('config').put(config, 'current');
    await transaction.objectStore('settings').put(identity, 'deviceIdentity');
    await transaction.done;
    this.emit();
  }

  async createPiece(piece: Piece): Promise<void> {
    const pieces = await this.getPieces();
    if (pieces.some((item) => item.id === piece.id)) throw new Error('PIECE_ALREADY_EXISTS');
    await this.putPieces([...pieces, piece]);
  }

  async movePiece(id: string, position: PiecePosition): Promise<void> {
    const pieces = await this.getPieces();
    const piece = pieces.find((item) => item.id === id);
    if (!piece) throw new Error('PIECE_NOT_FOUND');
    piece.position = { ...position };
    await this.putPieces(pieces);
  }

  async resizePiece(id: string, position: PiecePosition, sizePreset?: Piece['sizePreset']): Promise<void> {
    const pieces = await this.getPieces();
    const piece = pieces.find((item) => item.id === id);
    if (!piece) throw new Error('PIECE_NOT_FOUND');
    piece.position = { ...position };
    piece.sizePreset = sizePreset;
    await this.putPieces(pieces);
  }

  async hidePiece(id: string): Promise<void> {
    const pieces = await this.getPieces();
    const piece = pieces.find((item) => item.id === id);
    if (!piece) throw new Error('PIECE_NOT_FOUND');
    piece.container = { kind: 'hidden' };
    await this.putPieces(pieces);
  }

  async restorePiece(id: string): Promise<void> {
    const pieces = await this.getPieces();
    const piece = pieces.find((item) => item.id === id);
    if (!piece) throw new Error('PIECE_NOT_FOUND');
    piece.container = { kind: 'desktop' };
    if (!piece.position) piece.position = { x: -2, y: 0, width: 4, height: 3 };
    await this.putPieces(pieces);
  }

  async movePieceIntoFolder(id: string, folderPieceId: string): Promise<void> {
    const pieces = await this.getPieces();
    const piece = pieces.find((item) => item.id === id);
    if (!piece) throw new Error('PIECE_NOT_FOUND');
    if (piece.kind !== 'shortcut') throw new Error('ONLY_SHORTCUTS_CAN_ENTER_FOLDER');
    if (!pieces.some((item) => item.id === folderPieceId && item.kind === 'folder' && item.container.kind === 'desktop')) throw new Error('FOLDER_NOT_FOUND');
    piece.container = { kind: 'folder', folderPieceId };
    delete piece.position;
    await this.putPieces(pieces);
  }

  async movePieceOutOfFolder(id: string, position: PiecePosition): Promise<void> {
    const pieces = await this.getPieces();
    const piece = pieces.find((item) => item.id === id);
    if (!piece) throw new Error('PIECE_NOT_FOUND');
    piece.container = { kind: 'desktop' };
    piece.position = { ...position };
    await this.putPieces(pieces);
  }

  async deletePiece(id: string): Promise<void> {
    const pieces = await this.getPieces();
    if (id === 'piece:add-shortcut') throw new Error('PIECE_CANNOT_BE_DELETED');
    const folder = pieces.find((item) => item.id === id && item.kind === 'folder');
    if (folder && pieces.some((item) => item.container.kind === 'folder' && item.container.folderPieceId === folder.id)) throw new Error('FOLDER_NOT_EMPTY');
    await this.putPieces(pieces.filter((item) => item.id !== id));
  }

  async commitPieceLayout(snapshot: PieceSnapshot, pieces: Piece[]): Promise<void> {
    validatePieceSet(pieces);
    const database = await getDatabase();
    const transaction = database.transaction(['pieces', 'outbox', 'settings', 'config'], 'readwrite');
    const current = await transaction.objectStore('pieces').getAll();
    if (pieceFingerprint(current) !== snapshot.fingerprint) {
      transaction.abort();
      throw new Error('DESKTOP_STALE');
    }
    const identity = await this.requireIdentity(transaction.objectStore('settings'));
    const config = await this.requireConfig(transaction.objectStore('config'));
    const currentById = new Map(current.map((piece) => [piece.id, piece]));
    await transaction.objectStore('pieces').clear();
    for (const original of pieces) {
      const previous = currentById.get(original.id);
      const piece = clone(original);
      if (!previous || JSON.stringify(previous.position) !== JSON.stringify(piece.position) || JSON.stringify(previous.container) !== JSON.stringify(piece.container) || previous.sizePreset !== piece.sizePreset) {
        piece.revision = nextRevision(identity, previous?.revision ?? piece.revision);
        await transaction.objectStore('outbox').put(outboxEntry('piece', piece.id, piece.revision, 'upsert'));
      }
      await transaction.objectStore('pieces').put(piece);
    }
    mirrorPiecePositions(config, pieces);
    config.updatedAt = new Date().toISOString();
    await transaction.objectStore('config').put(config, 'current');
    await transaction.objectStore('settings').put(identity, 'deviceIdentity');
    await transaction.done;
    this.emit();
  }

  async getConfig(): Promise<AppConfig> {
    const config = await (await getDatabase()).get('config', 'current');
    return config ? clone(config) : this.initialize();
  }

  async getAppStateSnapshot(): Promise<AppStateSnapshot> {
    const database = await getDatabase();
    const transaction = database.transaction(['config', 'pieces', 'settings'], 'readonly');
    const config = await this.requireConfig(transaction.objectStore('config'));
    const pieces = await transaction.objectStore('pieces').getAll();
    const syncMode = await transaction.objectStore('settings').get('syncMode') as SyncMode | undefined;
    await transaction.done;
    return { config: clone(config), pieces: clone(pieces), syncMode: syncMode ?? 'chrome' };
  }

  async getMetadata(): Promise<SyncMetadata> {
    return clone(await (await getDatabase()).get('metadata', 'current') ?? { tombstones: [] });
  }

  async getOutbox(): Promise<OutboxEntry[]> {
    return clone(await (await getDatabase()).getAll('outbox'));
  }

  async addGroup(name: string, position?: WidgetPosition): Promise<ShortcutGroup> {
    const normalizedName = validateName(name, 80);
    const database = await getDatabase();
    const transaction = database.transaction(['config', 'outbox', 'settings', 'pieces'], 'readwrite');
    const config = await this.requireConfig(transaction.objectStore('config'));
    const identity = await this.requireIdentity(transaction.objectStore('settings'));
    const revision = nextRevision(identity);
    const last = [...config.groups].sort(compareBySortKey).at(-1);
    const snapshot = buildDesktopSnapshot(config);
    const addPosition = shortcutInsertionPosition(config, snapshot);
    const desktopPosition = position ?? nearestPieceDesktopVacancy(snapshot, addPosition);
    const group: ShortcutGroup = {
      id: crypto.randomUUID(),
      name: normalizedName,
      collapsed: false,
      sortKey: generateKeyBetween(last?.sortKey ?? null, null),
      position: desktopPosition,
      revision,
    };
    config.groups.push(group);
    const folderPiece: Piece = {
      id: `piece:folder:${group.id}`, kind: 'folder', payloadRef: group.id, container: { kind: 'desktop' },
      position: widgetPositionToPiece(desktopPosition), revision,
    };
    await transaction.objectStore('pieces').put(folderPiece);
    const placed = executePieceDesktopCommand(buildDesktopSnapshot(config), { type: 'move', key: `folder:${group.id}`, target: desktopPosition });
    const placements = desktopPlacements(placed.items);
    const placementOutbox = applyPlacementData(config, placements, identity);
    const currentPieces = await transaction.objectStore('pieces').getAll();
    const nextPieces = applyDesktopPlacementsToPieces(currentPieces, placements);
    const pieceOutboxIds = new Set<string>();
    config.updatedAt = new Date().toISOString();
    await transaction.objectStore('config').put(config, 'current');
    await transaction.objectStore('settings').put(identity, 'deviceIdentity');
    await transaction.objectStore('outbox').put(outboxEntry('group', group.id, group.revision, 'upsert'));
    for (const piece of nextPieces) {
      const previous = currentPieces.find((item) => item.id === piece.id);
      if (!previous || JSON.stringify(previous.position) !== JSON.stringify(piece.position)) {
        piece.revision = nextRevision(identity, previous?.revision ?? piece.revision);
        await transaction.objectStore('pieces').put(piece);
        await transaction.objectStore('outbox').put(outboxEntry('piece', piece.id, piece.revision, 'upsert'));
        pieceOutboxIds.add(piece.id);
      }
    }
    if (!pieceOutboxIds.has(folderPiece.id)) await transaction.objectStore('outbox').put(outboxEntry('piece', folderPiece.id, folderPiece.revision, 'upsert'));
    for (const entry of placementOutbox) await transaction.objectStore('outbox').put(entry);
    await transaction.done;
    this.emit();
    return clone(group);
  }

  async updateGroup(id: string, patch: Pick<ShortcutGroup, 'name' | 'collapsed'>): Promise<void> {
    const database = await getDatabase();
    const transaction = database.transaction(['config', 'outbox', 'settings', 'pieces'], 'readwrite');
    const config = await this.requireConfig(transaction.objectStore('config'));
    const identity = await this.requireIdentity(transaction.objectStore('settings'));
    const group = config.groups.find((item) => item.id === id);
    if (!group) throw new Error('GROUP_NOT_FOUND');
    group.name = validateName(patch.name, 80);
    group.collapsed = patch.collapsed;
    group.revision = nextRevision(identity, group.revision);
    config.updatedAt = new Date().toISOString();
    await transaction.objectStore('config').put(config, 'current');
    await transaction.objectStore('settings').put(identity, 'deviceIdentity');
    await transaction.objectStore('outbox').put(outboxEntry('group', id, group.revision, 'upsert'));
    await transaction.done;
    this.emit();
  }

  async deleteGroup(id: string): Promise<void> {
    if (id === DEFAULT_GROUP_ID) throw new Error('DEFAULT_GROUP_CANNOT_BE_DELETED');
    const database = await getDatabase();
    const transaction = database.transaction(['config', 'metadata', 'outbox', 'settings', 'pieces'], 'readwrite');
    const config = await this.requireConfig(transaction.objectStore('config'));
    const metadata = await transaction.objectStore('metadata').get('current') ?? { tombstones: [] };
    const identity = await this.requireIdentity(transaction.objectStore('settings'));
    const group = config.groups.find((item) => item.id === id);
    if (!group) throw new Error('GROUP_NOT_FOUND');
    if (config.shortcuts.some((item) => item.groupId === id)) throw new Error('FOLDER_NOT_EMPTY');
    const deletionRevision = nextRevision(identity, group.revision);
    config.groups = config.groups.filter((item) => item.id !== id);
    await transaction.objectStore('pieces').delete(`piece:folder:${id}`);
    metadata.tombstones = metadata.tombstones.filter((item) => !(item.entityType === 'group' && item.entityId === id));
    metadata.tombstones.push({ entityType: 'group', entityId: id, revision: deletionRevision });
    config.updatedAt = new Date().toISOString();
    await transaction.objectStore('config').put(config, 'current');
    await transaction.objectStore('metadata').put(metadata, 'current');
    await transaction.objectStore('settings').put(identity, 'deviceIdentity');
    await transaction.objectStore('outbox').put(outboxEntry('group', id, deletionRevision, 'delete'));
    this.faultInjector?.('deleteGroup', transaction);
    await transaction.done;
    this.emit();
  }

  async addShortcut(input: ShortcutInput & { position?: WidgetPosition }): Promise<Shortcut> {
    const normalizedName = validateName(input.name, 120);
    const database = await getDatabase();
    const transaction = database.transaction(['config', 'outbox', 'settings', 'pieces'], 'readwrite');
    const config = await this.requireConfig(transaction.objectStore('config'));
    const identity = await this.requireIdentity(transaction.objectStore('settings'));
    if (!config.groups.some((group) => group.id === input.groupId)) throw new Error('GROUP_NOT_FOUND');
    const siblings = config.shortcuts.filter((item) => item.groupId === input.groupId).sort(compareBySortKey);
    const revision = nextRevision(identity);
    const snapshot = buildDesktopSnapshot(config);
    const desktopPosition = input.groupId === DEFAULT_GROUP_ID
      ? input.position ?? shortcutInsertionPosition(config, snapshot)
      : undefined;
    const shortcut: Shortcut = {
      id: crypto.randomUUID(),
      name: normalizedName,
      url: normalizeShortcutUrl(input.url),
      groupId: input.groupId,
      sortKey: generateKeyBetween(siblings.at(-1)?.sortKey ?? null, null),
      ...(desktopPosition ? { position: desktopPosition } : {}),
      revision,
    };
    config.shortcuts.push(shortcut);
    const shortcutPiece: Piece = {
      id: `piece:shortcut:${shortcut.id}`, kind: 'shortcut', payloadRef: shortcut.id,
      container: desktopPosition ? { kind: 'desktop' } : { kind: 'folder', folderPieceId: `piece:folder:${input.groupId}` },
      ...(desktopPosition ? { position: widgetPositionToPiece(desktopPosition) } : {}), revision,
    };
    await transaction.objectStore('pieces').put(shortcutPiece);
    let placementOutbox: OutboxEntry[] = [];
    if (desktopPosition) {
      const placed = executePieceDesktopCommand(snapshot, { type: 'insert', node: {
        kind: 'shortcut', key: `shortcut:${shortcut.id}`, entity: shortcut, movable: true, revision,
        container: { kind: 'desktop' }, position: desktopPosition,
      } });
      const placements = desktopPlacements(placed.items);
      placementOutbox = applyPlacementData(config, placements, identity);
      const currentPieces = await transaction.objectStore('pieces').getAll();
      const nextPieces = applyDesktopPlacementsToPieces(currentPieces, placements);
      const pieceOutboxIds = new Set<string>();
      for (const piece of nextPieces) {
        const previous = currentPieces.find((item) => item.id === piece.id);
        if (!previous || JSON.stringify(previous.position) !== JSON.stringify(piece.position)) {
          piece.revision = nextRevision(identity, previous?.revision ?? piece.revision);
          await transaction.objectStore('pieces').put(piece);
          await transaction.objectStore('outbox').put(outboxEntry('piece', piece.id, piece.revision, 'upsert'));
          pieceOutboxIds.add(piece.id);
        }
      }
      if (!pieceOutboxIds.has(shortcutPiece.id)) await transaction.objectStore('outbox').put(outboxEntry('piece', shortcutPiece.id, shortcutPiece.revision, 'upsert'));
    }
    config.updatedAt = new Date().toISOString();
    await transaction.objectStore('config').put(config, 'current');
    await transaction.objectStore('settings').put(identity, 'deviceIdentity');
    await transaction.objectStore('outbox').put(outboxEntry('shortcut', shortcut.id, revision, 'upsert'));
    for (const entry of placementOutbox) await transaction.objectStore('outbox').put(entry);
    await transaction.done;
    this.emit();
    return clone(shortcut);
  }

  async updateShortcut(id: string, input: ShortcutInput): Promise<void> {
    const database = await getDatabase();
    const transaction = database.transaction(['config', 'outbox', 'settings', 'pieces', 'assets'], 'readwrite');
    const config = await this.requireConfig(transaction.objectStore('config'));
    const identity = await this.requireIdentity(transaction.objectStore('settings'));
    const shortcut = config.shortcuts.find((item) => item.id === id);
    if (!shortcut) throw new Error('SHORTCUT_NOT_FOUND');
    if (!config.groups.some((group) => group.id === input.groupId)) throw new Error('GROUP_NOT_FOUND');
    shortcut.name = validateName(input.name, 120);
    const nextUrl = normalizeShortcutUrl(input.url);
    const urlChanged = shortcut.url !== nextUrl;
    shortcut.url = nextUrl;
    if (urlChanged) await transaction.objectStore('assets').delete(shortcutIconAssetKey(id));
    const previousGroupId = shortcut.groupId;
    shortcut.groupId = input.groupId;
    if (input.groupId !== DEFAULT_GROUP_ID) delete shortcut.position;
    if (previousGroupId !== input.groupId && input.groupId === DEFAULT_GROUP_ID) {
      const before = buildDesktopSnapshot({ ...config, shortcuts: config.shortcuts.map((item) => item.id === id ? { ...item, groupId: previousGroupId } : item) });
      shortcut.position = shortcutInsertionPosition(config, before);
      const placed = executePieceDesktopCommand(buildDesktopSnapshot(config), { type: 'move', key: `shortcut:${id}`, target: shortcut.position });
      for (const entry of applyPlacementData(config, desktopPlacements(placed.items), identity)) await transaction.objectStore('outbox').put(entry);
    }
    shortcut.revision = nextRevision(identity, shortcut.revision);
    const piece = await transaction.objectStore('pieces').get(`piece:shortcut:${id}`);
    if (piece) {
      piece.container = input.groupId === DEFAULT_GROUP_ID ? { kind: 'desktop' } : { kind: 'folder', folderPieceId: `piece:folder:${input.groupId}` };
      if (input.groupId === DEFAULT_GROUP_ID && shortcut.position) piece.position = widgetPositionToPiece(shortcut.position);
      else delete piece.position;
      piece.revision = shortcut.revision;
      await transaction.objectStore('pieces').put(piece);
      await transaction.objectStore('outbox').put(outboxEntry('piece', piece.id, piece.revision, 'upsert'));
    }
    config.updatedAt = new Date().toISOString();
    await transaction.objectStore('config').put(config, 'current');
    await transaction.objectStore('settings').put(identity, 'deviceIdentity');
    await transaction.objectStore('outbox').put(outboxEntry('shortcut', id, shortcut.revision, 'upsert'));
    await transaction.done;
    this.emit();
  }

  async moveShortcut(id: string, groupId: string, beforeId?: string, afterId?: string, position?: WidgetPosition, commit?: DesktopCommit | FolderShortcutDesktopDropPlan): Promise<AppStateSnapshot> {
    return this.enqueueShortcutMove(() => this.moveShortcutAtomically(id, groupId, beforeId, afterId, position, commit));
  }

  private enqueueShortcutMove<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.shortcutMoveTail.then(operation, operation);
    this.shortcutMoveTail = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private async moveShortcutAtomically(id: string, groupId: string, beforeId?: string, afterId?: string, position?: WidgetPosition, commit?: DesktopCommit | FolderShortcutDesktopDropPlan): Promise<AppStateSnapshot> {
    const database = await getDatabase();
    const transaction = database.transaction(['config', 'outbox', 'settings', 'pieces'], 'readwrite');
    const config = await this.requireConfig(transaction.objectStore('config'));
    const identity = await this.requireIdentity(transaction.objectStore('settings'));
    const shortcut = config.shortcuts.find((item) => item.id === id);
    if (!shortcut) throw new Error('SHORTCUT_NOT_FOUND');
    if (!config.groups.some((group) => group.id === groupId)) throw new Error('GROUP_NOT_FOUND');
    const destination = config.shortcuts.filter((item) => item.id !== id && item.groupId === groupId).sort(compareBySortKey);
    const append = !beforeId && !afterId;
    const before = beforeId ? config.shortcuts.find((item) => item.id === beforeId)?.sortKey ?? null : append ? destination.at(-1)?.sortKey ?? null : null;
    const after = afterId ? config.shortcuts.find((item) => item.id === afterId)?.sortKey ?? null : null;
    const beforeSnapshot = buildDesktopSnapshot(config);
    if (commit && !isFolderShortcutDesktopDropPlan(commit) && commit.fingerprint !== beforeSnapshot.fingerprint) throw new Error('DESKTOP_STALE');
    const changedContainer = shortcut.groupId !== groupId;
    if (groupId === DEFAULT_GROUP_ID && (changedContainer || position)) {
      shortcut.position = position ?? shortcutInsertionPosition(config, beforeSnapshot);
    } else if (groupId !== DEFAULT_GROUP_ID) delete shortcut.position;
    shortcut.groupId = groupId;
    const generatedSortKey = generateKeyBetween(before, after);
    const folderDropPlan = isFolderShortcutDesktopDropPlan(commit) && commit.sortKey === generatedSortKey ? commit : undefined;
    shortcut.sortKey = folderDropPlan?.sortKey ?? generatedSortKey;
    shortcut.revision = nextRevision(identity, shortcut.revision);
    const piece = await transaction.objectStore('pieces').get(`piece:shortcut:${id}`);
    if (piece) {
      piece.container = groupId === DEFAULT_GROUP_ID ? { kind: 'desktop' } : { kind: 'folder', folderPieceId: `piece:folder:${groupId}` };
      if (groupId === DEFAULT_GROUP_ID && shortcut.position) piece.position = widgetPositionToPiece(shortcut.position);
      else delete piece.position;
      piece.revision = shortcut.revision;
      await transaction.objectStore('pieces').put(piece);
      await transaction.objectStore('outbox').put(outboxEntry('piece', piece.id, piece.revision, 'upsert'));
    }
    if (changedContainer && groupId === DEFAULT_GROUP_ID) {
      const postSnapshot = buildDesktopSnapshot(config);
      const trustedFolderDropPlan = folderDropPlan?.postTransitionLayoutFingerprint === desktopLayoutFingerprint(postSnapshot.nodes)
        ? folderDropPlan
        : undefined;
      const placements = trustedFolderDropPlan?.placements
        ?? (!isFolderShortcutDesktopDropPlan(commit) ? commit?.placements : undefined)
        ?? desktopPlacements(executePieceDesktopCommand(postSnapshot, { type: 'move', key: `shortcut:${id}`, target: shortcut.position! }).items);
      validateCommitAgainstSnapshot(postSnapshot, placements, isFolderShortcutDesktopDropPlan(commit) ? undefined : commit?.collisionGeometry);
      for (const entry of applyPlacementData(config, placements, identity)) await transaction.objectStore('outbox').put(entry);
      // A folder member can displace more than its own desktop slot. Keep the
      // Piece layout truth in lockstep with the placement projection just as
      // shortcut and folder creation already do.
      const currentPieces = await transaction.objectStore('pieces').getAll();
      const nextPieces = applyDesktopPlacementsToPieces(currentPieces, placements);
      validatePieceSet(nextPieces);
      for (const nextPiece of nextPieces) {
        const previousPiece = currentPieces.find((item) => item.id === nextPiece.id);
        if (!previousPiece || JSON.stringify(previousPiece.position) === JSON.stringify(nextPiece.position)) continue;
        nextPiece.revision = nextRevision(identity, previousPiece.revision ?? nextPiece.revision);
        await transaction.objectStore('pieces').put(nextPiece);
        await transaction.objectStore('outbox').put(outboxEntry('piece', nextPiece.id, nextPiece.revision, 'upsert'));
      }
    }
    if (shortcut.sortKey.length > 32) {
      const siblings = config.shortcuts.filter((item) => item.groupId === groupId).sort(compareBySortKey);
      const keys = generateNKeysBetween(null, null, siblings.length);
      for (const [index, sibling] of siblings.entries()) {
        sibling.sortKey = keys[index]!;
        sibling.revision = nextRevision(identity, sibling.revision);
        await transaction.objectStore('outbox').put(outboxEntry('shortcut', sibling.id, sibling.revision, 'upsert'));
      }
    }
    config.updatedAt = new Date().toISOString();
    await transaction.objectStore('config').put(config, 'current');
    await transaction.objectStore('settings').put(identity, 'deviceIdentity');
    await transaction.objectStore('outbox').put(outboxEntry('shortcut', id, shortcut.revision, 'upsert'));
    const finalPieces = await transaction.objectStore('pieces').getAll();
    const syncMode = await transaction.objectStore('settings').get('syncMode') as SyncMode | undefined;
    await transaction.done;
    this.emit();
    return { config: clone(config), pieces: clone(finalPieces), syncMode: syncMode ?? 'chrome' };
  }

  async moveGroup(id: string, beforeId?: string, afterId?: string): Promise<void> {
    const database = await getDatabase();
    const transaction = database.transaction(['config', 'outbox', 'settings'], 'readwrite');
    const config = await this.requireConfig(transaction.objectStore('config'));
    const identity = await this.requireIdentity(transaction.objectStore('settings'));
    const group = config.groups.find((item) => item.id === id);
    if (!group) throw new Error('GROUP_NOT_FOUND');
    const before = beforeId ? config.groups.find((item) => item.id === beforeId)?.sortKey ?? null : null;
    const after = afterId ? config.groups.find((item) => item.id === afterId)?.sortKey ?? null : null;
    group.sortKey = generateKeyBetween(before, after);
    group.revision = nextRevision(identity, group.revision);
    if (group.sortKey.length > 32) {
      const groups = config.groups.sort(compareBySortKey);
      const keys = generateNKeysBetween(null, null, groups.length);
      for (const [index, item] of groups.entries()) {
        item.sortKey = keys[index]!;
        item.revision = nextRevision(identity, item.revision);
        await transaction.objectStore('outbox').put(outboxEntry('group', item.id, item.revision, 'upsert'));
      }
    }
    config.updatedAt = new Date().toISOString();
    await transaction.objectStore('config').put(config, 'current');
    await transaction.objectStore('settings').put(identity, 'deviceIdentity');
    await transaction.objectStore('outbox').put(outboxEntry('group', id, group.revision, 'upsert'));
    await transaction.done;
    this.emit();
  }

  async deleteShortcut(id: string): Promise<void> {
    const database = await getDatabase();
    const transaction = database.transaction(['config', 'metadata', 'outbox', 'settings', 'pieces', 'assets'], 'readwrite');
    const config = await this.requireConfig(transaction.objectStore('config'));
    const metadata = await transaction.objectStore('metadata').get('current') ?? { tombstones: [] };
    const identity = await this.requireIdentity(transaction.objectStore('settings'));
    const shortcut = config.shortcuts.find((item) => item.id === id);
    if (!shortcut) throw new Error('SHORTCUT_NOT_FOUND');
    const revision = nextRevision(identity, shortcut.revision);
    config.shortcuts = config.shortcuts.filter((item) => item.id !== id);
    await transaction.objectStore('pieces').delete(`piece:shortcut:${id}`);
    await transaction.objectStore('assets').delete(shortcutIconAssetKey(id));
    metadata.tombstones = metadata.tombstones.filter((item) => !(item.entityType === 'shortcut' && item.entityId === id));
    metadata.tombstones.push({ entityType: 'shortcut', entityId: id, revision });
    config.updatedAt = new Date().toISOString();
    await transaction.objectStore('config').put(config, 'current');
    await transaction.objectStore('metadata').put(metadata, 'current');
    await transaction.objectStore('settings').put(identity, 'deviceIdentity');
    await transaction.objectStore('outbox').put(outboxEntry('shortcut', id, revision, 'delete'));
    this.faultInjector?.('deleteShortcut', transaction);
    await transaction.done;
    this.emit();
  }

  async commitDesktopResult(commit: DesktopCommit): Promise<void> {
    const database = await getDatabase();
    const transaction = database.transaction(['config', 'outbox', 'settings'], 'readwrite');
    const config = await this.requireConfig(transaction.objectStore('config'));
    const identity = await this.requireIdentity(transaction.objectStore('settings'));
    const snapshot = buildDesktopSnapshot(config);
    if (snapshot.fingerprint !== commit.fingerprint) throw new Error('DESKTOP_STALE');
    validateCommitAgainstSnapshot(snapshot, commit.placements, commit.collisionGeometry);
    for (const entry of applyPlacementData(config, commit.placements, identity)) await transaction.objectStore('outbox').put(entry);
    config.updatedAt = new Date().toISOString();
    await transaction.objectStore('config').put(config, 'current');
    await transaction.objectStore('settings').put(identity, 'deviceIdentity');
    this.faultInjector?.('commitDesktopResult', transaction);
    await transaction.done;
    this.emit();
  }

  async setWidgetEnabled(id: ConfigurableWidgetId, enabled: boolean): Promise<void> {
    const database = await getDatabase();
    const transaction = database.transaction(['config', 'outbox', 'settings', 'pieces'], 'readwrite');
    const config = await this.requireConfig(transaction.objectStore('config'));
    const identity = await this.requireIdentity(transaction.objectStore('settings'));
    const widget = config.appearance.widgetLayout.value.find((item) => item.id === id);
    if (!widget) throw new Error('WIDGET_NOT_FOUND');
    if (widget.enabled === enabled) { await transaction.done; return; }
    const previousRevision = config.appearance.widgetLayout.revision;
    if (enabled) {
      // Compute from the pre-enable snapshot so this hidden item cannot block
      // itself. Enabling must never displace existing desktop items.
      const snapshot = buildDesktopSnapshot(config);
      const key = id === 'addShortcut' ? 'add-shortcut' : `widget:${id}`;
      const node = snapshot.nodes.find((item) => item.key === key);
      if (!node?.position) throw new Error('WIDGET_POSITION_NOT_FOUND');
      widget.position = nearestPieceDesktopVacancy(snapshot, node.position, node.position);
    }
    widget.enabled = enabled;
    const pieceEntries = await syncWidgetPieces(transaction.objectStore('pieces'), config, identity);
    for (const entry of pieceEntries) await transaction.objectStore('outbox').put(entry);
    if (config.appearance.widgetLayout.revision === previousRevision) {
      config.appearance.widgetLayout.revision = nextRevision(identity, previousRevision);
      await transaction.objectStore('outbox').put(outboxEntry('appearance', 'widgetLayout', config.appearance.widgetLayout.revision, 'upsert'));
    }
    config.updatedAt = new Date().toISOString();
    await transaction.objectStore('config').put(config, 'current');
    await transaction.objectStore('settings').put(identity, 'deviceIdentity');
    await transaction.done;
    this.emit();
  }

  async updateAppearance<K extends keyof AppConfig['appearance']>(key: K, value: AppConfig['appearance'][K]['value']): Promise<void> {
    const database = await getDatabase();
    const transaction = database.transaction(['config', 'outbox', 'settings', 'pieces'], 'readwrite');
    const config = await this.requireConfig(transaction.objectStore('config'));
    const identity = await this.requireIdentity(transaction.objectStore('settings'));
    const current = config.appearance[key];
    const revision = nextRevision(identity, current.revision);
    config.appearance[key] = { value, revision } as AppConfig['appearance'][K];
    const pieceEntries = await syncWidgetPieces(transaction.objectStore('pieces'), config, identity);
    for (const entry of pieceEntries) await transaction.objectStore('outbox').put(entry);
    const desktopEntries: OutboxEntry[] = [];
    if (key === 'search') {
      const snapshot = buildDesktopSnapshot(config);
      const search = desktopItems(snapshot).find((item) => item.kind === 'system-widget' && item.id === 'search');
      if (search) desktopEntries.push(...applyPlacementData(config, desktopPlacements(executePieceDesktopCommand(snapshot, { type: 'move', key: search.key, target: search.position }).items), identity));
    } else if (key === 'widgetLayout') {
      desktopEntries.push(...applyPlacementData(config, desktopPlacements(executePieceDesktopCommand(buildDesktopSnapshot(config), { type: 'repair' }).items), identity));
    }
    config.updatedAt = new Date().toISOString();
    await transaction.objectStore('config').put(config, 'current');
    await transaction.objectStore('settings').put(identity, 'deviceIdentity');
    if (!(key === 'wallpaper' && (value as Wallpaper).type === 'upload')) {
      await transaction.objectStore('outbox').put(outboxEntry('appearance', key, config.appearance[key].revision, 'upsert'));
    }
    for (const entry of desktopEntries) await transaction.objectStore('outbox').put(entry);
    await transaction.done;
    this.emit();
  }

  async setWallpaper(wallpaper: Wallpaper): Promise<void> {
    return this.updateAppearance('wallpaper', wallpaper);
  }

  async setSolidWallpaper(color: string): Promise<void> {
    const database = await getDatabase();
    const transaction = database.transaction(['config', 'outbox', 'settings'], 'readwrite');
    const config = await this.requireConfig(transaction.objectStore('config'));
    const identity = await this.requireIdentity(transaction.objectStore('settings'));
    const shouldUpdateColor = config.appearance.solidColor.value !== color;
    const shouldUpdateWallpaper = config.appearance.wallpaper.value.type !== 'solid' || config.appearance.wallpaper.value.color !== color;
    if (!shouldUpdateColor && !shouldUpdateWallpaper) { await transaction.done; return; }
    if (shouldUpdateColor) {
      config.appearance.solidColor = { value: color, revision: nextRevision(identity, config.appearance.solidColor.revision) };
      await transaction.objectStore('outbox').put(outboxEntry('appearance', 'solidColor', config.appearance.solidColor.revision, 'upsert'));
    }
    if (shouldUpdateWallpaper) {
      config.appearance.wallpaper = { value: { type: 'solid', color }, revision: nextRevision(identity, config.appearance.wallpaper.revision) };
      await transaction.objectStore('outbox').put(outboxEntry('appearance', 'wallpaper', config.appearance.wallpaper.revision, 'upsert'));
    }
    config.updatedAt = new Date().toISOString();
    await transaction.objectStore('config').put(config, 'current');
    await transaction.objectStore('settings').put(identity, 'deviceIdentity');
    await transaction.done;
    this.emit();
  }

  async getRandomWallpaperState(): Promise<RandomWallpaperState | undefined> {
    const value = await (await getDatabase()).get('settings', 'randomWallpaper');
    return isRandomWallpaperState(value) ? clone(value) : undefined;
  }

  async saveRandomWallpaperState(state: RandomWallpaperState, blob: Blob): Promise<void> {
    const database = await getDatabase();
    const transaction = database.transaction(['settings', 'assets'], 'readwrite');
    await transaction.objectStore('settings').put(clone(state), 'randomWallpaper');
    await transaction.objectStore('assets').put({ key: RANDOM_WALLPAPER_ASSET_KEY, blob, updatedAt: state.updatedAt, sourceUrl: state.imageUrl });
    await transaction.objectStore('settings').delete('randomWallpaperNext');
    await transaction.objectStore('assets').delete(RANDOM_WALLPAPER_NEXT_ASSET_KEY);
    await transaction.done;
    this.emit();
  }

  async getPreparedRandomWallpaperState(): Promise<PreparedRandomWallpaperState | undefined> {
    const value = await (await getDatabase()).get('settings', 'randomWallpaperNext');
    return isPreparedRandomWallpaperState(value) ? clone(value) : undefined;
  }

  async savePreparedRandomWallpaperState(state: PreparedRandomWallpaperState, blob: Blob): Promise<void> {
    const database = await getDatabase();
    const transaction = database.transaction(['settings', 'assets'], 'readwrite');
    await transaction.objectStore('settings').put(clone(state), 'randomWallpaperNext');
    await transaction.objectStore('assets').put({ key: RANDOM_WALLPAPER_NEXT_ASSET_KEY, blob, updatedAt: state.preparedAt, sourceUrl: state.imageUrl });
    await transaction.done;
    this.emit();
  }

  async promotePreparedRandomWallpaperState(now = new Date()): Promise<RandomWallpaperState | undefined> {
    const database = await getDatabase();
    const transaction = database.transaction(['settings', 'assets'], 'readwrite');
    const current = await transaction.objectStore('settings').get('randomWallpaper');
    const prepared = await transaction.objectStore('settings').get('randomWallpaperNext');
    const asset = await transaction.objectStore('assets').get(RANDOM_WALLPAPER_NEXT_ASSET_KEY);
    if (!isRandomWallpaperState(current) || !isPreparedRandomWallpaperState(prepared) || prepared.currentWallpaperId !== current.wallpaperId || !asset) {
      await transaction.done;
      return undefined;
    }
    const next = nextRandomWallpaperState(prepared, current.interval, now);
    await transaction.objectStore('settings').put(clone(next), 'randomWallpaper');
    await transaction.objectStore('assets').put({ key: RANDOM_WALLPAPER_ASSET_KEY, blob: asset.blob, updatedAt: next.updatedAt, sourceUrl: next.imageUrl });
    await transaction.objectStore('settings').delete('randomWallpaperNext');
    await transaction.objectStore('assets').delete(RANDOM_WALLPAPER_NEXT_ASSET_KEY);
    await transaction.done;
    this.emit();
    return next;
  }

  async updateRandomWallpaperState(state: RandomWallpaperState): Promise<void> {
    const database = await getDatabase();
    const transaction = database.transaction(['settings', 'assets'], 'readwrite');
    await transaction.objectStore('settings').put(clone(state), 'randomWallpaper');
    await transaction.objectStore('settings').delete('randomWallpaperNext');
    await transaction.objectStore('assets').delete(RANDOM_WALLPAPER_NEXT_ASSET_KEY);
    await transaction.done;
    this.emit();
  }

  async clearPreparedRandomWallpaperState(): Promise<void> {
    const database = await getDatabase();
    const transaction = database.transaction(['settings', 'assets'], 'readwrite');
    await transaction.objectStore('settings').delete('randomWallpaperNext');
    await transaction.objectStore('assets').delete(RANDOM_WALLPAPER_NEXT_ASSET_KEY);
    await transaction.done;
    this.emit();
  }

  async clearRandomWallpaperState(): Promise<void> {
    const database = await getDatabase();
    const transaction = database.transaction(['settings', 'assets'], 'readwrite');
    await transaction.objectStore('settings').delete('randomWallpaper');
    await transaction.objectStore('settings').delete('randomWallpaperNext');
    await transaction.objectStore('assets').delete(RANDOM_WALLPAPER_ASSET_KEY);
    await transaction.objectStore('assets').delete(RANDOM_WALLPAPER_NEXT_ASSET_KEY);
    await transaction.done;
    this.emit();
  }

  async getBingWallpaperQuality(): Promise<import('../domain/types').BingWallpaperQuality> {
    const database = await getDatabase();
    const value = await database.get('settings', 'bingWallpaperQuality');
    if (isBingWallpaperQuality(value)) return value;
    if (value !== undefined) {
      await database.put('settings', DEFAULT_BING_WALLPAPER_QUALITY, 'bingWallpaperQuality');
      this.emit();
      return DEFAULT_BING_WALLPAPER_QUALITY;
    }
    const config = await database.get('config', 'current');
    const inherited = config?.appearance.wallpaper.value;
    const quality = inherited?.type === 'bing' || inherited?.type === 'bing-daily'
      ? inherited.quality
      : DEFAULT_BING_WALLPAPER_QUALITY;
    await database.put('settings', quality, 'bingWallpaperQuality');
    this.emit();
    return quality;
  }

  async setBingWallpaperQuality(quality: import('../domain/types').BingWallpaperQuality): Promise<void> {
    if (!isBingWallpaperQuality(quality)) throw new Error('BING_WALLPAPER_QUALITY_INVALID');
    await (await getDatabase()).put('settings', quality, 'bingWallpaperQuality');
    this.emit();
  }

  async getBingDailyState(): Promise<BingDailyState | undefined> {
    const value = await (await getDatabase()).get('settings', 'bingDailyWallpaper');
    const state = normalizeBingDailyState(value);
    return state ? clone(state) : undefined;
  }

  async saveBingDailyState(state: BingDailyState, blob: Blob): Promise<void> {
    const database = await getDatabase();
    const transaction = database.transaction(['settings', 'assets'], 'readwrite');
    await transaction.objectStore('settings').put(clone(state), 'bingDailyWallpaper');
    await transaction.objectStore('assets').put({ key: BING_DAILY_ASSET_KEY, blob, updatedAt: state.updatedAt, sourceUrl: state.imageUrl });
    await transaction.done;
    this.emit();
  }

  async updateBingDailyState(state: BingDailyState): Promise<void> {
    await (await getDatabase()).put('settings', clone(state), 'bingDailyWallpaper');
    this.emit();
  }

  async setUploadedWallpaper(blob: Blob): Promise<void> {
    const database = await getDatabase();
    const transaction = database.transaction(['config', 'assets', 'settings'], 'readwrite');
    const config = await this.requireConfig(transaction.objectStore('config'));
    const identity = await this.requireIdentity(transaction.objectStore('settings'));
    const revision = nextRevision(identity, config.appearance.wallpaper.revision);
    const assetKey = 'wallpaper/upload';
    config.appearance.wallpaper = { value: { type: 'upload', assetKey }, revision };
    config.updatedAt = new Date().toISOString();
    await transaction.objectStore('assets').put({ key: assetKey, blob, updatedAt: new Date().toISOString() });
    await transaction.objectStore('config').put(config, 'current');
    await transaction.objectStore('settings').put(identity, 'deviceIdentity');
    await transaction.done;
    this.emit();
  }

  async replaceFromImport(config: AppConfig, wallpaper?: Blob): Promise<void> {
    const database = await getDatabase();
    const transaction = database.transaction(['config', 'metadata', 'outbox', 'assets', 'settings'], 'readwrite');
    await transaction.objectStore('config').put(config, 'current');
    await transaction.objectStore('metadata').put({ tombstones: [] }, 'current');
    await transaction.objectStore('outbox').clear();
    for (const group of config.groups) await transaction.objectStore('outbox').put(outboxEntry('group', group.id, group.revision, 'upsert'));
    for (const shortcut of config.shortcuts) await transaction.objectStore('outbox').put(outboxEntry('shortcut', shortcut.id, shortcut.revision, 'upsert'));
    for (const [key, value] of Object.entries(config.appearance)) {
      if (key === 'wallpaper' && (value.value as Wallpaper).type === 'upload') continue;
      await transaction.objectStore('outbox').put(outboxEntry('appearance', key, value.revision, 'upsert'));
    }
    const identity = await this.requireIdentity(transaction.objectStore('settings'));
    const revisions = [
      ...config.groups.map((item) => item.revision),
      ...config.shortcuts.map((item) => item.revision),
      ...Object.values(config.appearance).map((item) => item.revision),
    ].filter((revision) => revision.deviceId === identity.deviceId);
    identity.counter = Math.max(identity.counter, ...revisions.map((revision) => revision.counter));
    await transaction.objectStore('settings').put(identity, 'deviceIdentity');
    await transaction.objectStore('settings').delete('randomWallpaperNext');
    await transaction.objectStore('assets').delete(RANDOM_WALLPAPER_NEXT_ASSET_KEY);
    if (wallpaper) {
      const asset: AssetRecord = { key: 'wallpaper/upload', blob: wallpaper, updatedAt: new Date().toISOString() };
      await transaction.objectStore('assets').put(asset);
    }
    await transaction.done;
    this.emit();
  }

  async replaceFromSync(
    config: AppConfig,
    metadata: SyncMetadata,
    identity: DeviceIdentity,
    cursor: ProviderCursor,
    options?: {
      pendingRevision?: OutboxEntry['revision'];
      discardOutbox?: boolean;
      pieces?: Piece[];
      replica?: SyncReplica;
      confirmedOutboxIds?: string[];
    },
  ): Promise<void> {
    const database = await getDatabase();
    const transaction = database.transaction(['config', 'metadata', 'settings', 'cursors', 'outbox', 'pieces', 'syncReplicas'], 'readwrite');
    const migration = migrateDesktopPositions(config);
    const normalized = migration.config;
    for (const id of migration.changedShortcuts) {
      const shortcut = normalized.shortcuts.find((item) => item.id === id)!;
      shortcut.revision = nextRevision(identity, shortcut.revision);
    }
    for (const id of migration.changedGroups) {
      const group = normalized.groups.find((item) => item.id === id)!;
      group.revision = nextRevision(identity, group.revision);
    }
    if (migration.widgetLayoutChanged) {
      normalized.appearance.widgetLayout.revision = nextRevision(identity, normalized.appearance.widgetLayout.revision);
    }
    if (options?.pieces) mirrorPiecePositions(normalized, options.pieces);
    normalized.updatedAt = new Date().toISOString();
    await transaction.objectStore('config').put(normalized, 'current');
    if (options?.pieces) {
      await transaction.objectStore('pieces').clear();
      for (const piece of options.pieces) await transaction.objectStore('pieces').put(clone(piece));
    }
    await transaction.objectStore('metadata').put(metadata, 'current');
    await transaction.objectStore('settings').put(identity, 'deviceIdentity');
    await transaction.objectStore('cursors').put(cursor);
    if (options?.replica) await transaction.objectStore('syncReplicas').put(clone(options.replica));
    if (options?.discardOutbox) await transaction.objectStore('outbox').clear();
    if (options?.confirmedOutboxIds?.length) {
      for (const opId of options.confirmedOutboxIds) await transaction.objectStore('outbox').delete(opId);
    }
    for (const id of migration.changedShortcuts) {
      const shortcut = normalized.shortcuts.find((item) => item.id === id)!;
      await transaction.objectStore('outbox').put(outboxEntry('shortcut', id, shortcut.revision, 'upsert'));
    }
    for (const id of migration.changedGroups) {
      const group = normalized.groups.find((item) => item.id === id)!;
      await transaction.objectStore('outbox').put(outboxEntry('group', id, group.revision, 'upsert'));
    }
    if (migration.widgetLayoutChanged) {
      await transaction.objectStore('outbox').put(outboxEntry('appearance', 'widgetLayout', normalized.appearance.widgetLayout.revision, 'upsert'));
    }
    if (options?.pendingRevision) await transaction.objectStore('outbox').put(outboxEntry('envelope', 'current', options.pendingRevision, 'upsert'));
    await transaction.done;
    this.emit();
  }

  async updateSyncControl(metadata: SyncMetadata, identity: DeviceIdentity, cursor: ProviderCursor): Promise<void> {
    const database = await getDatabase();
    const transaction = database.transaction(['metadata', 'settings', 'cursors'], 'readwrite');
    await transaction.objectStore('metadata').put(metadata, 'current');
    await transaction.objectStore('settings').put(identity, 'deviceIdentity');
    await transaction.objectStore('cursors').put(cursor);
    await transaction.done;
    this.emit();
  }

  async confirmSyncReplica(replica: SyncReplica, confirmedOutboxIds: string[], cursor?: ProviderCursor): Promise<void> {
    const database = await getDatabase();
    const transaction = database.transaction(['syncReplicas', 'outbox', 'cursors'], 'readwrite');
    await transaction.objectStore('syncReplicas').put(clone(replica));
    if (cursor) await transaction.objectStore('cursors').put(cursor);
    for (const opId of confirmedOutboxIds) await transaction.objectStore('outbox').delete(opId);
    await transaction.done;
    this.emit();
  }

  async importExternalSync(remote: AppConfig): Promise<void> {
    const database = await getDatabase();
    const transaction = database.transaction(['config', 'outbox', 'settings'], 'readwrite');
    const config = await this.requireConfig(transaction.objectStore('config'));
    const identity = await this.requireIdentity(transaction.objectStore('settings'));
    const groupIds = new Map<string, string>([[DEFAULT_GROUP_ID, DEFAULT_GROUP_ID]]);
    for (const source of remote.groups.filter((group) => group.id !== DEFAULT_GROUP_ID).sort(compareBySortKey)) {
      const revision = nextRevision(identity);
      const group: ShortcutGroup = { ...source, id: crypto.randomUUID(), revision };
      groupIds.set(source.id, group.id);
      config.groups.push(group);
      await transaction.objectStore('outbox').put(outboxEntry('group', group.id, revision, 'upsert'));
    }
    for (const source of remote.shortcuts.sort(compareBySortKey)) {
      const revision = nextRevision(identity);
      const shortcut: Shortcut = {
        ...source,
        id: crypto.randomUUID(),
        groupId: groupIds.get(source.groupId) ?? DEFAULT_GROUP_ID,
        revision,
      };
      if (shortcut.groupId !== DEFAULT_GROUP_ID) delete shortcut.position;
      config.shortcuts.push(shortcut);
      await transaction.objectStore('outbox').put(outboxEntry('shortcut', shortcut.id, revision, 'upsert'));
    }
    const repair = executePieceDesktopCommand(buildDesktopSnapshot(config), { type: 'repair' });
    for (const entry of applyPlacementData(config, desktopPlacements(repair.items), identity)) {
      await transaction.objectStore('outbox').put(entry);
    }
    config.updatedAt = new Date().toISOString();
    await transaction.objectStore('config').put(config, 'current');
    await transaction.objectStore('settings').put(identity, 'deviceIdentity');
    await transaction.done;
    this.emit();
  }

  async putAsset(key: string, blob: Blob, sourceUrl?: string): Promise<void> {
    await (await getDatabase()).put('assets', { key, blob, updatedAt: new Date().toISOString(), ...(sourceUrl ? { sourceUrl } : {}) });
    this.emit();
  }

  async getAsset(key: string): Promise<Blob | undefined> {
    return (await (await getDatabase()).get('assets', key))?.blob;
  }

  async getAssetRecord(key: string): Promise<AssetRecord | undefined> {
    return (await getDatabase()).get('assets', key);
  }

  async putShortcutIcon(shortcutId: string, blob: Blob, sourceUrl: string): Promise<void> {
    await (await getDatabase()).put('assets', { key: shortcutIconAssetKey(shortcutId), blob, updatedAt: new Date().toISOString(), sourceUrl });
  }

  async getShortcutIcon(shortcutId: string): Promise<Blob | undefined> {
    return (await (await getDatabase()).get('assets', shortcutIconAssetKey(shortcutId)))?.blob;
  }

  async getShortcutIcons(shortcutIds: string[]): Promise<Map<string, Blob>> {
    const database = await getDatabase();
    const results = await Promise.all(shortcutIds.map(async (id) => [id, (await database.get('assets', shortcutIconAssetKey(id)))?.blob] as const));
    return new Map(results.filter((entry): entry is readonly [string, Blob] => Boolean(entry[1])));
  }

  async clearShortcutIcon(shortcutId: string): Promise<void> {
    await (await getDatabase()).delete('assets', shortcutIconAssetKey(shortcutId));
  }

  async getSyncMode(): Promise<SyncMode> {
    return await (await getDatabase()).get('settings', 'syncMode') as SyncMode ?? 'chrome';
  }

  async setSyncMode(mode: SyncMode): Promise<void> {
    await (await getDatabase()).put('settings', mode, 'syncMode');
    this.emit();
  }

  async getDeviceIdentity(): Promise<DeviceIdentity> {
    const value = await (await getDatabase()).get('settings', 'deviceIdentity') as DeviceIdentity | undefined;
    if (value) return value;
    await this.initialize();
    return (await (await getDatabase()).get('settings', 'deviceIdentity')) as DeviceIdentity;
  }

  async putCursor(cursor: ProviderCursor): Promise<void> {
    await (await getDatabase()).put('cursors', cursor);
  }

  async getCursor(providerId: string): Promise<ProviderCursor | undefined> {
    return (await getDatabase()).get('cursors', providerId);
  }

  async removeOutbox(opIds: string[]): Promise<void> {
    const transaction = (await getDatabase()).transaction('outbox', 'readwrite');
    await Promise.all(opIds.map((id) => transaction.store.delete(id)));
    await transaction.done;
  }

  async createCheckpoint(): Promise<SyncCheckpoint> {
    const checkpoint: SyncCheckpoint = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      config: await this.getConfig(),
      metadata: await this.getMetadata(),
      outbox: await this.getOutbox(),
      pieces: await this.getPieces(),
      cursor: await this.getCursor('chrome'),
      replicas: clone(await (await getDatabase()).getAll('syncReplicas')),
    };
    await (await getDatabase()).put('checkpoints', checkpoint);
    const checkpoints = (await (await getDatabase()).getAll('checkpoints')).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    for (const stale of checkpoints.slice(5)) await (await getDatabase()).delete('checkpoints', stale.id);
    return checkpoint;
  }

  async getLatestCheckpoint(): Promise<SyncCheckpoint | undefined> {
    return (await (await getDatabase()).getAll('checkpoints')).sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  }

  async restoreLatestCheckpoint(): Promise<boolean> {
    const checkpoint = await this.getLatestCheckpoint();
    if (!checkpoint) return false;
    const database = await getDatabase();
    const transaction = database.transaction(['config', 'metadata', 'outbox', 'cursors', 'pieces', 'syncReplicas'], 'readwrite');
    await transaction.objectStore('config').put(checkpoint.config, 'current');
    await transaction.objectStore('metadata').put(checkpoint.metadata, 'current');
    await transaction.objectStore('outbox').clear();
    for (const entry of checkpoint.outbox) await transaction.objectStore('outbox').put(entry);
    if (checkpoint.pieces) {
      await transaction.objectStore('pieces').clear();
      for (const piece of checkpoint.pieces) await transaction.objectStore('pieces').put(piece);
    }
    if (checkpoint.cursor) await transaction.objectStore('cursors').put(checkpoint.cursor);
    else await transaction.objectStore('cursors').delete('chrome');
    await transaction.objectStore('syncReplicas').clear();
    for (const replica of checkpoint.replicas ?? []) await transaction.objectStore('syncReplicas').put(replica);
    await transaction.done;
    this.emit();
    return true;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.notifyListeners();
    this.channel?.postMessage('changed');
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) listener();
  }

  private async requireConfig(store: { get(key: 'current'): Promise<AppConfig | undefined> }): Promise<AppConfig> {
    const config = await store.get('current');
    if (!config) throw new Error('REPOSITORY_NOT_INITIALIZED');
    return config;
  }

  private async requireIdentity(store: { get(key: 'deviceIdentity'): Promise<unknown> }): Promise<DeviceIdentity> {
    const identity = await store.get('deviceIdentity');
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)
      || !('deviceId' in identity) || typeof identity.deviceId !== 'string'
      || !('counter' in identity) || typeof identity.counter !== 'number'
      || !('epoch' in identity) || typeof identity.epoch !== 'number') {
      throw new Error('REPOSITORY_NOT_INITIALIZED');
    }
    return identity as DeviceIdentity;
  }
}

function validateName(value: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error('NAME_REQUIRED');
  if (normalized.length > maxLength) throw new Error('NAME_TOO_LONG');
  return normalized;
}

function validateCommitAgainstSnapshot(
  snapshot: ReturnType<typeof buildDesktopSnapshot>,
  placements: DesktopPlacement[],
  collisionGeometry?: DesktopCollisionGeometry,
): void {
  const items = desktopItems(snapshot);
  if (placements.length !== items.length) throw new Error('DESKTOP_COMMIT_INCOMPLETE');
  const placementMap = new Map(placements.map((placement) => [placementKey(placement), placement]));
  if (placementMap.size !== placements.length) throw new Error('DESKTOP_DUPLICATE_KEY');
  const projected = items.map((item) => {
    const placement = placementMap.get(item.key);
    if (!placement) throw new Error('DESKTOP_COMMIT_INCOMPLETE');
    return { ...item, position: placement.position };
  });
  validateDesktopItems(projected, { allowLogicalOverlap: Boolean(collisionGeometry) });
  if (!collisionGeometry) return;
  const rects = projected.map((item) => {
    const rect = collisionRectFor(item.key, item.position, collisionGeometry);
    if (!rect) throw new Error('DESKTOP_COLLISION_GEOMETRY_INCOMPLETE');
    return { key: item.key, rect };
  });
  for (const [index, item] of rects.entries()) {
    if (rects.slice(index + 1).some((candidate) => collisionRectsOverlap(item.rect, candidate.rect))) {
      throw new Error('DESKTOP_ITEMS_OVERLAP');
    }
  }
}

function applyPlacementData(config: AppConfig, placements: DesktopPlacement[], identity: DeviceIdentity): OutboxEntry[] {
  const entries: OutboxEntry[] = [];
  let widgetChanged = false;
  for (const placement of placements) {
    if (placement.kind === 'shortcut') {
      const shortcut = config.shortcuts.find((item) => item.id === placement.id && item.groupId === DEFAULT_GROUP_ID);
      if (!shortcut) throw new Error('DESKTOP_ITEM_NOT_FOUND');
      if (samePosition(shortcut.position, placement.position)) continue;
      shortcut.position = placement.position;
      shortcut.revision = nextRevision(identity, shortcut.revision);
      entries.push(outboxEntry('shortcut', shortcut.id, shortcut.revision, 'upsert'));
    } else if (placement.kind === 'folder') {
      const group = config.groups.find((item) => item.id === placement.id && item.id !== DEFAULT_GROUP_ID);
      if (!group) throw new Error('DESKTOP_ITEM_NOT_FOUND');
      if (samePosition(group.position, placement.position)) continue;
      group.position = placement.position;
      group.revision = nextRevision(identity, group.revision);
      entries.push(outboxEntry('group', group.id, group.revision, 'upsert'));
    } else {
      const widget = config.appearance.widgetLayout.value.find((item) => item.id === placement.id);
      if (!widget) throw new Error('DESKTOP_ITEM_NOT_FOUND');
      if (samePosition(widget.position, placement.position) && widget.sizePreset === placement.sizePreset) continue;
      widget.position = placement.position;
      widget.sizePreset = placement.sizePreset;
      widgetChanged = true;
    }
  }
  if (widgetChanged) {
    config.appearance.widgetLayout.revision = nextRevision(identity, config.appearance.widgetLayout.revision);
    entries.push(outboxEntry('appearance', 'widgetLayout', config.appearance.widgetLayout.revision, 'upsert'));
  }
  return entries;
}

function placementKey(placement: DesktopPlacement): string {
  if (placement.kind === 'system-widget') return `widget:${placement.id}`;
  if (placement.kind === 'add-shortcut') return 'add-shortcut';
  return `${placement.kind}:${placement.id}`;
}

function widgetPositionToPiece(position: WidgetPosition): PiecePosition {
  return { x: position.column - 24, y: position.row, width: position.width, height: position.height };
}

function piecePositionToWidget(position: PiecePosition): WidgetPosition {
  return { column: position.x + 24, row: position.y, width: position.width, height: position.height, gridVersion: 3 };
}

function isFolderShortcutDesktopDropPlan(commit: DesktopCommit | FolderShortcutDesktopDropPlan | undefined): commit is FolderShortcutDesktopDropPlan {
  return Boolean(commit && 'kind' in commit && commit.kind === 'folder-shortcut-desktop-drop');
}

function validatePieceSet(pieces: Piece[]): void {
  const ids = new Set<string>();
  const desktop = pieces.filter((piece) => piece.container.kind === 'desktop' && piece.position);
  for (const piece of pieces) {
    if (ids.has(piece.id)) throw new Error('PIECE_DUPLICATE_ID');
    ids.add(piece.id);
    if (piece.container.kind === 'desktop' && (!piece.position || !isPiecePositionValid(piece.position))) throw new Error('PIECE_POSITION_INVALID');
    if (piece.container.kind === 'folder' && piece.position) throw new Error('PIECE_FOLDER_POSITION_INVALID');
    if (piece.container.kind === 'hidden' && piece.kind !== 'system-widget' && piece.kind !== 'add-shortcut' && piece.position) throw new Error('PIECE_HIDDEN_POSITION_INVALID');
    if (piece.container.kind === 'hidden' && (piece.kind === 'system-widget' || piece.kind === 'add-shortcut') && piece.position && !isPiecePositionValid(piece.position)) throw new Error('PIECE_POSITION_INVALID');
    if (piece.kind === 'add-shortcut' && piece.id !== 'piece:add-shortcut') throw new Error('ADD_PIECE_ID_INVALID');
    if (piece.kind === 'add-shortcut' && piece.container.kind === 'folder') throw new Error('ADD_PIECE_FOLDER_INVALID');
  }
  for (const [index, left] of desktop.entries()) {
    if (desktop.slice(index + 1).some((right) => piecePositionsOverlap(left.position!, right.position!))) throw new Error('PIECE_LAYOUT_OVERLAP');
  }
}

/** Keeps legacy read-only projections coherent for older exports and tests. */
function mirrorPiecePositions(config: AppConfig, pieces: Piece[]): void {
  for (const piece of pieces) {
    const position = piece.position ? piecePositionToWidget(piece.position) : undefined;
    if (piece.kind === 'system-widget' || piece.kind === 'add-shortcut') {
      const item = config.appearance.widgetLayout.value.find((candidate) => candidate.id === (piece.kind === 'add-shortcut' ? 'addShortcut' : piece.payloadRef));
      if (item && position) item.position = position;
    } else if (piece.kind === 'shortcut') {
      const shortcut = config.shortcuts.find((candidate) => candidate.id === piece.payloadRef);
      if (shortcut) { if (position && piece.container.kind === 'desktop') shortcut.position = position; else delete shortcut.position; }
    } else if (piece.kind === 'folder') {
      const group = config.groups.find((candidate) => candidate.id === piece.payloadRef);
      if (group && position) group.position = position;
    }
  }
}

type PieceStore = { getAll(): Promise<Piece[]>; put(value: Piece): Promise<unknown> };

async function ensureSystemPieces(store: PieceStore, config: AppConfig, identity: DeviceIdentity): Promise<OutboxEntry[]> {
  const existingPieces = await store.getAll();
  const existing = new Set(existingPieces.map((piece) => piece.id));
  const entries: OutboxEntry[] = [];
  for (const widgetId of SYSTEM_WIDGET_IDS) {
    const id = `piece:widget:${widgetId}`;
    if (existing.has(id)) continue;
    const widget = config.appearance.widgetLayout.value.find((item) => item.id === widgetId);
    const sizePreset = widget?.sizePreset ?? 'medium';
    const piece: Piece = {
      id,
      kind: 'system-widget',
      payloadRef: widgetId,
      container: widget?.enabled ? { kind: 'desktop' } : { kind: 'hidden' },
      position: piecePositionForWidget(widgetId, sizePreset, config.appearance.search.value.widthPercent),
      sizePreset,
      revision: nextRevision(identity, { counter: 0, deviceId: 'system-widget-default' }),
    };
    await store.put(piece);
    entries.push(outboxEntry('piece', piece.id, piece.revision, 'upsert'));
  }
  if (!existing.has('piece:add-shortcut')) {
    const addShortcut = resolveAddShortcutLayout(config.appearance.widgetLayout.value);
    const piece: Piece = {
      id: 'piece:add-shortcut',
      kind: 'add-shortcut',
      payloadRef: 'add-shortcut',
      container: addShortcut.enabled ? { kind: 'desktop' } : { kind: 'hidden' },
      position: widgetPositionToPiece(addShortcut.position),
      revision: nextRevision(identity, { counter: 0, deviceId: 'add-shortcut-default' }),
    };
    await store.put(piece);
    entries.push(outboxEntry('piece', piece.id, piece.revision, 'upsert'));
  }
  return entries;
}

async function syncWidgetPieces(store: PieceStore, config: AppConfig, identity: DeviceIdentity): Promise<OutboxEntry[]> {
  const pieces = await store.getAll();
  const entries: OutboxEntry[] = [];
  for (const piece of pieces.filter((item) => item.kind === 'system-widget')) {
    const widget = config.appearance.widgetLayout.value.find((item) => item.id === piece.payloadRef);
    if (!widget) continue;
    const sizePreset = widget.sizePreset ?? piece.sizePreset ?? 'medium';
    const size = piece.payloadRef === 'search'
      ? { width: searchPercentToPieceWidth(config.appearance.search.value.widthPercent), height: 2 }
      : (WIDGET_SIZE_PRESETS[piece.payloadRef as SystemWidgetId][sizePreset] ?? { width: piece.position?.width ?? 4, height: piece.position?.height ?? 3 });
    const old = piece.position ?? { x: -size.width / 2, y: 0, width: size.width, height: size.height };
    const legacyPosition = widget.position;
    const centered = legacyPosition
      ? legacyPosition.column === Math.round((48 - legacyPosition.width) / 2)
      : old.x === Math.round(-old.width / 2);
    const next: PiecePosition = {
      x: centered ? -size.width / 2 : legacyPosition ? legacyPosition.column - 24 : old.x,
      y: old.y,
      width: size.width,
      height: size.height,
    };
    next.y = widget.position?.row ?? old.y;
    const container = widget.enabled ? { kind: 'desktop' as const } : { kind: 'hidden' as const };
    if (JSON.stringify(piece.position) === JSON.stringify(next) && JSON.stringify(piece.container) === JSON.stringify(container) && piece.sizePreset === sizePreset) continue;
    piece.position = next;
    piece.container = container;
    piece.sizePreset = sizePreset;
    piece.revision = nextRevision(identity, piece.revision);
    await store.put(piece);
    entries.push(outboxEntry('piece', piece.id, piece.revision, 'upsert'));
  }
  const addPiece = pieces.find((piece) => piece.kind === 'add-shortcut');
  const addShortcut = resolveAddShortcutLayout(config.appearance.widgetLayout.value);
  if (addPiece) {
    const container = addShortcut.enabled ? { kind: 'desktop' as const } : { kind: 'hidden' as const };
    const position = widgetPositionToPiece(addShortcut.position);
    if (JSON.stringify(addPiece.container) !== JSON.stringify(container) || JSON.stringify(addPiece.position) !== JSON.stringify(position)) {
      addPiece.container = container;
      addPiece.position = position;
      addPiece.revision = nextRevision(identity, addPiece.revision);
      await store.put(addPiece);
      entries.push(outboxEntry('piece', addPiece.id, addPiece.revision, 'upsert'));
    }
  }
  return entries;
}

function shortcutInsertionPosition(config: AppConfig, snapshot: ReturnType<typeof buildDesktopSnapshot>): WidgetPosition {
  return desktopItems(snapshot).find((item) => item.kind === 'add-shortcut')?.position
    ?? resolveAddShortcutLayout(config.appearance.widgetLayout.value).position;
}

function isBingWallpaperQuality(value: unknown): value is import('../domain/types').BingWallpaperQuality {
  return value === '1080p' || value === '1440p' || value === '4k';
}

function hasWallpaperStartupFade(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const appearance = (value as { appearance?: unknown }).appearance;
  return Boolean(appearance && typeof appearance === 'object' && Object.hasOwn(appearance, 'wallpaperStartupFadeMs'));
}

async function ensureBusinessPieces(store: PieceStore, config: AppConfig): Promise<void> {
  const pieces = await store.getAll();
  const ids = new Set(pieces.map((piece) => piece.id));
  for (const group of config.groups.filter((item) => item.id !== DEFAULT_GROUP_ID && item.position)) {
    const id = `piece:folder:${group.id}`;
    if (ids.has(id)) continue;
    await store.put({ id, kind: 'folder', payloadRef: group.id, container: { kind: 'desktop' }, position: widgetPositionToPiece(group.position!), revision: group.revision });
  }
  for (const shortcut of config.shortcuts) {
    const id = `piece:shortcut:${shortcut.id}`;
    if (ids.has(id)) continue;
    const desktop = shortcut.groupId === DEFAULT_GROUP_ID && shortcut.position;
    await store.put({ id, kind: 'shortcut', payloadRef: shortcut.id, container: desktop ? { kind: 'desktop' } : { kind: 'folder', folderPieceId: `piece:folder:${shortcut.groupId}` }, ...(desktop ? { position: widgetPositionToPiece(shortcut.position!) } : {}), revision: shortcut.revision });
  }
}

/**
 * Repairs the only historical shortcut/container split that can render the
 * same shortcut twice: configuration still says "folder" while Piece says
 * "desktop". Piece is the desktop layout authority, so keep that placement.
 */
async function reconcileDesktopShortcutContainers(store: PieceStore, config: AppConfig, identity: DeviceIdentity): Promise<OutboxEntry[]> {
  const pieces = await store.getAll();
  const byShortcutId = new Map(pieces.filter((piece) => piece.kind === 'shortcut').map((piece) => [piece.payloadRef, piece]));
  const entries: OutboxEntry[] = [];
  let changed = false;
  for (const shortcut of config.shortcuts) {
    const piece = byShortcutId.get(shortcut.id);
    if (!piece || shortcut.groupId === DEFAULT_GROUP_ID || piece.container.kind !== 'desktop' || !piece.position) continue;
    shortcut.groupId = DEFAULT_GROUP_ID;
    shortcut.position = piecePositionToWidget(piece.position);
    shortcut.revision = nextRevision(identity, shortcut.revision);
    piece.revision = shortcut.revision;
    await store.put(piece);
    entries.push(outboxEntry('shortcut', shortcut.id, shortcut.revision, 'upsert'));
    entries.push(outboxEntry('piece', piece.id, piece.revision, 'upsert'));
    changed = true;
  }
  if (changed) config.updatedAt = new Date().toISOString();
  return entries;
}

export { IndexedDbUnitOfWork as AppRepository };

const appUnitOfWork = new IndexedDbUnitOfWork();

export const appRepositories = {
  config: appUnitOfWork as ConfigRepository,
  sync: appUnitOfWork as SyncRepository,
  assets: appUnitOfWork as AssetRepository,
  backup: appUnitOfWork as BackupRepository,
  pieces: appUnitOfWork,
};
