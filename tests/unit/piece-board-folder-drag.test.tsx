import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FolderShortcutOverlay } from '../../entrypoints/newtab/components/FolderDialog';
import { PieceBoard, requiredPieceRows } from '../../entrypoints/newtab/widgets/PieceBoard';
import { createInitialConfig } from '../../core/domain/defaults';

const dnd = vi.hoisted(() => ({ onPointerDown: vi.fn(), isDragging: false, context: undefined as any }));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const folderRect = { left: 100, top: 100, width: 82, height: 82, right: 182, bottom: 182, x: 100, y: 100, toJSON: () => ({}) } as DOMRect;
const shortcutDragEvent = {
  active: { id: 'piece:shortcut:docs', rect: { current: { initial: { left: 10, top: 10, width: 50, height: 50 } } } },
  delta: { x: 100, y: 100 },
};

function FolderDropHarness({ persist }: { persist(): Promise<void> }) {
  const [inFolder, setInFolder] = useState(false);
  const revision = { counter: 1, deviceId: 'test' };
  const shortcut = { id: 'docs', groupId: inFolder ? 'bookmarks' : 'default', name: 'Docs', url: 'https://example.com/docs', sortKey: 'a0', revision, position: { column: 0, row: 0, width: 4, height: 3, gridVersion: 3 } };
  const folder = { id: 'bookmarks', name: 'Bookmarks', sortKey: 'a1', collapsed: false, revision, position: { column: 8, row: 0, width: 4, height: 3, gridVersion: 3 } };
  return <PieceBoard
    pieces={[
      { id: 'piece:folder:bookmarks', kind: 'folder', payloadRef: 'bookmarks', container: { kind: 'desktop' }, position: { x: -16, y: 0, width: 4, height: 3 }, revision },
      ...(inFolder ? [] : [{ id: 'piece:shortcut:docs', kind: 'shortcut' as const, payloadRef: 'docs', container: { kind: 'desktop' as const }, position: { x: -24, y: 0, width: 4, height: 3 }, revision }]),
    ]}
    context={{
      config: { groups: [{ id: 'default', name: 'Default', sortKey: 'a0', collapsed: false, revision }, folder], shortcuts: [shortcut], appearance: { widgetLayout: { value: [] } } },
      onMoveShortcut: async () => { await persist(); setInFolder(true); },
    } as never}
  />;
}

function FolderDesktopDropHarness({ persist, afterMove = async () => undefined }: { persist(): Promise<void>; afterMove?(): Promise<void> }) {
  const [onDesktop, setOnDesktop] = useState(false);
  const [desktopPosition, setDesktopPosition] = useState<{ x: number; y: number; width: number; height: number }>();
  const revision = { counter: 1, deviceId: 'test' };
  const shortcut = { id: 'member', groupId: onDesktop ? 'default' : 'bookmarks', name: 'Member', url: 'https://example.com/member', sortKey: 'a0', revision, ...(onDesktop ? { position: { column: desktopPosition!.x + 24, row: desktopPosition!.y, width: desktopPosition!.width, height: desktopPosition!.height, gridVersion: 3 as const } } : {}) };
  const folder = { id: 'bookmarks', name: 'Bookmarks', sortKey: 'a1', collapsed: false, revision, position: { column: 8, row: 0, width: 4, height: 3, gridVersion: 3 as const } };
  const config = createInitialConfig({ deviceId: 'test', counter: 0, epoch: 0 });
  config.groups = [{ id: 'default', name: 'Default', sortKey: 'a0', collapsed: false, revision }, folder];
  config.shortcuts = [shortcut];
  return <PieceBoard
    pieces={[
      { id: 'piece:folder:bookmarks', kind: 'folder', payloadRef: 'bookmarks', container: { kind: 'desktop' }, position: { x: -16, y: 0, width: 4, height: 3 }, revision },
      { id: 'piece:shortcut:member', kind: 'shortcut', payloadRef: 'member', container: onDesktop ? { kind: 'desktop' } : { kind: 'folder', folderPieceId: 'piece:folder:bookmarks' }, ...(onDesktop ? { position: desktopPosition } : {}), revision },
    ]}
    context={{
      config,
      onMoveShortcut: async (_id: string, groupId: string, _before: string | undefined, _after: string | undefined, position?: { column: number; row: number; width: number; height: number }) => {
        await persist();
        if (groupId === 'default' && position) {
          setDesktopPosition({ x: position.column - 24, y: position.row, width: position.width, height: position.height });
          setOnDesktop(true);
        }
        await afterMove();
      },
    } as never}
  />;
}

