import { compareBySortKey } from './sort';
import { DEFAULT_GROUP_ID, type AppConfig, type Revision, type Shortcut, type ShortcutGroup } from './types';
import {
  DASHBOARD_COLUMNS,
  DASHBOARD_ROW_HEIGHT,
  resolveAddShortcutLayout,
  resolveWidgetLayout,
  type SystemWidgetId,
  type WidgetPosition,
  type WidgetSizePreset,
} from './widgets';
import type { DesktopCollisionGeometry } from './desktop-collision';

export const DESKTOP_ICON_SIZE = { width: 4, height: 3 } as const;

export type DesktopContainer =
  | { kind: 'desktop' }
  | { kind: 'folder'; folderId: string }
  | { kind: 'hidden' };

type DesktopNodeBase = {
  key: string;
  container: DesktopContainer;
  movable: boolean;
  revision: Revision;
  position?: WidgetPosition;
};

export type DesktopNode =
  | (DesktopNodeBase & { kind: 'system-widget'; key: `widget:${SystemWidgetId}`; id: SystemWidgetId; sizePreset: WidgetSizePreset })
  | (DesktopNodeBase & { kind: 'shortcut'; key: `shortcut:${string}`; entity: Shortcut })
  | (DesktopNodeBase & { kind: 'folder'; key: `folder:${string}`; entity: ShortcutGroup; children: Shortcut[] })
  | (DesktopNodeBase & { kind: 'add-shortcut'; key: 'add-shortcut' });

export type DesktopItem = DesktopNode & { container: { kind: 'desktop' }; position: WidgetPosition };

export type DesktopSnapshot = {
  columns: typeof DASHBOARD_COLUMNS;
  rowHeight: typeof DASHBOARD_ROW_HEIGHT;
  nodes: DesktopNode[];
  fingerprint: string;
};

export type DesktopPlacement = {
  kind: 'system-widget' | 'shortcut' | 'folder' | 'add-shortcut';
  id: string;
  position: WidgetPosition;
  sizePreset?: WidgetSizePreset;
};

export type DesktopCommit = {
  fingerprint: string;
  placements: DesktopPlacement[];
  /** Runtime-only validation data; never persisted or synchronized. */
  collisionGeometry?: DesktopCollisionGeometry;
};

export function buildDesktopSnapshot(config: AppConfig): DesktopSnapshot {
  const widgetRevision = config.appearance.widgetLayout.revision;
  const nodes: DesktopNode[] = resolveWidgetLayout(config.appearance.widgetLayout.value).map((item) => {
    const id = item.id as SystemWidgetId;
    const position = logicalWidgetPosition(config, id, item.position);
    return {
      kind: 'system-widget',
      key: `widget:${id}` as const,
      id,
      sizePreset: item.sizePreset ?? 'medium',
      movable: true,
      revision: widgetRevision,
      container: item.enabled ? { kind: 'desktop' } : { kind: 'hidden' },
      position,
    };
  });

  for (const shortcut of [...config.shortcuts].sort(compareBySortKey)) {
    nodes.push({
      kind: 'shortcut',
      key: `shortcut:${shortcut.id}`,
      entity: shortcut,
      movable: true,
      revision: shortcut.revision,
      container: shortcut.groupId === DEFAULT_GROUP_ID ? { kind: 'desktop' } : { kind: 'folder', folderId: shortcut.groupId },
      ...(shortcut.groupId === DEFAULT_GROUP_ID ? { position: normalizeIconRect(shortcut.position) } : {}),
    });
  }

  for (const group of config.groups.filter((item) => item.id !== DEFAULT_GROUP_ID).sort(compareBySortKey)) {
    nodes.push({
      kind: 'folder',
      key: `folder:${group.id}`,
      entity: group,
      children: config.shortcuts.filter((item) => item.groupId === group.id).sort(compareBySortKey),
      movable: true,
      revision: group.revision,
      container: { kind: 'desktop' },
      position: normalizeIconRect(group.position),
    });
  }

  const storedAdd = resolveAddShortcutLayout(config.appearance.widgetLayout.value);
  nodes.push({
    kind: 'add-shortcut',
    key: 'add-shortcut',
    movable: true,
    revision: widgetRevision,
    container: storedAdd.enabled ? { kind: 'desktop' } : { kind: 'hidden' },
    position: normalizeIconRect(storedAdd.position),
  });

  return {
    columns: DASHBOARD_COLUMNS,
    rowHeight: DASHBOARD_ROW_HEIGHT,
    nodes,
    fingerprint: desktopFingerprint(nodes),
  };
}

export function desktopItems(snapshot: DesktopSnapshot): DesktopItem[] {
  return snapshot.nodes.filter((node): node is DesktopItem => node.container.kind === 'desktop' && Boolean(node.position));
}

