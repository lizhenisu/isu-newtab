import { fetchWallhavenRandom } from './wallhaven';
import type { WallpaperRefreshInterval } from '../domain/types';

export const RANDOM_WALLPAPER_ASSET_KEY = 'wallpaper/random-current';
export const RANDOM_WALLPAPER_DISPLAY_PORT = 'isu:wallpaper:random-display';

export type RandomWallpaperDisplayMessage = { type: 'ready' };

export type RandomWallpaperState = {
  imageUrl: string;
  sourceUrl: string;
  wallpaperId: string;
  interval: WallpaperRefreshInterval;
  updatedAt: string;
  nextRefreshAt: string;
};

const INTERVAL_MS: Record<WallpaperRefreshInterval, number> = {
  '1h': 60 * 60_000,
  '5h': 5 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
};

export function wallpaperRefreshIntervalMs(interval: WallpaperRefreshInterval): number {
  return INTERVAL_MS[interval];
}

export function shouldDeferRandomWallpaperRefresh(
  state: RandomWallpaperState | undefined,
  hasCachedImage: boolean,
  hasReadyDisplay: boolean,
  now = Date.now(),
): boolean {
  if (!state || !hasCachedImage || hasReadyDisplay) return false;
  const nextRefreshAt = Date.parse(state.nextRefreshAt);
  return !Number.isFinite(nextRefreshAt) || nextRefreshAt <= now;
}

export function isRandomWallpaperDisplayReadyMessage(value: unknown): value is RandomWallpaperDisplayMessage {
  return Boolean(value) && typeof value === 'object' && (value as { type?: unknown }).type === 'ready';
}

export async function chooseRandomWallhaven(previousId?: string): Promise<Pick<RandomWallpaperState, 'imageUrl' | 'sourceUrl' | 'wallpaperId'>> {
  const items = await fetchWallhavenRandom();
  const candidates = items.filter((item) => item.id !== previousId);
  const pool = candidates.length ? candidates : items;
  if (!pool.length) throw new Error('WALLHAVEN_RANDOM_EMPTY');
  const item = pool[Math.floor(Math.random() * pool.length)]!;
  return { imageUrl: item.path, sourceUrl: item.url, wallpaperId: item.id };
}

export function nextRandomWallpaperState(
  wallpaper: Pick<RandomWallpaperState, 'imageUrl' | 'sourceUrl' | 'wallpaperId'>,
  interval: WallpaperRefreshInterval,
  now = new Date(),
): RandomWallpaperState {
  return {
    ...wallpaper,
    interval,
    updatedAt: now.toISOString(),
    nextRefreshAt: new Date(now.getTime() + wallpaperRefreshIntervalMs(interval)).toISOString(),
  };
}

export function rescheduleRandomWallpaper(state: RandomWallpaperState, interval: WallpaperRefreshInterval, now = new Date()): RandomWallpaperState {
  return { ...state, interval, nextRefreshAt: new Date(now.getTime() + wallpaperRefreshIntervalMs(interval)).toISOString() };
}

export function isRandomWallpaperState(value: unknown): value is RandomWallpaperState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<RandomWallpaperState>;
  return [state.imageUrl, state.sourceUrl].every((url) => typeof url === 'string' && isWallhavenUrl(url))
    && typeof state.wallpaperId === 'string' && state.wallpaperId.length > 0
    && (state.interval === '1h' || state.interval === '5h' || state.interval === '1d')
    && [state.updatedAt, state.nextRefreshAt].every((date) => typeof date === 'string' && !Number.isNaN(Date.parse(date)));
}

export async function downloadWallhavenImage(url: string): Promise<Blob> {
  if (!isWallhavenUrl(url)) throw new Error('WALLPAPER_URL_NOT_ALLOWED');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`WALLPAPER_HTTP_${response.status}`);
  const declaredSize = Number(response.headers.get('content-length') ?? 0);
  if (declaredSize > 30 * 1024 * 1024) throw new Error('WALLPAPER_TOO_LARGE');
  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) throw new Error('WALLPAPER_RESPONSE_INVALID');
  if (blob.size > 30 * 1024 * 1024) throw new Error('WALLPAPER_TOO_LARGE');
  return blob;
}

function isWallhavenUrl(value: string): boolean {
  return value.startsWith('https://w.wallhaven.cc/') || value.startsWith('https://wallhaven.cc/');
}
