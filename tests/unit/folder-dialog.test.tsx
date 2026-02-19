import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FolderDialog } from '../../entrypoints/newtab/components/FolderDialog';

const sortable = vi.hoisted(() => ({ useSortable: vi.fn() }));

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: unknown }) => children,
  rectSortingStrategy: vi.fn(),
  useSortable: sortable.useSortable,
}));

beforeEach(() => {
  sortable.useSortable.mockReturnValue({
    setNodeRef: vi.fn(),
    isDragging: false,
    isSorting: false,
    transform: null,
    transition: undefined,
    attributes: {},
    listeners: { onPointerDown: vi.fn() },
  });
});

describe('FolderDialog', () => {
  it('keeps native shortcut links without hover action controls', () => {
    const shortcut = { id: 'a', groupId: 'folder', name: 'Docs', url: 'https://example.com/docs', sortKey: 'a', revision: { counter: 1, deviceId: 'test' } };
    render(<FolderDialog
      folder={{ id: 'folder', name: 'Work', collapsed: false, sortKey: 'a', revision: { counter: 1, deviceId: 'test' } }}
      shortcuts={[shortcut]} onClose={vi.fn()}
    />);

    expect(screen.getByRole('link', { name: 'Docs' })).toHaveAttribute('href', 'https://example.com/docs');
    expect(screen.getByRole('link', { name: 'Docs' }).querySelector('.desktopIcon')).toHaveClass('shortcutWaterShell');
    expect(document.querySelector('.folderSurface')).toHaveClass('liquidGlassSurface');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(sortable.useSortable).toHaveBeenCalledWith({ id: 'folder-shortcut:a' });
  });
});
