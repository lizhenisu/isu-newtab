import { useEffect, useLayoutEffect, useRef, type MutableRefObject } from 'react';

type Point = { x: number; y: number };
type Motion = {
  from: Point;
  to: Point;
  startedAt: number;
  duration: number;
  frame?: number;
};

/** Pixels per millisecond used by the layout handoff. Longer moves therefore
 * take proportionally longer while retaining the same damped profile. */
export const DAMPED_LAYOUT_SPEED_PX_PER_MS = .75;
export const DAMPED_LAYOUT_MIN_DURATION = 280;

export function dampedLayoutProgress(progress: number): number {
  const clamped = Math.max(0, Math.min(1, progress));
  return clamped ** 4;
}

export function dampedLayoutPoint(from: Point, to: Point, progress: number): Point {
  const eased = dampedLayoutProgress(progress);
  return {
    x: from.x + (to.x - from.x) * eased,
    y: from.y + (to.y - from.y) * eased,
  };
}

export function dampedLayoutDistance(from: Point, to: Point): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

export function dampedLayoutDuration(from: Point, to: Point): number {
  return Math.max(DAMPED_LAYOUT_MIN_DURATION, Math.round(dampedLayoutDistance(from, to) / DAMPED_LAYOUT_SPEED_PX_PER_MS));
}

/** Converts a viewport measurement into the stable document coordinate space. */
export function documentLayoutPoint(viewportPoint: Point, scrollOffset: Point): Point {
  return {
    x: viewportPoint.x + scrollOffset.x,
    y: viewportPoint.y + scrollOffset.y,
  };
}

/** Returns the CSS translation needed to paint a document point at its target. */
export function layoutMotionTranslate(point: Point, target: Point): Point {
  return {
    x: point.x - target.x,
    y: point.y - target.y,
  };
}

/** Keeps interrupted layout motion on one deterministic straight-line trajectory. */
export function useDampedLayoutMotion(
  nodeRef: MutableRefObject<HTMLElement | null>,
  position: { column: number; row: number },
  disabled: boolean,
): void {
  const targetRef = useRef<Point | undefined>(undefined);
  const motionRef = useRef<Motion | undefined>(undefined);
  const disabledRef = useRef(disabled);

  useEffect(() => () => stopMotion(motionRef, nodeRef.current), [nodeRef]);

  useLayoutEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    const resumedFromOwnDrag = disabledRef.current && !disabled;
    disabledRef.current = disabled;
    const now = performance.now();
    const running = motionRef.current;
    const current = running ? motionPosition(running, now) : targetRef.current;

    // Individual translate is intentionally separate from dnd-kit's transform.
    // Clearing it gives the new layout target without disturbing drag transforms.
    node.style.translate = 'none';
    const rect = node.getBoundingClientRect();
    const target = documentLayoutPoint(
      { x: rect.left, y: rect.top },
      { x: window.scrollX, y: window.scrollY },
    );
    targetRef.current = target;

    const reducedMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // The dragged node already followed the pointer to its drop target. Its first
    // post-drag layout update must snap there instead of replaying A -> B.
    if (disabled || resumedFromOwnDrag || reducedMotion) {
      stopMotion(motionRef, node);
      return;
    }
    if (running && samePoint(running.to, target)) {
      applyPosition(node, current ?? target, target);
      return;
    }
    if (!current || samePoint(current, target)) {
      stopMotion(motionRef, node);
      return;
    }

    stopMotion(motionRef, node);
    const motion: Motion = { from: current, to: target, startedAt: now, duration: dampedLayoutDuration(current, target) };
    motionRef.current = motion;
    node.dataset.layoutMotion = 'damped-quartic';
    const tick = (time: number) => {
      if (motionRef.current !== motion) return;
      const point = motionPosition(motion, time);
      applyPosition(node, point, target);
      if (time - motion.startedAt < motion.duration) {
        motion.frame = requestAnimationFrame(tick);
      } else {
        motionRef.current = undefined;
        node.style.translate = '';
        delete node.dataset.layoutMotion;
      }
    };
    tick(now);
  }, [disabled, nodeRef, position.column, position.row]);
}

function motionPosition(motion: Motion, time: number): Point {
  return dampedLayoutPoint(motion.from, motion.to, (time - motion.startedAt) / motion.duration);
}

function applyPosition(node: HTMLElement, point: Point, target: Point): void {
  const translate = layoutMotionTranslate(point, target);
  node.style.translate = `${translate.x}px ${translate.y}px`;
}

function samePoint(left: Point, right: Point): boolean {
  return Math.hypot(left.x - right.x, left.y - right.y) < .5;
}

function stopMotion(ref: { current?: Motion }, node: HTMLElement | null): void {
  if (ref.current?.frame !== undefined) cancelAnimationFrame(ref.current.frame);
  ref.current = undefined;
  if (!node) return;
  node.style.translate = '';
  delete node.dataset.layoutMotion;
}
