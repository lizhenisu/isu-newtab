import { useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { t } from '../../core/browser/i18n';
import { DEFAULT_GROUP_ID, type Shortcut, type ShortcutGroup } from '../../core/domain/types';
import { DEFAULT_SOLID_WALLPAPER_COLOR } from '../../core/domain/defaults';
import { wallpaperTone } from '../../core/domain/wallpaper-tone';
import { builtinWallpaperBackground } from '../../core/wallpaper/builtin';
import { createWallpaperBootstrapThumbnail, getWallpaperBootstrapPreview, setWallpaperBootstrapPreview } from '../../core/wallpaper/bootstrap-preview';
import { RANDOM_WALLPAPER_ASSET_KEY, RANDOM_WALLPAPER_DISPLAY_PORT, type RandomWallpaperState } from '../../core/wallpaper/random';
import type { WidgetPosition } from '../../core/domain/widgets';
import { appRepositories } from '../../core/storage/repository';
import { useAppStore } from '../../core/state/store';
import { SettingsPanel } from './components/SettingsPanel';
import { ShortcutEditor } from './components/ShortcutEditor';
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
  const [clock, setClock] = useState(() => new Date());
  const searchHistory = useSearchHistorySource();
  const appLanguage = useAppLanguage();

  useEffect(() => { void initialize(); return appRepositories.config.subscribe(() => void refresh()); }, [initialize, refresh]);
  useEffect(() => { const timer = window.setInterval(() => setClock(new Date()), 1000); return () => window.clearInterval(timer); }, []);
  const wallpaperBackground = useWallpaperBackground(config?.appearance.wallpaper.value);

  useRandomWallpaperDisplayReady(
    wallpaperBackground?.source === 'asset' && wallpaperBackground.identity.startsWith('wallhaven-random:'),
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
      <WallpaperBackdrop background={wallpaperBackground} />
      <div className="backdrop" />
      <button className="settingsButton" type="button" onClick={() => setSettingsOpen(true)} aria-label={t('settings')}>⚙</button>
      <div className="content">
        <PieceBoard pieces={pieces} context={widgetContext} onPiecesChanged={actions.refresh} />
        {config.appearance.wallpaper.value.type === 'unsplash' && <UnsplashAttribution wallpaper={config.appearance.wallpaper.value} />}
      </div>
      {editing && <ShortcutEditor shortcut={'kind' in editing ? undefined : editing} groups={config.groups} defaultGroupId={'kind' in editing ? editing.groupId ?? DEFAULT_GROUP_ID : DEFAULT_GROUP_ID}
        onSave={(input) => 'kind' in editing ? actions.addShortcut({ ...input, ...(input.groupId === DEFAULT_GROUP_ID ? { position: editing.position } : {}) }) : actions.updateShortcut(editing.id, input)}
        onClose={() => setEditing(undefined)} />}
      {settingsOpen && <SettingsPanel language={appLanguage.language} onLanguageChange={appLanguage.selectLanguage} searchHistorySource={searchHistory.source} onSearchHistorySourceChange={searchHistory.selectSource} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

type WallpaperBackground = {
  identity: string;
  background: string;
  source: 'asset' | 'bootstrap' | 'static';
  dispose?: () => void;
};

function useWallpaperBackground(wallpaper?: NonNullable<ReturnType<typeof useAppStore.getState>['config']>['appearance']['wallpaper']['value']): WallpaperBackground | undefined {
  const [localBackground, setLocalBackground] = useState<WallpaperBackground>();
  const [bootstrapPreview] = useState(getWallpaperBootstrapPreview);
  const [randomState, setRandomState] = useState<RandomWallpaperState>();
  const objectUrlDisposers = useRef(new Set<() => void>());
  useEffect(() => () => {
    objectUrlDisposers.current.forEach((dispose) => dispose());
    objectUrlDisposers.current.clear();
  }, []);
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
  const randomBootstrapIdentity = bootstrapPreview?.identity.startsWith('wallhaven-random:') ? bootstrapPreview.identity : undefined;
  const localAsset = wallpaper?.type === 'upload'
    ? { key: wallpaper.assetKey, identity: `upload:${wallpaper.assetKey}` }
    : wallpaper?.type === 'wallhaven'
      ? { key: 'wallpaper/wallhaven-current', identity: `wallhaven:${wallpaper.imageUrl}` }
      : wallpaper?.type === 'wallhaven-random' && (randomState || randomBootstrapIdentity)
        ? { key: RANDOM_WALLPAPER_ASSET_KEY, identity: randomState ? `wallhaven-random:${randomState.imageUrl}` : randomBootstrapIdentity! }
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
      if (bootstrapPreview?.identity !== localAsset.identity) {
        void createWallpaperBootstrapThumbnail(blob).then((preview) => {
          if (active) setWallpaperBootstrapPreview({ identity: localAsset.identity, background: preview });
        }).catch(() => undefined);
      }
    });
    else setLocalBackground(undefined);
    return () => { active = false; };
  }, [bootstrapPreview?.identity, localAsset?.identity]);
  useEffect(() => {
    if (!wallpaper) return;
    if (wallpaper.type === 'solid') setWallpaperBootstrapPreview({ identity: `solid:${wallpaper.color}`, background: wallpaper.color });
    else if (wallpaper.type === 'builtin') setWallpaperBootstrapPreview({ identity: `builtin:${wallpaper.assetId}`, background: builtinWallpaperBackground(wallpaper.assetId) });
    else if (wallpaper.type === 'unsplash') setWallpaperBootstrapPreview({ identity: `unsplash:${wallpaper.imageUrl}`, background: `url("${wallpaper.imageUrl}")` });
  }, [wallpaper]);
  return useMemo(() => {
    if (!wallpaper) return bootstrapPreview ? { identity: bootstrapPreview.identity, background: bootstrapPreview.background, source: 'bootstrap' } : undefined;
    if (wallpaper.type === 'solid') return { identity: `solid:${wallpaper.color}`, background: wallpaper.color, source: 'static' };
    if (wallpaper.type === 'upload' || wallpaper.type === 'wallhaven') {
      const identity = wallpaper.type === 'upload' ? `upload:${wallpaper.assetKey}` : `wallhaven:${wallpaper.imageUrl}`;
      if (localBackground?.identity === identity) return localBackground;
      return bootstrapPreview?.identity === identity ? { identity, background: bootstrapPreview.background, source: 'bootstrap' } : undefined;
    }
    if (wallpaper.type === 'wallhaven-random') {
      const identity = randomState ? `wallhaven-random:${randomState.imageUrl}` : undefined;
      if (localBackground?.identity === identity) return localBackground;
      if (identity && bootstrapPreview?.identity === identity) return { identity, background: bootstrapPreview.background, source: 'bootstrap' };
      return bootstrapPreview?.identity.startsWith('wallhaven-random:')
        ? { identity: bootstrapPreview.identity, background: bootstrapPreview.background, source: 'bootstrap' }
        : undefined;
    }
    if (wallpaper.type === 'unsplash') return { identity: `unsplash:${wallpaper.imageUrl}`, background: `url("${wallpaper.imageUrl}")`, source: 'static' };
    return { identity: `builtin:${wallpaper.assetId}`, background: builtinWallpaperBackground(wallpaper.assetId), source: 'static' };
  }, [bootstrapPreview, localBackground, randomState, wallpaper]);
}

