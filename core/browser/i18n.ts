import { browser } from 'wxt/browser';
import type { AppLanguage } from '../domain/types';
import english from '../../public/_locales/en/messages.json';
import chinese from '../../public/_locales/zh_CN/messages.json';
import chineseHongKong from '../../public/_locales/zh_HK/messages.json';
import chineseTaiwan from '../../public/_locales/zh_TW/messages.json';
import japanese from '../../public/_locales/ja/messages.json';
import korean from '../../public/_locales/ko/messages.json';

type Messages = Record<string, { message: string }>;
type ResolvedLanguage = Exclude<AppLanguage, 'system'>;

const dictionaries: Record<ResolvedLanguage, Messages> = {
  en: english,
  zh_CN: chinese,
  zh_HK: chineseHongKong,
  zh_TW: chineseTaiwan,
  ko: korean,
  ja: japanese,
};
let language: AppLanguage = 'system';

export function t(key: string): string {
  if (typeof browser.i18n.getUILanguage !== 'function') {
    return browser.i18n.getMessage(key as Parameters<typeof browser.i18n.getMessage>[0]) || key;
  }

  const dictionary = dictionaries[resolveLanguage(language)];
  return dictionary[key]?.message ?? (browser.i18n.getMessage(key as Parameters<typeof browser.i18n.getMessage>[0]) || key);
}

export function setAppLanguage(value: AppLanguage): void {
  language = value;
}

export function resolveLanguage(value: AppLanguage): ResolvedLanguage {
  if (value !== 'system') return value;
  const browserLanguage = browser.i18n.getUILanguage?.().replace('_', '-').toLocaleLowerCase();
  if (!browserLanguage) return 'en';
  const [primary, secondSubtag, thirdSubtag] = browserLanguage.split('-');
  const script = secondSubtag?.length === 4 ? secondSubtag : undefined;
  const region = thirdSubtag ?? (script ? undefined : secondSubtag);
  if (primary === 'zh') {
    if (region === 'hk' || region === 'mo') return 'zh_HK';
    if (region === 'tw' || script === 'hant') return 'zh_TW';
    return 'zh_CN';
  }
  if (primary === 'ko') return 'ko';
  if (primary === 'ja') return 'ja';
  return 'en';
}

export function documentLanguage(value: AppLanguage): string {
  return {
    zh_CN: 'zh-CN',
    zh_HK: 'zh-HK',
    zh_TW: 'zh-TW',
    ko: 'ko',
    ja: 'ja',
    en: 'en',
  }[resolveLanguage(value)];
}

export function currentLanguageTag(): string {
  return documentLanguage(language);
}
