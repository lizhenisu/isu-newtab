import { useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { t } from '../../core/browser/i18n';
import { DEFAULT_GROUP_ID, type Shortcut, type ShortcutGroup } from '../../core/domain/types';
import { wallpaperTone } from '../../core/domain/wallpaper-tone';
import { builtinWallpaperBackground } from '../../core/wallpaper/builtin';
import { RANDOM_WALLPAPER_ASSET_KEY, RANDOM_WALLPAPER_DISPLAY_PORT, type RandomWallpaperState } from '../../core/wallpaper/random';
import { BING_DAILY_ASSET_KEY, BING_DAILY_DISPLAY_PORT, type BingDailyState } from '../../core/wallpaper/bing';
import type { WidgetPosition } from '../../core/domain/widgets';
import { appRepositories } from '../../core/storage/repository';
import { useAppStore } from '../../core/state/store';
import { SettingsPanel } from './components/SettingsPanel';
import { ShortcutEditor } from './components/ShortcutEditor';
import { ShortcutIconCacheProvider, useShortcutIconCache } from './components/ShortcutIconCache';
import { clearLoadedShortcutIcon } from './components/shortcut-icon-loader';
import { useSearchHistorySource } from './hooks/useSearchHistorySource';
import { useAppLanguage } from './hooks/useAppLanguage';
import type { DashboardWidgetContext } from './widgets/registry';
import { PieceBoard } from './widgets/PieceBoard';

export function App() {
  const config = useAppStore((state) => state.config);
  const pieces = useAppStore((state) => state.pieces);
  const loading = useAppStore((state) => state.loading);
  const error = useAppStore((state) => state.error);
  const initialize = useAppStore((state) => state.initialize);
  const refresh = useAppStore((state) => state.refresh);
  const appearancePreview = useAppStore((state) => state.appearancePreview);
  const actions = useAppStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editing, setEditing] = useState<Shortcut | { kind: 'new'; position?: WidgetPosition; groupId?: string }>();
  const [shortcutIconRefresh, setShortcutIconRefresh] = useState<{ shortcutId: string; version: number }>();
  const [clock, setClock] = useState(() => new Date());
  const searchHistory = useSearchHistorySource();
  const appLanguage = useAppLanguage();

  useEffect(() => { void initialize(); return appRepositories.config.subscribe(() => void refresh()); }, [initialize, refresh]);
  useEffect(() => { localStorage.removeItem('isu:wallpaper-bootstrap-preview'); }, []);
  useEffect(() => { const timer = window.setInterval(() => setClock(new Date()), 1000); return () => window.clearInterval(timer); }, []);
  const wallpaperBackground = useWallpaperBackground(config?.appearance.wallpaper.value);

  useRandomWallpaperDisplayReady(
    config?.appearance.wallpaper.value.type === 'wallhaven-random',
    wallpaperBackground?.source === 'asset' && wallpaperBackground.identity.startsWith('wallhaven-random:'),
  );
  useDailyWallpaperDisplayReady(
    config?.appearance.wallpaper.value.type === 'bing-daily',
    BING_DAILY_DISPLAY_PORT,
  );

  if (loading || !config || !searchHistory.source || !appLanguage.language) return <div className="loading">{error ?? '…'}</div>;
  const theme = config.appearance.theme.value;
  const backgroundTone = wallpaperTone(config.appearance.wallpaper.value);

  const addGroup = async (position?: WidgetPosition) => {
    const name = window.prompt(t('name'))?.trim();
    if (name) await actions.addGroup(name, position);
  };
  const renameGroup = async (group: ShortcutGroup) => {
    const name = window.prompt(t('name'), group.name)?.trim();
    if (name) await actions.updateGroup(group.id, name, group.collapsed);
  };
  const widgetContext: DashboardWidgetContext = {
    now: clock,
    config,
    searchPreferences: appearancePreview.search ?? config.appearance.search.value,
    searchHistorySource: searchHistory.source,
    onAddShortcut: (request = {}) => setEditing({ kind: 'new', ...request }),
    onAddGroup: (position) => { void addGroup(position); },
    onEditShortcut: setEditing,
    onDeleteShortcut: actions.deleteShortcut,
    onRenameGroup: (group) => { void renameGroup(group); },
    onDeleteGroup: async (group) => {
      if (config.shortcuts.some((item) => item.groupId === group.id)) return;
      if (window.confirm(t('confirmDeleteGroup'))) await actions.deleteGroup(group.id);
    },
    onMoveShortcut: actions.moveShortcut,
    onMoveGroup: actions.moveGroup,
    onSetWidgetEnabled: (id, enabled) => actions.setWidgetEnabled(id, enabled),
    onSetWidgetSize: async (id, preset) => {
      const layout = config.appearance.widgetLayout.value.map((item) => item.id === id ? { ...item, sizePreset: preset } : item);
      await actions.updateAppearance('widgetLayout', layout);
    },
  };

  return (
    <div className="app" data-theme={theme} data-wallpaper-tone={backgroundTone} style={{ '--blur': `${appearancePreview.blur ?? config.appearance.blur.value}px` } as React.CSSProperties}>
      <WallpaperBackdrop background={wallpaperBackground} startupFadeMs={config.appearance.wallpaperStartupFadeMs.value} />
      <div className="backdrop" />
      <button className="settingsButton shortcutWaterShell" type="button" onClick={() => setSettingsOpen(true)} aria-label={t('settings')}><span aria-hidden="true">⚙</span></button>
      <div className="content">
        <CachedPieceBoard pieces={pieces} context={widgetContext} onPiecesChanged={actions.refresh} shortcutIconRefresh={shortcutIconRefresh} />
        {config.appearance.wallpaper.value.type === 'unsplash' && <UnsplashAttribution wallpaper={config.appearance.wallpaper.value} />}
      </div>
      {editing && <ShortcutEditor shortcut={'kind' in editing ? undefined : editing} groups={config.groups} defaultGroupId={'kind' in editing ? editing.groupId ?? DEFAULT_GROUP_ID : DEFAULT_GROUP_ID}
        onSave={async (input, iconFile) => {
          const shortcut = 'kind' in editing
            ? await actions.addShortcut({ ...input, ...(input.groupId === DEFAULT_GROUP_ID ? { position: editing.position } : {}) })
            : (await actions.updateShortcut(editing.id, input), { id: editing.id });
          if (iconFile) {
            clearLoadedShortcutIcon(shortcut.id);
            await appRepositories.assets.putShortcutIcon(shortcut.id, iconFile, 'local-upload');
            await actions.refresh();
            setShortcutIconRefresh((current) => ({ shortcutId: shortcut.id, version: (current?.version ?? 0) + 1 }));
          }
        }}
        onClose={() => setEditing(undefined)} />}
      {settingsOpen && <SettingsPanel language={appLanguage.language} onLanguageChange={appLanguage.selectLanguage} searchHistorySource={searchHistory.source} onSearchHistorySourceChange={searchHistory.selectSource} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

function CachedPieceBoard({ pieces, context, onPiecesChanged, shortcutIconRefresh }: { pieces: import('../../core/domain/pieces').Piece[]; context: DashboardWidgetContext; onPiecesChanged: () => Promise<void>; shortcutIconRefresh?: { shortcutId: string; version: number } }) {
  const cache = useShortcutIconCache(context.config.shortcuts.map((shortcut) => shortcut.id), shortcutIconRefresh);
  if (!cache.ready) return null;
  return <ShortcutIconCacheProvider urls={cache.urls}><PieceBoard pieces={pieces} context={context} onPiecesChanged={onPiecesChanged} /></ShortcutIconCacheProvider>;
}

type WallpaperBackground = {
  identity: string;
  background: string;
  source: 'asset' | 'static';
  dispose?: () => void;
};

function useWallpaperBackground(wallpaper?: NonNullable<ReturnType<typeof useAppStore.getState>['config']>['appearance']['wallpaper']['value']): WallpaperBackground | undefined {
  const [localBackground, setLocalBackground] = useState<WallpaperBackground>();
  const [randomState, setRandomState] = useState<RandomWallpaperState>();
  const [bingDailyState, setBingDailyState] = useState<BingDailyState>();
  const [assetVersion, setAssetVersion] = useState(0);
  const objectUrlDisposers = useRef(new Set<() => void>());
  useEffect(() => () => {
    objectUrlDisposers.current.forEach((dispose) => dispose());
    objectUrlDisposers.current.clear();
  }, []);
  useEffect(() => appRepositories.config.subscribe(() => setAssetVersion((version) => version + 1)), []);
  useEffect(() => {
    if (wallpaper?.type !== 'wallhaven-random') {
      setRandomState(undefined);
      return;
    }
    let active = true;
    const load = () => appRepositories.config.getRandomWallpaperState().then((value) => {
      if (active) setRandomState(value);
    });
    void load();
    return appRepositories.config.subscribe(() => void load());
  }, [wallpaper?.type]);
  useEffect(() => {
    if (wallpaper?.type !== 'bing-daily') {
      setBingDailyState(undefined);
      return;
    }
    let active = true;
    const load = () => appRepositories.config.getBingDailyState().then((value) => {
      if (active) setBingDailyState(value);
    });
    void load();
    return appRepositories.config.subscribe(() => void load());
  }, [wallpaper?.type]);
  const localAsset = wallpaper?.type === 'upload'
    ? { key: wallpaper.assetKey, identity: `upload:${wallpaper.assetKey}` }
    : wallpaper?.type === 'wallhaven'
      ? { key: 'wallpaper/wallhaven-current', identity: `wallhaven:${wallpaper.imageUrl}` }
      : wallpaper?.type === 'bing'
        ? { key: 'wallpaper/bing-current', identity: `bing:${wallpaper.imageUrl}` }
      : wallpaper?.type === 'unsplash'
        ? { key: 'wallpaper/unsplash-current', identity: `unsplash:${wallpaper.imageUrl}` }
      : wallpaper?.type === 'wallhaven-random' && randomState
        ? { key: RANDOM_WALLPAPER_ASSET_KEY, identity: `wallhaven-random:${randomState.imageUrl}` }
        : wallpaper?.type === 'bing-daily' && bingDailyState
          ? { key: BING_DAILY_ASSET_KEY, identity: `bing-daily:${bingDailyState.imageUrl}` }
      : undefined;
  useEffect(() => {
    let active = true;
    if (localAsset) appRepositories.assets.getAsset(localAsset.key).then((blob) => {
      if (!blob || !active) return;
      const currentUrl = URL.createObjectURL(blob);
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        URL.revokeObjectURL(currentUrl);
        objectUrlDisposers.current.delete(dispose);
      };
      const background = `url("${currentUrl}")`;
      objectUrlDisposers.current.add(dispose);
      setLocalBackground({ identity: localAsset.identity, background, source: 'asset', dispose });
    });
    else setLocalBackground(undefined);
    return () => { active = false; };
  }, [assetVersion, localAsset?.identity]);
  return useMemo(() => {
    if (!wallpaper) return undefined;
    if (wallpaper.type === 'solid') return { identity: `solid:${wallpaper.color}`, background: wallpaper.color, source: 'static' };
    if (wallpaper.type === 'upload' || wallpaper.type === 'wallhaven' || wallpaper.type === 'bing' || wallpaper.type === 'unsplash') {
      const identity = wallpaper.type === 'upload'
        ? `upload:${wallpaper.assetKey}`
        : wallpaper.type === 'wallhaven' ? `wallhaven:${wallpaper.imageUrl}`
          : wallpaper.type === 'bing' ? `bing:${wallpaper.imageUrl}` : `unsplash:${wallpaper.imageUrl}`;
      if (localBackground?.identity === identity) return localBackground;
      return undefined;
    }
    if (wallpaper.type === 'wallhaven-random') {
      const identity = randomState ? `wallhaven-random:${randomState.imageUrl}` : undefined;
      if (localBackground?.identity === identity) return localBackground;
      return undefined;
    }
    if (wallpaper.type === 'bing-daily') {
      const identity = bingDailyState ? `bing-daily:${bingDailyState.imageUrl}` : undefined;
      if (localBackground?.identity === identity) return localBackground;
      return undefined;
    }
    return { identity: `builtin:${wallpaper.assetId}`, background: builtinWallpaperBackground(wallpaper.assetId), source: 'static' };
  }, [bingDailyState, localBackground, randomState, wallpaper]);
}

function useRandomWallpaperDisplayReady(enabled: boolean, visible: boolean): void {
  useWallpaperDisplaySignal(enabled, RANDOM_WALLPAPER_DISPLAY_PORT, 'ready');
  useWallpaperDisplaySignal(visible, RANDOM_WALLPAPER_DISPLAY_PORT, 'visible', WALLPAPER_FADE_DURATION_MS);
}

function useDailyWallpaperDisplayReady(displayed: boolean, portName: string): void {
  useWallpaperDisplaySignal(displayed, portName, 'ready');
}

function useWallpaperDisplaySignal(enabled: boolean, portName: string, signal: 'ready' | 'visible', delayMs = 0): void {
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let port: ReturnType<typeof browser.runtime.connect> | undefined;
    let nestedFrame: number | undefined;
    let timer: number | undefined;
    const frame = window.requestAnimationFrame(() => {
      nestedFrame = window.requestAnimationFrame(() => {
        if (!active) return;
        timer = window.setTimeout(() => {
          if (!active) return;
          port = browser.runtime.connect({ name: portName });
          port.postMessage({ type: signal });
        }, delayMs);
      });
    });
    return () => {
      active = false;
      window.cancelAnimationFrame(frame);
      if (nestedFrame !== undefined) window.cancelAnimationFrame(nestedFrame);
      if (timer !== undefined) window.clearTimeout(timer);
      port?.disconnect();
    };
  }, [delayMs, enabled, portName, signal]);
}

