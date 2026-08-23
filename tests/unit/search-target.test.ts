import { describe, expect, it } from 'vitest';
import { buildTextSearchTarget, buildVisualSearchTarget } from '../../core/search/search-target';

describe('search target builder', () => {
  it('builds localized, encoded Google text and visual targets', () => {
    expect(buildTextSearchTarget('google', ' C++ & Chrome ', 'zh-CN')).toBe('https://www.google.com/search?q=C%2B%2B+%26+Chrome&hl=zh-CN');
    expect(buildVisualSearchTarget('google', 'en-US')).toBe('https://images.google.com/?hl=en');
  });

  it('builds localized Bing text and visual targets', () => {
    expect(buildTextSearchTarget('bing', 'hello world', 'en')).toBe('https://www.bing.com/search?q=hello+world&setlang=en-US');
    expect(buildVisualSearchTarget('bing', 'zh-TW')).toBe('https://www.bing.com/images?setlang=zh-Hans');
  });
});