const folderShortcutDragEvent = {
  active: { id: 'folder-shortcut:member', rect: { current: { initial: { left: 10, top: 10, width: 58, height: 58 } } } },
  delta: { x: 0, y: 0 },
};

async function startFolderDrop(): Promise<void> {
  const preview = document.querySelector<HTMLElement>('.folderPreview');
  if (!preview) throw new Error('Folder preview was not rendered');
  vi.spyOn(preview, 'getBoundingClientRect').mockReturnValue(folderRect);
  dnd.isDragging = true;
  act(() => dnd.context.onDragStart({ active: shortcutDragEvent.active }));
  act(() => dnd.context.onDragMove(shortcutDragEvent));
  await waitFor(() => expect(document.querySelector('[data-piece-id="piece:folder:bookmarks"]')).toHaveClass('isFolderTarget'));
}

vi.mock('@dnd-kit/core', () => ({
  DndContext: (props: { children: unknown }) => { dnd.context = props; return props.children; },
  DragOverlay: (props: { children: unknown }) => props.children,
  PointerSensor: class {},
  pointerWithin: vi.fn(),
  useSensor: vi.fn(),
  useSensors: vi.fn(() => []),
  useDraggable: vi.fn(() => ({ setNodeRef: vi.fn(), isDragging: dnd.isDragging, transform: undefined, listeners: { onPointerDown: dnd.onPointerDown } })),
  useDroppable: vi.fn(() => ({ setNodeRef: vi.fn() })),
}));

vi.mock('../../entrypoints/newtab/hooks/useDampedLayoutMotion', () => ({ useDampedLayoutMotion: vi.fn() }));
vi.mock('../../entrypoints/newtab/hooks/useNativeDesktopContextMenu', () => ({ useNativeDesktopContextMenu: vi.fn() }));
vi.mock('../../entrypoints/newtab/hooks/useDragClickGuard', () => ({ useDragClickGuard: () => ({ blockClicks: vi.fn(), blockNextClick: vi.fn() }) }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  dnd.isDragging = false;
  dnd.context = undefined;
});

