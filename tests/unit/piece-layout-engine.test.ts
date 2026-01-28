import { describe, expect, it } from 'vitest';
import {
  deriveRelativePushDirection,
  hasProtectedPieceCollision,
  PieceLayoutEngine,
  PIECE_COLLISION_DWELL_MS,
  nextPieceCollisionDwellDeadline,
  pieceLayoutHasCollisions,
  resolvePieceCollisionIntentSession,
  solvePieceDragPlacement,
  type PieceDragDirection,
} from '../../core/layout/piece-layout-engine';
import type { Piece, PiecePosition } from '../../core/domain/pieces';

const revision = { counter: 1, deviceId: 'test' };

function piece(id: string, position: PiecePosition): Piece {
  return {
    id,
    kind: id === 'active' ? 'system-widget' : 'shortcut',
    payloadRef: id,
    container: { kind: 'desktop' },
    position,
    revision,
  };
}

function position(x: number, y: number, width = 4, height = 3): PiecePosition {
  return { x, y, width, height };
}

function solve(snapshot: Piece[], target: PiecePosition, direction: PieceDragDirection = { x: 1, y: 0 }) {
  return new PieceLayoutEngine().place(snapshot, 'active', target, direction);
}

describe('PieceLayoutEngine relative-position displacement', () => {
  it('derives the blocker direction from the active piece side', () => {
    expect(deriveRelativePushDirection(position(0, 7), position(0, 4))).toEqual({ x: 0, y: -1 });
    expect(deriveRelativePushDirection(position(0, 0), position(4, 0))).toEqual({ x: 1, y: 0 });
    expect(deriveRelativePushDirection(position(0, 0), position(0, 3))).toEqual({ x: 0, y: 1 });
    expect(deriveRelativePushDirection(position(7, 0), position(3, 0))).toEqual({ x: -1, y: 0 });
  });

  it('uses the shallower overlap axis for an equally distant diagonal target', () => {
    expect(deriveRelativePushDirection(position(2, 2, 4, 4), position(0, 0, 4, 4))).toEqual({ x: 0, y: -1 });
  });

  it('uses the active target side when placing an overlapping piece', () => {
    const result = solve([
      piece('active', position(0, 0)),
      piece('blocker', position(0, 4)),
    ], position(0, 5));
    expect(result.pieces.find((item) => item.id === 'blocker')?.position?.y).toBeLessThan(4);
    expect(pieceLayoutHasCollisions(result.pieces)).toBe(false);
  });

  it('moves a blocker by one cell when a one-cell clearance is enough', () => {
    const result = solve([piece('active', position(0, 0)), piece('blocker', position(6, 0))], position(3, 0));
    expect(result.pieces.find((item) => item.id === 'blocker')?.position).toEqual(position(7, 0));
    expect(result.pieces.find((item) => item.id === 'active')?.position).toEqual(position(3, 0));
    expect(result.movedPieceIds).toEqual(['active', 'blocker']);
    expect(pieceLayoutHasCollisions(result.pieces)).toBe(false);
  });

  it('does not report distant pieces as blockers until the target overlaps them', () => {
    const snapshot = [
      piece('active', position(0, 0)),
      piece('near', position(6, 0)),
      piece('distant', position(20, 0)),
    ];
    const result = solve(snapshot, position(3, 0));
    expect(result.movedPieceIds).toEqual(['active', 'near']);
    expect(result.pieces.find((item) => item.id === 'distant')?.position).toEqual(position(20, 0));
  });

  it('does not use the active piece width as the displacement step', () => {
    const result = solve([piece('active', position(0, 0)), piece('blocker', position(6, 0))], position(3, 0));
    expect(result.pieces.find((item) => item.id === 'blocker')?.position?.x).not.toBe(10);
  });

  it('keeps unrelated pieces frozen', () => {
    const result = solve([
      piece('active', position(0, 0)),
      piece('blocker', position(6, 0)),
      piece('unrelated', position(14, 0)),
    ], position(3, 0));
    expect(result.pieces.find((item) => item.id === 'unrelated')?.position).toEqual(position(14, 0));
  });

  it('uses the confirmed horizontal direction order', () => {
    const result = solve([
      piece('active', position(0, 0)),
      piece('blocker', position(6, 0)),
      piece('right-wall', position(10, 0)),
    ], position(3, 0), { x: 1, y: 0 });
    // The preferred direction is tried before the reverse direction and
    // remains deterministic even when the reverse side is closer.
    expect(result.pieces.find((item) => item.id === 'blocker')?.position?.x).toBeGreaterThan(6);
    expect(pieceLayoutHasCollisions(result.pieces)).toBe(false);
  });

  it('returns the same result for the same snapshot and command', () => {
    const snapshot = [piece('active', position(0, 0)), piece('blocker', position(6, 0)), piece('fixed', position(14, 0))];
    const first = solve(snapshot, position(3, 0));
    const second = solve(snapshot, position(3, 0));
    expect(first.pieces).toEqual(second.pieces);
    expect(first.movedPieceIds).toEqual(second.movedPieceIds);
  });

  it('keeps the entry-side direction while overlapping, then releases after fully crossing', () => {
    const snapshot = [piece('active', position(0, 0)), piece('blocker', position(0, 4))];
    const entered = solvePieceDragPlacement(snapshot, 'active', position(0, 2));
    expect(entered.contacts.get('blocker')).toEqual({ x: 0, y: 1 });

    const crossedCenter = solvePieceDragPlacement(snapshot, 'active', position(0, 6), entered.contacts);
    expect(crossedCenter.contacts.get('blocker')).toEqual({ x: 0, y: 1 });
    expect(crossedCenter.pieces.find((item) => item.id === 'blocker')?.position?.y).toBe(9);

    const passedOriginalPosition = solvePieceDragPlacement(snapshot, 'active', position(0, 8), crossedCenter.contacts);
    expect(passedOriginalPosition.contacts.has('blocker')).toBe(false);
    expect(passedOriginalPosition.pieces.find((item) => item.id === 'blocker')?.position).toEqual(position(0, 4));
    expect(pieceLayoutHasCollisions(passedOriginalPosition.pieces)).toBe(false);
  });

  it('keeps a blocker fixed while crossing it one grid row every 400ms', () => {
    const snapshot = [piece('active', position(0, 0)), piece('blocker', position(0, 3))];
    let collisionIntent = resolvePieceCollisionIntentSession(snapshot, 'active', position(0, 1), undefined, 0);
    expect(collisionIntent).toEqual({
      activeId: 'active',
      blockers: [{ id: 'blocker', mode: 'protected', dwellTarget: { x: 0, y: 1 }, dwellStartedAt: 0 }],
    });

    for (const [index, row] of [1, 2, 3, 4, 5].entries()) {
      collisionIntent = resolvePieceCollisionIntentSession(snapshot, 'active', position(0, row), collisionIntent, index * 400);
      const result = solvePieceDragPlacement(snapshot, 'active', position(0, row), new Map(), { collisionIntent });
      expect(result.pieces.find((item) => item.id === 'blocker')?.position).toEqual(position(0, 3));
      expect(result.movedPieceIds).toEqual(['active']);
      expect(result.contacts.has('blocker')).toBe(false);
    }

    const target = position(0, 6);
    collisionIntent = resolvePieceCollisionIntentSession(snapshot, 'active', target, collisionIntent, 2400);
    expect(collisionIntent).toBeUndefined();
    const completed = solvePieceDragPlacement(snapshot, 'active', target, new Map(), { collisionIntent });
    expect(completed.pieces.find((item) => item.id === 'active')?.position).toEqual(target);
    expect(completed.pieces.find((item) => item.id === 'blocker')?.position).toEqual(position(0, 3));
    expect(pieceLayoutHasCollisions(completed.pieces)).toBe(false);
  });

  it('lets a horizontally adjacent piece move through the blocker to either vertical side', () => {
    const snapshot = [piece('active', position(0, 4)), piece('blocker', position(4, 4))];
    const overlap = resolvePieceCollisionIntentSession(snapshot, 'active', position(2, 4), undefined, 0);
    expect(hasProtectedPieceCollision(overlap)).toBe(true);
    const above = position(4, 1);
    const below = position(4, 7);
    expect(resolvePieceCollisionIntentSession(snapshot, 'active', above, overlap, 400)).toBeUndefined();
    expect(resolvePieceCollisionIntentSession(snapshot, 'active', below, overlap, 400)).toBeUndefined();
    for (const target of [above, below]) {
      const result = solvePieceDragPlacement(snapshot, 'active', target);
      expect(result.pieces.find((item) => item.id === 'blocker')?.position).toEqual(position(4, 4));
      expect(result.pieces.find((item) => item.id === 'active')?.position).toEqual(target);
    }
  });

  it('supports the symmetric move from a vertical neighbor to either horizontal side', () => {
    const snapshot = [piece('active', position(0, 0)), piece('blocker', position(0, 3))];
    const overlap = resolvePieceCollisionIntentSession(snapshot, 'active', position(0, 1), undefined, 0);
    for (const target of [position(-4, 3), position(4, 3)]) {
      expect(resolvePieceCollisionIntentSession(snapshot, 'active', target, overlap, 400)).toBeUndefined();
      const result = solvePieceDragPlacement(snapshot, 'active', target);
      expect(result.pieces.find((item) => item.id === 'blocker')?.position).toEqual(position(0, 3));
      expect(result.pieces.find((item) => item.id === 'active')?.position).toEqual(target);
    }
  });

  it('protects a newly contacted blocker even when it was not initially adjacent', () => {
    const snapshot = [piece('active', position(0, 0)), piece('blocker', position(0, 10))];
    const collisionIntent = resolvePieceCollisionIntentSession(snapshot, 'active', position(0, 8), undefined, 100);
    expect(collisionIntent?.blockers[0]).toEqual({ id: 'blocker', mode: 'protected', dwellTarget: { x: 0, y: 8 }, dwellStartedAt: 100 });
    const preview = solvePieceDragPlacement(snapshot, 'active', position(0, 8), new Map(), { collisionIntent });
    expect(preview.pieces.find((item) => item.id === 'blocker')?.position).toEqual(position(0, 10));
  });

  it('releases a protected blocker into normal displacement after a stable dwell', () => {
    const snapshot = [piece('active', position(0, 0)), piece('blocker', position(0, 3))];
    const entered = resolvePieceCollisionIntentSession(snapshot, 'active', position(0, 1), undefined, 1000);
    expect(nextPieceCollisionDwellDeadline(entered)).toBe(1000 + PIECE_COLLISION_DWELL_MS);

    const waiting = resolvePieceCollisionIntentSession(snapshot, 'active', position(0, 1), entered, 1599);
    expect(waiting?.blockers[0]?.mode).toBe('protected');
    const released = resolvePieceCollisionIntentSession(snapshot, 'active', position(0, 1), waiting, 1600);
    expect(released?.blockers[0]).toEqual({ id: 'blocker', mode: 'push' });
    expect(nextPieceCollisionDwellDeadline(released)).toBeUndefined();

    const displaced = solvePieceDragPlacement(snapshot, 'active', position(0, 1), new Map(), { collisionIntent: released });
    expect(displaced.movedPieceIds).toContain('blocker');
    expect(displaced.pieces.find((item) => item.id === 'blocker')?.position).not.toEqual(position(0, 3));
  });

  it('restarts dwell when the grid target changes', () => {
    const snapshot = [piece('active', position(0, 0)), piece('blocker', position(0, 3))];
    const first = resolvePieceCollisionIntentSession(snapshot, 'active', position(0, 1), undefined, 100);
    const moved = resolvePieceCollisionIntentSession(snapshot, 'active', position(0, 2), first, 650);
    expect(moved?.blockers[0]?.dwellStartedAt).toBe(650);
    expect(resolvePieceCollisionIntentSession(snapshot, 'active', position(0, 2), moved, 1249)?.blockers[0]?.mode).toBe('protected');
  });

  it('ends a push cycle on separation and protects the blocker again on re-entry', () => {
    const snapshot = [piece('active', position(0, 0)), piece('blocker', position(0, 3))];
    const entered = resolvePieceCollisionIntentSession(snapshot, 'active', position(0, 1), undefined, 0);
    const pushing = resolvePieceCollisionIntentSession(snapshot, 'active', position(0, 1), entered, 600);
    expect(pushing?.blockers[0]?.mode).toBe('push');
    const separated = resolvePieceCollisionIntentSession(snapshot, 'active', position(8, 1), pushing, 700);
    expect(separated).toBeUndefined();
    const reentered = resolvePieceCollisionIntentSession(snapshot, 'active', position(0, 1), separated, 800);
    expect(reentered?.blockers[0]).toEqual({ id: 'blocker', mode: 'protected', dwellTarget: { x: 0, y: 1 }, dwellStartedAt: 800 });
  });

  it('tracks simultaneous blockers independently and drops blockers after separation', () => {
    const snapshot = [piece('active', position(-4, 0, 8, 3)), piece('left', position(-4, 3, 4, 4)), piece('right', position(0, 3, 6, 4))];
    const entered = resolvePieceCollisionIntentSession(snapshot, 'active', position(-4, 1, 8, 3), undefined, 100);
    expect(entered?.blockers.map((blocker) => blocker.id)).toEqual(['left', 'right']);
    const shifted = resolvePieceCollisionIntentSession(snapshot, 'active', position(0, 1, 8, 3), entered, 200);
    expect(shifted?.blockers).toEqual([{ id: 'right', mode: 'protected', dwellTarget: { x: 0, y: 1 }, dwellStartedAt: 200 }]);
  });

  it('releases after retreating past the entry edge and derives a new direction on re-entry', () => {
    const snapshot = [piece('active', position(0, 0)), piece('blocker', position(0, 4))];
    const entered = solvePieceDragPlacement(snapshot, 'active', position(0, 2));
    const retreated = solvePieceDragPlacement(snapshot, 'active', position(0, 1), entered.contacts);
    expect(retreated.contacts.has('blocker')).toBe(false);
    expect(retreated.pieces.find((item) => item.id === 'blocker')?.position).toEqual(position(0, 4));

    const enteredFromBelow = solvePieceDragPlacement(snapshot, 'active', position(0, 6), retreated.contacts);
    expect(enteredFromBelow.contacts.get('blocker')).toEqual({ x: 0, y: -1 });
    expect(enteredFromBelow.pieces.find((item) => item.id === 'blocker')?.position?.y).toBe(3);
  });

  it('releases a vertical push when the active piece leaves the blocker columns', () => {
    const snapshot = [piece('active', position(0, 0)), piece('blocker', position(0, 4))];
    const entered = solvePieceDragPlacement(snapshot, 'active', position(0, 2));
    const movedAside = solvePieceDragPlacement(snapshot, 'active', position(8, 8), entered.contacts);
    expect(movedAside.contacts.size).toBe(0);
    expect(movedAside.pieces.find((item) => item.id === 'blocker')?.position).toEqual(position(0, 4));
  });
});
