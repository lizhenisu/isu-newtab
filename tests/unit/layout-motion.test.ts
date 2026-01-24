import { describe, expect, it } from 'vitest';
import {
  dampedLayoutDistance,
  dampedLayoutDuration,
  dampedLayoutPoint,
  dampedLayoutProgress,
  documentLayoutPoint,
  DAMPED_LAYOUT_MIN_DURATION,
  layoutMotionTranslate,
} from '../../entrypoints/newtab/hooks/useDampedLayoutMotion';

describe('damped layout motion', () => {
  it('keeps the first two thirds slow and moves most distance in the final third', () => {
    expect(dampedLayoutProgress(-1)).toBe(0);
    expect(dampedLayoutProgress(.25)).toBe(.00390625);
    expect(dampedLayoutProgress(.5)).toBe(.0625);
    expect(dampedLayoutProgress(2 / 3)).toBeCloseTo(.1975, 3);
    expect(dampedLayoutProgress(.75)).toBeCloseTo(.3164, 3);
    expect(dampedLayoutProgress(2)).toBe(1);
  });

  it('uses the same damped progress on both axes to keep a straight path', () => {
    expect(dampedLayoutPoint({ x: 0, y: 0 }, { x: 8, y: 4 }, .5)).toEqual({ x: .5, y: .25 });
    expect(dampedLayoutPoint({ x: 2, y: 8 }, { x: -6, y: 0 }, .5)).toEqual({ x: 1.5, y: 7.5 });
  });

  it('scales duration with Euclidean movement distance', () => {
    const near = dampedLayoutDuration({ x: 0, y: 0 }, { x: 100, y: 0 });
    const far = dampedLayoutDuration({ x: 0, y: 0 }, { x: 300, y: 400 });
    expect(dampedLayoutDistance({ x: 0, y: 0 }, { x: 300, y: 400 })).toBe(500);
    expect(far).toBeGreaterThan(near);
    expect(dampedLayoutDuration({ x: 10, y: 20 }, { x: 110, y: 20 })).toBe(near);
  });

  it('keeps very short moves above the minimum duration', () => {
    expect(dampedLayoutDuration({ x: 0, y: 0 }, { x: .1, y: .1 })).toBe(DAMPED_LAYOUT_MIN_DURATION);
  });

  it.each([40, 80, 100, 210])('uses the 280ms minimum for a %dpx displacement', (distance) => {
    expect(dampedLayoutDuration({ x: 0, y: 0 }, { x: distance, y: 0 })).toBe(280);
  });

  it('continues increasing duration above the 210px minimum-speed boundary', () => {
    const justAboveMinimum = dampedLayoutDuration({ x: 0, y: 0 }, { x: 211, y: 0 });
    const farther = dampedLayoutDuration({ x: 0, y: 0 }, { x: 420, y: 0 });
    expect(justAboveMinimum).toBeGreaterThan(280);
    expect(farther).toBeGreaterThan(justAboveMinimum);
  });

  it('keeps the same document position when the viewport scrolls', () => {
    expect(documentLayoutPoint({ x: 24, y: 320 }, { x: 0, y: 0 })).toEqual({ x: 24, y: 320 });
    expect(documentLayoutPoint({ x: 24, y: 200 }, { x: 0, y: 120 })).toEqual({ x: 24, y: 320 });
  });

  it('keeps layout translation independent from viewport scroll', () => {
    const beforeScroll = layoutMotionTranslate(
      documentLayoutPoint({ x: 40, y: 420 }, { x: 0, y: 0 }),
      documentLayoutPoint({ x: 40, y: 500 }, { x: 0, y: 0 }),
    );
    const afterScroll = layoutMotionTranslate(
      documentLayoutPoint({ x: 40, y: 300 }, { x: 0, y: 120 }),
      documentLayoutPoint({ x: 40, y: 380 }, { x: 0, y: 120 }),
    );
    expect(afterScroll).toEqual(beforeScroll);
    expect(afterScroll).toEqual({ x: 0, y: -80 });
  });

  it('continues an interrupted animation from its current document position', () => {
    const current = documentLayoutPoint({ x: 0, y: 260 }, { x: 0, y: 140 });
    const nextTarget = documentLayoutPoint({ x: 0, y: 340 }, { x: 0, y: 140 });
    expect(layoutMotionTranslate(current, nextTarget)).toEqual({ x: 0, y: -80 });
  });
});
