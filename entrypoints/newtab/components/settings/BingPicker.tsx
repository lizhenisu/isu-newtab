import { useEffect, useState } from 'react';
import { currentLanguageTag, t } from '../../../../core/browser/i18n';
import { getAppLanguagePreference } from '../../../../core/browser/language-preference';
import { bingMarketForLanguage, fetchBingWallpapers, type BingWallpaper } from '../../../../core/wallpaper/bing';
import { errorMessage } from './error-message';

export function BingPicker({ onSelect }: { onSelect(item: BingWallpaper): Promise<void> }) {
  const [items, setItems] = useState<BingWallpaper[]>();
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    void getAppLanguagePreference()
      .then((language) => fetchBingWallpapers(bingMarketForLanguage(language), 8, controller.signal))
      .then((value) => setItems(value))
      .catch((reason) => {
        if (!(reason instanceof DOMException && reason.name === 'AbortError')) setError(errorMessage(reason));
      });
    return () => controller.abort();
  }, []);

  return <div className="wallhavenPicker bingPicker">
    <small>{t('bingRecent')}</small>
    {error && <small className="errorText">{error}</small>}
    {items && <div className="wallhavenGrid bingGrid">{items.map((item) => <figure key={item.date}>
      <button type="button" onClick={() => void onSelect(item)} aria-label={`${t('bingDaily')} ${formatDate(item.date)}`}><img src={item.imageUrl} alt="" loading="lazy" /></button>
      <figcaption>{formatDate(item.date)}</figcaption>
    </figure>)}</div>}
  </div>;
}

function formatDate(value: string): string {
  const date = new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T12:00:00`);
  return new Intl.DateTimeFormat(currentLanguageTag(), { dateStyle: 'medium' }).format(date);
}
