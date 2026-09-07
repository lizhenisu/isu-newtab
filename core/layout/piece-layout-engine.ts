import {
  PIECE_COLUMNS,
  PIECE_MAX_X,
  PIECE_MIN_X,
  type Piece,
  type PiecePosition,
  piecePositionsOverlap,
  isPiecePositionValid as isValidPiecePosition,
} from '../domain/pieces';

export type PieceDragDirection = { x: -1 | 0 | 1; y: -1 | 0 | 1 };
export type PieceDirectionInput = PieceDragDirection | ReadonlyMap<string, PieceDragDirection>;
export type PiecePushContacts = ReadonlyMap<string, PieceDragDirection>;
export const PIECE_COLLISION_DWELL_MS = 600;
export type PieceCollisionIntentBlocker = {
  id: string;
  mode: 'protected' | 'push';
  dwellTarget?: { x: number; y: number };
  dwellStartedAt?: number;
};
export type PieceCollisionIntentSession = {
  activeId: string;
  blockers: readonly PieceCollisionIntentBlocker[];
};
export type PieceLayoutResult = { pieces: Piece[]; movedPieceIds: string[] };
export type PieceDragLayoutResult = PieceLayoutResult & { contacts: Map<string, PieceDragDirection> };

/** Pure runtime collision data supplied by callers. The solver itself never
 * reads the DOM, React state, or persisted storage. */
export type PieceLayoutOptions = {
  overlaps?: (leftId: string, left: PiecePosition, rightId: string, right: PiecePosition) => boolean;
  /** Runtime-only directions retained while an active piece continuously
   * pushes a blocker. These contacts are never part of persisted Piece data. */
  contacts?: PiecePushContacts;
  /** Runtime-only collision intent. Every newly contacted blocker stays fixed
   * until a stable dwell confirms normal push. */
  collisionIntent?: PieceCollisionIntentSession;
};

export type PieceLayoutCommand =
  | { type: 'move'; activeId: string; target: PiecePosition; direction?: PieceDragDirection; options?: PieceLayoutOptions }
  | { type: 'insert'; piece: Piece; target?: PiecePosition; direction?: PieceDragDirection; options?: PieceLayoutOptions }
  | { type: 'repair'; options?: PieceLayoutOptions };

export type OccupancyItem = { id: string; position: PiecePosition };
export type OccupancyIndex = {
  items: OccupancyItem[];
  byX: OccupancyItem[];
  byY: OccupancyItem[];
};

type AxisInterval = { start: number; end: number; id: string };
export type PushPlan = Map<string, PiecePosition>;

/**
 * Deterministic integer-grid solver. It jumps between rectangle boundaries
 * instead of scanning every intermediate row or column.
 */
export class PieceLayoutEngine {
  constructor(private readonly columns = 48) {}

  execute(snapshot: Piece[], command: PieceLayoutCommand): PieceLayoutResult {
    if (command.type === 'move') return this.place(snapshot, command.activeId, command.target, command.direction, command.options);
    if (command.type === 'insert') return this.insert(snapshot, command.piece, command.target, command.direction, command.options);
    return this.repair(snapshot, command.options);
  }

