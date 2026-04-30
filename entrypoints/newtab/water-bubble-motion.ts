export type WaterBubbleKick = { sequence: number; x: number; y: number };

export type WaterBubbleDragState = {
  x: number;
  y: number;
  time: number;
  velocityX: number;
  velocityY: number;
  lastKickTime: number;
};

type DragPoint = Pick<WaterBubbleDragState, 'x' | 'y' | 'time'>;

export const WATER_BUBBLE_MAX_HORIZONTAL_KICK = 3;
export const WATER_BUBBLE_MAX_VERTICAL_KICK = 1.25;
const MIN_SAMPLE_DISTANCE = 4;
const MIN_SPEED = .12;
const MIN_KICK_INTERVAL_MS = 80;

/** Converts meaningful pointer reversals into a small, bounded liquid-lag kick. */
export function updateWaterBubbleDrag(state: WaterBubbleDragState | undefined, point: DragPoint): { state: WaterBubbleDragState; kick?: Omit<WaterBubbleKick, 'sequence'> } {
  if (!state) return { state: { ...point, velocityX: 0, velocityY: 0, lastKickTime: Number.NEGATIVE_INFINITY } };
  const elapsed = Math.max(1, point.time - state.time);
  const deltaX = point.x - state.x;
  const deltaY = point.y - state.y;
  const distance = Math.hypot(deltaX, deltaY);
  if (distance < MIN_SAMPLE_DISTANCE) return { state: { ...state, x: point.x, y: point.y, time: point.time } };

  const velocityX = deltaX / elapsed;
  const velocityY = deltaY / elapsed;
  const speed = Math.hypot(velocityX, velocityY);
  const previousSpeed = Math.hypot(state.velocityX, state.velocityY);
  const dotProduct = state.velocityX * velocityX + state.velocityY * velocityY;
  const reversed = previousSpeed >= MIN_SPEED && speed >= MIN_SPEED && dotProduct < -(previousSpeed * speed * .35);
  const canKick = point.time - state.lastKickTime >= MIN_KICK_INTERVAL_MS;
  const next: WaterBubbleDragState = { ...point, velocityX, velocityY, lastKickTime: state.lastKickTime };
  if (!reversed || !canKick) return { state: next };

  const kick = {
    x: normalizeZero(clamp(-velocityX * 6, -WATER_BUBBLE_MAX_HORIZONTAL_KICK, WATER_BUBBLE_MAX_HORIZONTAL_KICK)),
    y: normalizeZero(clamp(-velocityY * 2, -WATER_BUBBLE_MAX_VERTICAL_KICK, WATER_BUBBLE_MAX_VERTICAL_KICK)),
  };
  return { state: { ...next, lastKickTime: point.time }, kick };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}
