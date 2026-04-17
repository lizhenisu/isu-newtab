import { t } from '../../../../core/browser/i18n';
import type { AppLanguage } from '../../../../core/domain/types';

export function LanguageSettings({ language, onChange }: { language: AppLanguage; onChange(language: AppLanguage): Promise<void> }) {
  return (
    <section>
      <h3>{t('language')}</h3>
      <label>{t('language')}<select value={language} onChange={(event) => void onChange(event.target.value as AppLanguage)}>
        <option value="system">{t('followBrowserLanguage')}</option>
        <option value="zh_CN">简体中文</option>
        <option value="zh_HK">香港繁體中文</option>
        <option value="zh_TW">臺灣正體中文</option>
        <option value="ko">한국어</option>
        <option value="ja">日本語</option>
        <option value="en">English</option>
      </select></label>
    </section>
  );
}