  place(snapshot: Piece[], activeId: string, target: PiecePosition, direction: PieceDragDirection = { x: 0, y: 1 }, options: PieceLayoutOptions = {}): PieceLayoutResult {
    const active = snapshot.find((piece) => piece.id === activeId);
    if (!active || active.container.kind !== 'desktop') return unchanged(snapshot);

    const activePosition = clampPosition({
      ...target,
      width: active.position?.width ?? target.width,
      height: active.position?.height ?? target.height,
    }, this.columns);
    const desktop = snapshot.filter((piece): piece is Piece & { position: PiecePosition } => piece.id !== activeId
      && piece.container.kind === 'desktop' && Boolean(piece.position));
    const protectedBlockerIds = options.collisionIntent?.activeId === activeId
      ? new Set(options.collisionIntent.blockers.filter((blocker) => blocker.mode === 'protected').map((blocker) => blocker.id))
      : new Set<string>();
    const blockers = desktop.filter((piece) => !protectedBlockerIds.has(piece.id)
      && overlapsWith(piece.id, piece.position, activeId, activePosition, options));
    const pieces = snapshot.map((piece) => structuredClone(piece));
    const activeResult = pieces.find((piece) => piece.id === activeId)!;
    activeResult.position = activePosition;

    if (!blockers.length) return { pieces, movedPieceIds: [activeId] };

    const blockerIds = new Set(blockers.map((piece) => piece.id));
    const fixed = desktop.filter((piece) => !blockerIds.has(piece.id));
    const index = buildPieceOccupancyIndex([
      { id: activeId, position: activePosition },
      ...fixed.map((piece) => ({ id: piece.id, position: piece.position })),
    ]);

    const blockerDirections = new Map(blockers.map((blocker) => [
      blocker.id,
      options.contacts?.get(blocker.id)
        ?? deriveRelativePushDirection(activePosition, blocker.position, active.position, direction),
    ]));
    const preferredDirections = blockers.map((blocker) => blockerDirections.get(blocker.id)!);
    const allowRigidPush = preferredDirections.every((candidate) => sameDirection(candidate, preferredDirections[0]));
    for (const pushDirections of orderedDirectionMaps(blockers, blockerDirections)) {
      const plan = solveDirectionalPush(blockers, index, activePosition, pushDirections, this.columns, options, activeId, allowRigidPush);
      if (plan) return applyPlan(pieces, activeId, activePosition, plan);
    }

    const fallbackPlan = solveNearestFallback(blockers, index, activeId, activePosition, this.columns, options);
    if (fallbackPlan) return applyPlan(pieces, activeId, activePosition, fallbackPlan);

    // The board is vertically expanding, so this is only a defensive guard
    // for malformed snapshots or an invalid custom column count.
    return unchanged(snapshot);
  }

  insert(snapshot: Piece[], piece: Piece, target = piece.position, direction: PieceDragDirection = { x: 0, y: 1 }, options: PieceLayoutOptions = {}): PieceLayoutResult {
    if (!target) return { pieces: snapshot.map((item) => structuredClone(item)), movedPieceIds: [] };
    const next = snapshot.filter((item) => item.id !== piece.id).map((item) => structuredClone(item));
    next.push({ ...structuredClone(piece), container: { kind: 'desktop' }, position: { ...target } });
    return this.place(next, piece.id, target, direction, options);
  }

  /** Repairs only connected desktop overlap components, preserving the
   * highest-priority item in each component and placing the rest nearby. */
  repair(snapshot: Piece[], options: PieceLayoutOptions = {}): PieceLayoutResult {
    const pieces = snapshot.map((piece) => structuredClone(piece));
    const desktop = pieces.filter((piece): piece is Piece & { position: PiecePosition } => piece.container.kind === 'desktop' && Boolean(piece.position));
    const unseen = new Set(desktop.map((piece) => piece.id));
    const byId = new Map(desktop.map((piece) => [piece.id, piece]));
    const moved = new Set<string>();
    while (unseen.size) {
      const firstId = [...unseen].sort()[0]!;
      unseen.delete(firstId);
      const component: Array<Piece & { position: PiecePosition }> = [];
      const queue = [byId.get(firstId)!];
      while (queue.length) {
        const current = queue.shift()!;
        component.push(current);
        for (const candidateId of [...unseen].sort()) {
          const candidate = byId.get(candidateId)!;
          if (component.some((item) => overlapsWith(item.id, item.position, candidate.id, candidate.position, options))) {
            unseen.delete(candidateId);
            queue.push(candidate);
          }
        }
      }
      if (component.length <= 1) continue;
      const ordered = component.slice().sort(compareRepairPriority);
      const winner = ordered.shift()!;
      const occupied = desktop.filter((item) => !component.some((candidate) => candidate.id === item.id)).map((item) => ({ id: item.id, position: item.position }));
      occupied.push({ id: winner.id, position: winner.position });
      for (const item of ordered) {
        const position = nearestFreePosition(item.position, buildPieceOccupancyIndex(occupied), this.columns, item.id, options);
        if (!position) continue;
        if (!samePosition(item.position, position)) {
          item.position = position;
          moved.add(item.id);
        }
        occupied.push({ id: item.id, position });
      }
    }
    return { pieces, movedPieceIds: [...moved].sort() };
  }

