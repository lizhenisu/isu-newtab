export const BUILTIN_WALLPAPERS = {
  aurora: 'radial-gradient(ellipse at 22% 18%, rgba(212, 245, 186, .72) 0%, rgba(212, 245, 186, 0) 34%), radial-gradient(ellipse at 80% 74%, rgba(246, 211, 150, .38) 0%, rgba(246, 211, 150, 0) 38%), linear-gradient(138deg, #183127 0%, #52765d 50%, #a68560 100%)',
  dusk: 'linear-gradient(135deg, #4c1d4f, #c8555b 48%, #f5b56b)',
  ocean: 'linear-gradient(145deg, #061d33, #0c7690 55%, #61c0bf)',
} as const;

export type BuiltinWallpaperId = keyof typeof BUILTIN_WALLPAPERS;

export const BUILTIN_WALLPAPER_IDS = Object.keys(BUILTIN_WALLPAPERS) as BuiltinWallpaperId[];

export function builtinWallpaperBackground(assetId: string): string {
  return BUILTIN_WALLPAPERS[assetId as BuiltinWallpaperId] ?? BUILTIN_WALLPAPERS.aurora;
}
