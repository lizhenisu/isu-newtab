import { describe, expect, it } from 'vitest';
import { createInitialConfig } from '../../core/domain/defaults';
import { buildDesktopSnapshot, centeredGridSpan, desktopItems, desktopPlacements, migrateDesktopPositions, overlaps, type DesktopItem } from '../../core/domain/desktop';
import { DEFAULT_GROUP_ID, type Shortcut } from '../../core/domain/types';
import type { WidgetPosition } from '../../core/domain/widgets';
import { placeDesktopNode, placeNewDesktopNode, repairDesktopSnapshot } from '../../core/layout/piece-desktop-adapter';

const revision = { counter: 1, deviceId: 'test' };
const position = (column: number, row = 20) => ({ column, row, width: 4 as const, height: 3 as const, gridVersion: 3 as const });

describe('desktop aggregate and layout engine', () => {
  it('derives a stable logical search footprint without DOM measurements', () => {
    const config = createInitialConfig({ deviceId: 'test', counter: 0, epoch: 0 });
    config.appearance.search.value.widthPercent = 100;
    const search = desktopItems(buildDesktopSnapshot(config)).find((item) => item.kind === 'system-widget' && item.id === 'search');
    expect(search?.position).toMatchObject({ column: 4, width: 40 });
  });

  it('adds the minimum parity column required for exact integer-grid centering', () => {
    expect(centeredGridSpan(12, 48)).toBe(12);
    expect(centeredGridSpan(13, 48)).toBe(14);
    expect(centeredGridSpan(39, 48)).toBe(40);
    expect(centeredGridSpan(12, 49)).toBe(13);
  });

  it('builds snapshots without silently repairing stored overlaps', () => {
    const config = configWithShortcuts([shortcut('a', position(0, 26)), shortcut('b', position(0, 26))]);
    const items = desktopItems(buildDesktopSnapshot(config));
    expect(items.find((item) => item.key === 'shortcut:a')?.position).toEqual(position(0, 26));
    expect(items.find((item) => item.key === 'shortcut:b')?.position).toEqual(position(0, 26));
  });

  it('places on an empty target without moving unrelated nodes', () => {
    const snapshot = buildDesktopSnapshot(configWithShortcuts([shortcut('a', position(0, 26)), shortcut('b', position(8, 26))]));
    const result = placeDesktopNode(snapshot, 'shortcut:a', position(4, 26), { x: 1, y: 0 });
    expect(result.movedKeys).toEqual(['shortcut:a']);
    expect(result.items.find((item) => item.key === 'shortcut:b')?.position).toEqual(position(8, 26));
  });

  it('resolves occupied targets deterministically with minimum unrelated changes', () => {
    const snapshot = buildDesktopSnapshot(configWithShortcuts([
      shortcut('a', position(0, 26)), shortcut('b', position(4, 26)), shortcut('c', position(8, 26)),
    ]));
    const first = placeDesktopNode(snapshot, 'shortcut:c', position(4, 26), { x: -1, y: 0 });
    const second = placeDesktopNode(snapshot, 'shortcut:c', position(4, 26), { x: -1, y: 0 });
    expect(desktopPlacements(first.items)).toEqual(desktopPlacements(second.items));
    expect(first.items.find((item) => item.key === 'shortcut:a')?.position).toEqual(position(0, 26));
    assertValid(first.items);
  });

  it('still pushes a folder when the command is a desktop placement rather than a folder drop', () => {
    const config = configWithShortcuts([shortcut('a', position(0, 26))]);
    config.groups.push({ id: 'folder', name: 'Folder', collapsed: false, sortKey: 'z', revision, position: position(4, 26) });
    const result = placeDesktopNode(buildDesktopSnapshot(config), 'shortcut:a', position(4, 26), { x: 1, y: 0 });
    expect(result.items.find((item) => item.key === 'shortcut:a')?.position).toEqual(position(4, 26));
    expect(result.items.find((item) => item.key === 'folder:folder')?.position).not.toEqual(position(4, 26));
    assertValid(result.items);
  });

  it('does not expand a push into an unrelated add tile', () => {
    const config = configWithShortcuts([shortcut('a', position(0, 0))]);
    config.groups.push({ id: 'folder', name: 'Folder', collapsed: false, sortKey: 'z', revision, position: position(4, 0) });
    const addShortcut = config.appearance.widgetLayout.value.find((item) => item.id === 'addShortcut')!;
    addShortcut.enabled = true;
    addShortcut.position = position(8, 0);
    const result = placeDesktopNode(buildDesktopSnapshot(config), 'shortcut:a', position(4, 0), { x: 1, y: 0 });
    const add = result.items.find((item) => item.key === 'add-shortcut');
    expect(add?.position).toEqual(position(8, 0));
    assertValid(result.items);
  });

  it('creates a shortcut at the add tile and moves the add tile away', () => {
    const config = createInitialConfig({ deviceId: 'test', counter: 0, epoch: 0 });
    config.appearance.widgetLayout.value.find((item) => item.id === 'addShortcut')!.enabled = true;
    const snapshot = buildDesktopSnapshot(config);
    const add = desktopItems(snapshot).find((item) => item.kind === 'add-shortcut')!;
    const entity = shortcut('new', add.position);
    const result = placeNewDesktopNode(snapshot, {
      kind: 'shortcut', key: 'shortcut:new', entity, movable: true, revision,
      container: { kind: 'desktop' }, position: add.position,
    });
    expect(result.items.find((item) => item.key === 'shortcut:new')?.position).toEqual(add.position);
    expect(result.items.find((item) => item.key === 'add-shortcut')?.position).not.toEqual(add.position);
    assertValid(result.items);
  });

  it('repairs only the connected overlap component', () => {
    const snapshot = buildDesktopSnapshot(configWithShortcuts([
      shortcut('a', position(0, 26)), shortcut('b', position(0, 26)), shortcut('stable', position(20, 30)),
    ]));
    const result = repairDesktopSnapshot(snapshot);
    expect(result.items.find((item) => item.key === 'shortcut:stable')?.position).toEqual(position(20, 30));
    assertValid(result.items);
  });

  it('migrates legacy positions once and clears positions from folder members', () => {
    const config = createInitialConfig({ deviceId: 'test', counter: 0, epoch: 0 });
    config.groups.push({ id: 'folder', name: 'Folder', collapsed: false, sortKey: 'z', revision, position: position(12) });
    config.shortcuts.push({ ...shortcut('member', position(4)), groupId: 'folder' });
    const first = migrateDesktopPositions(config);
    const second = migrateDesktopPositions(first.config);
    expect(first.config.shortcuts[0]?.position).toBeUndefined();
    expect(second.changedShortcuts).toEqual([]);
    expect(second.widgetLayoutChanged).toBe(false);
  });

  it('preserves invariants across a deterministic set of mixed moves', () => {
    const config = configWithShortcuts(Array.from({ length: 12 }, (_, index) => shortcut(String(index), position((index % 6) * 4, 26 + Math.floor(index / 6) * 3))));
    let snapshot = buildDesktopSnapshot(config);
    for (let index = 0; index < 40; index += 1) {
      const result = placeDesktopNode(snapshot, `shortcut:${index % 12}`, position((index * 7) % 44, 26 + (index * 5) % 18), { x: index % 2 ? 1 : -1, y: 0 });
      assertValid(result.items);
      snapshot = result.snapshot;
    }
  });
});

function shortcut(id: string, itemPosition: WidgetPosition): Shortcut {
  return { id, groupId: DEFAULT_GROUP_ID, name: id, url: `https://${id}.example`, sortKey: id, revision, position: itemPosition };
}

function configWithShortcuts(shortcuts: Shortcut[]) {
  const config = createInitialConfig({ deviceId: 'test', counter: 0, epoch: 0 });
  config.shortcuts.push(...shortcuts);
  return config;
}

function assertValid(items: DesktopItem[]): void {
  for (const [index, item] of items.entries()) {
    expect(item.position.column).toBeGreaterThanOrEqual(0);
    expect(item.position.column + item.position.width).toBeLessThanOrEqual(48);
    expect(item.position.row).toBeGreaterThanOrEqual(0);
    expect(items.slice(index + 1).some((candidate) => overlaps(item.position, candidate.position))).toBe(false);
  }
}