  nearestVacancy(snapshot: Piece[], origin: PiecePosition, size = origin, options: PieceLayoutOptions = {}): PiecePosition {
    const occupied = snapshot.filter((piece): piece is Piece & { position: PiecePosition } => piece.container.kind === 'desktop' && Boolean(piece.position))
      .map((piece) => ({ id: piece.id, position: piece.position }));
    return nearestFreePosition({ ...origin, ...size }, buildPieceOccupancyIndex(occupied), this.columns, '__vacancy__', options)
      ?? bottomVacancy({ ...origin, ...size }, buildPieceOccupancyIndex(occupied), this.columns, '__vacancy__', options)
      ?? { ...origin, ...size, x: PIECE_MIN_X, y: Math.max(0, origin.y) };
  }
}

export function solvePiecePlacement(snapshot: Piece[], activeId: string, target: PiecePosition, direction?: PieceDragDirection, options?: PieceLayoutOptions): PieceLayoutResult {
  return new PieceLayoutEngine().place(snapshot, activeId, target, direction, options);
}

/** Solves one drag frame and carries only contacts that still belong to the
 * same continuous push. Preview and pointer-up commit use this same boundary. */
export function solvePieceDragPlacement(
  snapshot: Piece[],
  activeId: string,
  target: PiecePosition,
  previousContacts: PiecePushContacts = new Map(),
  options: Omit<PieceLayoutOptions, 'contacts'> = {},
): PieceDragLayoutResult {
  const contacts = updatePiecePushContacts(snapshot, activeId, target, previousContacts, options);
  const result = new PieceLayoutEngine().place(snapshot, activeId, target, undefined, { ...options, contacts });
  return { ...result, contacts };
}

/** Reduces one frame of collision intent. Only blockers that actually overlap
 * the aligned target remain in the session, so leaving and re-entering always
 * starts a fresh dwell cycle. */