export function desktopPlacements(items: DesktopItem[]): DesktopPlacement[] {
  return items.map((item) => {
    if (item.kind === 'add-shortcut') return { kind: item.kind, id: 'addShortcut', position: item.position };
    if (item.kind === 'system-widget') return { kind: item.kind, id: item.id, position: item.position, sizePreset: item.sizePreset };
    return { kind: item.kind, id: item.entity.id, position: item.position };
  });
}

export function snapshotWithDesktopItems(snapshot: DesktopSnapshot, items: DesktopItem[]): DesktopSnapshot {
  const replacements = new Map(items.map((item) => [item.key, item]));
  const nodes = snapshot.nodes.map((node) => replacements.get(node.key) ?? node);
  for (const item of items) if (!nodes.some((node) => node.key === item.key)) nodes.push(item);
  return { ...snapshot, nodes, fingerprint: desktopFingerprint(nodes) };
}

export function validateDesktopItems(items: DesktopItem[], options: { allowLogicalOverlap?: boolean } = {}): void {
  const keys = new Set<string>();
  for (const item of items) {
    if (keys.has(item.key)) throw new Error('DESKTOP_DUPLICATE_KEY');
    keys.add(item.key);
    if (!isInsideBoard(item.position)) throw new Error('DESKTOP_ITEM_OUTSIDE_BOARD');
  }
  if (options.allowLogicalOverlap) return;
  for (const [index, item] of items.entries()) {
    if (items.slice(index + 1).some((candidate) => overlaps(item.position, candidate.position))) {
      throw new Error('DESKTOP_ITEMS_OVERLAP');
    }
  }
}

export function firstFreePosition(
  occupied: WidgetPosition[],
  size: Pick<WidgetPosition, 'width' | 'height'> = DESKTOP_ICON_SIZE,
  start: Pick<WidgetPosition, 'column' | 'row'> = { column: 0, row: 0 },
): WidgetPosition {
  const origin = normalizeTarget({ ...start, ...size, gridVersion: 3 }, { ...start, ...size, gridVersion: 3 });
  const maxRadius = Math.max(DASHBOARD_COLUMNS, ...occupied.map((item) => item.row + item.height), origin.row) + 200;
  for (let radius = 0; radius <= maxRadius; radius += 1) {
    const candidates: WidgetPosition[] = [];
    for (let rowOffset = -radius; rowOffset <= radius; rowOffset += 1) {
      const columnOffset = radius - Math.abs(rowOffset);
      for (const signed of columnOffset === 0 ? [0] : [-columnOffset, columnOffset]) {
        const candidate = normalizeTarget({ ...origin, column: origin.column + signed, row: origin.row + rowOffset }, origin);
        if (Math.abs(candidate.column - origin.column) + Math.abs(candidate.row - origin.row) !== radius) continue;
        candidates.push(candidate);
      }
    }
    candidates.sort((left, right) => left.row - right.row || left.column - right.column);
    for (const candidate of candidates) if (!occupied.some((position) => overlaps(candidate, position))) return candidate;
  }
  throw new Error('DESKTOP_POSITION_EXHAUSTED');
}

export function centeredGridSpan(span: number, columns = DASHBOARD_COLUMNS): number {
  const normalized = Math.max(1, Math.min(columns, Math.round(span)));
  return (columns - normalized) % 2 === 0 ? normalized : Math.min(columns, normalized + 1);
}

export function isHorizontallyCentered(position: WidgetPosition, columns = DASHBOARD_COLUMNS): boolean {
  return position.column === Math.round((columns - position.width) / 2);
}

export function overlaps(left: WidgetPosition, right: WidgetPosition): boolean {
  return left.column < right.column + right.width
    && left.column + left.width > right.column
    && left.row < right.row + right.height
    && left.row + left.height > right.row;
}

export function isInsideBoard(position: WidgetPosition): boolean {
  return position.column >= 0 && position.row >= 0 && position.width > 0 && position.height > 0
    && position.column + position.width <= DASHBOARD_COLUMNS;
}

export function normalizeTarget(target: WidgetPosition, footprint: WidgetPosition): WidgetPosition {
  return {
    ...footprint,
    column: clamp(target.column, 0, DASHBOARD_COLUMNS - footprint.width),
    row: Math.max(0, Math.round(target.row)),
    gridVersion: 3,
  };
}

export function samePosition(left: WidgetPosition | undefined, right: WidgetPosition | undefined): boolean {
  return Boolean(left && right && left.column === right.column && left.row === right.row
    && left.width === right.width && left.height === right.height && left.gridVersion === right.gridVersion);
}

