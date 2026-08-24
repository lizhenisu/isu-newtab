import { describe, expect, it } from 'vitest';
import { wallpaperTone } from '../../core/domain/wallpaper-tone';
import { createInitialConfig, DEFAULT_SOLID_WALLPAPER_COLOR } from '../../core/domain/defaults';

describe('wallpaper tone', () => {
  it('uses pure white as the default solid wallpaper', () => {
    const config = createInitialConfig({ deviceId: 'test', counter: 0, epoch: 0 });
    expect(DEFAULT_SOLID_WALLPAPER_COLOR).toBe('#ffffff');
    expect(config.appearance.wallpaper.value).toEqual({ type: 'solid', color: '#ffffff' });
    expect(config.appearance.solidColor.value).toBe('#ffffff');
    expect(wallpaperTone(config.appearance.wallpaper.value)).toBe('light');
  });

  it.each(['#ffffff', '#f2f4f7', '#ffff00'])('recognizes light solid color %s', (color) => {
    expect(wallpaperTone({ type: 'solid', color })).toBe('light');
  });

  it.each(['#000000', '#172033', '#4c1d4f'])('recognizes dark solid color %s', (color) => {
    expect(wallpaperTone({ type: 'solid', color })).toBe('dark');
  });

  it('keeps image wallpapers on the established light foreground', () => {
    expect(wallpaperTone({ type: 'builtin', assetId: 'aurora' })).toBe('dark');
  });
});
