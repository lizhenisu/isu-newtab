import { browser } from 'wxt/browser';
import { appRepositories } from '../../core/storage/repository';
import { ChromeCommitSyncAdapter } from '../../core/sync/chrome-v2-adapter';
import { SyncCoordinator } from '../../core/sync/coordinator';
import { GoogleDriveCommitSyncAdapter } from '../../core/sync/google-drive-v2-adapter';
import { SyncProviderManager } from '../../core/sync/provider-manager';
import { BrowserSyncStatusStore } from '../../core/sync/status-store';
import { cacheBingImage, cacheUnsplashImage, cacheWallhavenImage } from '../../core/wallpaper/cache';
import { BING_DAILY_ASSET_KEY, BING_DAILY_DISPLAY_PORT, bingImageUrlForQuality, bingMarketForLanguage, downloadBingImage, fetchBingWallpapers, nextBingDailyState, retryBingDailyState } from '../../core/wallpaper/bing';
import {
  RANDOM_WALLPAPER_ASSET_KEY,
  RANDOM_WALLPAPER_NEXT_ASSET_KEY,
  RANDOM_WALLPAPER_DISPLAY_PORT,
  chooseRandomWallhaven,
  downloadWallhavenImage,
  isRandomWallpaperDisplayReadyMessage,
  nextRandomWallpaperState,
  prepareRandomWallpaperState,
  rescheduleRandomWallpaper,
} from '../../core/wallpaper/random';
import type { AppConfig, AppLanguage } from '../../core/domain/types';
import { refreshDesktopContextMenus, registerDesktopContextMenus } from '../../core/browser/context-menu-controller';
import { getAppLanguagePreference } from '../../core/browser/language-preference';
import { setAppLanguage } from '../../core/browser/i18n';

const syncStatusStore = new BrowserSyncStatusStore();
const chromeSyncCoordinator = new SyncCoordinator({
  adapter: new ChromeCommitSyncAdapter(),
  repository: appRepositories.sync,
  statusStore: syncStatusStore,
  providerMode: 'chrome',
  refreshWallpaper: refreshWallpaperAssets,
});
const googleDriveSyncCoordinator = new SyncCoordinator({
  adapter: new GoogleDriveCommitSyncAdapter(),
  repository: appRepositories.sync,
  statusStore: syncStatusStore,
  providerMode: 'google-drive',
  refreshWallpaper: refreshWallpaperAssets,
  scheduleDelayMs: 30_000,
});
const syncProviders = new SyncProviderManager(appRepositories.sync, {
  chrome: chromeSyncCoordinator,
  'google-drive': googleDriveSyncCoordinator,
}, syncStatusStore);

const RANDOM_WALLPAPER_ALARM = 'isu:wallpaper:random';
const BING_DAILY_ALARM = 'isu:wallpaper:bing-daily';
const GOOGLE_DRIVE_SYNC_ALARM = 'isu:sync:google-drive';
let randomRefresh: Promise<void> | undefined;
let randomPrefetch: Promise<void> | undefined;
let bingDailyRefresh: Promise<void> | undefined;
let readyRandomWallpaperDisplays = 0;
let visibleRandomWallpaperDisplays = 0;
let readyBingDailyDisplays = 0;

