import { describe, expect, it } from 'vitest';
import { folderReorderNeighbors, reorderFolderIds } from '../../entrypoints/newtab/widgets/folder-reorder';

describe('folderReorderNeighbors', () => {
  const ids = ['first', 'middle', 'last'];

  it('derives the complete optimistic order from the same move', () => {
    expect(reorderFolderIds(ids, 'last', 'first')).toEqual(['last', 'first', 'middle']);
    expect(reorderFolderIds(ids, 'middle', 'middle')).toBeUndefined();
  });

  it('places the first member after the hovered middle member', () => {
    expect(folderReorderNeighbors(ids, 'first', 'middle')).toEqual({ beforeId: 'middle', afterId: 'last' });
  });

  it('places the last member before the hovered first member', () => {
    expect(folderReorderNeighbors(ids, 'last', 'first')).toEqual({ beforeId: undefined, afterId: 'first' });
  });

  it('places a middle member at the end when hovering the last member', () => {
    expect(folderReorderNeighbors(ids, 'middle', 'last')).toEqual({ beforeId: 'last', afterId: undefined });
  });

  it('does not persist a self-drop, empty drop, or unknown member', () => {
    expect(folderReorderNeighbors(ids, 'middle', 'middle')).toBeUndefined();
    expect(folderReorderNeighbors(ids, 'middle')).toBeUndefined();
    expect(folderReorderNeighbors(ids, 'middle', 'missing')).toBeUndefined();
  });
});