type FrozenWallpaperLayer = WallpaperBackground & {
  key: string;
  opacity: number;
};

type WallpaperLayers = {
  frozen: FrozenWallpaperLayer[];
  incoming?: FrozenWallpaperLayer;
  transitionId: number;
  startup?: boolean;
};

const WALLPAPER_FADE_DURATION_MS = 2_000;

function WallpaperBackdrop({ background, startupFadeMs }: { background?: WallpaperBackground; startupFadeMs: number }) {
  const [layers, setLayers] = useState<WallpaperLayers>(() => ({
    frozen: [],
    transitionId: 0,
  }));
  const layersRef = useRef(layers);
  const transitionId = useRef(0);
  const fallbackTimer = useRef<number | undefined>(undefined);
  const layerElements = useRef(new Map<string, HTMLDivElement>());

  const commitLayers = (next: WallpaperLayers) => {
    layersRef.current = next;
    setLayers(next);
  };
  const cancelScheduledCallbacks = () => {
    if (fallbackTimer.current !== undefined) window.clearTimeout(fallbackTimer.current);
    fallbackTimer.current = undefined;
  };
  const finishTransition = (id: number) => {
    const active = layersRef.current;
    if (active.transitionId !== id || !active.incoming) return;
    cancelScheduledCallbacks();
    const completed = active.incoming;
    commitLayers({ frozen: [{ ...completed, key: `wallpaper:stable:${id}`, opacity: 1 }], transitionId: id });
    disposeLayers(active.frozen, completed);
  };

  const freezeVisibleLayers = (active: WallpaperLayers): FrozenWallpaperLayer[] => {
    const frozen = active.frozen.map((layer) => ({ ...layer, opacity: measuredOpacity(layer, layerElements.current) }));
    if (active.incoming) {
      const opacity = measuredOpacity(active.incoming, layerElements.current);
      if (opacity > 0) frozen.push({ ...active.incoming, opacity });
    }
    return frozen.filter((layer) => layer.opacity > 0);
  };

  useEffect(() => {
    if (!background) return;
    const active = layersRef.current;
    const stableCurrent = active.frozen.length === 1 ? active.frozen[0] : undefined;
    if (stableCurrent?.identity === background.identity && stableCurrent.background === background.background && !active.incoming) return;
    if (stableCurrent?.identity === background.identity && !active.incoming) {
      const id = ++transitionId.current;
      let cancelled = false;
      void preloadWallpaper(background.background).then(() => {
        if (cancelled || id !== transitionId.current) return;
        commitLayers({ frozen: [{ ...background, key: `wallpaper:stable:${id}`, opacity: 1 }], transitionId: id });
        disposeLayers([stableCurrent], background);
      }, () => undefined);
      return () => { cancelled = true; };
    }
    if (stableCurrent?.identity === background.identity && active.incoming) {
      const id = ++transitionId.current;
      cancelScheduledCallbacks();
      disposeLayers([active.incoming], stableCurrent);
      commitLayers({ frozen: [{ ...stableCurrent, key: `wallpaper:stable:${id}`, opacity: 1 }], transitionId: id });
      return;
    }
    if (active.incoming?.identity === background.identity) return;
    const id = ++transitionId.current;
    let cancelled = false;
    const beginTransition = () => {
      if (cancelled || id !== transitionId.current) return;
      cancelScheduledCallbacks();
      const previous = layersRef.current;
      const frozen = freezeVisibleLayers(previous);
      const startup = frozen.length === 0;
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (reducedMotion || (startup && startupFadeMs === 0)) {
        commitLayers({ frozen: [{ ...background, key: `wallpaper:stable:${id}`, opacity: 1 }], transitionId: id });
        disposeLayers(frozen, background);
        return;
      }
      commitLayers({
        frozen,
        incoming: { ...background, key: `wallpaper:incoming:${id}`, opacity: 0 },
        transitionId: id,
        startup,
      });
      fallbackTimer.current = window.setTimeout(() => finishTransition(id), (startup ? startupFadeMs : WALLPAPER_FADE_DURATION_MS) + 100);
    };
    void preloadWallpaper(background.background).then(beginTransition, () => undefined);
    return () => { cancelled = true; };
  }, [background, startupFadeMs]);
  useEffect(() => () => {
    cancelScheduledCallbacks();
    disposeLayers([...layersRef.current.frozen, ...(layersRef.current.incoming ? [layersRef.current.incoming] : [])]);
  }, []);
  const style = (value: FrozenWallpaperLayer) => ({
    '--wallpaper-layer': value.background,
    '--wallpaper-layer-opacity': value.opacity,
  } as React.CSSProperties);
  const registerLayer = (key: string) => (element: HTMLDivElement | null) => {
    if (element) layerElements.current.set(key, element);
    else layerElements.current.delete(key);
  };
  const visibleCurrent = layers.incoming ?? layers.frozen.at(-1);
  return <div className={`wallpaperBackdrop ${layers.incoming ? 'wallpaperBackdrop--transitioning' : ''} ${layers.startup ? 'wallpaperBackdrop--startup' : ''}`} style={{ '--wallpaper-startup-fade': `${startupFadeMs}ms` } as React.CSSProperties} aria-hidden="true" data-wallpaper-current={visibleCurrent?.identity} data-wallpaper-source={visibleCurrent?.source} data-wallpaper-incoming={layers.incoming?.identity}>
    {layers.frozen.map((layer) => <div key={layer.key} ref={registerLayer(layer.key)} className="wallpaperLayer wallpaperLayer--frozen" data-wallpaper-layer={layer.identity} style={style(layer)} />)}
    {layers.incoming && <div key={layers.incoming.key} ref={registerLayer(layers.incoming.key)} className="wallpaperLayer wallpaperLayer--current wallpaperLayer--incoming" data-wallpaper-layer={layers.incoming.identity} style={style(layers.incoming)} onAnimationEnd={(event) => {
      if (event.animationName === 'wallpaper-dissolve' || event.animationName === 'wallpaper-startup-fade') finishTransition(layers.transitionId);
    }} />}
  </div>;
}