describe('PieceBoard folder drag activation', () => {
  it('starts normal displacement after dwelling on an adjacent blocker without another pointer event', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-03T00:00:00Z'));
    const revision = { counter: 1, deviceId: 'test' };
    const pieces = [
      { id: 'piece:active', kind: 'add-shortcut' as const, payloadRef: 'add-shortcut', container: { kind: 'desktop' as const }, position: { x: 0, y: 0, width: 4, height: 3 }, revision },
      { id: 'piece:blocker', kind: 'shortcut' as const, payloadRef: 'blocker', container: { kind: 'desktop' as const }, position: { x: 0, y: 3, width: 4, height: 3 }, revision },
    ];
    render(<PieceBoard pieces={pieces} context={{
      config: {
        groups: [{ id: 'default', name: 'Default', sortKey: 'a0', collapsed: false, revision }],
        shortcuts: [{ id: 'blocker', groupId: 'default', name: 'Blocker', url: 'https://example.com', sortKey: 'a0', revision, position: { column: 24, row: 3, width: 4, height: 3, gridVersion: 3 } }],
        appearance: { widgetLayout: { value: [] } },
      },
    } as never} />);
    const board = document.querySelector<HTMLElement>('.pieceBoard')!;
    vi.spyOn(board, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 480, bottom: 800, width: 480, height: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    const active = { id: 'piece:active', rect: { current: { initial: { left: 240, top: 0, width: 40, height: 120 } } } };

    act(() => dnd.context.onDragStart({ active }));
    act(() => dnd.context.onDragMove({ active, delta: { x: 0, y: 40 } }));
    expect(document.querySelector('[data-piece-id="piece:blocker"]')).not.toHaveClass('isDisplaced');

    act(() => vi.advanceTimersByTime(599));
    expect(document.querySelector('[data-piece-id="piece:blocker"]')).not.toHaveClass('isDisplaced');
    act(() => vi.advanceTimersByTime(1));
    expect(document.querySelector('[data-piece-id="piece:blocker"]')).toHaveClass('isDisplaced');
  });

  it('requires a fresh dwell after leaving and re-entering a previously displaced blocker', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-03T00:00:00Z'));
    const revision = { counter: 1, deviceId: 'test' };
    const pieces = [
      { id: 'piece:active', kind: 'add-shortcut' as const, payloadRef: 'add-shortcut', container: { kind: 'desktop' as const }, position: { x: 0, y: 0, width: 4, height: 3 }, revision },
      { id: 'piece:blocker', kind: 'shortcut' as const, payloadRef: 'blocker', container: { kind: 'desktop' as const }, position: { x: 0, y: 3, width: 4, height: 3 }, revision },
    ];
    render(<PieceBoard pieces={pieces} context={{
      config: {
        groups: [{ id: 'default', name: 'Default', sortKey: 'a0', collapsed: false, revision }],
        shortcuts: [{ id: 'blocker', groupId: 'default', name: 'Blocker', url: 'https://example.com', sortKey: 'a0', revision, position: { column: 24, row: 3, width: 4, height: 3, gridVersion: 3 } }],
        appearance: { widgetLayout: { value: [] } },
      },
    } as never} />);
    const board = document.querySelector<HTMLElement>('.pieceBoard')!;
    vi.spyOn(board, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 480, bottom: 800, width: 480, height: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    const active = { id: 'piece:active', rect: { current: { initial: { left: 240, top: 0, width: 40, height: 120 } } } };

    act(() => dnd.context.onDragStart({ active }));
    act(() => dnd.context.onDragMove({ active, delta: { x: 0, y: 40 } }));
    act(() => vi.advanceTimersByTime(600));
    expect(document.querySelector('[data-piece-id="piece:blocker"]')).toHaveClass('isDisplaced');

    act(() => dnd.context.onDragMove({ active, delta: { x: 100, y: 40 } }));
    expect(document.querySelector('[data-piece-id="piece:blocker"]')).not.toHaveClass('isDisplaced');
    act(() => dnd.context.onDragMove({ active, delta: { x: 0, y: 40 } }));
    expect(document.querySelector('[data-piece-id="piece:blocker"]')).not.toHaveClass('isDisplaced');
    act(() => vi.advanceTimersByTime(599));
    expect(document.querySelector('[data-piece-id="piece:blocker"]')).not.toHaveClass('isDisplaced');
    act(() => vi.advanceTimersByTime(1));
    expect(document.querySelector('[data-piece-id="piece:blocker"]')).toHaveClass('isDisplaced');
  });

  it('keeps the board row extent monotonic for the duration of a drag', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-03T00:00:00Z'));
    const revision = { counter: 1, deviceId: 'test' };
    const pieces = [
      { id: 'piece:active', kind: 'add-shortcut' as const, payloadRef: 'add-shortcut', container: { kind: 'desktop' as const }, position: { x: 0, y: 17, width: 4, height: 3 }, revision },
      { id: 'piece:blocker', kind: 'shortcut' as const, payloadRef: 'blocker', container: { kind: 'desktop' as const }, position: { x: 0, y: 21, width: 4, height: 3 }, revision },
    ];
    render(<PieceBoard pieces={pieces} context={{
      config: {
        groups: [{ id: 'default', name: 'Default', sortKey: 'a0', collapsed: false, revision }],
        shortcuts: [{ id: 'blocker', groupId: 'default', name: 'Blocker', url: 'https://example.com', sortKey: 'a0', revision, position: { column: 24, row: 21, width: 4, height: 3, gridVersion: 3 } }],
        appearance: { widgetLayout: { value: [] } },
      },
    } as never} />);
    const board = document.querySelector<HTMLElement>('.pieceBoard')!;
    vi.spyOn(board, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 480, bottom: 1000, width: 480, height: 1000, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    const active = { id: 'piece:active', rect: { current: { initial: { left: 240, top: 680, width: 40, height: 120 } } } };

    act(() => dnd.context.onDragStart({ active }));
    act(() => dnd.context.onDragMove({ active, delta: { x: 0, y: 80 } }));
    act(() => vi.advanceTimersByTime(600));
    const expandedRows = Number(board.style.getPropertyValue('--piece-rows'));
    expect(expandedRows).toBeGreaterThan(requiredPieceRows(pieces));

    act(() => dnd.context.onDragMove({ active, delta: { x: 0, y: -40 } }));
    expect(Number(board.style.getPropertyValue('--piece-rows'))).toBe(expandedRows);
  });

  it('forwards pointer presses from the folder button to the drag sensor', () => {
    const revision = { counter: 1, deviceId: 'test' };
    render(<PieceBoard
      pieces={[{ id: 'piece:folder:bookmarks', kind: 'folder', payloadRef: 'bookmarks', container: { kind: 'desktop' }, position: { x: 0, y: 0, width: 4, height: 3 }, revision }]}
      context={{
        config: {
          groups: [
            { id: 'default', name: 'Default', sortKey: 'a0', collapsed: false, revision },
            { id: 'bookmarks', name: 'Bookmarks', sortKey: 'a1', collapsed: false, revision },
          ],
          shortcuts: [],
          appearance: { widgetLayout: { value: [] } },
        },
      } as never}
    />);

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Bookmarks' }));
    expect(dnd.onPointerDown).toHaveBeenCalledTimes(1);
  });

  it('still opens the folder on a normal click', () => {
    const revision = { counter: 1, deviceId: 'test' };
    render(<PieceBoard
      pieces={[{ id: 'piece:folder:bookmarks', kind: 'folder', payloadRef: 'bookmarks', container: { kind: 'desktop' }, position: { x: 0, y: 0, width: 4, height: 3 }, revision }]}
      context={{
        config: {
          groups: [
            { id: 'default', name: 'Default', sortKey: 'a0', collapsed: false, revision },
            { id: 'bookmarks', name: 'Bookmarks', sortKey: 'a1', collapsed: false, revision },
          ],
          shortcuts: [],
          appearance: { widgetLayout: { value: [] } },
        },
      } as never}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'Bookmarks' }));
    expect(screen.getByRole('dialog', { name: 'Bookmarks' })).toBeInTheDocument();
  });

  it('uses a fixed overlay and leaves the desktop source as a placeholder', async () => {
    const revision = { counter: 1, deviceId: 'test' };
    render(<PieceBoard
      pieces={[{ id: 'piece:add-shortcut', kind: 'add-shortcut', payloadRef: 'add-shortcut', container: { kind: 'desktop' }, position: { x: 0, y: 0, width: 4, height: 3 }, revision }]}
      context={{ config: { groups: [], shortcuts: [], appearance: { widgetLayout: { value: [] } } } } as never}
    />);

    dnd.isDragging = true;
    act(() => dnd.context.onDragStart({ active: { id: 'piece:add-shortcut' } }));

    await waitFor(() => expect(document.querySelector('[data-desktop-drag-overlay] .pieceAdd')).toBeInTheDocument());
    expect(document.querySelector('[data-piece-id="piece:add-shortcut"]')).toHaveClass('piece--drag-overlay-source');
    expect(document.querySelector('[data-piece-id="piece:add-shortcut"] .shortcutWaterShell')).toBeInTheDocument();
    expect(document.querySelector('[data-piece-id="piece:add-shortcut"] .liquidGlassSurface')).not.toBeInTheDocument();
    expect(document.querySelector('[data-piece-id="piece:add-shortcut"] svg.shortcutWaterShell__plus path')).toHaveAttribute('d', 'M12 5v14M5 12h14');
    expect(document.querySelector('[data-desktop-drag-overlay] .desktopPieceDragOverlay__gridOutline')).toBeInTheDocument();
    expect(document.querySelector('[data-desktop-drag-overlay] .shortcutWaterShell')).toBeInTheDocument();
    expect(document.querySelector('[data-desktop-drag-overlay]')).toHaveAttribute('data-water-bubble-kick');
    expect((document.querySelector('[data-desktop-drag-overlay]') as HTMLElement).style.getPropertyValue('--water-bubble-kick-x')).not.toBe('');
  });

  it('passes the same bounded kick shape to the folder shortcut overlay', () => {
    const shortcut = { id: 'docs', groupId: 'folder', name: 'Docs', url: 'https://example.com/docs', sortKey: 'a', revision: { counter: 1, deviceId: 'test' } };
    render(<FolderShortcutOverlay shortcut={shortcut} bubbleKick={{ sequence: 2, x: 3, y: -1.25 }} />);

    const overlay = document.querySelector('[data-folder-drag-overlay]') as HTMLElement;
    expect(overlay).toHaveAttribute('data-water-bubble-kick', 'a');
    expect(overlay.style.getPropertyValue('--water-bubble-kick-x')).toBe('3px');
    expect(overlay.style.getPropertyValue('--water-bubble-kick-y')).toBe('-1.25px');
  });

  it('immediately removes the source and overlay while a folder drop is being persisted', async () => {
    const save = deferred<void>();
    const persist = vi.fn(() => save.promise);
    render(<FolderDropHarness persist={persist} />);

    await startFolderDrop();
    let end!: Promise<void>;
    act(() => { end = dnd.context.onDragEnd(shortcutDragEvent); });

    expect(persist).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-desktop-drag-overlay]')).not.toBeInTheDocument();
    expect(document.querySelector('[data-piece-id="piece:shortcut:docs"]')).not.toBeInTheDocument();

    await act(async () => { save.resolve(); await save.promise; });
    await end;
    await waitFor(() => expect(document.querySelector('.folderPreview > span')).toBeInTheDocument());
    expect(document.querySelector('[data-piece-id="piece:shortcut:docs"]')).not.toBeInTheDocument();
  });

  it('restores the desktop source when a folder drop cannot be persisted', async () => {
    const save = deferred<void>();
    render(<FolderDropHarness persist={() => save.promise} />);

    await startFolderDrop();
    let end!: Promise<void>;
    act(() => { end = dnd.context.onDragEnd(shortcutDragEvent); });
    const outcome = end.catch((error: unknown) => error);
    expect(document.querySelector('[data-piece-id="piece:shortcut:docs"]')).not.toBeInTheDocument();

    await act(async () => { save.reject(new Error('save failed')); });
    await expect(outcome).resolves.toMatchObject({ message: 'save failed' });
    await waitFor(() => expect(document.querySelector('[data-piece-id="piece:shortcut:docs"]')).toBeInTheDocument());
  });

  it('keeps the dimmed folder member until the unified move command returns its desktop snapshot', async () => {
    const save = deferred<void>();
    render(<FolderDesktopDropHarness persist={() => save.promise} />);
    const board = document.querySelector<HTMLElement>('.dashboardBoard')!;
    vi.spyOn(board, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 960, height: 800, right: 960, bottom: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    fireEvent.click(screen.getByRole('button', { name: 'Bookmarks' }));
    expect(screen.getByRole('dialog', { name: 'Bookmarks' })).toBeInTheDocument();

    dnd.isDragging = true;
    act(() => dnd.context.onDragStart({ active: folderShortcutDragEvent.active }));
    let end!: Promise<void>;
    act(() => { end = dnd.context.onDragEnd(folderShortcutDragEvent); });

    await waitFor(() => expect(within(screen.getByRole('dialog', { name: 'Bookmarks' })).getByRole('link', { name: 'Member' }).closest('.folderDialogItem')).toHaveClass('isPendingDesktopDrop'));
    expect(document.querySelector('[data-folder-drag-handoff]')).not.toBeInTheDocument();
    expect(document.querySelector('[data-piece-id="piece:shortcut:member"]')).not.toBeInTheDocument();

    await act(async () => { save.resolve(); await save.promise; });
    await end;
    await waitFor(() => expect(document.querySelector('[data-piece-id="piece:shortcut:member"]')).toBeInTheDocument());
    expect(document.querySelector('[data-piece-id="piece:shortcut:member"]')).toBeInTheDocument();
  });

  it('restores the folder member when its desktop drop fails', async () => {
    const save = deferred<void>();
    render(<FolderDesktopDropHarness persist={() => save.promise} />);
    const board = document.querySelector<HTMLElement>('.dashboardBoard')!;
    vi.spyOn(board, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 960, height: 800, right: 960, bottom: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    fireEvent.click(screen.getByRole('button', { name: 'Bookmarks' }));

    dnd.isDragging = true;
    act(() => dnd.context.onDragStart({ active: folderShortcutDragEvent.active }));
    let end!: Promise<void>;
    act(() => { end = dnd.context.onDragEnd(folderShortcutDragEvent); });
    await waitFor(() => expect(within(screen.getByRole('dialog', { name: 'Bookmarks' })).getByRole('link', { name: 'Member' }).closest('.folderDialogItem')).toHaveClass('isPendingDesktopDrop'));
    const outcome = end.catch((error: unknown) => error);

    await act(async () => { save.reject(new Error('save failed')); });
    await expect(outcome).resolves.toMatchObject({ message: 'save failed' });
    expect(screen.getByRole('link', { name: 'Member' }).closest('.folderDialogItem')).not.toHaveClass('isPendingDesktopDrop');
    expect(screen.getByRole('link', { name: 'Member' })).toBeInTheDocument();
  });

  it('uses one generic move command and does not create a desktop handoff layer', async () => {
    const afterMove = vi.fn(async () => undefined);
    render(<FolderDesktopDropHarness persist={async () => undefined} afterMove={afterMove} />);
    const board = document.querySelector<HTMLElement>('.dashboardBoard')!;
    vi.spyOn(board, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 960, height: 800, right: 960, bottom: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    fireEvent.click(screen.getByRole('button', { name: 'Bookmarks' }));

    dnd.isDragging = true;
    act(() => dnd.context.onDragStart({ active: folderShortcutDragEvent.active }));
    await act(async () => { await dnd.context.onDragEnd(folderShortcutDragEvent); });
    await waitFor(() => expect(document.querySelector('[data-piece-id="piece:shortcut:member"]')).toBeInTheDocument());

    expect(afterMove).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-folder-drag-handoff]')).not.toBeInTheDocument();
    expect(document.querySelector('[data-piece-id="piece:shortcut:member"]')).toBeInTheDocument();
  });
});
