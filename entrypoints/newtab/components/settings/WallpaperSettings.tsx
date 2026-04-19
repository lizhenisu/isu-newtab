import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties } from 'react';
import { browser } from 'wxt/browser';
import { t } from '../../../../core/browser/i18n';
import { useAppStore } from '../../../../core/state/store';
import { appRepositories } from '../../../../core/storage/repository';
import { processWallpaperImage } from '../../../../core/wallpaper/image';
import { BUILTIN_WALLPAPER_IDS, BUILTIN_WALLPAPERS } from '../../../../core/wallpaper/builtin';
import { searchWallhaven, type WallhavenPage } from '../../../../core/wallpaper/wallhaven';
import { errorMessage } from './error-message';
import { UnsplashPicker } from './UnsplashPicker';
import { BingPicker } from './BingPicker';
import { currentLanguageTag } from '../../../../core/browser/i18n';
import type { BingWallpaperQuality, Wallpaper, WallpaperRefreshInterval } from '../../../../core/domain/types';
import type { RandomWallpaperState } from '../../../../core/wallpaper/random';
import { bingImageUrlForQuality, DEFAULT_BING_WALLPAPER_QUALITY } from '../../../../core/wallpaper/bing';
import { RangeInput } from './RangeInput';

export function WallpaperSettings() {
  const wallpaper = useAppStore((state) => state.config!.appearance.wallpaper.value);
  const setWallpaper = useAppStore((state) => state.setWallpaper);
  const setSolidWallpaper = useAppStore((state) => state.setSolidWallpaper);
  const refresh = useAppStore((state) => state.refresh);
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [onlineSource, setOnlineSource] = useState<'wallhaven' | 'unsplash' | 'bing'>('wallhaven');
  const solidColor = useAppStore((state) => state.config!.appearance.solidColor.value);
  const startupFadeMs = useAppStore((state) => state.config!.appearance.wallpaperStartupFadeMs.value);
  const updateAppearance = useAppStore((state) => state.updateAppearance);
  const [bingQuality, setBingQuality] = useState<BingWallpaperQuality>(DEFAULT_BING_WALLPAPER_QUALITY);

  const reconcileOnlineWallpapers = () => Promise.all([
    browser.runtime.sendMessage({ type: 'wallpaper:random:reconcile' }).catch(() => undefined),
    browser.runtime.sendMessage({ type: 'wallpaper:bing:reconcile' }).catch(() => undefined),
  ]);

  const selectWallpaper = async (next: Wallpaper, action: 'activate' | 'reconcile' | 'bing-activate' = 'reconcile') => {
    await setWallpaper(next);
    const type = action === 'activate' ? 'wallpaper:random:activate' : action === 'bing-activate' ? 'wallpaper:bing:activate' : 'wallpaper:random:reconcile';
    await browser.runtime.sendMessage({ type }).catch(() => undefined);
    await reconcileOnlineWallpapers();
  };
  const selectSolidWallpaper = () => void setSolidWallpaper(solidColor).then(reconcileOnlineWallpapers);

  useEffect(() => {
    let active = true;
    void appRepositories.config.getBingWallpaperQuality().then((quality) => {
      if (active) setBingQuality(quality);
    });
    return () => { active = false; };
  }, []);

  const changeBingQuality = async (quality: BingWallpaperQuality) => {
    try {
      await appRepositories.config.setBingWallpaperQuality(quality);
      setBingQuality(quality);
      if (wallpaper.type === 'bing') {
        const imageUrl = bingImageUrlForQuality(wallpaper.imageUrl, quality);
        await browser.runtime.sendMessage({ type: 'wallpaper:bing:cache', url: imageUrl });
        await selectWallpaper({ ...wallpaper, imageUrl, quality });
      } else if (wallpaper.type === 'bing-daily') {
        await selectWallpaper({ type: 'bing-daily', quality }, 'bing-activate');
      }
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const image = await processWallpaperImage(file);
      await appRepositories.assets.setUploadedWallpaper(image);
      await refresh();
      await reconcileOnlineWallpapers();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      event.target.value = '';
    }
  };

  return (
    <section>
      <h3>{t('wallpaper')}</h3>
      <div className="wallpaperChoices">
        <div
          className={`colorChoice ${wallpaper.type === 'solid' ? 'active' : ''}`}
          role="button"
          tabIndex={0}
          aria-pressed={wallpaper.type === 'solid'}
          onClick={selectSolidWallpaper}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
            event.preventDefault();
            selectSolidWallpaper();
          }}
        >
          <span>{t('solid')}</span>
          <input
            type="color"
            aria-label={t('solid')}
            value={solidColor}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onChange={(event) => void setSolidWallpaper(event.target.value).then(reconcileOnlineWallpapers)}
          />
        </div>
        {BUILTIN_WALLPAPER_IDS.map((assetId) => <button key={assetId} type="button" aria-pressed={wallpaper.type === 'builtin' && wallpaper.assetId === assetId} className={`builtinPreview ${assetId} ${wallpaper.type === 'builtin' && wallpaper.assetId === assetId ? 'active' : ''}`} style={{ '--builtin-wallpaper': BUILTIN_WALLPAPERS[assetId] } as CSSProperties} onClick={() => void selectWallpaper({ type: 'builtin', assetId })}>{t(assetId)}</button>)}
        <button type="button" className={`secondary wallpaperUploadChoice ${wallpaper.type === 'upload' ? 'active' : ''}`} aria-pressed={wallpaper.type === 'upload'} onClick={() => { void reconcileOnlineWallpapers(); fileInput.current?.click(); }}>{t('upload')}</button>
        <button type="button" className={`secondary wallpaperRandomChoice ${wallpaper.type === 'wallhaven-random' ? 'active' : ''}`} aria-pressed={wallpaper.type === 'wallhaven-random'} onClick={() => void selectWallpaper({ type: 'wallhaven-random', interval: '1d' }, 'activate')}>{t('onlineRandom')}</button>
        <button type="button" className={`secondary wallpaperBingDailyChoice ${wallpaper.type === 'bing-daily' ? 'active' : ''}`} aria-pressed={wallpaper.type === 'bing-daily'} onClick={() => void selectWallpaper({ type: 'bing-daily', quality: bingQuality }, 'bing-activate')}>{t('bingDaily')}</button>
        <input ref={fileInput} type="file" accept="image/*" hidden onChange={upload} />
      </div>
      {wallpaper.type === 'wallhaven-random' && <RandomWallpaperControls interval={wallpaper.interval} onIntervalChange={(interval) => selectWallpaper({ type: 'wallhaven-random', interval })} onRefresh={() => browser.runtime.sendMessage({ type: 'wallpaper:random:activate' })} />}
      <label>{t('onlineSource')}<select value={onlineSource} onChange={(event) => setOnlineSource(event.target.value as 'wallhaven' | 'unsplash' | 'bing')}><option value="wallhaven">Wallhaven</option><option value="unsplash">Unsplash</option><option value="bing">Bing</option></select></label>
      {(onlineSource === 'bing' || wallpaper.type === 'bing' || wallpaper.type === 'bing-daily') && <label>{t('bingQuality')}<select value={bingQuality} onChange={(event) => void changeBingQuality(event.target.value as BingWallpaperQuality)}>
        <option value="1080p">{t('bingQuality1080p')}</option>
        <option value="1440p">{t('bingQuality1440p')}</option>
        <option value="4k">{t('bingQuality4k')}</option>
      </select></label>}
      {onlineSource === 'wallhaven'
        ? <WallhavenPicker onSelect={async (item) => {
          await browser.runtime.sendMessage({ type: 'wallpaper:cache', url: item.path });
          await selectWallpaper({ type: 'wallhaven', imageUrl: item.path, sourceUrl: item.url, wallpaperId: item.id });
        }} />
        : onlineSource === 'unsplash' ? <UnsplashPicker onSelect={async (item) => {
          await browser.runtime.sendMessage({ type: 'wallpaper:unsplash:cache', url: item.imageUrl });
          await selectWallpaper({ type: 'unsplash', imageUrl: item.imageUrl, sourceUrl: item.sourceUrl, photoId: item.id, photographerName: item.photographerName, photographerUrl: item.photographerUrl });
        }} /> : <BingPicker onSelect={async (item) => {
          const imageUrl = bingImageUrlForQuality(item.imageUrl, bingQuality);
          await browser.runtime.sendMessage({ type: 'wallpaper:bing:cache', url: imageUrl });
          await selectWallpaper({ type: 'bing', imageUrl, sourceUrl: item.sourceUrl, date: item.date, quality: bingQuality });
        }} />}
      <label>{t('wallpaperStartupFade')}<RangeInput min={0} max={2000} step={50} value={startupFadeMs} onChange={(event) => void updateAppearance('wallpaperStartupFadeMs', Number(event.target.value))} /><output>{startupFadeMs}ms</output></label>
      <WallpaperStatus />
      {error && <p className="errorText" role="alert">{error}</p>}
    </section>
  );
}