export default defineBackground(() => {
  registerDesktopContextMenus();
  void getAppLanguagePreference().then(async (language) => {
    setAppLanguage(language);
    await refreshDesktopContextMenus();
  });
  void appRepositories.config.initialize().then(async (config) => {
    await refreshWallpaperAssets(config);
    await reconcileSyncProvider();
  });

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== RANDOM_WALLPAPER_DISPLAY_PORT && port.name !== BING_DAILY_DISPLAY_PORT) return;
    let ready = false;
    let visible = false;
    port.onMessage.addListener((message: unknown) => {
      if (!isRandomWallpaperDisplayReadyMessage(message)) return;
      if (port.name === RANDOM_WALLPAPER_DISPLAY_PORT) {
        if (message.type === 'ready' && !ready) { ready = true; readyRandomWallpaperDisplays += 1; }
        if (message.type === 'visible' && !visible) { visible = true; visibleRandomWallpaperDisplays += 1; }
        void reconcileRandomWallpaper();
      } else {
        if (ready || message.type !== 'ready') return;
        ready = true;
        readyBingDailyDisplays += 1;
        void reconcileBingDailyWallpaper();
      }
    });
    port.onDisconnect.addListener(() => {
      if (!ready && !visible) return;
      if (port.name === RANDOM_WALLPAPER_DISPLAY_PORT) {
        if (ready) readyRandomWallpaperDisplays = Math.max(0, readyRandomWallpaperDisplays - 1);
        if (visible) visibleRandomWallpaperDisplays = Math.max(0, visibleRandomWallpaperDisplays - 1);
      }
      else readyBingDailyDisplays = Math.max(0, readyBingDailyDisplays - 1);
    });
  });

  browser.runtime.onMessage.addListener((message: unknown) => {
    const request = message as { type?: string; mode?: 'local' | 'chrome' | 'google-drive'; force?: boolean; choice?: 'local-overwrite' | 'remote-replace' | 'external-import'; url?: string; language?: AppLanguage };
    if (request.type === 'sync:schedule') void syncProviders.schedule();
    if (request.type === 'sync:set-mode' && request.mode) {
      return syncProviders.setMode(request.mode, request.force).then(reconcileSyncProvider);
    }
    if (request.type === 'sync:resolve' && request.choice) return syncProviders.resolveConflict(request.choice);
    if (request.type === 'wallpaper:cache' && request.url) return cacheWallpaperWithStatus(request.url);
    if (request.type === 'wallpaper:unsplash:cache' && request.url) return cacheUnsplashWallpaperWithStatus(request.url);
    if (request.type === 'wallpaper:random:activate') return refreshRandomWallpaper();
    if (request.type === 'wallpaper:random:reconcile') return reconcileRandomWallpaper();
    if (request.type === 'wallpaper:bing:cache' && request.url) return cacheBingWallpaperWithStatus(request.url);
    if (request.type === 'wallpaper:bing:activate') return refreshBingDailyWallpaper();
    if (request.type === 'wallpaper:bing:reconcile') return reconcileBingDailyWallpaper();
    if (request.type === 'language:set' && request.language) {
      setAppLanguage(request.language);
      return Promise.all([refreshDesktopContextMenus(), reconcileBingDailyWallpaper()]);
    }
    return undefined;
  });

  browser.storage.onChanged.addListener((changes, areaName) => {
    // Immutable objects and acknowledgements are not new application state.
    // Only a device head can expose a new commit to this installation; listening
    // to our own ack writes would otherwise create a sync feedback loop.
    if (areaName === 'sync' && Object.keys(changes).some((key) => key.startsWith('isu/v2/head/') || key === 'sync/activeHead')) void scheduleChromeSyncIfActive();
  });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RANDOM_WALLPAPER_ALARM) void reconcileRandomWallpaper();
    if (alarm.name === BING_DAILY_ALARM) void reconcileBingDailyWallpaper();
    if (alarm.name === GOOGLE_DRIVE_SYNC_ALARM) void syncGoogleDriveIfActive();
  });
});

async function reconcileSyncProvider(): Promise<void> {
  const mode = await appRepositories.sync.getSyncMode();
  if (mode === 'google-drive') browser.alarms.create(GOOGLE_DRIVE_SYNC_ALARM, { periodInMinutes: 15 });
  else await browser.alarms.clear(GOOGLE_DRIVE_SYNC_ALARM);
  await syncProviders.runActive();
}

async function scheduleChromeSyncIfActive(): Promise<void> {
  if (await appRepositories.sync.getSyncMode() === 'chrome') chromeSyncCoordinator.schedule(0);
}

async function syncGoogleDriveIfActive(): Promise<void> {
  if (await appRepositories.sync.getSyncMode() === 'google-drive') await googleDriveSyncCoordinator.run();
}

async function cacheWallpaperWithStatus(url: string): Promise<void> {
  try {
    await cacheWallhavenImage(url);
    await browser.storage.local.remove('wallpaperStatus');
  } catch (error) {
    await browser.storage.local.set({ wallpaperStatus: { state: 'error', message: error instanceof Error ? error.message : String(error) } });
    throw error;
  }
}

async function cacheBingWallpaperWithStatus(url: string): Promise<void> {
  try {
    await cacheBingImage(url);
    await browser.storage.local.remove('wallpaperStatus');
  } catch (error) {
    await browser.storage.local.set({ wallpaperStatus: { state: 'error', message: error instanceof Error ? error.message : String(error) } });
    throw error;
  }
}

async function cacheUnsplashWallpaperWithStatus(url: string): Promise<void> {
  try {
    await cacheUnsplashImage(url);
    await browser.storage.local.remove('wallpaperStatus');
  } catch (error) {
    await browser.storage.local.set({ wallpaperStatus: { state: 'error', message: error instanceof Error ? error.message : String(error) } });
    throw error;
  }
}

