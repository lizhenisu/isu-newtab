import type { WidgetLayout } from './widgets';
import type { Piece } from './pieces';

export const DEFAULT_GROUP_ID = 'default';

export type Revision = {
  counter: number;
  deviceId: string;
};

export type VersionedValue<T> = {
  value: T;
  revision: Revision;
};

export type ShortcutGroup = {
  id: string;
  name: string;
  sortKey: string;
  collapsed: boolean;
  position?: import('./widgets').WidgetPosition;
  revision: Revision;
};

export type Shortcut = {
  id: string;
  groupId: string;
  name: string;
  url: string;
  sortKey: string;
  position?: import('./widgets').WidgetPosition;
  revision: Revision;
};

export type ShortcutInput = Pick<Shortcut, 'name' | 'url' | 'groupId'>;

export type BingWallpaperQuality = '1080p' | '1440p' | '4k';

export type Wallpaper =
  | { type: 'solid'; color: string }
  | { type: 'builtin'; assetId: string }
  | { type: 'upload'; assetKey: string }
  | { type: 'wallhaven'; imageUrl: string; sourceUrl?: string; wallpaperId?: string }
  | { type: 'wallhaven-random'; interval: WallpaperRefreshInterval }
  | { type: 'bing'; imageUrl: string; sourceUrl: string; date: string; quality: BingWallpaperQuality }
  | { type: 'bing-daily'; quality: BingWallpaperQuality }
  | { type: 'unsplash'; imageUrl: string; sourceUrl: string; photoId: string; photographerName: string; photographerUrl: string };

export type WallpaperRefreshInterval = '1h' | '5h' | '1d';

export type WallpaperSyncProjection =
  | { type: 'solid'; color: string }
  | { type: 'builtin'; assetId: string }
  | { type: 'wallhaven'; imageUrl: string }
  | { type: 'wallhaven-random'; interval: WallpaperRefreshInterval }
  | { type: 'bing'; imageUrl: string; sourceUrl: string; date: string; quality: BingWallpaperQuality }
  | { type: 'bing-daily'; quality: BingWallpaperQuality }
  | { type: 'unsplash'; imageUrl: string; sourceUrl: string; photoId: string; photographerName: string; photographerUrl: string };

export type SearchPreferences = {
  engine: SearchEngine;
  widthPercent: number;
  backgroundOpacity: number;
  historyEnabled: boolean;
  suggestionsEnabled: boolean;
};

export type SearchEngine = 'google' | 'bing';
export type SearchHistorySource = 'local' | 'chrome';
export type AppLanguage = 'system' | 'zh_CN' | 'en';

export type Appearance = {
  theme: VersionedValue<'light' | 'dark' | 'system'>;
  blur: VersionedValue<number>;
  solidColor: VersionedValue<string>;
  wallpaper: VersionedValue<Wallpaper>;
  widgetLayout: VersionedValue<WidgetLayout>;
  search: VersionedValue<SearchPreferences>;
};

export type AppConfig = {
  schemaVersion: 1;
  datasetId: string;
  updatedAt: string;
  groups: ShortcutGroup[];
  shortcuts: Shortcut[];
  appearance: Appearance;
};

export type Tombstone = {
  entityType: 'group' | 'shortcut';
  entityId: string;
  revision: Revision;
};

export type SyncMetadata = {
  tombstones: Tombstone[];
};

export type OutboxEntry = {
  opId: string;
  entityType: 'group' | 'shortcut' | 'piece' | 'appearance' | 'envelope';
  entityId: string;
  revision: Revision;
  changeType: 'upsert' | 'delete';
  createdAt: string;
};

export type SyncAppearance = Omit<Appearance, 'wallpaper'> & {
  wallpaper?: VersionedValue<WallpaperSyncProjection>;
};

export type SyncAppConfig = Omit<AppConfig, 'appearance'> & {
  appearance: SyncAppearance;
};

export type SyncEnvelope = {
  schemaVersion: 1;
  datasetId: string;
  epoch: number;
  revision: Revision;
  config: SyncAppConfig;
  pieces: Piece[];
  metadata: SyncMetadata;
};

export type SyncMode = 'local' | 'chrome';

export type ProviderCursor = {
  providerId: string;
  datasetId: string;
  baseRevision: Revision;
  baseSnapshotHash: string;
  compressedBaseline: string;
  remoteVersion: string;
  lastSyncedAt: string;
  needsReconciliation: boolean;
};

export type DeviceIdentity = {
  deviceId: string;
  counter: number;
  epoch: number;
};

export type SyncCheckpoint = {
  id: string;
  createdAt: string;
  config: AppConfig;
  metadata: SyncMetadata;
  outbox: OutboxEntry[];
  pieces?: Piece[];
  cursor?: ProviderCursor;
  replicas?: import('../sync/replica').SyncReplica[];
};

export type AssetRecord = {
  key: string;
  blob: Blob;
  updatedAt: string;
  sourceUrl?: string;
};
