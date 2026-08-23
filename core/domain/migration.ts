import { generateNKeysBetween } from 'fractional-indexing';
import { appConfigSchema } from './schema';
import { normalizeShortcutUrl } from './url';
import { DEFAULT_GROUP_ID, type AppConfig, type Revision } from './types';
import { createDefaultWidgetLayout } from './widgets';
import { DEFAULT_SEARCH_PREFERENCES, DEFAULT_SOLID_WALLPAPER_COLOR } from './defaults';

type LegacyConfig = {
  schemaVersion?: 0;
  datasetId?: string;
  updatedAt?: string;
  shortcuts?: Array<{ id?: string; name?: string; url?: string; icon?: string }>;
  appearance?: { theme?: string; blur?: number; cardSize?: string };
  wallpaper?: { type?: string; color?: string };
};

export function migrateAppConfig(input: unknown): AppConfig {
  const current = appConfigSchema.safeParse(input);
  if (current.success) return withNewWidgetDefaults(current.data);
  if (!input || typeof input !== 'object' || (input as LegacyConfig).schemaVersion !== 0) throw new Error('UNSUPPORTED_CONFIG_SCHEMA');
  const legacy = input as LegacyConfig;
  const shortcuts = legacy.shortcuts ?? [];
  const keys = generateNKeysBetween(null, null, shortcuts.length);
  const revision = (counter: number): Revision => ({ counter, deviceId: 'legacy-import' });
  const wallpaper = legacy.wallpaper?.type === 'solid' && /^#[0-9a-f]{6}$/i.test(legacy.wallpaper.color ?? '')
    ? { type: 'solid' as const, color: legacy.wallpaper.color! }
    : { type: 'solid' as const, color: DEFAULT_SOLID_WALLPAPER_COLOR };
  return withNewWidgetDefaults(appConfigSchema.parse({
    schemaVersion: 1,
    datasetId: legacy.datasetId || crypto.randomUUID(),
    updatedAt: legacy.updatedAt && !Number.isNaN(Date.parse(legacy.updatedAt)) ? new Date(legacy.updatedAt).toISOString() : new Date().toISOString(),
    groups: [{ id: DEFAULT_GROUP_ID, name: 'Default', collapsed: false, sortKey: 'a0', revision: revision(1) }],
    shortcuts: shortcuts.map((shortcut, index) => ({
      id: shortcut.id || crypto.randomUUID(),
      groupId: DEFAULT_GROUP_ID,
      name: shortcut.name?.trim() || new URL(normalizeShortcutUrl(shortcut.url ?? '')).hostname,
      url: normalizeShortcutUrl(shortcut.url ?? ''),
      ...(shortcut.icon ? { icon: shortcut.icon } : {}),
      sortKey: keys[index]!,
      revision: revision(index + 2),
    })),
    appearance: {
      theme: { value: ['light', 'dark', 'system'].includes(legacy.appearance?.theme ?? '') ? legacy.appearance!.theme : 'system', revision: revision(shortcuts.length + 2) },
      blur: { value: Math.max(0, Math.min(40, legacy.appearance?.blur ?? 18)), revision: revision(shortcuts.length + 3) },
      cardSize: { value: ['small', 'medium', 'large'].includes(legacy.appearance?.cardSize ?? '') ? legacy.appearance!.cardSize : 'medium', revision: revision(shortcuts.length + 4) },
      wallpaper: { value: wallpaper, revision: revision(shortcuts.length + 5) },
      widgetLayout: { value: createDefaultWidgetLayout(), revision: revision(shortcuts.length + 6) },
      search: { value: { ...DEFAULT_SEARCH_PREFERENCES }, revision: revision(shortcuts.length + 7) },
    },
  }));
}

function withNewWidgetDefaults(config: AppConfig): AppConfig {
  if (config.appearance.widgetLayout.value.some((item) => item.id === 'weather')) return config;
  const weather = createDefaultWidgetLayout().find((item) => item.id === 'weather');
  if (!weather) return config;
  return {
    ...config,
    appearance: {
      ...config.appearance,
      widgetLayout: {
        ...config.appearance.widgetLayout,
        value: [...config.appearance.widgetLayout.value, weather],
      },
    },
  };
}
