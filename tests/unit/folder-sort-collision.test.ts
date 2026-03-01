import { describe, expect, it } from 'vitest';
import { folderSortableContainers, isDraggedCenterWithinFolderMember, isFolderShortcutDrag, isPointerInsideFolderSurface } from '../../entrypoints/newtab/widgets/folder-sort-collision';

describe('folder sort collision helpers', () => {
  it('identifies only folder member drags', () => {
    expect(isFolderShortcutDrag('folder-shortcut:docs')).toBe(true);
    expect(isFolderShortcutDrag('piece:shortcut:docs')).toBe(false);
  });

  it('accepts pointer coordinates within the folder surface boundary', () => {
    const surface = { left: 100, top: 50, width: 240, height: 180 };
    expect(isPointerInsideFolderSurface({ x: 100, y: 50 }, surface)).toBe(true);
    expect(isPointerInsideFolderSurface({ x: 340, y: 230 }, surface)).toBe(true);
    expect(isPointerInsideFolderSurface({ x: 99, y: 50 }, surface)).toBe(false);
    expect(isPointerInsideFolderSurface(null, surface)).toBe(false);
  });

  it('filters hybrid collision candidates to folder members while sorting', () => {
    expect(folderSortableContainers([
      { id: 'folder-shortcut:docs' },
      { id: 'piece:shortcut:docs' },
      { id: 'folder-shortcut:guide' },
    ])).toEqual([{ id: 'folder-shortcut:docs' }, { id: 'folder-shortcut:guide' }]);
  });

  it('only accepts a sortable drop when the dragged member center is inside the target card', () => {
    const source = { left: 10, top: 10, width: 58, height: 58 };
    const target = { left: 100, top: 10, width: 68, height: 68 };
    expect(isDraggedCenterWithinFolderMember(source, { x: 100, y: 0 }, target)).toBe(true);
    expect(isDraggedCenterWithinFolderMember(source, { x: 170, y: 80 }, target)).toBe(false);
  });
});