export function migrateDesktopPositions(config: AppConfig): {
  config: AppConfig;
  changedShortcuts: string[];
  changedGroups: string[];
  widgetLayoutChanged: boolean;
} {
  const next = structuredClone(config);
  const legacy = next.appearance.widgetLayout.value.find((item) => item.id === 'shortcuts');
  const storedAdd = resolveAddShortcutLayout(next.appearance.widgetLayout.value);
  const storedSystem = next.appearance.widgetLayout.value.filter((item) => item.id !== 'shortcuts' && item.id !== 'addShortcut');
  const resolved = resolveWidgetLayout(next.appearance.widgetLayout.value);
  const occupied = resolved.filter((item) => item.enabled).map((item) => logicalWidgetPosition(next, item.id as SystemWidgetId, item.position));
  let widgetLayoutChanged = Boolean(legacy) || !next.appearance.widgetLayout.value.some((item) => item.id === 'addShortcut')
    || JSON.stringify(storedSystem) !== JSON.stringify(resolved);
  next.appearance.widgetLayout.value = resolved;
  const changedShortcuts: string[] = [];
  const changedGroups: string[] = [];
  const seed = legacy?.position ?? { column: 0, row: Math.max(0, ...occupied.map((item) => item.row + item.height)), width: 4, height: 3, gridVersion: 3 };

  for (const shortcut of next.shortcuts.filter((item) => item.groupId === DEFAULT_GROUP_ID).sort(compareBySortKey)) {
    const desired = normalizeIconRect(shortcut.position ?? seed);
    const position = occupied.some((item) => overlaps(item, desired)) ? firstFreePosition(occupied, DESKTOP_ICON_SIZE, desired) : desired;
    if (!samePosition(shortcut.position, position)) changedShortcuts.push(shortcut.id);
    shortcut.position = position;
    occupied.push(position);
  }
  for (const shortcut of next.shortcuts.filter((item) => item.groupId !== DEFAULT_GROUP_ID)) {
    if (shortcut.position) changedShortcuts.push(shortcut.id);
    delete shortcut.position;
  }
  for (const group of next.groups.filter((item) => item.id !== DEFAULT_GROUP_ID).sort(compareBySortKey)) {
    const desired = normalizeIconRect(group.position ?? seed);
    const position = occupied.some((item) => overlaps(item, desired)) ? firstFreePosition(occupied, DESKTOP_ICON_SIZE, desired) : desired;
    if (!samePosition(group.position, position)) changedGroups.push(group.id);
    group.position = position;
    occupied.push(position);
  }
  const desiredAdd = normalizeIconRect(storedAdd.position ?? seed);
  const addPosition = storedAdd.enabled && occupied.some((item) => overlaps(item, desiredAdd)) ? firstFreePosition(occupied, DESKTOP_ICON_SIZE, desiredAdd) : desiredAdd;
  if (!samePosition(storedAdd.position, addPosition)) widgetLayoutChanged = true;
  next.appearance.widgetLayout.value.push({ id: 'addShortcut', enabled: storedAdd.enabled, position: addPosition });
  return { config: next, changedShortcuts: [...new Set(changedShortcuts)], changedGroups, widgetLayoutChanged };
}

function logicalWidgetPosition(config: AppConfig, id: SystemWidgetId, position: WidgetPosition): WidgetPosition {
  if (id !== 'search') return { ...position, gridVersion: 3 };
  const width = centeredGridSpan(Math.ceil(config.appearance.search.value.widthPercent * 0.4));
  const centered = isHorizontallyCentered(position);
  return {
    ...position,
    width,
    column: centered ? Math.round((DASHBOARD_COLUMNS - width) / 2) : clamp(position.column, 0, DASHBOARD_COLUMNS - width),
    gridVersion: 3,
  };
}

function normalizeIconRect(position?: WidgetPosition): WidgetPosition {
  return {
    column: clamp(position?.column ?? 0, 0, DASHBOARD_COLUMNS - DESKTOP_ICON_SIZE.width),
    row: Math.max(0, Math.round(position?.row ?? 0)),
    ...DESKTOP_ICON_SIZE,
    gridVersion: 3,
  };
}

function desktopFingerprint(nodes: DesktopNode[]): string {
  return [...nodes].sort((left, right) => left.key.localeCompare(right.key)).map((node) => {
    const container = node.container.kind === 'folder' ? `folder:${node.container.folderId}` : node.container.kind;
    const position = node.position ? `${node.position.column},${node.position.row},${node.position.width},${node.position.height}` : '-';
    return `${node.key}|${container}|${position}|${node.revision.counter}@${node.revision.deviceId}`;
  }).join(';');
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}
