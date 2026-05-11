import { z } from 'zod';
import { resolveLanguage } from '../browser/i18n';
import type { AppLanguage, BingWallpaperQuality } from '../domain/types';

export const BING_DAILY_ASSET_KEY = 'wallpaper/bing-daily-current';
export const BING_DAILY_DISPLAY_PORT = 'isu:wallpaper:bing-daily-display';

const BING_ORIGIN = 'https://www.bing.com';
const MAX_WALLPAPER_BYTES = 30 * 1024 * 1024;
const BING_MARKETS = ['zh-CN', 'zh-HK', 'zh-TW', 'ko-KR', 'ja-JP', 'en-US'] as const;

export type BingMarket = typeof BING_MARKETS[number];

export const DEFAULT_BING_WALLPAPER_QUALITY: BingWallpaperQuality = '1080p';
export const BING_WALLPAPER_QUALITY_SIZES: Record<BingWallpaperQuality, { width: number; height: number }> = {
  '1080p': { width: 1920, height: 1080 },
  '1440p': { width: 2560, height: 1440 },
  '4k': { width: 3840, height: 2160 },
};

const bingImageSchema = z.object({
  startdate: z.string().regex(/^\d{8}$/),
  url: z.string().startsWith('/th?'),
  copyrightlink: z.string().optional(),
});

const bingResponseSchema = z.object({ images: z.array(bingImageSchema).min(1).max(8) });

export type BingWallpaper = {
  date: string;
  imageUrl: string;
  sourceUrl: string;
};

export type BingDailyState = BingWallpaper & {
  market: BingMarket;
  quality: BingWallpaperQuality;
  updatedAt: string;
  nextRefreshAt: string;
};

export function bingMarketForLanguage(language: AppLanguage): BingMarket {
  const markets: Record<Exclude<AppLanguage, 'system'>, BingMarket> = {
    zh_CN: 'zh-CN',
    zh_HK: 'zh-HK',
    zh_TW: 'zh-TW',
    ko: 'ko-KR',
    ja: 'ja-JP',
    en: 'en-US',
  };
  return markets[resolveLanguage(language)];
}

export async function fetchBingWallpapers(market: BingMarket, count = 8, signal?: AbortSignal): Promise<BingWallpaper[]> {
  const params = new URLSearchParams({ format: 'js', idx: '0', n: String(Math.min(8, Math.max(1, count))), mkt: market });
  const response = await fetch(`${BING_ORIGIN}/HPImageArchive.aspx?${params}`, { signal });
  if (!response.ok) throw new Error(`BING_HTTP_${response.status}`);
  const parsed = bingResponseSchema.parse(await response.json());
  return parsed.images.map((image) => ({
    date: image.startdate,
    imageUrl: bingUrl(image.url),
    sourceUrl: bingUrl(image.copyrightlink ?? image.url),
  }));
}

export function bingImageUrlForQuality(imageUrl: string, quality: BingWallpaperQuality): string {
  if (!isBingImageUrl(imageUrl)) throw new Error('WALLPAPER_URL_NOT_ALLOWED');
  const url = new URL(imageUrl);
  const { width, height } = BING_WALLPAPER_QUALITY_SIZES[quality];
  url.searchParams.set('w', String(width));
  url.searchParams.set('h', String(height));
  url.searchParams.set('rs', '1');
  url.searchParams.set('c', '4');
  return url.toString();
}

export function nextBingDailyState(wallpaper: BingWallpaper, market: BingDailyState['market'], quality: BingWallpaperQuality, now = new Date()): BingDailyState {
  return {
    ...wallpaper,
    imageUrl: bingImageUrlForQuality(wallpaper.imageUrl, quality),
    market,
    quality,
    updatedAt: now.toISOString(),
    nextRefreshAt: nextLocalMidnight(now).toISOString(),
  };
}

export function retryBingDailyState(state: BingDailyState, now = new Date()): BingDailyState {
  return { ...state, nextRefreshAt: new Date(now.getTime() + 60 * 60_000).toISOString() };
}

export function isBingDailyState(value: unknown): value is BingDailyState {
  return normalizeBingDailyState(value) !== undefined && typeof (value as Partial<BingDailyState> | undefined)?.quality === 'string';
}

export function normalizeBingDailyState(value: unknown): BingDailyState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const state = value as Partial<BingDailyState>;
  const quality = state.quality === undefined ? DEFAULT_BING_WALLPAPER_QUALITY : state.quality;
  if (!(quality === '1080p' || quality === '1440p' || quality === '4k')) return undefined;
  if (!(typeof state.date === 'string' && /^\d{8}$/.test(state.date)
    && BING_MARKETS.includes(state.market as BingMarket)
    && typeof state.imageUrl === 'string' && isBingImageUrl(state.imageUrl)
    && typeof state.sourceUrl === 'string' && isBingUrl(state.sourceUrl)
    && typeof state.updatedAt === 'string' && !Number.isNaN(Date.parse(state.updatedAt))
    && typeof state.nextRefreshAt === 'string' && !Number.isNaN(Date.parse(state.nextRefreshAt)))) return undefined;
  return { ...state, quality } as BingDailyState;
}

export async function downloadBingImage(url: string): Promise<Blob> {
  if (!isBingImageUrl(url)) throw new Error('WALLPAPER_URL_NOT_ALLOWED');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`WALLPAPER_HTTP_${response.status}`);
  const declaredSize = Number(response.headers.get('content-length') ?? 0);
  if (declaredSize > MAX_WALLPAPER_BYTES) throw new Error('WALLPAPER_TOO_LARGE');
  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) throw new Error('WALLPAPER_RESPONSE_INVALID');
  if (blob.size > MAX_WALLPAPER_BYTES) throw new Error('WALLPAPER_TOO_LARGE');
  return blob;
}

function bingUrl(path: string): string {
  const value = new URL(path, BING_ORIGIN);
  if (!isBingUrl(value.toString())) throw new Error('BING_URL_NOT_ALLOWED');
  return value.toString();
}

function isBingUrl(value: string): boolean {
  try {
    return new URL(value).origin === BING_ORIGIN;
  } catch {
    return false;
  }
}

export function isBingImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === BING_ORIGIN && url.pathname === '/th' && url.searchParams.get('id')?.startsWith('OHR.') === true;
  } catch {
    return false;
  }
}

function nextLocalMidnight(now: Date): Date {
  const next = new Date(now);
  next.setHours(24, 5, 0, 0);
  return next;
}
