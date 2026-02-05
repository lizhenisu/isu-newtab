import { afterEach, describe, expect, it, vi } from 'vitest';
import { nativeShortcutIconUrl, shortcutIconAssetKey, shortcutIconSources, validateShortcutIconBlob } from '../../core/domain/shortcut-icons';
import { appRepositories } from '../../core/storage/repository';
import { clearLoadedShortcutIcon, loadShortcutIcon } from '../../entrypoints/newtab/components/shortcut-icon-loader';

afterEach(() => {
  clearLoadedShortcutIcon('deepseek');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('shortcut icon sources', () => {
  it('uses a 128px native favicon for the immediate visual', () => {
    expect(nativeShortcutIconUrl('https://example.com/path')).toContain('size=128');
  });

  it('orders remote providers for restricted-network fallback without exposing a URL path to domain services', () => {
    const sources = shortcutIconSources('https://example.com/private/path?token=secret');
    expect(sources.map((source) => source.provider)).toEqual(['google-s2', 'gstatic', 'favicon-im', 'duckduckgo']);
    expect(sources[0]!.url).toContain('domain_url=https%3A%2F%2Fexample.com');
    expect(sources[1]!.url).toContain('url=https%3A%2F%2Fexample.com');
    expect(sources[2]!.url).toBe('https://a.favicon.im/example.com?larger=true&throw-error-on-404=true');
    expect(sources[3]!.url).toBe('https://icons.duckduckgo.com/ip3/example.com.ico');
  });

  it('keeps cache keys isolated by shortcut identity', () => {
    expect(shortcutIconAssetKey('shortcut-1')).toBe('shortcut-icon/shortcut-1');
  });

  it('rejects unsupported, oversized, and undersized user-selected icons', async () => {
    await expect(validateShortcutIconBlob(new Blob(['not an image'], { type: 'text/plain' }))).rejects.toThrow('ICON_UNSUPPORTED_FORMAT');
    await expect(validateShortcutIconBlob(new Blob([new Uint8Array(1024 * 1024 + 1)], { type: 'image/svg+xml' }))).rejects.toThrow('ICON_TOO_LARGE');
    vi.stubGlobal('Image', class {
      naturalWidth = 32;
      naturalHeight = 32;
      set src(_value: string) {}
      async decode() {}
    });
    await expect(validateShortcutIconBlob(new Blob(['png'], { type: 'image/png' }))).rejects.toThrow('ICON_TOO_SMALL');
  });

  it('shares one remote request when the same shortcut is rendered in multiple surfaces', async () => {
    vi.stubGlobal('Image', class {
      naturalWidth = 128;
      naturalHeight = 128;
      set src(_value: string) {}
      async decode() {}
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['icon'], { type: 'image/png' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(appRepositories.assets, 'putShortcutIcon').mockResolvedValue(undefined);

    const first = loadShortcutIcon('deepseek', 'https://deepseek.com/');
    const second = loadShortcutIcon('deepseek', 'https://deepseek.com/');
    const [left, right] = await Promise.all([first, second]);

    expect(left.blob.size).toBe(right.blob.size);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(appRepositories.assets.putShortcutIcon).toHaveBeenCalledTimes(1);
    await loadShortcutIcon('deepseek', 'https://deepseek.com/');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('allows a failed provider chain to retry on a later mount', async () => {
    vi.stubGlobal('Image', class {
      naturalWidth = 128;
      naturalHeight = 128;
      set src(_value: string) {}
      async decode() {}
    });
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ ok: true, blob: async () => new Blob(['icon'], { type: 'image/png' }) });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(appRepositories.assets, 'putShortcutIcon').mockResolvedValue(undefined);

    await expect(loadShortcutIcon('deepseek', 'https://deepseek.com/')).rejects.toThrow('ICON_FETCH_FAILED');
    await expect(loadShortcutIcon('deepseek', 'https://deepseek.com/')).resolves.toMatchObject({ sourceUrl: expect.any(String) });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('does not persist a response for an older URL after the shortcut is edited', async () => {
    vi.stubGlobal('Image', class {
      naturalWidth = 128;
      naturalHeight = 128;
      set src(_value: string) {}
      async decode() {}
    });
    let resolveOld!: (response: unknown) => void;
    let resolveNew!: (response: unknown) => void;
    const oldResponse = new Promise((resolve) => { resolveOld = resolve; });
    const newResponse = new Promise((resolve) => { resolveNew = resolve; });
    const fetchMock = vi.fn().mockImplementationOnce(() => oldResponse).mockImplementationOnce(() => newResponse);
    vi.stubGlobal('fetch', fetchMock);
    const put = vi.spyOn(appRepositories.assets, 'putShortcutIcon').mockResolvedValue(undefined);

    const oldLoad = loadShortcutIcon('deepseek', 'https://old.example/');
    const newLoad = loadShortcutIcon('deepseek', 'https://new.example/');
    resolveOld({ ok: true, blob: async () => new Blob(['old'], { type: 'image/png' }) });
    resolveNew({ ok: true, blob: async () => new Blob(['new'], { type: 'image/png' }) });
    await Promise.all([oldLoad, newLoad]);

    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]?.[2]).toContain('new.example');
  });
});
