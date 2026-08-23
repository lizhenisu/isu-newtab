import { t } from '../../../core/browser/i18n';
import { Modal } from './Modal';
import { AppearanceSettings } from './settings/AppearanceSettings';
import { BackupSettings } from './settings/BackupSettings';
import { SyncSettings } from './settings/SyncSettings';
import { SearchSettings } from './settings/SearchSettings';
import { WallpaperSettings } from './settings/WallpaperSettings';
import { WidgetSettings } from './settings/WidgetSettings';
import { LanguageSettings } from './settings/LanguageSettings';
import { SoftwareInfoSettings } from './settings/SoftwareInfoSettings';
import { WeatherSettings } from './settings/WeatherSettings';
import type { AppLanguage, SearchHistorySource } from '../../../core/domain/types';

type Props = {
  language: AppLanguage;
  onLanguageChange(language: AppLanguage): Promise<void>;
  searchHistorySource: SearchHistorySource;
  onSearchHistorySourceChange(source: SearchHistorySource): Promise<boolean>;
  onClose(): void;
};

export function SettingsPanel({ language, onLanguageChange, searchHistorySource, onSearchHistorySourceChange, onClose }: Props) {
  return (
    <Modal title={t('settings')} onClose={onClose} variant="drawer">
      <div className="settings">
        <AppearanceSettings />
        <LanguageSettings language={language} onChange={onLanguageChange} />
        <WidgetSettings />
        <WeatherSettings />
        <SearchSettings historySource={searchHistorySource} onHistorySourceChange={onSearchHistorySourceChange} />
        <WallpaperSettings />
        <SyncSettings />
        <BackupSettings />
        <SoftwareInfoSettings />
      </div>
    </Modal>
  );
}
