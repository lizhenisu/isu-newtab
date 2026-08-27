import type { AppLanguage } from '../domain/types';
import { getDatabase } from '../storage/database';

export async function getAppLanguagePreference(): Promise<AppLanguage> {
  const value = await (await getDatabase()).get('settings', 'appLanguage');
  return value === 'zh_CN' || value === 'zh_HK' || value === 'zh_TW' || value === 'ko' || value === 'ja' || value === 'en' ? value : 'system';
}

export async function setAppLanguagePreference(language: AppLanguage): Promise<void> {
  await (await getDatabase()).put('settings', language, 'appLanguage');
}
