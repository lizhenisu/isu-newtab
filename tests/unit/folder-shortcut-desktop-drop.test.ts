import { describe, expect, it } from 'vitest';
import { createInitialConfig } from '../../core/domain/defaults';
import { overlaps } from '../../core/domain/desktop';
import { planFolderShortcutDesktopDrop } from '../../core/layout/folder-shortcut-desktop-drop';

const revision = { counter: 1, deviceId: 'test' };
const position = (column: number, row: number) => ({ column, row, width: 4 as const, height: 3 as const, gridVersion: 3 as const });

describe('folder shortcut desktop drop planning', () => {
  it('plans collision-free desktop placements without mutating the folder member source', () => {
    const config = createInitialConfig({ deviceId: 'test', counter: 0, epoch: 0 });
    config.shortcuts.push(
      { id: 'occupied', groupId: 'default', name: 'Occupied', url: 'https://occupied.example', sortKey: 'a0', revision, position: position(0, 0) },
      { id: 'member', groupId: 'folder', name: 'Member', url: 'https://member.example', sortKey: 'a1', revision },
    );
    config.groups.push({ id: 'folder', name: 'Folder', sortKey: 'a2', collapsed: false, revision, position: position(8, 0) });
    const plan = planFolderShortcutDesktopDrop(config, 'member', position(0, 0));
    const desktop = plan.placements;

    expect(plan.kind).toBe('folder-shortcut-desktop-drop');
    expect(plan.placements.some((placement) => placement.kind === 'shortcut' && placement.id === 'member')).toBe(true);
    expect(desktop.some((piece, index) => desktop.slice(index + 1).some((other) => overlaps(
      piece.position,
      other.position,
    )))).toBe(false);
  });
});