async function refreshWallpaperAssets(config: AppConfig): Promise<void> {
  const wallpaper = config.appearance.wallpaper.value;
  if (wallpaper.type === 'wallhaven') {
    try {
      await cacheWallpaperWithStatus(wallpaper.imageUrl);
    } catch {
      // The status is already persisted for the UI; sync must not fail on a cache miss.
    }
  }
  if (wallpaper.type === 'bing') {
    try {
      await cacheBingWallpaperWithStatus(wallpaper.imageUrl);
    } catch {
      // A synced Bing selection remains visible from its existing local cache when offline.
    }
  }
  if (wallpaper.type === 'unsplash') {
    try {
      await cacheUnsplashWallpaperWithStatus(wallpaper.imageUrl);
    } catch {
      // A synced Unsplash selection remains black until its local cache is available.
    }
  }
  await reconcileRandomWallpaper(config);
  await reconcileBingDailyWallpaper(config);
}

async function reconcileRandomWallpaper(config?: AppConfig): Promise<void> {
  const resolvedConfig = config ?? await appRepositories.config.getConfig();
  const wallpaper = resolvedConfig.appearance.wallpaper.value;
  if (wallpaper.type !== 'wallhaven-random') {
    await browser.alarms.clear(RANDOM_WALLPAPER_ALARM);
    await appRepositories.config.clearPreparedRandomWallpaperState();
    return;
  }
  if (!readyRandomWallpaperDisplays) {
    await browser.alarms.clear(RANDOM_WALLPAPER_ALARM);
    return;
  }
  const state = await appRepositories.config.getRandomWallpaperState();
  const nextAt = state ? Date.parse(state.nextRefreshAt) : 0;
  const cachedImage = state ? await appRepositories.assets.getAsset(RANDOM_WALLPAPER_ASSET_KEY) : undefined;
  if (!state || !cachedImage || !Number.isFinite(nextAt) || nextAt <= Date.now()) {
    if (state && cachedImage) {
      const promoted = await appRepositories.config.promotePreparedRandomWallpaperState();
      if (promoted) {
        await browser.alarms.create(RANDOM_WALLPAPER_ALARM, { when: Date.parse(promoted.nextRefreshAt) });
        void prefetchNextRandomWallpaper(promoted);
        return;
      }
    }
    await refreshRandomWallpaper();
    return;
  }
  if (state.interval !== wallpaper.interval) {
    const updated = rescheduleRandomWallpaper(state, wallpaper.interval);
    await appRepositories.config.updateRandomWallpaperState(updated);
    await browser.alarms.create(RANDOM_WALLPAPER_ALARM, { when: Date.parse(updated.nextRefreshAt) });
    void prefetchNextRandomWallpaper(updated);
    return;
  }
  await browser.alarms.create(RANDOM_WALLPAPER_ALARM, { when: nextAt });
  void prefetchNextRandomWallpaper(state);
}

async function refreshRandomWallpaper(): Promise<void> {
  if (randomRefresh) return randomRefresh;
  const task = (async () => {
    const config = await appRepositories.config.getConfig();
    const wallpaper = config.appearance.wallpaper.value;
    if (wallpaper.type !== 'wallhaven-random') {
      await browser.alarms.clear(RANDOM_WALLPAPER_ALARM);
      return;
    }
    const current = await appRepositories.config.getRandomWallpaperState();
    try {
      const selected = await chooseRandomWallhaven(current?.wallpaperId);
      const blob = await downloadWallhavenImage(selected.imageUrl);
      const latestWallpaper = (await appRepositories.config.getConfig()).appearance.wallpaper.value;
      if (latestWallpaper.type !== 'wallhaven-random') {
        await reconcileRandomWallpaper();
        return;
      }
      const state = nextRandomWallpaperState(selected, latestWallpaper.interval);
      await appRepositories.config.saveRandomWallpaperState(state, blob);
      await browser.storage.local.remove('wallpaperStatus');
      await browser.alarms.create(RANDOM_WALLPAPER_ALARM, { when: Date.parse(state.nextRefreshAt) });
      if (visibleRandomWallpaperDisplays) void prefetchNextRandomWallpaper(state);
    } catch (error) {
      await browser.storage.local.set({ wallpaperStatus: { state: 'error', message: error instanceof Error ? error.message : String(error) } });
      const retryAt = Date.now() + 15 * 60_000;
      await browser.alarms.create(RANDOM_WALLPAPER_ALARM, { when: retryAt });
    }
  })();
  randomRefresh = task;
  try {
    await task;
  } finally {
    if (randomRefresh === task) randomRefresh = undefined;
  }
}