export function resolvePieceCollisionIntentSession(
  snapshot: Piece[],
  activeId: string,
  target: PiecePosition,
  previous?: PieceCollisionIntentSession,
  now = 0,
  options: Pick<PieceLayoutOptions, 'overlaps'> = {},
): PieceCollisionIntentSession | undefined {
  const active = snapshot.find((piece): piece is Piece & { position: PiecePosition } => piece.id === activeId
    && piece.container.kind === 'desktop' && Boolean(piece.position));
  if (!active) return undefined;
  const desktop = snapshot.filter((piece): piece is Piece & { position: PiecePosition } => piece.id !== activeId
    && piece.container.kind === 'desktop' && Boolean(piece.position));
  const activePosition = clampPosition({
    ...target,
    width: active.position.width,
    height: active.position.height,
  }, PIECE_COLUMNS);
  const previousById = new Map((previous?.activeId === activeId ? previous.blockers : []).map((blocker) => [blocker.id, blocker]));
  const blockers = desktop.filter((piece) => overlapsWith(piece.id, piece.position, activeId, activePosition, options))
    .map((piece): PieceCollisionIntentBlocker => {
    const state = previousById.get(piece.id);
    if (state?.mode === 'push') return state;
    const sameTarget = state?.dwellTarget?.x === activePosition.x && state.dwellTarget.y === activePosition.y;
    const dwellStartedAt = sameTarget && state?.dwellStartedAt !== undefined ? state.dwellStartedAt : now;
    if (now - dwellStartedAt >= PIECE_COLLISION_DWELL_MS) return { id: piece.id, mode: 'push' };
    return { id: piece.id, mode: 'protected', dwellTarget: { x: activePosition.x, y: activePosition.y }, dwellStartedAt };
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (!blockers.length) return undefined;
  const session = previous?.activeId === activeId ? previous : undefined;
  return session && blockers.length === session.blockers.length && blockers.every((state, index) => state === session.blockers[index])
    ? session
    : { activeId, blockers };
}

/** Returns the next dwell deadline for a protected blocker currently
 * overlapping at a stable grid target. The UI owns the timer and feeds its
 * timestamp back into the pure session reducer. */
export function nextPieceCollisionDwellDeadline(collisionIntent?: PieceCollisionIntentSession): number | undefined {
  const deadlines = collisionIntent?.blockers
    .filter((blocker) => blocker.mode === 'protected' && blocker.dwellStartedAt !== undefined)
    .map((blocker) => blocker.dwellStartedAt! + PIECE_COLLISION_DWELL_MS) ?? [];
  return deadlines.length ? Math.min(...deadlines) : undefined;
}

export function hasProtectedPieceCollision(collisionIntent?: PieceCollisionIntentSession): boolean {
  return collisionIntent?.blockers.some((blocker) => blocker.mode === 'protected') ?? false;
}

/** A contact locks direction while the active piece still overlaps the
 * blocker's original rectangle. Fully crossing, retreating, or leaving the
 * perpendicular projection releases it so a later collision can re-evaluate. */
export function updatePiecePushContacts(
  snapshot: Piece[],
  activeId: string,
  target: PiecePosition,
  previousContacts: PiecePushContacts = new Map(),
  options: Omit<PieceLayoutOptions, 'contacts'> = {},
): Map<string, PieceDragDirection> {
  const active = snapshot.find((piece) => piece.id === activeId);
  if (!active || active.container.kind !== 'desktop') return new Map();
  const activePosition = clampPosition({
    ...target,
    width: active.position?.width ?? target.width,
    height: active.position?.height ?? target.height,
  }, PIECE_COLUMNS);
  const desktop = snapshot.filter((piece): piece is Piece & { position: PiecePosition } => piece.id !== activeId
    && piece.container.kind === 'desktop' && Boolean(piece.position));
  const contacts = new Map<string, PieceDragDirection>();

  for (const blocker of desktop) {
    if (options.collisionIntent?.activeId === activeId
      && options.collisionIntent.blockers.some((state) => state.id === blocker.id && state.mode === 'protected')) continue;
    const overlaps = overlapsWith(blocker.id, blocker.position, activeId, activePosition, options);
    const previousDirection = previousContacts.get(blocker.id);
    if (overlaps && previousDirection && retainsPushContact(activePosition, blocker.position, previousDirection)) {
      contacts.set(blocker.id, previousDirection);
      continue;
    }
    if (overlaps) {
      contacts.set(blocker.id, deriveRelativePushDirection(activePosition, blocker.position, active.position));
    }
  }
  return contacts;
}

/**
 * Returns the direction in which a blocker should move to get away from the
 * active piece. Positions use the board's grid coordinate system, so this is
 * independent of pointer velocity and DOM measurements.
 */
export function deriveRelativePushDirection(
  active: PiecePosition,
  blocker: PiecePosition,
  previousActive?: PiecePosition,
  fallback: PieceDragDirection = { x: 0, y: 1 },
): PieceDragDirection {
  const activeCenter = centerOf(active);
  const blockerCenter = centerOf(blocker);
  const delta = { x: activeCenter.x - blockerCenter.x, y: activeCenter.y - blockerCenter.y };
  const previousDelta = previousActive ? {
    x: centerOf(previousActive).x - blockerCenter.x,
    y: centerOf(previousActive).y - blockerCenter.y,
  } : { x: 0, y: 0 };
  const overlap = {
    x: overlapLength(active.x, active.x + active.width, blocker.x, blocker.x + blocker.width),
    y: overlapLength(active.y, active.y + active.height, blocker.y, blocker.y + blocker.height),
  };

  let axis: 'x' | 'y';
  if (Math.abs(delta.x) > Math.abs(delta.y)) axis = 'x';
  else if (Math.abs(delta.y) > Math.abs(delta.x)) axis = 'y';
  else if (overlap.x < overlap.y) axis = 'x';
  else if (overlap.y < overlap.x) axis = 'y';
  else if (Math.abs(previousDelta.x) > Math.abs(previousDelta.y)) axis = 'x';
  else if (Math.abs(previousDelta.y) > Math.abs(previousDelta.x)) axis = 'y';
  else if (fallback.x !== 0) axis = 'x';
  else axis = 'y';

  const value = axis === 'x' ? (delta.x || previousDelta.x || fallback.x) : (delta.y || previousDelta.y || fallback.y);
  if (value === 0) return { x: 0, y: 1 };
  if (axis === 'x') return { x: value > 0 ? -1 : 1, y: 0 };
  return { x: 0, y: value > 0 ? -1 : 1 };
}

export function buildPieceOccupancyIndex(items: OccupancyItem[]): OccupancyIndex {
  const normalized = items.slice().sort((left, right) => left.id.localeCompare(right.id));
  return {
    items: normalized,
    byX: normalized.slice().sort((left, right) => left.position.x - right.position.x || left.id.localeCompare(right.id)),
    byY: normalized.slice().sort((left, right) => left.position.y - right.position.y || left.id.localeCompare(right.id)),
  };
}

export function pieceLayoutHasCollisions(pieces: Piece[]): boolean {
  const desktop = pieces.filter((piece): piece is Piece & { position: PiecePosition } => piece.container.kind === 'desktop' && Boolean(piece.position));
  return desktop.some((left, index) => desktop.slice(index + 1).some((right) => piecePositionsOverlap(left.position, right.position)));
}

export function solveDirectionalPush(
  blockers: Array<Piece & { position: PiecePosition }>,
  fixedIndex: OccupancyIndex,
  active: PiecePosition,
  direction: PieceDirectionInput,
  columns: number,
  options: PieceLayoutOptions = {},
  activeId = 'active',
  allowRigidPush = true,
): PushPlan | undefined {
  const directions = blockers.map((blocker) => directionFor(direction, blocker.id));
  const rigidDirection = directions.every((candidate) => sameDirection(candidate, directions[0])) ? directions[0] : undefined;
  // A rigid push is the least disruptive result: every directly blocking
  // piece keeps its relative arrangement and only one boundary distance is
  // calculated for the whole cluster.
  const rigid = allowRigidPush && rigidDirection ? solveRigidPush(blockers, fixedIndex, activeId, active, rigidDirection, columns, options) : undefined;

  // If the rigid cluster cannot pass an edge or a fixed obstacle, split only
  // the direct blockers. Previously placed blockers become fixed obstacles,
  // so unrelated pieces are never pulled into the reflow.
  const plan: PushPlan = new Map();
  const placed: OccupancyItem[] = fixedIndex.items.slice();
  placed.push({ id: activeId, position: active });
  for (const blocker of blockers.slice().sort((left, right) => left.id.localeCompare(right.id))) {
    const candidate = directionalClearance(blocker.position, buildPieceOccupancyIndex(placed), directionFor(direction, blocker.id), columns, options, blocker.id);
    if (!candidate) return rigid;
    plan.set(blocker.id, candidate);
    placed.push({ id: blocker.id, position: candidate });
  }
  if (!rigid) return plan;
  return comparePushPlans(rigid, plan, blockers, direction) <= 0 ? rigid : plan;
}

export function comparePushPlans(
  left: PushPlan,
  right: PushPlan,
  originals: Array<Pick<Piece, 'id' | 'position'>>,
  direction: PieceDirectionInput,
): number {
  const score = (plan: PushPlan) => {
    const distances = originals.map((item) => {
      const from = item.position!;
      const to = plan.get(item.id) ?? from;
      return {
        distance: Math.abs(to.x - from.x) + Math.abs(to.y - from.y),
        directionPenalty: Math.max(0, -((to.x - from.x) * directionFor(direction, item.id).x + (to.y - from.y) * directionFor(direction, item.id).y)),
      };
    });
    return {
      moved: distances.filter((item) => item.distance > 0).length,
      total: distances.reduce((sum, item) => sum + item.distance, 0),
      maximum: Math.max(0, ...distances.map((item) => item.distance)),
      penalty: distances.reduce((sum, item) => sum + item.directionPenalty, 0),
      key: [...plan.entries()].sort(([leftId], [rightId]) => leftId.localeCompare(rightId))
        .map(([id, position]) => `${id}:${position.x},${position.y}`).join('|'),
    };
  };
  const leftScore = score(left);
  const rightScore = score(right);
  return leftScore.moved - rightScore.moved
    || leftScore.total - rightScore.total
    || leftScore.maximum - rightScore.maximum
    || leftScore.penalty - rightScore.penalty
    || leftScore.key.localeCompare(rightScore.key);
}

function solveRigidPush(
  blockers: Array<Piece & { position: PiecePosition }>,
  fixedIndex: OccupancyIndex,
  activeId: string,
  active: PiecePosition,
  direction: PieceDragDirection,
  columns: number,
  options: PieceLayoutOptions,
): PushPlan | undefined {
  if (!blockers.length) return new Map();
  const axis = direction.x !== 0 ? 'x' : direction.y !== 0 ? 'y' : undefined;
  if (!axis) return undefined;

  const obstacles = [{ id: activeId, position: active }, ...fixedIndex.items];
  const events: AxisInterval[] = [];
  let maximumDistance = Number.POSITIVE_INFINITY;

  for (const blocker of blockers) {
    const position = blocker.position;
    const base = axis === 'x' ? position.x : position.y;
    const size = axis === 'x' ? position.width : position.height;
    const sign = axis === 'x' ? direction.x : direction.y;
    const perpendicularStart = axis === 'x' ? position.y : position.x;
    const perpendicularEnd = axis === 'x' ? position.y + position.height : position.x + position.width;
    const edgeDistance = sign > 0
      ? (axis === 'x' ? columns / 2 - position.width - position.x : Number.POSITIVE_INFINITY)
      : (axis === 'x' ? position.x - PIECE_MIN_X : position.y);
    maximumDistance = Math.min(maximumDistance, edgeDistance);

    for (const obstacle of obstacles) {
      const obstacleStart = axis === 'x' ? obstacle.position.y : obstacle.position.x;
      const obstacleEnd = axis === 'x' ? obstacle.position.y + obstacle.position.height : obstacle.position.x + obstacle.position.width;
      if (perpendicularEnd <= obstacleStart || obstacleEnd <= perpendicularStart) continue;
      const obstacleAxisStart = axis === 'x' ? obstacle.position.x : obstacle.position.y;
      const obstacleAxisEnd = axis === 'x' ? obstacle.position.x + obstacle.position.width : obstacle.position.y + obstacle.position.height;
      const coordinateStart = obstacleAxisStart - size + 1;
      const coordinateEnd = obstacleAxisEnd - 1;
      const distanceStart = sign > 0 ? coordinateStart - base : base - coordinateEnd;
      const distanceEnd = sign > 0 ? coordinateEnd - base : base - coordinateStart;
      const start = Math.max(0, Math.min(distanceStart, distanceEnd));
      const end = Math.max(distanceStart, distanceEnd);
      if (end >= 0 && start <= maximumDistance) events.push({ start, end, id: `${blocker.id}:${obstacle.id}` });
    }
  }

  const distance = firstFreeDistance(events, maximumDistance);
  if (distance === undefined) return undefined;
  const plan = new Map<string, PiecePosition>();
  for (const blocker of blockers) {
    const position = translate(blocker.position, direction, distance);
    if (!isPiecePositionValid(position, columns) || overlapsWith(blocker.id, position, activeId, active, options)
      || blockers.some((other) => other.id !== blocker.id && overlapsWith(blocker.id, position, other.id, translate(other.position, direction, distance), options))
      || fixedIndex.items.some((item) => overlapsWith(blocker.id, position, item.id, item.position, options))) return undefined;
    plan.set(blocker.id, position);
  }
  return plan;
}

export function directionalClearance(position: PiecePosition, index: OccupancyIndex, direction: PieceDragDirection, columns: number, options: PieceLayoutOptions = {}, movingId = 'active'): PiecePosition | undefined {
  const axis = direction.x !== 0 ? 'x' : direction.y !== 0 ? 'y' : undefined;
  if (!axis) return undefined;
  const sign = axis === 'x' ? direction.x : direction.y;
  const base = axis === 'x' ? position.x : position.y;
  const size = axis === 'x' ? position.width : position.height;
  const perpendicularStart = axis === 'x' ? position.y : position.x;
  const perpendicularEnd = axis === 'x' ? position.y + position.height : position.x + position.width;
  const intervals = (axis === 'x' ? index.byY : index.byX).flatMap((item) => {
    const obstacleStart = axis === 'x' ? item.position.y : item.position.x;
    const obstacleEnd = axis === 'x' ? item.position.y + item.position.height : item.position.x + item.position.width;
    if (perpendicularEnd <= obstacleStart || obstacleEnd <= perpendicularStart) return [];
    const obstacleAxisStart = axis === 'x' ? item.position.x : item.position.y;
    const obstacleAxisEnd = axis === 'x' ? item.position.x + item.position.width : item.position.y + item.position.height;
    return [{
      start: obstacleAxisStart - size + 1,
      end: obstacleAxisEnd - 1,
      id: item.id,
    }];
  }).sort((left, right) => sign > 0 ? left.start - right.start || left.end - right.end || left.id.localeCompare(right.id) : right.end - left.end || right.start - left.start || left.id.localeCompare(right.id));

  let coordinate = base;
  const minimum = axis === 'x' ? PIECE_MIN_X : 0;
  const maximum = axis === 'x' ? columns / 2 - size : Number.POSITIVE_INFINITY;
  for (let event = 0; event <= intervals.length; event += 1) {
    const obstacle = intervals.find((candidate) => coordinate >= candidate.start && coordinate <= candidate.end);
    if (!obstacle) {
      const candidate = axis === 'x'
        ? { ...position, x: coordinate }
        : { ...position, y: coordinate };
      return isPiecePositionValid(candidate, columns) && !index.items.some((item) => overlapsWith(movingId, candidate, item.id, item.position, options)) ? candidate : undefined;
    }
    coordinate = jumpPastObstacle(coordinate, obstacle, sign as -1 | 1);
    if (coordinate < minimum || coordinate > maximum) return undefined;
  }
  return undefined;
}

export function jumpPastObstacle(coordinate: number, obstacle: AxisInterval, direction: -1 | 1): number {
  return direction > 0 ? obstacle.end + 1 : obstacle.start - 1;
}

function solveNearestFallback(
  blockers: Array<Piece & { position: PiecePosition }>,
  fixedIndex: OccupancyIndex,
  activeId: string,
  active: PiecePosition,
  columns: number,
  options: PieceLayoutOptions,
): PushPlan | undefined {
  const plan: PushPlan = new Map();
  const occupied = fixedIndex.items.some((item) => item.id === activeId)
    ? fixedIndex.items.slice()
    : [...fixedIndex.items, { id: activeId, position: active }];
  for (const blocker of blockers.slice().sort((left, right) => left.id.localeCompare(right.id))) {
    const candidate = nearestFreePosition(blocker.position, buildPieceOccupancyIndex(occupied), columns, blocker.id, options);
    if (!candidate) return undefined;
    plan.set(blocker.id, candidate);
    occupied.push({ id: blocker.id, position: candidate });
  }
  return plan;
}

function nearestFreePosition(position: PiecePosition, index: OccupancyIndex, columns: number, movingId: string, options: PieceLayoutOptions): PiecePosition | undefined {
  const xCandidates = new Set<number>([PIECE_MIN_X, position.x, PIECE_MAX_X - position.width]);
  const yCandidates = new Set<number>([0, position.y]);
  for (const item of index.items) {
    xCandidates.add(item.position.x - position.width);
    xCandidates.add(item.position.x + item.position.width);
    yCandidates.add(item.position.y - position.height);
    yCandidates.add(item.position.y + item.position.height);
  }
  const candidates = [...xCandidates].flatMap((x) => [...yCandidates].map((y) => clampPosition({ ...position, x, y }, columns)))
    .filter((candidate, index, all) => all.findIndex((item) => samePosition(item, candidate)) === index)
    .filter((candidate) => !index.items.some((item) => overlapsWith(item.id, item.position, movingId, candidate, options)));
  candidates.sort((left, right) => Math.abs(left.x - position.x) + Math.abs(left.y - position.y) - (Math.abs(right.x - position.x) + Math.abs(right.y - position.y))
    || left.y - right.y || left.x - right.x);
  return candidates[0] ?? bottomVacancy(position, index, columns, movingId, options);
}

function bottomVacancy(position: PiecePosition, index: OccupancyIndex, columns: number, movingId: string, options: PieceLayoutOptions): PiecePosition | undefined {
  const y = Math.max(0, ...index.items.map((item) => item.position.y + item.position.height));
  const candidate = clampPosition({ ...position, x: PIECE_MIN_X, y }, columns);
  return index.items.some((item) => overlapsWith(item.id, item.position, movingId, candidate, options)) ? undefined : candidate;
}

function overlapsWith(leftId: string, left: PiecePosition, rightId: string, right: PiecePosition, options: PieceLayoutOptions): boolean {
  return options.overlaps?.(leftId, left, rightId, right) ?? piecePositionsOverlap(left, right);
}

function compareRepairPriority(left: Piece, right: Piece): number {
  return right.revision.counter - left.revision.counter
    || right.revision.deviceId.localeCompare(left.revision.deviceId)
    || repairKindPriority(left) - repairKindPriority(right)
    || left.id.localeCompare(right.id);
}

function repairKindPriority(piece: Piece): number {
  return piece.kind === 'system-widget' ? 0 : piece.kind === 'add-shortcut' ? 1 : piece.kind === 'folder' ? 2 : 3;
}

function firstFreeDistance(events: AxisInterval[], maximumDistance: number): number | undefined {
  let distance = 0;
  for (let event = 0; event <= events.length; event += 1) {
    const obstacle = events.find((candidate) => distance >= candidate.start && distance <= candidate.end);
    if (!obstacle) return distance <= maximumDistance ? distance : undefined;
    distance = obstacle.end + 1;
    if (distance > maximumDistance) return undefined;
  }
  return undefined;
}

function orderedDirections(direction: PieceDragDirection): PieceDragDirection[] {
  if (direction.x !== 0) return [
    { x: direction.x, y: 0 },
    { x: -direction.x as -1 | 1, y: 0 },
    { x: 0, y: -1 },
    { x: 0, y: 1 },
  ];
  if (direction.y !== 0) return [
    { x: 0, y: direction.y },
    { x: 0, y: -direction.y as -1 | 1 },
    { x: -1, y: 0 },
    { x: 1, y: 0 },
  ];
  return [{ x: 0, y: -1 }, { x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }];
}

function orderedDirectionMaps(
  blockers: Array<Pick<Piece, 'id'>>,
  directions: ReadonlyMap<string, PieceDragDirection>,
): Array<ReadonlyMap<string, PieceDragDirection>> {
  const candidates = blockers.map((blocker) => orderedDirections(directions.get(blocker.id) ?? { x: 0, y: 1 }));
  return [0, 1, 2, 3].map((index) => new Map(blockers.map((blocker, blockerIndex) => [blocker.id, candidates[blockerIndex]![index]!])))
    .filter((candidate) => candidate.size > 0);
}

function directionFor(direction: PieceDirectionInput, pieceId: string): PieceDragDirection {
  if (typeof direction === 'object' && 'get' in direction) return direction.get(pieceId) ?? { x: 0, y: 1 };
  return direction;
}

function sameDirection(left?: PieceDragDirection, right?: PieceDragDirection): boolean {
  return Boolean(left && right && left.x === right.x && left.y === right.y);
}

function centerOf(position: PiecePosition): { x: number; y: number } {
  return { x: position.x + position.width / 2, y: position.y + position.height / 2 };
}

function overlapLength(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): number {
  return Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart));
}