function RandomWallpaperControls({ interval, onIntervalChange, onRefresh }: { interval: WallpaperRefreshInterval; onIntervalChange(interval: WallpaperRefreshInterval): Promise<void>; onRefresh(): Promise<unknown> }) {
  const [state, setState] = useState<RandomWallpaperState>();
  useEffect(() => {
    let active = true;
    const load = () => appRepositories.config.getRandomWallpaperState().then((value) => { if (active) setState(value); });
    void load();
    return appRepositories.config.subscribe(() => void load());
  }, []);
  const updatedAt = state?.updatedAt ? new Intl.DateTimeFormat(currentLanguageTag(), { dateStyle: 'short', timeStyle: 'short' }).format(new Date(state.updatedAt)) : t('wallpaperLoading');
  return <div className="randomWallpaperControls">
    <label>{t('wallpaperFrequency')}<select value={interval} onChange={(event) => void onIntervalChange(event.target.value as WallpaperRefreshInterval)}><option value="1h">{t('wallpaperEveryHour')}</option><option value="5h">{t('wallpaperEveryFiveHours')}</option><option value="1d">{t('wallpaperEveryDay')}</option></select></label>
    <button type="button" className="secondary" onClick={() => void onRefresh()}>{t('wallpaperChangeNow')}</button>
    <small>{t('wallpaperLastUpdated')}: {updatedAt}</small>
  </div>;
}

