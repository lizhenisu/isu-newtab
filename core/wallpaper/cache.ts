import { appRepositories } from '../storage/repository';
import type { AssetRepository } from '../storage/ports';
import { downloadWallhavenImage } from './random';

export async function cacheWallhavenImage(url: string, repository: AssetRepository = appRepositories.assets, key = 'wallpaper/wallhaven-current'): Promise<void> {
  if ((await repository.getAssetRecord(key))?.sourceUrl === url) return;
  const blob = await downloadWallhavenImage(url);
  await repository.putAsset(key, blob, url);
}
