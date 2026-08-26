export const WIDGET_IDS = [
  'clock',
  'greeting',
  'focusTimer',
  'search',
  'quickNote',
  'weather',
  'shortcuts',
  'dailyQuote',
  'addShortcut',
] as const;

export type WidgetId = typeof WIDGET_IDS[number];
export type SystemWidgetId = Exclude<WidgetId, 'shortcuts' | 'addShortcut'>;
export type ConfigurableWidgetId = Exclude<WidgetId, 'shortcuts'>;
export const SYSTEM_WIDGET_IDS = WIDGET_IDS.filter((id): id is SystemWidgetId => id !== 'shortcuts' && id !== 'addShortcut');
export type WidgetSizePreset = 'small' | 'medium' | 'large';

export type WidgetLayoutItem = {
  id: WidgetId;
  enabled: boolean;
  position?: WidgetPosition;
  sizePreset?: WidgetSizePreset;
};

export type WidgetLayout = WidgetLayoutItem[];

export type WidgetPosition = {
  column: number;
  row: number;
  width: number;
  height: number;
  gridVersion?: 2 | 3;
};

export type ResolvedWidgetLayoutItem = WidgetLayoutItem & { position: WidgetPosition };

export const DASHBOARD_COLUMNS = 48;
export const DASHBOARD_ROW_HEIGHT = 40;

export function snapGridCoordinate(value: number, previous?: number, hysteresis = 0.15): number {
  const nearest = Math.round(value);
  if (previous === undefined || nearest === previous) return nearest;
  if (nearest > previous) return value >= previous + 0.5 + hysteresis ? nearest : previous;
  return value <= previous - 0.5 - hysteresis ? nearest : previous;
}

const DEFAULT_POSITIONS: Record<WidgetId, WidgetPosition> = {
  clock: { column: 19, row: 0, width: 10, height: 4, gridVersion: 3 },
  greeting: { column: 20, row: 4, width: 8, height: 2, gridVersion: 3 },
  focusTimer: { column: 17, row: 6, width: 14, height: 6, gridVersion: 3 },
  search: { column: 14, row: 0, width: 20, height: 2, gridVersion: 3 },
  quickNote: { column: 10, row: 14, width: 28, height: 7, gridVersion: 3 },
  weather: { column: 19, row: 26, width: 10, height: 3, gridVersion: 3 },
  shortcuts: { column: 16, row: 20, width: 16, height: 4, gridVersion: 3 },
  dailyQuote: { column: 16, row: 24, width: 16, height: 2, gridVersion: 3 },
  addShortcut: { column: 34, row: 24, width: 4, height: 3, gridVersion: 3 },
};

export const WIDGET_SIZE_PRESETS: Record<SystemWidgetId, Record<WidgetSizePreset, Pick<WidgetPosition, 'width' | 'height'>>> = {
  clock: { small: { width: 8, height: 3 }, medium: { width: 10, height: 4 }, large: { width: 12, height: 5 } },
  greeting: { small: { width: 6, height: 2 }, medium: { width: 8, height: 2 }, large: { width: 10, height: 3 } },
  focusTimer: { small: { width: 10, height: 5 }, medium: { width: 14, height: 6 }, large: { width: 18, height: 7 } },
  search: { small: { width: 20, height: 2 }, medium: { width: 20, height: 2 }, large: { width: 20, height: 2 } },
  quickNote: { small: { width: 16, height: 5 }, medium: { width: 28, height: 7 }, large: { width: 36, height: 9 } },
  weather: { small: { width: 6, height: 2 }, medium: { width: 10, height: 3 }, large: { width: 14, height: 4 } },
  dailyQuote: { small: { width: 12, height: 2 }, medium: { width: 16, height: 2 }, large: { width: 20, height: 3 } },
};

export function createDefaultWidgetLayout(): WidgetLayout {
  return [
    ...SYSTEM_WIDGET_IDS.map((id) => ({ id, enabled: id === 'search', sizePreset: 'medium' as const, position: { ...DEFAULT_POSITIONS[id] } })),
    { id: 'addShortcut' as const, enabled: false, position: { ...DEFAULT_POSITIONS.addShortcut } },
  ];
}

/** Keeps persisted layouts stable while appending components introduced by newer releases. */
export function resolveWidgetLayout(layout: WidgetLayout): ResolvedWidgetLayoutItem[] {
  const known = new Set<WidgetId>();
  const resolved = layout.filter((item) => {
    if (!SYSTEM_WIDGET_IDS.includes(item.id as SystemWidgetId) || known.has(item.id)) return false;
    known.add(item.id);
    return true;
  }).map((item) => {
    const id = item.id as SystemWidgetId;
    const sizePreset = item.sizePreset ?? 'medium';
    const footprint = WIDGET_SIZE_PRESETS[id][sizePreset];
    return { ...item, id, sizePreset, position: normalizePosition(item.position, { ...DEFAULT_POSITIONS[id], ...footprint }) };
  });
  for (const id of SYSTEM_WIDGET_IDS) {
    if (!known.has(id)) resolved.push({ id, enabled: id === 'search', sizePreset: 'medium', position: { ...DEFAULT_POSITIONS[id] } });
  }
  return resolved;
}

/** Resolves the separately-rendered add-shortcut component without reviving the removed shortcuts container. */
export function resolveAddShortcutLayout(layout: WidgetLayout): WidgetLayoutItem & { id: 'addShortcut'; position: WidgetPosition } {
  const stored = layout.find((item) => item.id === 'addShortcut');
  return {
    id: 'addShortcut',
    enabled: stored?.enabled ?? false,
    position: normalizePosition(stored?.position, DEFAULT_POSITIONS.addShortcut),
  };
}

function normalizePosition(position: WidgetPosition | undefined, fallback: WidgetPosition): WidgetPosition {
  if (!position) return { ...fallback };
  // Sizes were never user-editable, so release-defined footprints can safely compact older layouts.
  const width = fallback.width;
  const columnScale = position.gridVersion === 3 ? 1 : position.gridVersion === 2 ? 2 : 4;
  const previousColumn = position.column * columnScale;
  const previousWidth = position.width * columnScale;
  const wasCentered = previousColumn === Math.round((DASHBOARD_COLUMNS - previousWidth) / 2);
  const column = wasCentered ? Math.round((DASHBOARD_COLUMNS - width) / 2) : previousColumn;
  const row = position.gridVersion ? position.row : position.row * 2;
  return {
    column: Math.max(0, Math.min(DASHBOARD_COLUMNS - width, Math.round(column))),
    row: Math.max(0, Math.round(row)),
    width,
    height: fallback.height,
    gridVersion: 3,
  };
}
