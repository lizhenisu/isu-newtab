import { useCallback, useEffect, useRef, useState } from 'react';

type BoundaryEvent = Pick<MouseEvent | PointerEvent, 'relatedTarget'>;

/** A null related target means the pointer crossed the browser document boundary. */
export function leftBrowserViewport(event: BoundaryEvent): boolean {
  return event.relatedTarget === null;
}

function isOutsideAutoScrollHotZone(event: MouseEvent | PointerEvent): boolean {
  const insetX = window.innerWidth * .2;
  const insetY = window.innerHeight * .2;
  return event.clientX >= insetX && event.clientX <= window.innerWidth - insetX
    && event.clientY >= insetY && event.clientY <= window.innerHeight - insetY;
}

/** Stops dnd-kit auto-scroll while a drag pointer is outside the browser window. */
export function useDragViewportAutoScroll(dragging: boolean): {
  autoScrollEnabled: boolean;
  beginDrag(): void;
} {
  const insideViewport = useRef(true);
  const waitingForSafeReentry = useRef(false);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const setInsideViewport = useCallback((next: boolean) => {
    if (insideViewport.current === next) return;
    insideViewport.current = next;
    setAutoScrollEnabled(next);
  }, []);
  const beginDrag = useCallback(() => {
    waitingForSafeReentry.current = false;
    setInsideViewport(true);
  }, [setInsideViewport]);

  useEffect(() => {
    if (!dragging) {
      beginDrag();
      return;
    }
    const pauseOutsideViewport = (event: MouseEvent | PointerEvent) => {
      if (!leftBrowserViewport(event)) return;
      waitingForSafeReentry.current = true;
      setInsideViewport(false);
    };
    const resumeAfterSafeReentry = (event: MouseEvent | PointerEvent) => {
      if (!waitingForSafeReentry.current || !isOutsideAutoScrollHotZone(event)) return;
      waitingForSafeReentry.current = false;
      setInsideViewport(true);
    };
    const pauseForBlur = () => {
      waitingForSafeReentry.current = true;
      setInsideViewport(false);
    };
    document.addEventListener('pointerout', pauseOutsideViewport, true);
    document.addEventListener('mouseout', pauseOutsideViewport, true);
    document.addEventListener('pointermove', resumeAfterSafeReentry, true);
    document.addEventListener('mousemove', resumeAfterSafeReentry, true);
    window.addEventListener('blur', pauseForBlur);
    return () => {
      document.removeEventListener('pointerout', pauseOutsideViewport, true);
      document.removeEventListener('mouseout', pauseOutsideViewport, true);
      document.removeEventListener('pointermove', resumeAfterSafeReentry, true);
      document.removeEventListener('mousemove', resumeAfterSafeReentry, true);
      window.removeEventListener('blur', pauseForBlur);
      beginDrag();
    };
  }, [beginDrag, dragging, setInsideViewport]);

  return { autoScrollEnabled, beginDrag };
}
