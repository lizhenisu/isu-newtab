import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { leftBrowserViewport, useDragViewportAutoScroll } from '../../entrypoints/newtab/hooks/useDragViewportAutoScroll';

describe('drag viewport auto-scroll guard', () => {
  it('only treats a null related target as leaving the browser viewport', () => {
    const pageElement = document.createElement('div');
    expect(leftBrowserViewport({ relatedTarget: pageElement })).toBe(false);
    expect(leftBrowserViewport({ relatedTarget: null })).toBe(true);
  });

  it('pauses while the pointer is outside or the window is blurred, then resumes on return', () => {
    const { result, rerender } = renderHook(({ dragging }) => useDragViewportAutoScroll(dragging), { initialProps: { dragging: false } });
    rerender({ dragging: true });

    act(() => document.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })));
    expect(result.current.autoScrollEnabled).toBe(true);

    act(() => document.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null })));
    expect(result.current.autoScrollEnabled).toBe(false);

    act(() => document.dispatchEvent(new Event('blur')));
    expect(result.current.autoScrollEnabled).toBe(false);

    act(() => document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 1, clientY: 1 })));
    expect(result.current.autoScrollEnabled).toBe(false);

    act(() => document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: window.innerWidth / 2, clientY: window.innerHeight / 2 })));
    expect(result.current.autoScrollEnabled).toBe(true);

    act(() => window.dispatchEvent(new Event('blur')));
    expect(result.current.autoScrollEnabled).toBe(false);
  });
});
