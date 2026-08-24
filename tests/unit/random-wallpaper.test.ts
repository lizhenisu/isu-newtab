import { afterEach, describe, expect, it, vi } from 'vitest';
import { chooseRandomWallhaven, nextRandomWallpaperState, wallpaperRefreshIntervalMs } from '../../core/wallpaper/random';
import { fetchWallhavenRandom } from '../../core/wallpaper/wallhaven';

afterEach(() => vi.unstubAllGlobals());

const wallhavenResponse = {
  data: [
    { id: 'old', url: 'https://wallhaven.cc/w/old', thumbs: { large: 'https://th.wallhaven.cc/lg/ol/old.jpg' }, path: 'https://w.wallhaven.cc/full/ol/wallhaven-old.jpg' },
    { id: 'new', url: 'https://wallhaven.cc/w/new', thumbs: { large: 'https://th.wallhaven.cc/lg/ne/new.jpg' }, path: 'https://w.wallhaven.cc/full/ne/wallhaven-new.jpg' },
  ],
  meta: { current_page: 1, last_page: 1 },
};

describe('random Wallhaven wallpaper', () => {
  it('uses fresh SFW random batches and excludes the current wallpaper when possible', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(wallhavenResponse), { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    const items = await fetchWallhavenRandom();
    const selected = await chooseRandomWallhaven('old');

    expect(items).toHaveLength(2);
    expect(selected.wallpaperId).toBe('new');
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.get('sorting')).toBe('random');
    expect(url.searchParams.get('purity')).toBe('100');
    expect(url.searchParams.get('categories')).toBe('111');
  });

  it('maps every configured interval and creates a local next refresh timestamp', () => {
    expect(wallpaperRefreshIntervalMs('1h')).toBe(60 * 60_000);
    expect(wallpaperRefreshIntervalMs('5h')).toBe(5 * 60 * 60_000);
    expect(wallpaperRefreshIntervalMs('1d')).toBe(24 * 60 * 60_000);
    expect(nextRandomWallpaperState({ imageUrl: 'https://w.wallhaven.cc/full/ne/wallhaven-new.jpg', sourceUrl: 'https://wallhaven.cc/w/new', wallpaperId: 'new' }, '1h', new Date('2026-08-23T00:00:00Z')).nextRefreshAt).toBe('2026-08-23T01:00:00.000Z');
  });
});
