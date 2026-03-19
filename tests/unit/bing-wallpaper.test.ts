import { afterEach, describe, expect, it, vi } from 'vitest';
import { bingImageUrlForQuality, bingMarketForLanguage, fetchBingWallpapers, isBingDailyState, nextBingDailyState, normalizeBingDailyState, retryBingDailyState } from '../../core/wallpaper/bing';
import { wallpaperSchema } from '../../core/domain/schema';

afterEach(() => vi.unstubAllGlobals());

describe('Bing daily wallpaper', () => {
  it('maps interface languages to Bing markets', () => {
    expect(bingMarketForLanguage('zh_CN')).toBe('zh-CN');
    expect(bingMarketForLanguage('zh_HK')).toBe('zh-HK');
    expect(bingMarketForLanguage('zh_TW')).toBe('zh-TW');
    expect(bingMarketForLanguage('ko')).toBe('ko-KR');
    expect(bingMarketForLanguage('ja')).toBe('ja-JP');
    expect(bingMarketForLanguage('en')).toBe('en-US');
  });

  it('normalizes only Bing image archive records', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      images: [{ startdate: '20260826', url: '/th?id=OHR.Test_ZH-CN123_1920x1080.jpg&pid=hp', copyrightlink: '/search?q=test' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchBingWallpapers('zh-CN', 8)).resolves.toEqual([{
      date: '20260826',
      imageUrl: 'https://www.bing.com/th?id=OHR.Test_ZH-CN123_1920x1080.jpg&pid=hp',
      sourceUrl: 'https://www.bing.com/search?q=test',
    }]);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('mkt=zh-CN');
    expect(String(fetchMock.mock.calls[0]![0])).toContain('n=8');
  });

  it('rejects archive payloads with a non-Bing image path', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      images: [{ startdate: '20260826', url: 'https://example.com/image.jpg' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    await expect(fetchBingWallpapers('en-US')).rejects.toThrow();
  });

  it('constructs only safe Bing image URLs for each requested quality', () => {
    const imageUrl = 'https://www.bing.com/th?id=OHR.Test_1920x1080.jpg&pid=hp';
    expect(bingImageUrlForQuality(imageUrl, '1080p')).toContain('w=1920&h=1080&rs=1&c=4');
    expect(bingImageUrlForQuality(imageUrl, '1440p')).toContain('w=2560&h=1440&rs=1&c=4');
    expect(bingImageUrlForQuality(imageUrl, '4k')).toContain('w=3840&h=2160&rs=1&c=4');
    expect(() => bingImageUrlForQuality('https://example.com/image.jpg', '4k')).toThrow('WALLPAPER_URL_NOT_ALLOWED');
  });

  it('schedules the next daily check and retries hourly while Bing still serves the old date', () => {
    const state = nextBingDailyState({ date: '20260826', imageUrl: 'https://www.bing.com/th?id=OHR.Test_1920x1080.jpg', sourceUrl: 'https://www.bing.com/th?id=OHR.Test_1920x1080.jpg' }, 'zh-CN', '1440p', new Date(2026, 7, 26, 10));
    expect(state.quality).toBe('1440p');
    expect(state.imageUrl).toContain('w=2560&h=1440');
    expect(state.nextRefreshAt).toBe(new Date(2026, 7, 27, 0, 5).toISOString());
    const retry = retryBingDailyState(state, new Date(2026, 7, 27, 0, 5));
    expect(retry.nextRefreshAt).toBe(new Date(2026, 7, 27, 1, 5).toISOString());
    expect(isBingDailyState(retry)).toBe(true);
  });

  it('treats legacy local daily state as 1080p', () => {
    const state = normalizeBingDailyState({
      date: '20260826',
      market: 'en-US',
      imageUrl: 'https://www.bing.com/th?id=OHR.Test_1920x1080.jpg&pid=hp',
      sourceUrl: 'https://www.bing.com/search?q=test',
      updatedAt: '2026-08-26T00:00:00.000Z',
      nextRefreshAt: '2026-08-27T00:05:00.000Z',
    });
    expect(state?.quality).toBe('1080p');
    expect(wallpaperSchema.parse({ type: 'bing-daily' })).toEqual({ type: 'bing-daily', quality: '1080p' });
    expect(wallpaperSchema.parse({
      type: 'bing',
      imageUrl: 'https://www.bing.com/th?id=OHR.Test_1920x1080.jpg&pid=hp',
      sourceUrl: 'https://www.bing.com/search?q=test',
      date: '20260826',
    })).toMatchObject({ quality: '1080p' });
  });
});
