import { describe, expect, it } from 'vitest';
import { createInitialConfig } from '../../core/domain/defaults';
import { buildDesktopSnapshot, desktopItems } from '../../core/domain/desktop';
import { collisionGeometryForRects, collisionRectFor, collisionRectsOverlap, roundCollisionSize, type DesktopCollisionGeometry } from '../../core/layout/desktop-collision';
import { placeDesktopNode } from '../../core/layout/piece-desktop-adapter';

const geometry: DesktopCollisionGeometry = {
  boardLeft: 0,
  boardTop: 0,
  columnWidth: 10,
  rowHeight: 40,
  nodes: {
    'shortcut:a': { width: 20, height: 20, offsetX: 0, offsetY: 0 },
    'shortcut:b': { width: 20, height: 20, offsetX: 0, offsetY: 0 },
  },
};

describe('desktop collision geometry', () => {
  it('rounds the smallest collision box up to whole grid units', () => {
    expect(roundCollisionSize(61, 41, 20, 40)).toEqual({ width: 80, height: 80 });
    expect(roundCollisionSize(41, 41, 20, 40)).toEqual({ width: 80, height: 80 });
    expect(roundCollisionSize(41, 41, 20, 40, 47)).toEqual({ width: 60, height: 80 });
    expect(roundCollisionSize(79.99999999, 80, 20, 40)).toEqual({ width: 80, height: 80 });
  });

  it('snaps rounded geometry edges to the board grid', () => {
    const result = collisionGeometryForRects(
      { left: 0, top: 0, width: 960 },
      40,
      [{
        key: 'shortcut:center',
        position: { column: 10, row: 2, width: 4, height: 3, gridVersion: 3 },
        rect: { left: 210, top: 95, width: 61, height: 41 },
      }],
    );
    const node = result.nodes['shortcut:center']!;
    expect(node).toMatchObject({ width: 80, height: 80, offsetX: 20, offsetY: 0 });
    const collision = collisionRectFor('shortcut:center', { column: 10, row: 2, width: 4, height: 3, gridVersion: 3 }, result)!;
    expect(collision).toEqual({ left: 220, right: 300, top: 80, bottom: 160 });
    expect(collision.left % result.columnWidth).toBeCloseTo(0);
    expect(collision.top % result.rowHeight).toBeCloseTo(0);
    expect((collision.right - result.boardLeft) % result.columnWidth).toBeCloseTo(0);
    expect((collision.bottom - result.boardTop) % result.rowHeight).toBeCloseTo(0);
  });

  it('does not treat an edge touch as a collision', () => {
    expect(collisionRectsOverlap(
      { left: 0, right: 20, top: 0, bottom: 20 },
      { left: 20, right: 40, top: 0, bottom: 20 },
    )).toBe(false);
    expect(collisionRectsOverlap(
      { left: 0, right: 20, top: 0, bottom: 20 },
      { left: 19, right: 40, top: 0, bottom: 20 },
    )).toBe(true);
  });

  it('keeps the actual box as the source of collision coordinates', () => {
    const a = collisionRectFor('shortcut:a', { column: 0, row: 0, width: 4, height: 3, gridVersion: 3 }, geometry);
    const b = collisionRectFor('shortcut:b', { column: 3, row: 0, width: 4, height: 3, gridVersion: 3 }, geometry);
    expect(a).toEqual({ left: 0, right: 20, top: 0, bottom: 40 });
    expect(b).toEqual({ left: 30, right: 50, top: 0, bottom: 40 });
    expect(collisionRectsOverlap(a!, b!)).toBe(false);
  });

  it('does not push a logically overlapping item while actual boxes remain apart', () => {
    const config = createInitialConfig({ deviceId: 'test', counter: 0, epoch: 0 });
    config.shortcuts.push(
      { id: 'a', groupId: 'default', name: 'A', url: 'https://a.example', sortKey: 'a', revision: { counter: 1, deviceId: 'test' }, position: { column: 0, row: 0, width: 4, height: 3, gridVersion: 3 } },
      { id: 'b', groupId: 'default', name: 'B', url: 'https://b.example', sortKey: 'b', revision: { counter: 1, deviceId: 'test' }, position: { column: 3, row: 0, width: 4, height: 3, gridVersion: 3 } },
    );
    const snapshot = buildDesktopSnapshot(config);
    const result = placeDesktopNode(snapshot, 'shortcut:a', { column: 1, row: 0, width: 4, height: 3, gridVersion: 3 }, { x: 1, y: 0 }, geometry);
    expect(result.movedKeys).toEqual(['shortcut:a']);
    expect(result.items.find((item) => item.key === 'shortcut:b')?.position.column).toBe(3);
    expect(desktopItems(result.snapshot).find((item) => item.key === 'shortcut:a')?.position.column).toBe(1);
  });

  it('pushes once actual boxes overlap', () => {
    const config = createInitialConfig({ deviceId: 'test', counter: 0, epoch: 0 });
    config.shortcuts.push(
      { id: 'a', groupId: 'default', name: 'A', url: 'https://a.example', sortKey: 'a', revision: { counter: 1, deviceId: 'test' }, position: { column: 0, row: 0, width: 4, height: 3, gridVersion: 3 } },
      { id: 'b', groupId: 'default', name: 'B', url: 'https://b.example', sortKey: 'b', revision: { counter: 1, deviceId: 'test' }, position: { column: 3, row: 0, width: 4, height: 3, gridVersion: 3 } },
    );
    const result = placeDesktopNode(buildDesktopSnapshot(config), 'shortcut:a', { column: 2, row: 0, width: 4, height: 3, gridVersion: 3 }, { x: 1, y: 0 }, geometry);
    expect(result.items.find((item) => item.key === 'shortcut:b')?.position.column).not.toBe(3);
  });
});
