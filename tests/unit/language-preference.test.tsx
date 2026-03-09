import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import english from '../../public/_locales/en/messages.json';
import chinese from '../../public/_locales/zh_CN/messages.json';
import chineseHongKong from '../../public/_locales/zh_HK/messages.json';
import chineseTaiwan from '../../public/_locales/zh_TW/messages.json';
import japanese from '../../public/_locales/ja/messages.json';
import korean from '../../public/_locales/ko/messages.json';
import { documentLanguage, resolveLanguage, setAppLanguage, t } from '../../core/browser/i18n';
import { getAppLanguagePreference, setAppLanguagePreference } from '../../core/browser/language-preference';
import { getDatabase } from '../../core/storage/database';
import { LanguageSettings } from '../../entrypoints/newtab/components/settings/LanguageSettings';

beforeEach(async () => {
  await (await getDatabase()).delete('settings', 'appLanguage');
  setAppLanguage('system');
});

afterEach(() => {
  cleanup();
  setAppLanguage('system');
  vi.clearAllMocks();
});

describe('app language preference', () => {
  it('defaults to the browser language and persists only on this device', async () => {
    await expect(getAppLanguagePreference()).resolves.toBe('system');

    await setAppLanguagePreference('zh_HK');

    await expect(getAppLanguagePreference()).resolves.toBe('zh_HK');
    await (await getDatabase()).put('settings', 'unsupported' as never, 'appLanguage');
    await expect(getAppLanguagePreference()).resolves.toBe('system');
  });

  it('uses each selected dictionary and resolves browser languages by region', () => {
    const original = browser.i18n.getUILanguage;
    Object.assign(browser.i18n, { getUILanguage: () => 'en-US' });

    setAppLanguage('en');
    expect(t('settings')).toBe('Settings');
    setAppLanguage('zh_CN');
    expect(t('settings')).toBe('设置');
    setAppLanguage('zh_HK');
    expect(t('settings')).toBe('設定');
    setAppLanguage('zh_TW');
    expect(t('settings')).toBe('設定');
    setAppLanguage('ko');
    expect(t('settings')).toBe('설정');
    setAppLanguage('ja');
    expect(t('settings')).toBe('設定');

    for (const [browserLanguage, expected] of [
      ['zh-HK', 'zh_HK'], ['zh-MO', 'zh_HK'], ['zh-TW', 'zh_TW'], ['zh-Hant', 'zh_TW'], ['zh-CN', 'zh_CN'], ['ko-KR', 'ko'], ['ja-JP', 'ja'], ['fr-FR', 'en'],
    ] as const) {
      Object.assign(browser.i18n, { getUILanguage: () => browserLanguage });
      expect(resolveLanguage('system')).toBe(expected);
    }
    expect(documentLanguage('zh_HK')).toBe('zh-HK');
    expect(documentLanguage('zh_TW')).toBe('zh-TW');
    expect(documentLanguage('ko')).toBe('ko');
    expect(documentLanguage('ja')).toBe('ja');

    Object.assign(browser.i18n, { getUILanguage: original });
  });

  it('keeps all locale message keys aligned and renders the seven language choices', () => {
    const keys = Object.keys(english).sort();
    for (const dictionary of [chinese, chineseHongKong, chineseTaiwan, korean, japanese]) {
      expect(Object.keys(dictionary).sort()).toEqual(keys);
    }
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<LanguageSettings language="system" onChange={onChange} />);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'ja' } });

    expect(onChange).toHaveBeenCalledWith('ja');
    expect(screen.getByRole('option', { name: '简体中文' })).toBeVisible();
    expect(screen.getByRole('option', { name: '香港繁體中文' })).toBeVisible();
    expect(screen.getByRole('option', { name: '臺灣正體中文' })).toBeVisible();
    expect(screen.getByRole('option', { name: '한국어' })).toBeVisible();
    expect(screen.getByRole('option', { name: '日本語' })).toBeVisible();
    expect(screen.getByRole('option', { name: 'English' })).toBeVisible();
  });
});