async function prefetchNextRandomWallpaper(current: import('../../core/wallpaper/random').RandomWallpaperState): Promise<void> {
  if (!visibleRandomWallpaperDisplays || randomPrefetch) return randomPrefetch;
  const prepared = await appRepositories.config.getPreparedRandomWallpaperState();
  const preparedAsset = prepared ? await appRepositories.assets.getAsset(RANDOM_WALLPAPER_NEXT_ASSET_KEY) : undefined;
  if (prepared && preparedAsset && prepared.currentWallpaperId === current.wallpaperId && prepared.interval === current.interval) return;
  const task = (async () => {
    try {
      const selected = await chooseRandomWallhaven(current.wallpaperId);
      const blob = await downloadWallhavenImage(selected.imageUrl);
      const latest = await appRepositories.config.getRandomWallpaperState();
      if (!latest || latest.wallpaperId !== current.wallpaperId || latest.interval !== current.interval || !visibleRandomWallpaperDisplays) return;
      await appRepositories.config.savePreparedRandomWallpaperState(prepareRandomWallpaperState(selected, current.wallpaperId, current.interval), blob);
    } catch {
      // The current image stays valid. The next displayed tab or scheduled retry tries again.
    }
  })();
  randomPrefetch = task;
  try { await task; } finally { if (randomPrefetch === task) randomPrefetch = undefined; }
}

async function reconcileBingDailyWallpaper(config?: AppConfig): Promise<void> {
  const resolvedConfig = config ?? await appRepositories.config.getConfig();
  if (resolvedConfig.appearance.wallpaper.value.type !== 'bing-daily') {
    await browser.alarms.clear(BING_DAILY_ALARM);
    return;
  }
  if (!readyBingDailyDisplays) {
    await browser.alarms.clear(BING_DAILY_ALARM);
    return;
  }
  const state = await appRepositories.config.getBingDailyState();
  const cachedImage = state ? await appRepositories.assets.getAsset(BING_DAILY_ASSET_KEY) : undefined;
  const nextAt = state ? Date.parse(state.nextRefreshAt) : 0;
  const market = bingMarketForLanguage(await getAppLanguagePreference());
  if (state && cachedImage && (state.market !== market || state.quality !== resolvedConfig.appearance.wallpaper.value.quality)) {
    await refreshBingDailyWallpaper();
    return;
  }
  if (!state || !cachedImage || !Number.isFinite(nextAt) || nextAt <= Date.now()) {
    await refreshBingDailyWallpaper();
    return;
  }
  await browser.alarms.create(BING_DAILY_ALARM, { when: nextAt });
}

async function refreshBingDailyWallpaper(): Promise<void> {
  if (bingDailyRefresh) return bingDailyRefresh;
  const task = (async () => {
    const config = await appRepositories.config.getConfig();
    if (config.appearance.wallpaper.value.type !== 'bing-daily') {
      await browser.alarms.clear(BING_DAILY_ALARM);
      return;
    }
    const quality = config.appearance.wallpaper.value.quality;
    const state = await appRepositories.config.getBingDailyState();
    try {
      const language = await getAppLanguagePreference();
      const market = bingMarketForLanguage(language);
      const wallpaper = (await fetchBingWallpapers(market, 1))[0]!;
      if (state?.date === wallpaper.date && state.market === market && state.quality === quality) {
        const retry = retryBingDailyState(state);
        await appRepositories.config.updateBingDailyState(retry);
        await browser.alarms.create(BING_DAILY_ALARM, { when: Date.parse(retry.nextRefreshAt) });
        return;
      }
      const blob = await downloadBingImage(bingImageUrlForQuality(wallpaper.imageUrl, quality));
      const latest = (await appRepositories.config.getConfig()).appearance.wallpaper.value;
      if (latest.type !== 'bing-daily' || latest.quality !== quality) {
        await reconcileBingDailyWallpaper();
        return;
      }
      const next = nextBingDailyState(wallpaper, market, quality);
      await appRepositories.config.saveBingDailyState(next, blob);
      await browser.storage.local.remove('wallpaperStatus');
      await browser.alarms.create(BING_DAILY_ALARM, { when: Date.parse(next.nextRefreshAt) });
    } catch (error) {
      await browser.storage.local.set({ wallpaperStatus: { state: 'error', message: error instanceof Error ? error.message : String(error) } });
      await browser.alarms.create(BING_DAILY_ALARM, { when: Date.now() + 60 * 60_000 });
    }
  })();
  bingDailyRefresh = task;
  try {
    await task;
  } finally {
    if (bingDailyRefresh === task) bingDailyRefresh = undefined;
  }
}
