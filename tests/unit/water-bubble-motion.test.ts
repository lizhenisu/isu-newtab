import { describe, expect, it } from 'vitest';
import { WATER_BUBBLE_MAX_HORIZONTAL_KICK, WATER_BUBBLE_MAX_VERTICAL_KICK, updateWaterBubbleDrag } from '../../entrypoints/newtab/water-bubble-motion';

describe('water bubble drag motion', () => {
  it('ignores low-speed motion', () => {
    let state = updateWaterBubbleDrag(undefined, { x: 0, y: 0, time: 0 }).state;
    ({ state } = updateWaterBubbleDrag(state, { x: 8, y: 0, time: 1_000 }));
    const result = updateWaterBubbleDrag(state, { x: 0, y: 0, time: 2_000 });

    expect(result.kick).toBeUndefined();
  });

  it('kicks opposite a fast horizontal reversal', () => {
    let state = updateWaterBubbleDrag(undefined, { x: 0, y: 0, time: 0 }).state;
    ({ state } = updateWaterBubbleDrag(state, { x: 12, y: 0, time: 20 }));
    const result = updateWaterBubbleDrag(state, { x: -8, y: 0, time: 120 });

    expect(result.kick).toMatchObject({ x: expect.any(Number), y: 0 });
    expect(result.kick!.x).toBeGreaterThan(0);
  });

  it('kicks opposite a fast vertical reversal', () => {
    let state = updateWaterBubbleDrag(undefined, { x: 0, y: 0, time: 0 }).state;
    ({ state } = updateWaterBubbleDrag(state, { x: 0, y: 12, time: 20 }));
    const result = updateWaterBubbleDrag(state, { x: 0, y: -8, time: 120 });

    expect(result.kick).toMatchObject({ x: 0, y: expect.any(Number) });
    expect(result.kick!.y).toBeGreaterThan(0);
  });

  it('caps liquid inertia inside the icon bounds', () => {
    let state = updateWaterBubbleDrag(undefined, { x: 0, y: 0, time: 0 }).state;
    ({ state } = updateWaterBubbleDrag(state, { x: 1_000, y: 1_000, time: 20 }));
    const result = updateWaterBubbleDrag(state, { x: -1_000, y: -1_000, time: 120 });

    expect(Math.abs(result.kick!.x)).toBeLessThanOrEqual(WATER_BUBBLE_MAX_HORIZONTAL_KICK);
    expect(Math.abs(result.kick!.y)).toBeLessThanOrEqual(WATER_BUBBLE_MAX_VERTICAL_KICK);
  });
});
