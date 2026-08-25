import { describe, expect, it } from 'vitest';
import { createInitialConfig } from '../../core/domain/defaults';
import { appConfigSchema, syncEnvelopeSchema } from '../../core/domain/schema';
import { createDefaultWidgetLayout, resolveWidgetLayout, snapGridCoordinate, SYSTEM_WIDGET_IDS } from '../../core/domain/widgets';
import { createEnvelope } from '../../core/sync/engine';
import { migrateAppConfig } from '../../core/domain/migration';

describe('dashboard component layout', () => {
  it('contains every registered component in the default order', () => {
    expect(createDefaultWidgetLayout().map((item) => item.id)).toEqual([...SYSTEM_WIDGET_IDS, 'addShortcut']);
  });

  it('preserves user order and appends components introduced later', () => {
    expect(resolveWidgetLayout([
      { id: 'search', enabled: false },
      { id: 'clock', enabled: true },
    ]).slice(0, 3).map(({ id, enabled }) => ({ id, enabled }))).toEqual([
      { id: 'search', enabled: false },
      { id: 'clock', enabled: true },
      { id: 'greeting', enabled: true },
    ]);
  });

  it('removes the legacy shortcut container from the runtime layout', () => {
    const layout = resolveWidgetLayout([{
      id: 'shortcuts',
      enabled: true,
      position: { column: 1, row: 9, width: 10, height: 6 },
    }]);
    expect(layout.some((item) => item.id === 'shortcuts')).toBe(false);
  });

  it('doubles version 2 horizontal coordinates without changing vertical coordinates', () => {
    const [search] = resolveWidgetLayout([{
      id: 'search',
      enabled: true,
      position: { column: 8, row: 12, width: 8, height: 2, gridVersion: 2 },
    }]);
    expect(search?.position).toEqual({ column: 14, row: 12, width: 20, height: 2, gridVersion: 3 });
  });

  it('uses compact footprints for the clock, greeting, weather, and daily quote', () => {
    const layout = resolveWidgetLayout(createDefaultWidgetLayout());
    expect(layout.find((item) => item.id === 'clock')?.position.width).toBe(10);
    expect(layout.find((item) => item.id === 'greeting')?.position.width).toBe(8);
    expect(layout.find((item) => item.id === 'search')?.position.width).toBe(20);
    expect(layout.find((item) => item.id === 'weather')?.position).toMatchObject({ width: 10, height: 3 });
    expect(layout.find((item) => item.id === 'dailyQuote')?.position.width).toBe(16);
  });

  it('adds the weather component hidden when upgrading an existing layout', () => {
    const config = createInitialConfig({ deviceId: 'weather-upgrade', counter: 0, epoch: 0 });
    config.appearance.widgetLayout.value = config.appearance.widgetLayout.value.filter((item) => item.id !== 'weather');

    const migrated = migrateAppConfig(config);
    expect(migrated.appearance.widgetLayout.value.find((item) => item.id === 'weather')).toMatchObject({ enabled: false, sizePreset: 'medium' });
  });

  it('keeps a snapped coordinate stable around a neighboring-cell boundary', () => {
    expect(snapGridCoordinate(4.6, 4)).toBe(4);
    expect(snapGridCoordinate(4.66, 4)).toBe(5);
    expect(snapGridCoordinate(4.4, 5)).toBe(5);
    expect(snapGridCoordinate(4.34, 5)).toBe(4);
  });

  it('adds the default layout when reading an older local configuration', () => {
    const config = createInitialConfig({ deviceId: 'local', counter: 0, epoch: 0 });
    const oldConfig = structuredClone(config) as Record<string, unknown> & { appearance: Record<string, unknown> };
    delete oldConfig.appearance.widgetLayout;
    expect(appConfigSchema.parse(oldConfig).appearance.widgetLayout.value).toEqual(createDefaultWidgetLayout());
  });

  it('drops the removed global card-size preference from older configurations', () => {
    const config = createInitialConfig({ deviceId: 'local', counter: 0, epoch: 0 });
    const oldConfig = structuredClone(config) as Record<string, unknown> & { appearance: Record<string, unknown> };
    oldConfig.appearance.cardSize = { value: 'large', revision: { counter: 1, deviceId: 'legacy' } };

    expect(appConfigSchema.parse(oldConfig).appearance).not.toHaveProperty('cardSize');
  });

  it('derives the remembered solid color from older solid wallpaper data', () => {
    const config = createInitialConfig({ deviceId: 'local', counter: 0, epoch: 0 });
    config.appearance.wallpaper.value = { type: 'solid', color: '#4a7098' };
    const oldConfig = structuredClone(config) as Record<string, unknown> & { appearance: Record<string, unknown> };
    delete oldConfig.appearance.solidColor;
    expect(appConfigSchema.parse(oldConfig).appearance.solidColor.value).toBe('#4a7098');
  });

  it('adds the default layout when reading an older remote envelope', () => {
    const config = createInitialConfig({ deviceId: 'remote', counter: 0, epoch: 0 });
    const oldEnvelope = createEnvelope(config, { tombstones: [] }, { counter: 1, deviceId: 'remote' }, 0) as unknown as { config: { appearance: Record<string, unknown> } };
    delete oldEnvelope.config.appearance.widgetLayout;
    expect(syncEnvelopeSchema.parse(oldEnvelope).config.appearance.widgetLayout.value).toEqual(createDefaultWidgetLayout());
  });
});
