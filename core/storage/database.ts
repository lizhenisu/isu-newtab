import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  AppConfig,
  AppLanguage,
  AssetRecord,
  BingWallpaperQuality,
  DeviceIdentity,
  OutboxEntry,
  ProviderCursor,
  SyncCheckpoint,
  SearchHistorySource,
  SyncMetadata,
  SyncMode,
} from '../domain/types';
import type { PreparedRandomWallpaperState, RandomWallpaperState } from '../wallpaper/random';
import type { BingDailyState } from '../wallpaper/bing';
import type { WeatherPreferences } from '../weather/preferences';
import type { WeatherCache } from '../weather/cache';
import type { Piece } from '../domain/pieces';
import type { SearchHistoryEntry } from '../search/history';
import type { SyncReplica } from '../sync/replica';

interface NewTabDatabase extends DBSchema {
  config: { key: 'current'; value: AppConfig };
  metadata: { key: 'current'; value: SyncMetadata };
  outbox: { key: string; value: OutboxEntry };
  assets: { key: string; value: AssetRecord };
  cursors: { key: string; value: ProviderCursor };
  settings: {
    key: 'deviceIdentity' | 'syncMode' | 'searchHistory' | 'searchHistorySource' | 'appLanguage' | 'weatherPreferences' | 'weatherCache' | 'randomWallpaper' | 'randomWallpaperNext' | 'bingDailyWallpaper' | 'bingWallpaperQuality';
    value: DeviceIdentity | SyncMode | SearchHistoryEntry[] | SearchHistorySource | AppLanguage | WeatherPreferences | WeatherCache | RandomWallpaperState | PreparedRandomWallpaperState | BingDailyState | BingWallpaperQuality;
  };
  checkpoints: { key: string; value: SyncCheckpoint };
  pieces: { key: string; value: Piece };
  syncReplicas: { key: string; value: SyncReplica };
}

let databasePromise: Promise<IDBPDatabase<NewTabDatabase>> | undefined;
const DATABASE_NAME = 'isu-newtab';
const LEGACY_DATABASE_NAME = ['isu', 'new', 'tab'].join('-');
const STORE_NAMES = ['config', 'metadata', 'outbox', 'assets', 'cursors', 'settings', 'checkpoints', 'pieces', 'syncReplicas'] as const;

export function getDatabase(): Promise<IDBPDatabase<NewTabDatabase>> {
  databasePromise ??= openDatabase();
  return databasePromise;
}

async function openDatabase(): Promise<IDBPDatabase<NewTabDatabase>> {
  const database = await openDB<NewTabDatabase>(DATABASE_NAME, 3, {
    upgrade(current) {
      if (!current.objectStoreNames.contains('config')) current.createObjectStore('config');
      if (!current.objectStoreNames.contains('metadata')) current.createObjectStore('metadata');
      if (!current.objectStoreNames.contains('outbox')) current.createObjectStore('outbox', { keyPath: 'opId' });
      if (!current.objectStoreNames.contains('assets')) current.createObjectStore('assets', { keyPath: 'key' });
      if (!current.objectStoreNames.contains('cursors')) current.createObjectStore('cursors', { keyPath: 'providerId' });
      if (!current.objectStoreNames.contains('settings')) current.createObjectStore('settings');
      if (!current.objectStoreNames.contains('checkpoints')) current.createObjectStore('checkpoints', { keyPath: 'id' });
      if (!current.objectStoreNames.contains('pieces')) current.createObjectStore('pieces', { keyPath: 'id' });
      if (!current.objectStoreNames.contains('syncReplicas')) current.createObjectStore('syncReplicas', { keyPath: 'providerId' });
    },
  });
  await migrateLegacyDatabase(database);
  return database;
}

async function migrateLegacyDatabase(target: IDBPDatabase<NewTabDatabase>): Promise<void> {
  if (typeof indexedDB.databases !== 'function') return;
  const databases = await indexedDB.databases();
  if (!databases.some((entry) => entry.name === LEGACY_DATABASE_NAME)) return;
  const legacy = await openDB<NewTabDatabase>(LEGACY_DATABASE_NAME, 1);
  try {
    if (await target.get('config', 'current')) return;
    const availableStores = STORE_NAMES.filter((store) => legacy.objectStoreNames.contains(store));
    const records = await Promise.all(availableStores.map(async (store) => ({ store, values: await legacy.getAll(store) })));
    const transaction = target.transaction(availableStores, 'readwrite');
    for (const { store, values } of records) {
      for (const value of values) await transaction.objectStore(store).put(value as never);
    }
    await transaction.done;
  } finally {
    legacy.close();
    indexedDB.deleteDatabase(LEGACY_DATABASE_NAME);
  }
}

export async function closeDatabase(): Promise<void> {
  const database = await databasePromise;
  database?.close();
  databasePromise = undefined;
}
