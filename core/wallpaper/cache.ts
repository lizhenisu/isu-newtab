import { appRepositories } from '../storage/repository';
import type { AssetRepository } from '../storage/ports';
import { downloadWallhavenImage } from './random';
import { downloadBingImage } from './bing';

export async function cacheWallhavenImage(url: string, repository: AssetRepository = appRepositories.assets, key = 'wallpaper/wallhaven-current'): Promise<void> {
  if ((await repository.getAssetRecord(key))?.sourceUrl === url) return;
  const blob = await downloadWallhavenImage(url);
  await repository.putAsset(key, blob, url);
}

export async function cacheBingImage(url: string, repository: AssetRepository = appRepositories.assets, key = 'wallpaper/bing-current'): Promise<void> {
  if ((await repository.getAssetRecord(key))?.sourceUrl === url) return;
  const blob = await downloadBingImage(url);
  await repository.putAsset(key, blob, url);
}

export async function cacheUnsplashImage(url: string, repository: AssetRepository = appRepositories.assets, key = 'wallpaper/unsplash-current'): Promise<void> {
  if (!url.startsWith('https://images.unsplash.com/')) throw new Error('WALLPAPER_URL_NOT_ALLOWED');
  if ((await repository.getAssetRecord(key))?.sourceUrl === url) return;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`WALLPAPER_HTTP_${response.status}`);
  const declaredSize = Number(response.headers.get('content-length') ?? 0);
  if (declaredSize > 30 * 1024 * 1024) throw new Error('WALLPAPER_TOO_LARGE');
  const blob = await response.blob();
  if (!blob.type.startsWith('image/') || blob.size > 30 * 1024 * 1024) throw new Error('WALLPAPER_RESPONSE_INVALID');
  await repository.putAsset(key, blob, url);
}
