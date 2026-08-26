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
  shortcuts?: Array<{ id?: string; name?: string; url?: string }>;
  appearance?: { theme?: string; blur?: number; solidColor?: string };
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
    : { type: 'builtin' as const, assetId: 'aurora' };
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
      sortKey: keys[index]!,
      revision: revision(index + 2),
    })),
    appearance: {
      theme: { value: ['light', 'dark', 'system'].includes(legacy.appearance?.theme ?? '') ? legacy.appearance!.theme : 'system', revision: revision(shortcuts.length + 2) },
      blur: { value: Math.max(0, Math.min(40, legacy.appearance?.blur ?? 0)), revision: revision(shortcuts.length + 3) },
      solidColor: { value: /^#[0-9a-f]{6}$/i.test(legacy.appearance?.solidColor ?? '')
        ? legacy.appearance!.solidColor!
        : /^#[0-9a-f]{6}$/i.test(legacy.wallpaper?.color ?? '') ? legacy.wallpaper!.color! : DEFAULT_SOLID_WALLPAPER_COLOR, revision: revision(shortcuts.length + 4) },
      wallpaper: { value: wallpaper, revision: revision(shortcuts.length + 4) },
      widgetLayout: { value: createDefaultWidgetLayout(), revision: revision(shortcuts.length + 5) },
      search: { value: { ...DEFAULT_SEARCH_PREFERENCES }, revision: revision(shortcuts.length + 6) },
    },
  }));
}

/** Returns persisted shortcut IDs that still carry the removed remote-icon field. */
export function legacyShortcutIconIds(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const shortcuts = (input as { shortcuts?: unknown }).shortcuts;
  if (!Array.isArray(shortcuts)) return [];
  return shortcuts.flatMap((shortcut) => {
    if (!shortcut || typeof shortcut !== 'object') return [];
    const record = shortcut as { id?: unknown; icon?: unknown };
    return typeof record.id === 'string' && Object.hasOwn(record, 'icon') ? [record.id] : [];
  });
}

function withNewWidgetDefaults(config: AppConfig): AppConfig {
  const defaults = createDefaultWidgetLayout();
  const missing = defaults.filter((item) => !config.appearance.widgetLayout.value.some((current) => current.id === item.id));
  if (!missing.length) return config;
  return {
    ...config,
    appearance: {
      ...config.appearance,
      widgetLayout: {
        ...config.appearance.widgetLayout,
        value: [...config.appearance.widgetLayout.value, ...missing],
      },
    },
  };
}
