import { faviconUrl } from './url';

export const SHORTCUT_ICON_MIN_SIZE = 64;
export const SHORTCUT_ICON_MAX_BYTES = 1024 * 1024;
export const SHORTCUT_ICON_ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon'] as const;

export type ShortcutIconProvider = 'google-s2' | 'gstatic' | 'favicon-im' | 'duckduckgo';

export type ShortcutIconSource = {
  provider: ShortcutIconProvider;
  url: string;
  timeoutMs: number;
};

export function shortcutIconAssetKey(shortcutId: string): string {
  return `shortcut-icon/${shortcutId}`;
}

export function nativeShortcutIconUrl(pageUrl: string): string {
  return faviconUrl(pageUrl, 128);
}

/** Validates a user-selected icon before it is persisted in the local asset cache. */
export async function validateShortcutIconBlob(blob: Blob): Promise<void> {
  if (!SHORTCUT_ICON_ACCEPTED_TYPES.includes(blob.type as typeof SHORTCUT_ICON_ACCEPTED_TYPES[number])) throw new Error('ICON_UNSUPPORTED_FORMAT');
  if (blob.size > SHORTCUT_ICON_MAX_BYTES) throw new Error('ICON_TOO_LARGE');
  if (blob.type === 'image/svg+xml') return;
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    if (image.naturalWidth < SHORTCUT_ICON_MIN_SIZE || image.naturalHeight < SHORTCUT_ICON_MIN_SIZE) throw new Error('ICON_TOO_SMALL');
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/** Remote candidates are intentionally ordered for restricted-network fallback. */
export function shortcutIconSources(pageUrl: string): readonly ShortcutIconSource[] {
  const parsed = new URL(pageUrl);
  const origin = parsed.origin;
  const hostname = parsed.hostname;
  const google = new URLSearchParams({ domain_url: origin, sz: '128' });
  const gstatic = new URLSearchParams({ client: 'SOCIAL', type: 'FAVICON', fallback_opts: 'TYPE,SIZE,URL', url: origin, size: '128' });
  return [
    { provider: 'google-s2', url: `https://www.google.com/s2/favicons?${google}`, timeoutMs: 5_000 },
    { provider: 'gstatic', url: `https://t0.gstatic.cn/faviconV2?${gstatic}`, timeoutMs: 5_000 },
    { provider: 'favicon-im', url: `https://a.favicon.im/${hostname}?larger=true&throw-error-on-404=true`, timeoutMs: 5_000 },
    { provider: 'duckduckgo', url: `https://icons.duckduckgo.com/ip3/${hostname}.ico`, timeoutMs: 3_000 },
  ];
}