function measuredOpacity(layer: FrozenWallpaperLayer, elements: Map<string, HTMLDivElement>): number {
  const element = elements.get(layer.key);
  const renderedOpacity = element ? Number.parseFloat(getComputedStyle(element).opacity) : layer.opacity;
  return Number.isFinite(renderedOpacity) ? Math.min(1, Math.max(0, renderedOpacity)) : layer.opacity;
}

function disposeLayers(layers: readonly WallpaperBackground[], keep?: WallpaperBackground): void {
  const disposed = new Set<() => void>();
  for (const layer of layers) {
    if (!layer.dispose || layer.dispose === keep?.dispose || disposed.has(layer.dispose)) continue;
    disposed.add(layer.dispose);
    layer.dispose();
  }
}

function preloadWallpaper(background: string): Promise<void> {
  const url = /^url\("(.+)"\)$/.exec(background)?.[1];
  if (!url) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => { void image.decode?.().catch(() => undefined).then(resolve); };
    image.onerror = () => reject(new Error('WALLPAPER_PRELOAD_FAILED'));
    image.src = url;
  });
}

function UnsplashAttribution({ wallpaper }: { wallpaper: Extract<NonNullable<ReturnType<typeof useAppStore.getState>['config']>['appearance']['wallpaper']['value'], { type: 'unsplash' }> }) {
  return <footer className="photoAttribution">{t('photoBy')} <a href={wallpaper.photographerUrl} target="_blank" rel="noreferrer">{wallpaper.photographerName}</a> / <a href={wallpaper.sourceUrl} target="_blank" rel="noreferrer">Unsplash</a></footer>;
}
