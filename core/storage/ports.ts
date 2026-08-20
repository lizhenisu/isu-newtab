import type {
  AppConfig,
  AssetRecord,
  DeviceIdentity,
  OutboxEntry,
  ProviderCursor,
  Shortcut,
  ShortcutInput,
  ShortcutGroup,
  SyncCheckpoint,
  SyncMetadata,
  SyncMode,
  Wallpaper,
} from '../domain/types';
import type { DesktopCommit } from '../domain/desktop';
import type { FolderShortcutDesktopDropPlan } from '../layout/folder-shortcut-desktop-drop';
import type { WidgetPosition } from '../domain/widgets';
import type { Piece, PiecePosition, PieceSnapshot } from '../domain/pieces';
import type { PreparedRandomWallpaperState, RandomWallpaperState } from '../wallpaper/random';
import type { BingDailyState } from '../wallpaper/bing';
import type { SyncReplica } from '../sync/replica';

export type AppStateSnapshot = {
  config: AppConfig;
  pieces: Piece[];
  syncMode: SyncMode;
};

export interface PieceRepository {
  getPieces(): Promise<Piece[]>;
  getSyncReplica(providerId: string): Promise<SyncReplica | undefined>;
  putSyncReplica(replica: SyncReplica): Promise<void>;
  putPieces(pieces: Piece[]): Promise<void>;
  createPiece(piece: Piece): Promise<void>;
  movePiece(id: string, position: PiecePosition): Promise<void>;
  resizePiece(id: string, position: PiecePosition, sizePreset?: Piece['sizePreset']): Promise<void>;
  hidePiece(id: string): Promise<void>;
  restorePiece(id: string): Promise<void>;
  movePieceIntoFolder(id: string, folderPieceId: string): Promise<void>;
  movePieceOutOfFolder(id: string, position: PiecePosition): Promise<void>;
  deletePiece(id: string): Promise<void>;
  commitPieceLayout(snapshot: PieceSnapshot, pieces: Piece[]): Promise<void>;
}

export interface ConfigRepository {
  initialize(): Promise<AppConfig>;
  getConfig(): Promise<AppConfig>;
  /** Reads values rendered by the new-tab page from one IndexedDB snapshot. */
  getAppStateSnapshot(): Promise<AppStateSnapshot>;
  addGroup(name: string, position?: WidgetPosition): Promise<ShortcutGroup>;
  updateGroup(id: string, patch: Pick<ShortcutGroup, 'name' | 'collapsed'>): Promise<void>;
  deleteGroup(id: string): Promise<void>;
  addShortcut(input: ShortcutInput & { position?: WidgetPosition }): Promise<Shortcut>;
  updateShortcut(id: string, input: ShortcutInput): Promise<void>;
  moveShortcut(id: string, groupId: string, beforeId?: string, afterId?: string, position?: WidgetPosition, commit?: DesktopCommit | FolderShortcutDesktopDropPlan): Promise<AppStateSnapshot>;
  moveGroup(id: string, beforeId?: string, afterId?: string): Promise<void>;
  deleteShortcut(id: string): Promise<void>;
  commitDesktopResult(commit: DesktopCommit): Promise<void>;
  setWidgetEnabled(id: import('../domain/widgets').ConfigurableWidgetId, enabled: boolean): Promise<void>;
  updateAppearance<K extends keyof AppConfig['appearance']>(key: K, value: AppConfig['appearance'][K]['value']): Promise<void>;
  setWallpaper(wallpaper: Wallpaper): Promise<void>;
  setSolidWallpaper(color: string): Promise<void>;
  getRandomWallpaperState(): Promise<RandomWallpaperState | undefined>;
  saveRandomWallpaperState(state: RandomWallpaperState, blob: Blob): Promise<void>;
  getPreparedRandomWallpaperState(): Promise<PreparedRandomWallpaperState | undefined>;
  savePreparedRandomWallpaperState(state: PreparedRandomWallpaperState, blob: Blob): Promise<void>;
  promotePreparedRandomWallpaperState(now?: Date): Promise<RandomWallpaperState | undefined>;
  updateRandomWallpaperState(state: RandomWallpaperState): Promise<void>;
  clearPreparedRandomWallpaperState(): Promise<void>;
  clearRandomWallpaperState(): Promise<void>;
  getBingWallpaperQuality(): Promise<import('../domain/types').BingWallpaperQuality>;
  setBingWallpaperQuality(quality: import('../domain/types').BingWallpaperQuality): Promise<void>;
  getBingDailyState(): Promise<BingDailyState | undefined>;
  saveBingDailyState(state: BingDailyState, blob: Blob): Promise<void>;
  updateBingDailyState(state: BingDailyState): Promise<void>;
  subscribe(listener: () => void): () => void;
}

/** Persistence operations required by provider-neutral synchronization. */
export interface SyncRepository {
  initialize(): Promise<AppConfig>;
  getConfig(): Promise<AppConfig>;
  getMetadata(): Promise<SyncMetadata>;
  getOutbox(): Promise<OutboxEntry[]>;
  getSyncMode(): Promise<SyncMode>;
  setSyncMode(mode: SyncMode): Promise<void>;
  getDeviceIdentity(): Promise<DeviceIdentity>;
  getPieces(): Promise<Piece[]>;
  getSyncReplica(providerId: string): Promise<SyncReplica | undefined>;
  putSyncReplica(replica: SyncReplica): Promise<void>;
  putCursor(cursor: ProviderCursor): Promise<void>;
  getCursor(providerId: string): Promise<ProviderCursor | undefined>;
  removeOutbox(opIds: string[]): Promise<void>;
  createCheckpoint(): Promise<SyncCheckpoint>;
  replaceFromSync(
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
  ): Promise<void>;
  updateSyncControl(metadata: SyncMetadata, identity: DeviceIdentity, cursor: ProviderCursor): Promise<void>;
  confirmSyncReplica(replica: SyncReplica, confirmedOutboxIds: string[], cursor?: ProviderCursor): Promise<void>;
  importExternalSync(remote: AppConfig): Promise<void>;
}

export interface AssetRepository {
  setUploadedWallpaper(blob: Blob): Promise<void>;
  putAsset(key: string, blob: Blob, sourceUrl?: string): Promise<void>;
  getAsset(key: string): Promise<Blob | undefined>;
  getAssetRecord(key: string): Promise<AssetRecord | undefined>;
  putShortcutIcon(shortcutId: string, blob: Blob, sourceUrl: string): Promise<void>;
  getShortcutIcon(shortcutId: string): Promise<Blob | undefined>;
  getShortcutIcons(shortcutIds: string[]): Promise<Map<string, Blob>>;
  clearShortcutIcon(shortcutId: string): Promise<void>;
}

export interface BackupRepository {
  getDeviceIdentity(): Promise<DeviceIdentity>;
  replaceFromImport(config: AppConfig, wallpaper?: Blob): Promise<void>;
  createCheckpoint(): Promise<SyncCheckpoint>;
  restoreLatestCheckpoint(): Promise<boolean>;
}

export type AppUnitOfWork = ConfigRepository & SyncRepository & AssetRepository & BackupRepository & PieceRepository;
