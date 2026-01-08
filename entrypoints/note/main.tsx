import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { t } from '../../core/browser/i18n';
import { wallpaperTone } from '../../core/domain/wallpaper-tone';
import { appRepositories } from '../../core/storage/repository';
import { useAppStore } from '../../core/state/store';
import { useAppLanguage } from '../newtab/hooks/useAppLanguage';
import { QuickNote } from '../newtab/components/QuickNote';
import { useWallpaperBackground, WallpaperBackdrop } from '../newtab/App';
import '../newtab/style.css';
import './style.css';

function NotePage() {
  const config = useAppStore((state) => state.config);
  const loading = useAppStore((state) => state.loading);
  const error = useAppStore((state) => state.error);
  const initialize = useAppStore((state) => state.initialize);
  const refresh = useAppStore((state) => state.refresh);
  const updateQuickNote = useAppStore((state) => state.updateQuickNote);
  const language = useAppLanguage();

  useEffect(() => {
    void initialize();
    return appRepositories.config.subscribe(() => void refresh());
  }, [initialize, refresh]);
  useEffect(() => { if (language.language) document.title = t('quickNote'); }, [language.language]);

  const background = useWallpaperBackground(config?.appearance.wallpaper.value);
  if (loading || !config || !language.language) return <div className="loading">{error ?? '…'}</div>;
  const theme = config.appearance.theme.value;
  const tone = wallpaperTone(config.appearance.wallpaper.value);
  return <div className="app noteApp" data-theme={theme} data-wallpaper-tone={tone} style={{ '--blur': `${config.appearance.blur.value}px` } as React.CSSProperties}>
    <WallpaperBackdrop background={background} startupFadeMs={config.appearance.wallpaperStartupFadeMs.value} />
    <div className="backdrop" />
    <main className="notePage" aria-label={t('quickNote')}>
      <QuickNote expanded value={config.quickNote?.value ?? ''} onChange={updateQuickNote} />
    </main>
  </div>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><NotePage /></React.StrictMode>);