function translate(position: PiecePosition, direction: PieceDragDirection, distance: number): PiecePosition {
  return { ...position, x: position.x + direction.x * distance, y: position.y + direction.y * distance };
}

function retainsPushContact(active: PiecePosition, blocker: PiecePosition, direction: PieceDragDirection): boolean {
  if (direction.x !== 0) {
    const sharesRows = overlapLength(active.y, active.y + active.height, blocker.y, blocker.y + blocker.height) > 0;
    if (!sharesRows) return false;
    return active.x + active.width > blocker.x && active.x < blocker.x + blocker.width;
  }
  if (direction.y !== 0) {
    const sharesColumns = overlapLength(active.x, active.x + active.width, blocker.x, blocker.x + blocker.width) > 0;
    if (!sharesColumns) return false;
    return active.y + active.height > blocker.y && active.y < blocker.y + blocker.height;
  }
  return false;
}

function clampPosition(position: PiecePosition, columns: number): PiecePosition {
  const maxX = columns / 2 - position.width;
  return { ...position, x: Math.max(PIECE_MIN_X, Math.min(maxX, Math.round(position.x))), y: Math.max(0, Math.round(position.y)) };
}

function isPiecePositionValid(position: PiecePosition, columns: number): boolean {
  return isPiecePositionValidBase(position) && position.x + position.width <= columns / 2;
}

function isPiecePositionValidBase(position: PiecePosition): boolean {
  return isValidPiecePosition(position);
}

function samePosition(left: PiecePosition, right: PiecePosition): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

function applyPlan(
  pieces: Piece[],
  activeId: string,
  activePosition: PiecePosition,
  plan: PushPlan,
): PieceLayoutResult {
  const moved = new Set<string>([activeId]);
  for (const piece of pieces) {
    if (piece.id === activeId) piece.position = activePosition;
    const next = plan.get(piece.id);
    if (next) {
      piece.position = next;
      moved.add(piece.id);
    }
  }
  return { pieces, movedPieceIds: [...moved].sort() };
}

function unchanged(snapshot: Piece[], activeId?: string, activePosition?: PiecePosition): PieceLayoutResult {
  const pieces = snapshot.map((piece) => structuredClone(piece));
  if (activeId && activePosition) pieces.find((piece) => piece.id === activeId)!.position = activePosition;
  return { pieces, movedPieceIds: activeId ? [activeId] : [] };
}