function useRandomWallpaperDisplayReady(displayed: boolean): void {
  useEffect(() => {
    if (!displayed) return;
    let active = true;
    let port: ReturnType<typeof browser.runtime.connect> | undefined;
    let nestedFrame: number | undefined;
    const frame = window.requestAnimationFrame(() => {
      nestedFrame = window.requestAnimationFrame(() => {
        if (!active) return;
        port = browser.runtime.connect({ name: RANDOM_WALLPAPER_DISPLAY_PORT });
        port.postMessage({ type: 'ready' });
      });
    });
    return () => {
      active = false;
      window.cancelAnimationFrame(frame);
      if (nestedFrame !== undefined) window.cancelAnimationFrame(nestedFrame);
      port?.disconnect();
    };
  }, [displayed]);
}

type FrozenWallpaperLayer = WallpaperBackground & {
  key: string;
  opacity: number;
};

type WallpaperLayers = {
  frozen: FrozenWallpaperLayer[];
  incoming?: FrozenWallpaperLayer;
  transitionId: number;
};

const WALLPAPER_FADE_DURATION_MS = 2_000;

function WallpaperBackdrop({ background }: { background?: WallpaperBackground }) {
  const initialBackground = useRef<WallpaperBackground>({ identity: 'initial-white', background: DEFAULT_SOLID_WALLPAPER_COLOR, source: 'static' }).current;
  const [layers, setLayers] = useState<WallpaperLayers>(() => ({
    frozen: [{ ...(background ?? initialBackground), key: 'wallpaper:initial', opacity: 1 }],
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
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        commitLayers({ frozen: [{ ...background, key: `wallpaper:stable:${id}`, opacity: 1 }], transitionId: id });
        disposeLayers(frozen, background);
        return;
      }
      commitLayers({
        frozen,
        incoming: { ...background, key: `wallpaper:incoming:${id}`, opacity: 0 },
        transitionId: id,
      });
      fallbackTimer.current = window.setTimeout(() => finishTransition(id), WALLPAPER_FADE_DURATION_MS + 100);
    };
    void preloadWallpaper(background.background).then(beginTransition, () => undefined);
    return () => { cancelled = true; };
  }, [background]);
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
  return <div className={`wallpaperBackdrop ${layers.incoming ? 'wallpaperBackdrop--transitioning' : ''}`} aria-hidden="true" data-wallpaper-current={visibleCurrent?.identity} data-wallpaper-source={visibleCurrent?.source} data-wallpaper-incoming={layers.incoming?.identity}>
    {layers.frozen.map((layer) => <div key={layer.key} ref={registerLayer(layer.key)} className="wallpaperLayer wallpaperLayer--frozen" data-wallpaper-layer={layer.identity} style={style(layer)} />)}
    {layers.incoming && <div key={layers.incoming.key} ref={registerLayer(layers.incoming.key)} className="wallpaperLayer wallpaperLayer--current wallpaperLayer--incoming" data-wallpaper-layer={layers.incoming.identity} style={style(layers.incoming)} onAnimationEnd={(event) => {
      if (event.animationName === 'wallpaper-dissolve') finishTransition(layers.transitionId);
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
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('WALLPAPER_PRELOAD_FAILED'));
    image.src = url;
  });
}

function UnsplashAttribution({ wallpaper }: { wallpaper: Extract<NonNullable<ReturnType<typeof useAppStore.getState>['config']>['appearance']['wallpaper']['value'], { type: 'unsplash' }> }) {
  return <footer className="photoAttribution">{t('photoBy')} <a href={wallpaper.photographerUrl} target="_blank" rel="noreferrer">{wallpaper.photographerName}</a> / <a href={wallpaper.sourceUrl} target="_blank" rel="noreferrer">Unsplash</a></footer>;
}
