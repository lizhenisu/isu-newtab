import { browser } from 'wxt/browser';
import { appRepositories } from '../../core/storage/repository';
import { ChromeSyncAdapter } from '../../core/sync/chrome-adapter';
import { SyncCoordinator } from '../../core/sync/coordinator';
import { BrowserSyncStatusStore } from '../../core/sync/status-store';
import { cacheWallhavenImage } from '../../core/wallpaper/cache';
import {
  RANDOM_WALLPAPER_ASSET_KEY,
  RANDOM_WALLPAPER_DISPLAY_PORT,
  chooseRandomWallhaven,
  downloadWallhavenImage,
  isRandomWallpaperDisplayReadyMessage,
  nextRandomWallpaperState,
  rescheduleRandomWallpaper,
  shouldDeferRandomWallpaperRefresh,
} from '../../core/wallpaper/random';
import type { AppConfig, AppLanguage } from '../../core/domain/types';
import { refreshDesktopContextMenus, registerDesktopContextMenus } from '../../core/browser/context-menu-controller';
import { getAppLanguagePreference } from '../../core/browser/language-preference';
import { setAppLanguage } from '../../core/browser/i18n';

const syncCoordinator = new SyncCoordinator({
  adapter: new ChromeSyncAdapter(),
  repository: appRepositories.sync,
  statusStore: new BrowserSyncStatusStore(),
  providerMode: 'chrome',
  refreshWallpaper: refreshWallpaperAssets,
});

const RANDOM_WALLPAPER_ALARM = 'isu:wallpaper:random';
let randomRefresh: Promise<void> | undefined;
let readyRandomWallpaperDisplays = 0;

export default defineBackground(() => {
  registerDesktopContextMenus();
  void getAppLanguagePreference().then(async (language) => {
    setAppLanguage(language);
    await refreshDesktopContextMenus();
  });
  void appRepositories.config.initialize().then(async (config) => {
    await reconcileRandomWallpaper(config);
    await syncCoordinator.run();
  });

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== RANDOM_WALLPAPER_DISPLAY_PORT) return;
    let ready = false;
    port.onMessage.addListener((message: unknown) => {
      if (ready || !isRandomWallpaperDisplayReadyMessage(message)) return;
      ready = true;
      readyRandomWallpaperDisplays += 1;
      void reconcileRandomWallpaper();
    });
    port.onDisconnect.addListener(() => {
      if (!ready) return;
      readyRandomWallpaperDisplays = Math.max(0, readyRandomWallpaperDisplays - 1);
    });
  });

  browser.runtime.onMessage.addListener((message: unknown) => {
    const request = message as { type?: string; mode?: 'local' | 'chrome'; force?: boolean; choice?: 'local-overwrite' | 'remote-replace' | 'external-import'; url?: string; language?: AppLanguage };
    if (request.type === 'sync:schedule') syncCoordinator.schedule();
    if (request.type === 'sync:set-mode' && request.mode) {
      return syncCoordinator.setMode(request.mode, request.force);
    }
    if (request.type === 'sync:resolve' && request.choice) return syncCoordinator.resolveConflict(request.choice);
    if (request.type === 'wallpaper:cache' && request.url) return cacheWallpaperWithStatus(request.url);
    if (request.type === 'wallpaper:random:activate') return refreshRandomWallpaper();
    if (request.type === 'wallpaper:random:reconcile') return reconcileRandomWallpaper();
    if (request.type === 'language:set' && request.language) {
      setAppLanguage(request.language);
      return refreshDesktopContextMenus();
    }
    return undefined;
  });

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync' && Object.keys(changes).some((key) => key.startsWith('sync/'))) syncCoordinator.schedule(0);
  });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RANDOM_WALLPAPER_ALARM) void reconcileRandomWallpaper();
  });
});

async function cacheWallpaperWithStatus(url: string): Promise<void> {
  try {
    await cacheWallhavenImage(url);
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
  await reconcileRandomWallpaper(config);
}

async function reconcileRandomWallpaper(config?: AppConfig): Promise<void> {
  const resolvedConfig = config ?? await appRepositories.config.getConfig();
  const wallpaper = resolvedConfig.appearance.wallpaper.value;
  if (wallpaper.type !== 'wallhaven-random') {
    await browser.alarms.clear(RANDOM_WALLPAPER_ALARM);
    return;
  }
  const state = await appRepositories.config.getRandomWallpaperState();
  const nextAt = state ? Date.parse(state.nextRefreshAt) : 0;
  const cachedImage = state ? await appRepositories.assets.getAsset(RANDOM_WALLPAPER_ASSET_KEY) : undefined;
  if (shouldDeferRandomWallpaperRefresh(state, Boolean(cachedImage), readyRandomWallpaperDisplays > 0)) {
    await browser.alarms.clear(RANDOM_WALLPAPER_ALARM);
    return;
  }
  if (!state || !cachedImage || !Number.isFinite(nextAt) || nextAt <= Date.now()) {
    await refreshRandomWallpaper();
    return;
  }
  if (state.interval !== wallpaper.interval) {
    const updated = rescheduleRandomWallpaper(state, wallpaper.interval);
    await appRepositories.config.saveRandomWallpaperState(updated, cachedImage);
    await browser.alarms.create(RANDOM_WALLPAPER_ALARM, { when: Date.parse(updated.nextRefreshAt) });
    return;
  }
  await browser.alarms.create(RANDOM_WALLPAPER_ALARM, { when: nextAt });
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
