import { create } from 'zustand';
import { browser } from 'wxt/browser';
import type { AppConfig, SearchPreferences, Shortcut, ShortcutInput, SyncMode, Wallpaper } from '../domain/types';
import type { DesktopCommit } from '../domain/desktop';
import type { FolderShortcutDesktopDropPlan } from '../layout/folder-shortcut-desktop-drop';
import type { ConfigurableWidgetId } from '../domain/widgets';
import type { WidgetPosition } from '../domain/widgets';
import type { Piece } from '../domain/pieces';
import { appRepositories } from '../storage/repository';
import type { AppStateSnapshot } from '../storage/ports';
import { t } from '../browser/i18n';

type AppState = {
  config: AppConfig | null;
  pieces: Piece[];
  appearancePreview: { blur?: number; search?: SearchPreferences };
  syncMode: SyncMode;
  loading: boolean;
  error?: string;
  initialize(): Promise<void>;
  refresh(): Promise<void>;
  addGroup(name: string, position?: WidgetPosition): Promise<void>;
  updateGroup(id: string, name: string, collapsed: boolean): Promise<void>;
  deleteGroup(id: string): Promise<void>;
  addShortcut(input: ShortcutInput & { position?: WidgetPosition }): Promise<Shortcut>;
  updateShortcut(id: string, input: ShortcutInput): Promise<void>;
  deleteShortcut(id: string): Promise<void>;
  moveShortcut(id: string, groupId: string, beforeId?: string, afterId?: string, position?: WidgetPosition, commit?: DesktopCommit | FolderShortcutDesktopDropPlan): Promise<void>;
  moveGroup(id: string, beforeId?: string, afterId?: string): Promise<void>;
  commitDesktopResult(commit: DesktopCommit): Promise<void>;
  setWidgetEnabled(id: ConfigurableWidgetId, enabled: boolean): Promise<void>;
  updateAppearance<K extends keyof AppConfig['appearance']>(key: K, value: AppConfig['appearance'][K]['value']): Promise<void>;
  previewAppearance<K extends 'blur' | 'search'>(key: K, value: K extends 'blur' ? number : SearchPreferences): void;
  clearAppearancePreview(key: 'blur' | 'search'): void;
  setWallpaper(wallpaper: Wallpaper): Promise<void>;
  setSolidWallpaper(color: string): Promise<void>;
  setSyncMode(mode: SyncMode): Promise<void>;
};

let latestRefreshRequest = 0;

async function reload(set: (state: Partial<AppState>) => void): Promise<void> {
  const request = ++latestRefreshRequest;
  const snapshot = await appRepositories.config.getAppStateSnapshot();
  // Repository notifications and mutation completion can overlap. Do not let
  // an older read replace a newer, internally consistent desktop snapshot.
  if (request !== latestRefreshRequest) return;
  set({ ...snapshot, error: undefined });
}

function applyCommittedSnapshot(set: (state: Partial<AppState>) => void, snapshot: AppStateSnapshot): void {
  // A command result is causally newer than any refresh already in flight.
  latestRefreshRequest += 1;
  set({ ...snapshot, error: undefined });
}

async function scheduleSync(): Promise<void> {
  await browser.runtime.sendMessage({ type: 'sync:schedule' }).catch(() => undefined);
}

export const useAppStore = create<AppState>((set) => ({
  config: null,
  pieces: [],
  appearancePreview: {},
  syncMode: 'chrome',
  loading: true,
  async initialize() {
    try {
      await appRepositories.config.initialize();
      await reload(set);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ loading: false });
    }
  },
  async refresh() { await reload(set); },
  async addGroup(name, position) { await mutate(set, () => appRepositories.config.addGroup(name, position)); },
  async updateGroup(id, name, collapsed) { await mutate(set, () => appRepositories.config.updateGroup(id, { name, collapsed })); },
  async deleteGroup(id) { await mutate(set, () => appRepositories.config.deleteGroup(id)); },
  async addShortcut(input) {
    let shortcut: Shortcut | undefined;
    await mutate(set, async () => { shortcut = await appRepositories.config.addShortcut(input); });
    return shortcut!;
  },
  async updateShortcut(id, input) { await mutate(set, () => appRepositories.config.updateShortcut(id, input)); },
  async deleteShortcut(id) { await mutate(set, () => appRepositories.config.deleteShortcut(id)); },
  async moveShortcut(id, groupId, beforeId, afterId, position, commit) {
    try {
      const snapshot = await appRepositories.config.moveShortcut(id, groupId, beforeId, afterId, position, commit);
      applyCommittedSnapshot(set, snapshot);
    } catch (error) {
      await reload(set);
      throw error;
    }
    await scheduleSync();
  },
  async moveGroup(id, beforeId, afterId) { await mutate(set, () => appRepositories.config.moveGroup(id, beforeId, afterId)); },
  async commitDesktopResult(commit) { await mutate(set, () => appRepositories.config.commitDesktopResult(commit)); },
  async setWidgetEnabled(id, enabled) { await mutate(set, () => appRepositories.config.setWidgetEnabled(id, enabled)); },
  async updateAppearance(key, value) { await mutate(set, () => appRepositories.config.updateAppearance(key, value)); },
  previewAppearance(key, value) { set((state) => ({ appearancePreview: { ...state.appearancePreview, [key]: value } })); },
  clearAppearancePreview(key) {
    set((state) => {
      const next = { ...state.appearancePreview };
      delete next[key];
      return { appearancePreview: next };
    });
  },
  async setWallpaper(wallpaper) { await mutate(set, () => appRepositories.config.setWallpaper(wallpaper)); },
  async setSolidWallpaper(color) { await mutate(set, () => appRepositories.config.setSolidWallpaper(color)); },
  async setSyncMode(mode) {
    try {
      await browser.runtime.sendMessage({ type: 'sync:set-mode', mode });
    } catch (error) {
      if (mode !== 'local' || !window.confirm(t('forceLocal'))) throw error;
      await browser.runtime.sendMessage({ type: 'sync:set-mode', mode, force: true });
    }
    await reload(set);
  },
}));

async function mutate(set: (state: Partial<AppState>) => void, operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    await reload(set);
    throw error;
  }
  await reload(set);
  await scheduleSync();
}