function WallhavenPicker({ onSelect }: { onSelect(item: WallhavenPage['items'][number]): Promise<void> }) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<WallhavenPage>();
  const [error, setError] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [categories, setCategories] = useState([true, true, true]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      searchWallhaven(query, page, categories.map((item) => item ? '1' : '0').join(''), controller.signal).then(setResult).catch((reason) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return;
        setError(errorMessage(reason));
      });
    }, 500);
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [categories, enabled, page, query]);

  const select = async (item: WallhavenPage['items'][number]) => {
    try {
      setError('');
      await onSelect(item);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  return (
    <div className="wallhavenPicker">
      <input value={query} placeholder={t('wallhavenSearch')} onFocus={() => setEnabled(true)} onChange={(event) => { setEnabled(true); setQuery(event.target.value); setPage(1); }} />
      <div className="categoryChoices">{(['general', 'anime', 'people'] as const).map((name, index) => <label key={name}><input type="checkbox" checked={categories[index]} onChange={(event) => setCategories((current) => {
        if (!event.target.checked && current.filter(Boolean).length === 1) return current;
        return current.map((value, itemIndex) => itemIndex === index ? event.target.checked : value);
      })} />{t(name)}</label>)}</div>
      {error && <small className="errorText">{error}</small>}
      {result && !result.items.length && <small>{t('noWallpapers')}</small>}
      {result && <><div className="wallhavenGrid">{result.items.map((item) => <button type="button" key={item.id} onClick={() => select(item)}><img src={item.thumbs.large} alt="" loading="lazy" /></button>)}</div><div className="pager"><button type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>{t('previous')}</button><span>{page}/{result.lastPage}</span><button type="button" disabled={page >= result.lastPage} onClick={() => setPage((value) => value + 1)}>{t('next')}</button></div></>}
    </div>
  );
}

function WallpaperStatus() {
  const wallpaper = useAppStore((state) => state.config?.appearance.wallpaper.value);
  const [status, setStatus] = useState<{ state?: string; message?: string }>();
  useEffect(() => {
    browser.storage.local.get('wallpaperStatus').then((value) => setStatus(value.wallpaperStatus as typeof status));
    const listener = (changes: Record<string, Browser.storage.StorageChange>) => {
      if (changes.wallpaperStatus) setStatus(changes.wallpaperStatus.newValue as typeof status);
    };
    browser.storage.local.onChanged.addListener(listener);
    return () => browser.storage.local.onChanged.removeListener(listener);
  }, []);
  if (status?.state !== 'error' || (wallpaper?.type !== 'wallhaven' && wallpaper?.type !== 'wallhaven-random' && wallpaper?.type !== 'bing' && wallpaper?.type !== 'bing-daily' && wallpaper?.type !== 'unsplash')) return null;
  const request = wallpaper.type === 'wallhaven-random'
    ? { type: 'wallpaper:random:activate' }
    : wallpaper.type === 'bing-daily' ? { type: 'wallpaper:bing:activate' }
      : wallpaper.type === 'bing' ? { type: 'wallpaper:bing:cache', url: wallpaper.imageUrl }
        : wallpaper.type === 'unsplash' ? { type: 'wallpaper:unsplash:cache', url: wallpaper.imageUrl }
          : { type: 'wallpaper:cache', url: wallpaper.imageUrl };
  return <div className="wallpaperStatus"><small className="errorText">{status.message}</small><button type="button" className="secondary" onClick={() => browser.runtime.sendMessage(request)}>{t('retry')}</button></div>;
}
