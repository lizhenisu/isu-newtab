import { describe, expect, it } from 'vitest';
import { isDraggedPieceCenterWithinFolder } from '../../entrypoints/newtab/widgets/folder-drop-target';

const initial = { left: 20, top: 40, width: 80, height: 60 };
const folderPreview = { left: 100, top: 100, width: 120, height: 90 };

describe('isDraggedPieceCenterWithinFolder', () => {
  it('accepts a partially overlapping piece when its center is inside the visible preview', () => {
    expect(isDraggedPieceCenterWithinFolder(initial, { x: 80, y: 75 }, folderPreview)).toBe(true);
  });

  it('accepts a center point on the preview boundary', () => {
    expect(isDraggedPieceCenterWithinFolder(initial, { x: 40, y: 30 }, folderPreview)).toBe(true);
  });

  it('rejects a piece whose center remains outside the folder', () => {
    expect(isDraggedPieceCenterWithinFolder(initial, { x: 39.9, y: 30 }, folderPreview)).toBe(false);
  });

  it('rejects a center inside the folder grid footprint but outside its visible preview', () => {
    const folderGrid = { left: 60, top: 60, width: 200, height: 180 };
    const previewInsideGrid = { left: 120, top: 100, width: 82, height: 82 };
    const delta = { x: 40, y: 30 }; // Center is (100, 100): inside the grid, outside the preview.
    expect(isDraggedPieceCenterWithinFolder(initial, delta, folderGrid)).toBe(true);
    expect(isDraggedPieceCenterWithinFolder(initial, delta, previewInsideGrid)).toBe(false);
  });
});
