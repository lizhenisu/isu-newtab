import { useEffect, useRef, useState } from 'react';
import { t } from '../../../../core/browser/i18n';
import type { SearchHistorySource, SearchPreferences } from '../../../../core/domain/types';
import { clearSearchHistory } from '../../../../core/search/history';
import { useAppStore } from '../../../../core/state/store';
import { useAppearancePreview } from './useAppearancePreview';
import { RangeInput } from './RangeInput';

type Props = {
  historySource: SearchHistorySource;
  onHistorySourceChange(source: SearchHistorySource): Promise<boolean>;
};

export function SearchSettings({ historySource, onHistorySourceChange }: Props) {
  const storedPreferences = useAppStore((state) => state.config!.appearance.search.value);
  const [preferences, setPreferences] = useAppearancePreview('search', storedPreferences);
  const [historyCleared, setHistoryCleared] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const draftRef = useRef(preferences);
  useEffect(() => { draftRef.current = preferences; }, [preferences]);
  const update = (patch: Partial<SearchPreferences>) => {
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next;
    setPreferences(next);
  };

  const clearHistory = async () => {
    await clearSearchHistory();
    setHistoryCleared(true);
  };
  const changeHistorySource = async (source: SearchHistorySource) => {
    const selection = onHistorySourceChange(source);
    setPermissionDenied(false);
    if (!await selection) setPermissionDenied(true);
  };
  const changeHistoryEnabled = async (enabled: boolean) => {
    update({ historyEnabled: enabled });
    if (!enabled && historySource === 'chrome') await changeHistorySource('local');
  };

  return (
    <section>
      <div className="settingsSectionHeader"><div><h3>{t('searchSettings')}</h3><p>{t('searchSettingsDescription')}</p></div></div>
      <label>{t('searchEngine')}<select aria-label={t('searchEngine')} value={preferences.engine} onChange={(event) => update({ engine: event.target.value as SearchPreferences['engine'] })}><option value="google">{t('searchEngineGoogle')}</option><option value="bing">{t('searchEngineBing')}</option></select></label>
      <label>{t('searchWidth')}<RangeInput aria-label={t('searchWidth')} min={25} max={100} step="1" value={preferences.widthPercent} onChange={(event) => update({ widthPercent: Number(event.target.value) })} /><output>{preferences.widthPercent}%</output></label>
      <label>{t('searchBackground')}<RangeInput aria-label={t('searchBackground')} min={0} max={100} step="1" value={preferences.backgroundOpacity} onChange={(event) => update({ backgroundOpacity: Number(event.target.value) })} /><output>{preferences.backgroundOpacity}%</output></label>
      <label className="settingToggle"><input type="checkbox" checked={preferences.historyEnabled} onChange={(event) => void changeHistoryEnabled(event.target.checked)} /><span>{t('searchHistory')}</span></label>
      {preferences.historyEnabled && <fieldset className="historySourceChoices"><legend>{t('searchHistorySource')}</legend>
        <button type="button" className="secondary" disabled={historySource === 'local'} onClick={() => void changeHistorySource('local')}>{t('localSearchHistory')}</button>
        <button type="button" className="secondary" disabled={historySource === 'chrome'} onClick={() => void changeHistorySource('chrome')}>{t(historySource === 'chrome' ? 'chromeSearchHistory' : 'enableChromeSearchHistory')}</button>
      </fieldset>}
      <label className="settingToggle"><input type="checkbox" checked={preferences.suggestionsEnabled} onChange={(event) => update({ suggestionsEnabled: event.target.checked })} /><span>{t('searchSuggestions')}</span></label>
      <p className="settingsHint">{t(historySource === 'chrome' ? 'chromeSearchHistoryPrivacy' : 'searchSuggestionsPrivacy')}</p>
      {permissionDenied && <p className="errorText">{t('chromeHistoryPermissionDenied')}</p>}
      {historySource === 'local' && <div className="searchHistoryActions"><button type="button" className="secondary" onClick={() => void clearHistory()}>{t('clearSearchHistory')}</button>{historyCleared && <span>{t('searchHistoryCleared')}</span>}</div>}
    </section>
  );
}
