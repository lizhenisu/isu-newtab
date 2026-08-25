import { describe, expect, it } from 'vitest';
import { BUILTIN_WALLPAPER_IDS, BUILTIN_WALLPAPERS, builtinWallpaperBackground } from '../../core/wallpaper/builtin';

describe('builtin wallpapers', () => {
  it('defines stable backgrounds for every selectable builtin wallpaper', () => {
    expect(BUILTIN_WALLPAPER_IDS).toEqual(['aurora', 'dusk', 'ocean']);
    for (const id of BUILTIN_WALLPAPER_IDS) {
      expect(builtinWallpaperBackground(id)).toBe(BUILTIN_WALLPAPERS[id]);
      expect(BUILTIN_WALLPAPERS[id]).toMatch(/gradient/);
    }
  });

  it('uses a warm forest palette for aurora instead of the ocean blue palette', () => {
    expect(BUILTIN_WALLPAPERS.aurora).toContain('#183127');
    expect(BUILTIN_WALLPAPERS.aurora).toContain('#a68560');
    expect(BUILTIN_WALLPAPERS.aurora).not.toContain('#605be9');
    expect(builtinWallpaperBackground('unknown')).toBe(BUILTIN_WALLPAPERS.aurora);
  });
});
