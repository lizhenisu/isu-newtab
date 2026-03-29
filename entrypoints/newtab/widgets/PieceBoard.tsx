import { DndContext, DragOverlay, PointerSensor, closestCenter, pointerWithin, useDraggable, useDroppable, useSensor, useSensors, type CollisionDetection, type DragEndEvent, type DragMoveEvent } from '@dnd-kit/core';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { t } from '../../../core/browser/i18n';
import { compareBySortKey } from '../../../core/domain/sort';
import { pieceGridStyle, PIECE_SIZE_PRESETS, searchPercentToPieceWidth, type Piece, type PiecePosition } from '../../../core/domain/pieces';
import type { SystemWidgetId } from '../../../core/domain/widgets';
import { hasProtectedPieceCollision, nextPieceCollisionDwellDeadline, resolvePieceCollisionIntentSession, solvePieceDragPlacement, type PieceCollisionIntentSession, type PieceDragDirection } from '../../../core/layout/piece-layout-engine';
import { appRepositories } from '../../../core/storage/repository';
import { FolderDialog, FolderShortcutOverlay } from '../components/FolderDialog';
import { PlusIcon } from '../components/PlusIcon';
import { ShortcutIcon } from '../components/ShortcutIcon';
import { isDraggedPieceCenterWithinFolder, type FolderDropRect } from './folder-drop-target';
import { folderSortableContainers, isDraggedCenterWithinFolderMember, isFolderShortcutDrag, isPointerInsideFolderSurface } from './folder-sort-collision';
import { folderReorderNeighbors, reorderFolderIds } from './folder-reorder';
import { updateWaterBubbleDrag, type WaterBubbleDragState, type WaterBubbleKick } from '../water-bubble-motion';
import { useDragClickGuard } from '../hooks/useDragClickGuard';
import { useDampedLayoutMotion } from '../hooks/useDampedLayoutMotion';
import { useDragViewportAutoScroll } from '../hooks/useDragViewportAutoScroll';
import { useNativeDesktopContextMenu } from '../hooks/useNativeDesktopContextMenu';
import type { DesktopContextAction, DesktopContextTarget } from '../../../core/browser/native-context-menu';
import type { DesktopItem } from '../../../core/domain/desktop';
import { DEFAULT_GROUP_ID } from '../../../core/domain/types';
import { WIDGET_REGISTRY, type DashboardWidgetContext } from './registry';

type Props = { pieces: Piece[]; context: DashboardWidgetContext; onPiecesChanged?: () => Promise<void> };

/** The desktop only knows pieces; business widgets are rendered inside them. */
export function PieceBoard({ pieces, context, onPiecesChanged }: Props) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { delay: 500, tolerance: 6 } }));
  const boardRef = useRef<HTMLDivElement>(null);
  const dragBaseRef = useRef<Piece[]>(pieces);
  const activeDragId = useRef<string | undefined>(undefined);
  const folderPreviewBoundsRef = useRef<Map<string, FolderDropRect>>(new Map());
  // This is intentionally a ref rather than relying on the asynchronous React
  // state used to paint the teal target. A pointer-up may arrive before React
  // has committed the last drag-move render, but it must commit the same
  // preview target that was visibly active at release time.
  const folderTargetRef = useRef<string | undefined>(undefined);
  const folderTargetBoundsRef = useRef<FolderDropRect | undefined>(undefined);
  const folderDragOverRef = useRef<{ activeId: string; overId: string } | undefined>(undefined);
  const pendingDropRef = useRef<{ id: string; position: PiecePosition } | undefined>(undefined);
  const pushContactsRef = useRef<Map<string, PieceDragDirection>>(new Map());
  const collisionIntentRef = useRef<PieceCollisionIntentSession | undefined>(undefined);
  const collisionDwellTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dragSessionIdRef = useRef(0);
  const latestDragTargetRef = useRef<{ sessionId: number; activeId: string; target: PiecePosition } | undefined>(undefined);
  const dragRowsRef = useRef<number | undefined>(undefined);
  const waterBubbleDragRef = useRef<WaterBubbleDragState | undefined>(undefined);
  const waterBubbleSequenceRef = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [activeDragPieceId, setActiveDragPieceId] = useState<string>();
  const [preview, setPreview] = useState<Piece[]>();
  const [openFolderId, setOpenFolderId] = useState<string>();
  const [folderTargetId, setFolderTargetId] = useState<string>();
  const [activeFolderShortcutId, setActiveFolderShortcutId] = useState<string>();
  const [folderOrderPreview, setFolderOrderPreview] = useState<{ folderId: string; ids: string[] }>();
  const [waterBubbleKick, setWaterBubbleKick] = useState<WaterBubbleKick>();
  const [pendingFolderDropPieceId, setPendingFolderDropPieceId] = useState<string>();
  const [pendingFolderDesktopShortcutId, setPendingFolderDesktopShortcutId] = useState<string>();
  const [dragRows, setDragRows] = useState<number>();
  useEffect(() => () => {
    folderPreviewBoundsRef.current.clear();
    pushContactsRef.current.clear();
    collisionIntentRef.current = undefined;
    if (collisionDwellTimerRef.current !== undefined) clearTimeout(collisionDwellTimerRef.current);
  }, []);
  const { blockClicks, blockNextClick } = useDragClickGuard();
  const { autoScrollEnabled, beginDrag } = useDragViewportAutoScroll(dragging);
  const derivedPieces = useMemo(() => augmentPieces(pieces, context), [pieces, context]);
  useEffect(() => {
    const pending = pendingDropRef.current;
    if (!pending) return;
    const persisted = pieces.find((piece) => piece.id === pending.id);
    if (!persisted || !samePosition(persisted.position, pending.position)) return;
    pendingDropRef.current = undefined;
    setActiveDragPieceId((current) => current === pending.id ? undefined : current);
  }, [pieces]);
  useEffect(() => {
    if (!folderOrderPreview) return;
    const persistedIds = context.config.shortcuts.filter((item) => item.groupId === folderOrderPreview.folderId).sort(compareBySortKey).map((item) => item.id);
    if (sameIdOrder(persistedIds, folderOrderPreview.ids)) setFolderOrderPreview(undefined);
  }, [context.config.shortcuts, folderOrderPreview]);
  useEffect(() => {
    const pendingPiece = pendingFolderDropPieceId && derivedPieces.find((piece) => piece.id === pendingFolderDropPieceId);
    if (pendingFolderDropPieceId && (!pendingPiece || pendingPiece.container.kind !== 'desktop')) {
      setPendingFolderDropPieceId(undefined);
    }
  }, [derivedPieces, pendingFolderDropPieceId]);
  const layoutPieces = preview
    ? preview.map((piece) => piece.id === activeDragId.current && dragging ? dragBaseRef.current.find((basePiece) => basePiece.id === piece.id) ?? piece : piece)
    : derivedPieces;
  const shown = pendingFolderDropPieceId
    ? layoutPieces.filter((piece) => piece.id !== pendingFolderDropPieceId)
    : layoutPieces;
  const activeFolderShortcut = activeFolderShortcutId ? context.config.shortcuts.find((shortcut) => shortcut.id === activeFolderShortcutId) : undefined;
  const activeDesktopPiece = activeDragPieceId ? dragBaseRef.current.find((piece) => piece.id === activeDragPieceId) : undefined;
  useNativeDesktopContextMenu(boardRef, useMemo(() => shown.filter((piece) => piece.container.kind === 'desktop' && piece.position).map((piece) => pieceToDesktopItem(piece, context)), [shown, context]), (action, target) => void handleContextAction(action, target, shown, context, setOpenFolderId));
  const contentRows = requiredPieceRows(shown);
  const rows = dragging ? Math.max(contentRows, dragRows ?? contentRows) : contentRows;
  const collisionDetection: CollisionDetection = (args) => {
    if (!isFolderShortcutDrag(args.active.id) || !openFolderId) return pointerWithin(args);
    const surface = document.querySelector<HTMLElement>(`[data-folder-context-id="${CSS.escape(openFolderId)}"]`);
    const pointerInsideSurface = isPointerInsideFolderSurface(args.pointerCoordinates, surface?.getBoundingClientRect());
    if (!pointerInsideSurface) return pointerWithin(args);
    return closestCenter({ ...args, droppableContainers: folderSortableContainers(args.droppableContainers) });
  };

  const beginWaterBubbleMotion = () => {
    waterBubbleDragRef.current = undefined;
    waterBubbleSequenceRef.current += 1;
    setWaterBubbleKick({ sequence: waterBubbleSequenceRef.current, x: -1.25, y: .35 });
  };
  const updateWaterBubbleMotion = (event: DragMoveEvent) => {
    const next = updateWaterBubbleDrag(waterBubbleDragRef.current, { x: event.delta.x, y: event.delta.y, time: performance.now() });
    waterBubbleDragRef.current = next.state;
    if (!next.kick) return;
    waterBubbleSequenceRef.current += 1;
    setWaterBubbleKick({ sequence: waterBubbleSequenceRef.current, ...next.kick });
  };
  const clearWaterBubbleMotion = () => {
    waterBubbleDragRef.current = undefined;
    setWaterBubbleKick(undefined);
  };
  const beginPushSession = (snapshot: Piece[]) => {
    dragSessionIdRef.current += 1;
    if (collisionDwellTimerRef.current !== undefined) clearTimeout(collisionDwellTimerRef.current);
    collisionDwellTimerRef.current = undefined;
    latestDragTargetRef.current = undefined;
    pushContactsRef.current = new Map();
    collisionIntentRef.current = undefined;
    const initialRows = requiredPieceRows(snapshot);
    dragRowsRef.current = initialRows;
    setDragRows(initialRows);
  };
  const expandDragRows = (snapshot: Piece[]) => {
    const nextRows = Math.max(dragRowsRef.current ?? 0, requiredPieceRows(snapshot));
    if (nextRows === dragRowsRef.current) return;
    dragRowsRef.current = nextRows;
    setDragRows(nextRows);
  };
  const endPushSession = () => {
    dragSessionIdRef.current += 1;
    if (collisionDwellTimerRef.current !== undefined) clearTimeout(collisionDwellTimerRef.current);
    collisionDwellTimerRef.current = undefined;
    latestDragTargetRef.current = undefined;
    pushContactsRef.current = new Map();
    collisionIntentRef.current = undefined;
    dragRowsRef.current = undefined;
    setDragRows(undefined);
  };
  const clearCollisionIntent = () => {
    if (collisionDwellTimerRef.current !== undefined) clearTimeout(collisionDwellTimerRef.current);
    collisionDwellTimerRef.current = undefined;
    latestDragTargetRef.current = undefined;
    collisionIntentRef.current = undefined;
    pushContactsRef.current = new Map();
  };
  const scheduleCollisionDwell = (sessionId: number) => {
    if (collisionDwellTimerRef.current !== undefined) clearTimeout(collisionDwellTimerRef.current);
    collisionDwellTimerRef.current = undefined;
    const deadline = nextPieceCollisionDwellDeadline(collisionIntentRef.current);
    if (deadline === undefined) return;
    collisionDwellTimerRef.current = setTimeout(() => {
      collisionDwellTimerRef.current = undefined;
      const latest = latestDragTargetRef.current;
      if (!latest || latest.sessionId !== sessionId || dragSessionIdRef.current !== sessionId) return;
      updateDesktopDragPreview(dragBaseRef.current, latest.activeId, latest.target, Date.now());
    }, Math.max(1, deadline - Date.now()));
  };
  const updateDesktopDragPreview = (base: Piece[], activeId: string, target: PiecePosition, now: number) => {
    const sessionId = dragSessionIdRef.current;
    latestDragTargetRef.current = { sessionId, activeId, target };
    const collisionIntent = resolvePieceCollisionIntentSession(base, activeId, target, collisionIntentRef.current, now);
    collisionIntentRef.current = collisionIntent;
    const result = solvePieceDragPlacement(base, activeId, target, pushContactsRef.current, { collisionIntent });
    pushContactsRef.current = result.contacts;
    expandDragRows(result.pieces);
    const changed = result.pieces.some((piece) => !samePiecePlacement(piece, base.find((item) => item.id === piece.id)));
    setPreview(changed ? result.pieces : undefined);
    scheduleCollisionDwell(sessionId);
  };
  const captureFolderPreviewBounds = () => {
    const bounds = new Map<string, FolderDropRect>();
    boardRef.current?.querySelectorAll<HTMLElement>('[data-piece-id] .folderPreview').forEach((preview) => {
      const piece = preview.closest<HTMLElement>('[data-piece-id]');
      if (!piece?.dataset.pieceId) return;
      const { left, top, width, height } = preview.getBoundingClientRect();
      bounds.set(piece.dataset.pieceId, { left, top, width, height });
    });
    folderPreviewBoundsRef.current = bounds;
  };
  const clearFolderPreviewBounds = () => {
    folderPreviewBoundsRef.current.clear();
    folderTargetBoundsRef.current = undefined;
  };

  const finish = async (event: DragEndEvent) => {
    const id = String(event.active.id);
    blockNextClick(id);
    clearWaterBubbleMotion();
    const base = dragBaseRef.current;
    const pushContacts = new Map(pushContactsRef.current);
    let collisionIntent = collisionIntentRef.current;
    endPushSession();
    if (id.startsWith('folder-shortcut:')) {
      const shortcutId = id.slice('folder-shortcut:'.length);
      const shortcut = context.config.shortcuts.find((item) => item.id === shortcutId);
      const board = boardRef.current?.getBoundingClientRect();
      const initial = event.active.rect.current.initial;
      const translated = event.active.rect.current.translated;
      const draggedRect = translated ?? (initial && {
        left: initial.left + event.delta.x,
        top: initial.top + event.delta.y,
        width: initial.width,
        height: initial.height,
      });
      const folderSurface = openFolderId
        ? document.querySelector<HTMLElement>(`[data-folder-context-id="${CSS.escape(openFolderId)}"]`)
        : undefined;
      const draggedCenter = draggedRect && { x: draggedRect.left + draggedRect.width / 2, y: draggedRect.top + draggedRect.height / 2 };
      const droppedWithinFolderSurface = Boolean(draggedCenter && isPointerInsideFolderSurface(draggedCenter, folderSurface?.getBoundingClientRect()));
      const sortTargetId = droppedWithinFolderSurface
        && folderDragOverRef.current?.activeId === id ? folderDragOverRef.current.overId : undefined;
      const droppedOnBoard = Boolean(!droppedWithinFolderSurface && board && draggedRect && draggedRect.left + draggedRect.width / 2 >= board.left && draggedRect.left + draggedRect.width / 2 <= board.right && draggedRect.top + draggedRect.height / 2 >= board.top && draggedRect.top + draggedRect.height / 2 <= board.bottom);
      setDragging(false);
      setActiveFolderShortcutId(undefined);
      activeDragId.current = undefined;
      setFolderTargetId(undefined);
      setPreview(undefined);
      if (sortTargetId && shortcut) {
        const overId = sortTargetId.replace(/^folder-shortcut:/, '');
        const siblings = context.config.shortcuts.filter((item) => item.groupId === shortcut.groupId).sort(compareBySortKey).map((item) => item.id);
        const reorder = folderReorderNeighbors(siblings, shortcutId, overId);
        if (reorder) {
          const reorderedIds = reorderFolderIds(siblings, shortcutId, overId)!;
          setFolderOrderPreview({ folderId: shortcut.groupId, ids: reorderedIds });
          try {
            await context.onMoveShortcut(shortcutId, shortcut.groupId, reorder.beforeId, reorder.afterId);
          } catch (error) {
            setFolderOrderPreview((current) => current?.folderId === shortcut.groupId ? undefined : current);
            throw error;
          } finally {
            folderDragOverRef.current = undefined;
            setActiveDragPieceId(undefined);
            setActiveFolderShortcutId(undefined);
          }
          return;
        }
        setActiveDragPieceId(undefined);
        setActiveFolderShortcutId(undefined);
        folderDragOverRef.current = undefined;
        return;
      }
      if (droppedOnBoard && board && draggedRect) {
        const columnWidth = board.width / 48;
        const centerX = draggedRect.left + draggedRect.width / 2;
        const centerY = draggedRect.top + draggedRect.height / 2;
        const target = { column: Math.max(0, Math.min(44, Math.round((centerX - board.left) / columnWidth) - 2)), row: Math.max(0, Math.round((centerY - board.top) / 40) - 1), width: 4, height: 3, gridVersion: 3 as const };
        setPendingFolderDesktopShortcutId(shortcutId);
        try {
          await context.onMoveShortcut(shortcutId, DEFAULT_GROUP_ID, undefined, undefined, target);
        } catch (error) {
          setPendingFolderDesktopShortcutId((current) => current === shortcutId ? undefined : current);
          throw error;
        } finally {
          setPendingFolderDesktopShortcutId((current) => current === shortcutId ? undefined : current);
          setActiveDragPieceId(undefined);
        }
      } else {
        setActiveDragPieceId(undefined);
        setActiveFolderShortcutId(undefined);
      }
      folderDragOverRef.current = undefined;
      return;
    }
    const active = base.find((piece) => piece.id === id);
    setDragging(false);
    setFolderTargetId(undefined);
    if (!active?.position) { setPreview(undefined); activeDragId.current = undefined; setActiveDragPieceId(undefined); return; }
    if (active.kind === 'shortcut') captureFolderPreviewBounds();
    const folder = findFolderDrop(id, event) ?? folderTargetRef.current;
    folderTargetRef.current = undefined;
    folderTargetBoundsRef.current = undefined;
    if (active.kind === 'shortcut' && folder) {
      setPreview(undefined);
      activeDragId.current = undefined;
      // dnd-kit has already reset the overlay transform at pointer-up. Hide the
      // source immediately so it cannot replay from the old desktop cell while
      // the container change is being committed.
      setActiveDragPieceId(undefined);
      setPendingFolderDropPieceId(active.id);
      try {
        await context.onMoveShortcut(active.payloadRef, folder);
      } catch (error) {
        setPendingFolderDropPieceId(undefined);
        throw error;
      }
      return;
    }
    const board = boardRef.current?.getBoundingClientRect();
    const initial = event.active.rect.current.initial;
    if (!board || !initial) { setPreview(undefined); activeDragId.current = undefined; setActiveDragPieceId(undefined); return; }
    const columnWidth = board.width / 48;
    const target: PiecePosition = { ...active.position, x: active.position.x + Math.round(event.delta.x / columnWidth), y: active.position.y + Math.round(event.delta.y / 40) };
    // Pointer-up can win the event loop race with the dwell timer. Advance the
    // pure session with the release timestamp so a completed dwell commits the
    // same normal displacement that the timer would have previewed.
    collisionIntent = resolvePieceCollisionIntentSession(base, id, target, collisionIntent, Date.now());
    // The solver derives each blocker direction from the active target's side;
    // pointer velocity is used only to obtain this grid-aligned target.
    if (hasProtectedPieceCollision(collisionIntent)) {
      setPreview(undefined);
      activeDragId.current = undefined;
      setActiveDragPieceId(undefined);
      return;
    }
    const result = solvePieceDragPlacement(base, id, target, pushContacts, { collisionIntent });
    if (result.pieces.every((piece) => samePiecePlacement(piece, base.find((item) => item.id === piece.id)))) { setPreview(undefined); activeDragId.current = undefined; setActiveDragPieceId(undefined); return; }
    setPreview(result.pieces);
    const targetPiece = result.pieces.find((piece) => piece.id === id);
    if (targetPiece?.position) pendingDropRef.current = { id, position: { ...targetPiece.position } };
    let committed = false;
    try {
      await appRepositories.pieces.putPieces(result.pieces);
      await onPiecesChanged?.();
      committed = true;
    } finally {
      setPreview(undefined);
      activeDragId.current = undefined;
      if (!committed || !onPiecesChanged) {
        pendingDropRef.current = undefined;
        setActiveDragPieceId(undefined);
      }
    }
  };

  const findFolderDrop = (id: string, event: DragEndEvent) => {
    const active = dragBaseRef.current.find((piece) => piece.id === id);
    if (active?.kind !== 'shortcut') return;
    return dragBaseRef.current.find((piece) => piece.kind === 'folder' && dragCenterInsideFolder(event, piece.id))?.payloadRef;
  };

  function dragCenterInsideFolder(event: DragMoveEvent | DragEndEvent, folderPieceId: string): boolean {
    const initial = event.active.rect.current.initial;
    const folderPreview = folderPreviewBoundsRef.current.get(folderPieceId);
    if (!initial || !folderPreview) return false;
    return isDraggedPieceCenterWithinFolder(initial, event.delta, folderPreview);
  }

  return <DndContext sensors={sensors} collisionDetection={collisionDetection} autoScroll={autoScrollEnabled}
    onDragStart={({ active }) => { const id = String(active.id); beginDrag(); beginWaterBubbleMotion(); activeDragId.current = id; folderDragOverRef.current = undefined; folderTargetRef.current = undefined; folderTargetBoundsRef.current = undefined; setActiveFolderShortcutId(id.startsWith('folder-shortcut:') ? id.slice('folder-shortcut:'.length) : undefined); setActiveDragPieceId(id); blockClicks(id); const base = derivedPieces.map((piece) => structuredClone(piece)); dragBaseRef.current = base; beginPushSession(base); captureFolderPreviewBounds(); setDragging(true); }}
    onDragMove={(event) => {
      updateWaterBubbleMotion(event);
      const base = dragBaseRef.current;
      const activeId = String(event.active.id);
      if (activeId.startsWith('folder-shortcut:')) {
        const overId = String(event.over?.id ?? '');
        if (overId.startsWith('folder-shortcut:') && overId !== activeId
          && isDraggedCenterWithinFolderMember(event.active.rect.current.initial, event.delta, event.over?.rect)) {
          folderDragOverRef.current = { activeId, overId };
        } else {
          folderDragOverRef.current = undefined;
        }
        return;
      }
      const active = base.find((piece) => piece.id === activeId);
      if (!active?.position || !boardRef.current) return;
      if (active.kind === 'shortcut') captureFolderPreviewBounds();
      const overFolderPiece = active.kind === 'shortcut'
        ? base.find((piece) => piece.kind === 'folder' && dragCenterInsideFolder(event, piece.id))
        : undefined;
      const dragInitial = event.active.rect.current.initial;
      const retainedFolderId = !overFolderPiece && active.kind === 'shortcut' && dragInitial && folderTargetRef.current && folderTargetBoundsRef.current
        && isDraggedPieceCenterWithinFolder(dragInitial, event.delta, folderTargetBoundsRef.current)
        ? folderTargetRef.current
        : undefined;
      const overFolderId = overFolderPiece?.payloadRef ?? retainedFolderId;
      if (overFolderPiece) folderTargetBoundsRef.current = folderPreviewBoundsRef.current.get(overFolderPiece.id);
      if (!overFolderId) folderTargetBoundsRef.current = undefined;
      folderTargetRef.current = overFolderId;
      setFolderTargetId(overFolderId);
      if (overFolderId) {
        clearCollisionIntent();
        setPreview(undefined);
        return;
      }
      const target = { ...active.position, x: active.position.x + Math.round(event.delta.x / (boardRef.current.getBoundingClientRect().width / 48)), y: active.position.y + Math.round(event.delta.y / 40) };
      // Keep drag preview and commit on the same geometry-based direction
      // rule. `event.delta` only determines the aligned target position.
      updateDesktopDragPreview(base, active.id, target, Date.now());
    }}
    onDragCancel={({ active }) => { blockNextClick(String(active.id)); clearWaterBubbleMotion(); clearFolderPreviewBounds(); endPushSession(); activeDragId.current = undefined; folderDragOverRef.current = undefined; folderTargetRef.current = undefined; setActiveFolderShortcutId(undefined); setActiveDragPieceId(undefined); setDragging(false); setFolderTargetId(undefined); setPreview(undefined); }}
    onDragEnd={(event) => finish(event).finally(clearFolderPreviewBounds)}>
    <div ref={boardRef} className={`pieceBoard dashboardBoard ${dragging ? 'pieceBoard--dragging' : ''} ${preview ? 'reflowPreview' : ''}`} style={{ '--piece-rows': rows, gridTemplateRows: `repeat(${rows}, 40px)` } as React.CSSProperties}>
      {shown.filter((piece) => piece.container.kind === 'desktop' && piece.position).map((piece) => {
        // Keep the comparison against the frozen drag snapshot. `context` is
        // recreated by the clock/search widgets while dragging; comparing
        // against a freshly derived list would make displaced pieces lose the
        // preview marker even though their grid position changed.
        const basePiece = dragBaseRef.current.find((item) => item.id === piece.id);
        const displaced = Boolean(preview && activeDragId.current !== piece.id && basePiece && !samePiecePlacement(piece, basePiece));
        return <PieceCell key={piece.id} piece={piece} context={context} dragging={dragging} activeDragPieceId={activeDragPieceId} displaced={displaced} folderTarget={folderTargetId === piece.payloadRef} onOpenFolder={setOpenFolderId} onAdd={() => context.onAddShortcut()} />;
      })}
    </div>
    {openFolderId && <FolderDialog folder={context.config.groups.find((group) => group.id === openFolderId)!} shortcuts={context.config.shortcuts.filter((shortcut) => shortcut.groupId === openFolderId)} orderedIds={folderOrderPreview?.folderId === openFolderId ? folderOrderPreview.ids : undefined} pendingShortcutId={pendingFolderDesktopShortcutId} dragDisabled={Boolean(pendingFolderDesktopShortcutId)} onClose={() => setOpenFolderId(undefined)} />}
    <DragOverlay dropAnimation={null} zIndex={40}>
      {activeFolderShortcut
        ? <FolderShortcutOverlay shortcut={activeFolderShortcut} bubbleKick={waterBubbleKick} />
        : activeDesktopPiece && <DesktopPieceDragOverlay pieceId={activeDesktopPiece.id} bubbleKick={waterBubbleKick} />}
    </DragOverlay>
  </DndContext>;
}

function augmentPieces(pieces: Piece[], context: DashboardWidgetContext): Piece[] {
  const result = pieces.map((piece) => {
    const clone = structuredClone(piece);
    if (clone.kind === 'system-widget' && clone.position) {
      const widget = context.config.appearance.widgetLayout.value.find((item) => item.id === clone.payloadRef);
      const preset = widget?.sizePreset ?? clone.sizePreset ?? 'medium';
      const size = clone.payloadRef === 'search' ? { width: searchPercentToPieceWidth(context.searchPreferences.widthPercent), height: 2 } : PIECE_SIZE_PRESETS[clone.payloadRef as keyof typeof PIECE_SIZE_PRESETS][preset];
      if (size) {
        const legacyPosition = widget?.position;
        const isCentered = legacyPosition
          ? legacyPosition.column === Math.round((48 - legacyPosition.width) / 2)
          : clone.position.x === Math.round(-clone.position.width / 2);
        const x = isCentered ? -size.width / 2 : legacyPosition ? legacyPosition.column - 24 : clone.position.x;
        clone.position = { ...clone.position, x, width: size.width, height: size.height };
      }
    }
    return clone;
  });
  const ids = new Set(result.map((piece) => piece.id));
  for (const group of context.config.groups.filter((item) => item.id !== 'default' && item.position)) {
    const id = `piece:folder:${group.id}`;
    if (!ids.has(id)) result.push({ id, kind: 'folder', payloadRef: group.id, container: { kind: 'desktop' }, position: { x: group.position!.column - 24, y: group.position!.row, width: 4, height: 3 }, revision: group.revision });
  }
  for (const shortcut of context.config.shortcuts) {
    const id = `piece:shortcut:${shortcut.id}`;
    if (ids.has(id)) continue;
    const desktop = shortcut.groupId === 'default' && shortcut.position;
    result.push({ id, kind: 'shortcut', payloadRef: shortcut.id, container: desktop ? { kind: 'desktop' } : { kind: 'folder', folderPieceId: `piece:folder:${shortcut.groupId}` }, ...(desktop ? { position: { x: shortcut.position!.column - 24, y: shortcut.position!.row, width: 4, height: 3 } } : {}), revision: shortcut.revision });
  }
  return result;
}

function PieceCell({ piece, context, dragging, activeDragPieceId, displaced, folderTarget, onOpenFolder, onAdd }: { piece: Piece; context: DashboardWidgetContext; dragging: boolean; activeDragPieceId?: string; displaced: boolean; folderTarget: boolean; onOpenFolder(id: string): void; onAdd(): void }) {
  const draggable = useDraggable({ id: piece.id, disabled: piece.kind === 'system-widget' && piece.container.kind !== 'desktop' });
  const droppable = useDroppable({ id: `piece:${piece.id}`, disabled: piece.kind !== 'folder' });
  const nodeRef = useRef<HTMLElement | null>(null);
  const position = piece.position!;
  useDampedLayoutMotion(nodeRef, { column: position.x, row: position.y }, (draggable.isDragging && !displaced) || activeDragPieceId === piece.id);
  const content: ReactNode = piece.kind === 'system-widget'
    ? WIDGET_REGISTRY[piece.payloadRef as keyof typeof WIDGET_REGISTRY].render(context)
    : piece.kind === 'shortcut'
      ? <ShortcutContent shortcut={context.config.shortcuts.find((shortcut) => shortcut.id === piece.payloadRef)} />
      : piece.kind === 'folder'
        ? <FolderContent group={context.config.groups.find((group) => group.id === piece.payloadRef)} shortcuts={context.config.shortcuts.filter((shortcut) => shortcut.groupId === piece.payloadRef)} onOpen={() => onOpenFolder(piece.payloadRef)} />
        : <button type="button" className="pieceAdd" onClick={onAdd}><span className="shortcutWaterShell shortcutWaterShell--add"><PlusIcon className="shortcutWaterShell__content shortcutWaterShell__plus" /></span><strong>{t('addShortcut')}</strong></button>;
  return <section ref={(node) => { draggable.setNodeRef(node); droppable.setNodeRef(node); nodeRef.current = node; }} data-piece-id={piece.id} data-desktop-key={pieceKey(piece)} data-drag-click-key={piece.id} data-widget-id={piece.kind === 'system-widget' ? piece.payloadRef : undefined}
    className={`piece dashboardWidget desktopItem--${piece.kind} piece--${piece.kind} ${piece.kind === 'system-widget' ? `dashboardWidget--${piece.payloadRef}` : ''} ${folderTarget ? 'isFolderTarget' : ''} ${displaced ? 'isDisplaced' : ''} ${draggable.isDragging ? 'piece--dragging piece--drag-overlay-source' : ''} ${dragging ? 'piece--editable' : ''}`}
    style={{ ...pieceGridStyle(position), transform: dragging && !draggable.isDragging && draggable.transform ? `translate3d(${draggable.transform.x}px,${draggable.transform.y}px,0)` : undefined }}
    onPointerDown={(event) => {
      const interactiveControl = (event.target as HTMLElement).closest('button,input,textarea,select,[contenteditable="true"]');
      const isFolderButton = piece.kind === 'folder' && interactiveControl?.matches('button.pieceFolder');
      if (piece.kind !== 'add-shortcut' && !isFolderButton && interactiveControl) return;
      draggable.listeners?.onPointerDown?.(event);
    }}>
    <div className={`pieceContent ${piece.kind === 'system-widget' && piece.payloadRef === 'search' ? 'pieceContent--search' : ''}`}>{content}</div>
  </section>;
}

/** A static DOM copy keeps drag visuals independent from document scroll compensation. */
function DesktopPieceDragOverlay({ pieceId, bubbleKick }: { pieceId: string; bubbleKick?: WaterBubbleKick }) {
  const snapshotRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const source = document.querySelector<HTMLElement>(`[data-piece-id="${CSS.escape(pieceId)}"]`);
    if (!source || !snapshotRef.current) return;
    const snapshot = source.cloneNode(true) as HTMLElement;
    snapshot.removeAttribute('style');
    snapshot.removeAttribute('data-piece-id');
    snapshot.removeAttribute('data-desktop-key');
    snapshot.removeAttribute('data-drag-click-key');
    snapshot.removeAttribute('data-widget-id');
    snapshot.setAttribute('aria-hidden', 'true');
    snapshot.classList.remove('piece--dragging', 'piece--drag-overlay-source', 'piece--editable');
    snapshotRef.current.replaceChildren(snapshot);
    return () => { snapshotRef.current?.replaceChildren(); };
  }, [pieceId]);
  return <div className="desktopPieceDragOverlay" data-desktop-drag-overlay data-water-bubble-kick={bubbleKick ? bubbleKick.sequence % 2 === 0 ? 'a' : 'b' : undefined} style={bubbleKick ? { '--water-bubble-kick-x': `${bubbleKick.x}px`, '--water-bubble-kick-y': `${bubbleKick.y}px`, '--water-bubble-rebound-x': `${-bubbleKick.x * .35}px`, '--water-bubble-rebound-y': `${-bubbleKick.y * .35}px`, '--water-bubble-settle-x': `${bubbleKick.x * .12}px`, '--water-bubble-settle-y': `${bubbleKick.y * .12}px` } as React.CSSProperties : undefined} aria-hidden="true">
    <div ref={snapshotRef} className="desktopPieceDragOverlay__snapshot" />
    <div className="desktopPieceDragOverlay__gridOutline" />
  </div>;
}

function pieceKey(piece: Piece): string {
  if (piece.kind === 'system-widget') return `widget:${piece.payloadRef}`;
  if (piece.kind === 'shortcut') return `shortcut:${piece.payloadRef}`;
  if (piece.kind === 'folder') return `folder:${piece.payloadRef}`;
  return 'add-shortcut';
}

function pieceToDesktopItem(piece: Piece, context: DashboardWidgetContext): DesktopItem {
  const position = piece.position!;
  if (piece.kind === 'system-widget') return { kind: 'system-widget', id: piece.payloadRef as never, key: pieceKey(piece), entity: { id: piece.payloadRef } as never, movable: true, revision: piece.revision, container: { kind: 'desktop' }, position, sizePreset: piece.sizePreset ?? 'medium' } as unknown as DesktopItem;
  if (piece.kind === 'shortcut') return { kind: 'shortcut', key: pieceKey(piece), entity: { id: piece.payloadRef } as never, movable: true, revision: piece.revision, container: { kind: 'desktop' }, position } as unknown as DesktopItem;
  if (piece.kind === 'folder') return { kind: 'folder', key: pieceKey(piece), entity: { id: piece.payloadRef, name: piece.payloadRef } as never, children: context.config.shortcuts.filter((shortcut) => shortcut.groupId === piece.payloadRef), movable: true, revision: piece.revision, container: { kind: 'desktop' }, position } as unknown as DesktopItem;
  return { kind: 'add-shortcut', key: 'add-shortcut', movable: true, revision: piece.revision, container: { kind: 'desktop' }, position } as unknown as DesktopItem;
}

async function handleContextAction(action: DesktopContextAction, target: DesktopContextTarget, pieces: Piece[], context: DashboardWidgetContext, openFolder: (id: string) => void): Promise<void> {
  if (target.kind === 'folder-shortcut') {
    const shortcut = context.config.shortcuts.find((item) => item.id === target.shortcutId && item.groupId === target.groupId);
    if (shortcut && action === 'edit') context.onEditShortcut(shortcut);
    if (shortcut && action === 'delete') await context.onDeleteShortcut(shortcut.id);
    return;
  }
  if (target.kind === 'folder-contents' && action === 'add-shortcut') {
    if (context.config.groups.some((group) => group.id === target.groupId)) context.onAddShortcut({ groupId: target.groupId });
    return;
  }
  const targetKey = target.kind === 'none' || target.kind === 'board' || target.kind === 'folder-contents'
    ? undefined
    : target.kind === 'add-shortcut' ? 'add-shortcut' : target.key;
  const piece = targetKey ? pieces.find((item) => pieceKey(item) === targetKey) : undefined;
  if (target.kind === 'board' && action === 'new-folder') return context.onAddGroup(target.position);
  if (target.kind === 'board' && action === 'add-shortcut') return context.onAddShortcut({ position: target.position });
  if (target.kind === 'shortcut' && piece?.kind === 'shortcut') {
    const shortcut = context.config.shortcuts.find((item) => item.id === piece.payloadRef);
    if (shortcut && action === 'edit') context.onEditShortcut(shortcut);
    if (action === 'delete') await context.onDeleteShortcut(piece.payloadRef);
  }
  if (target.kind === 'folder' && piece?.kind === 'folder') {
    const group = context.config.groups.find((item) => item.id === piece.payloadRef);
    if (group && action === 'open') return openFolder(group.id);
    if (group && action === 'add-shortcut') return context.onAddShortcut({ groupId: group.id });
    if (group && action === 'rename') context.onRenameGroup(group);
    if (group && action === 'delete') await context.onDeleteGroup(group);
  }
  if (piece && action === 'center') {
    const next = pieces.map((item) => item.id === piece.id && item.position ? { ...item, position: { ...item.position, x: -item.position.width / 2 } } : item);
    await appRepositories.pieces.putPieces(next);
  }
  if (target.kind === 'system-widget' && piece?.kind === 'system-widget') {
    if (action === 'hide') await context.onSetWidgetEnabled?.(piece.payloadRef as SystemWidgetId, false);
    if (action.startsWith('size-')) await context.onSetWidgetSize?.(piece.payloadRef as SystemWidgetId, action.slice('size-'.length) as 'small' | 'medium' | 'large');
  }
}

function ShortcutContent({ shortcut }: { shortcut?: { id: string; name: string; url: string } }) {
  if (!shortcut) return null;
  return <ShortcutTile shortcut={shortcut} />;
}

function ShortcutTile({ shortcut }: { shortcut: { id: string; name: string; url: string } }) {
  const [iconUnavailable, setIconUnavailable] = useState(false);
  useEffect(() => setIconUnavailable(false), [shortcut.id, shortcut.url]);
  return <a className="pieceShortcut" href={shortcut.url}><span className="pieceIcon desktopIcon shortcutWaterShell"><ShortcutIcon shortcutId={shortcut.id} url={shortcut.url} onNativeUnavailable={() => setIconUnavailable(true)} onHighResolutionAvailable={() => setIconUnavailable(false)} /><b hidden={!iconUnavailable}>{shortcut.name.slice(0, 1).toUpperCase()}</b></span><span>{shortcut.name}</span></a>;
}

function FolderContent({ group, shortcuts, onOpen }: { group?: { name: string }; shortcuts: { id: string; url: string }[]; onOpen(): void }) {
  return <button type="button" className="pieceFolder desktopFolder" onClick={onOpen}><span className={`pieceFolderPreview folderPreview liquidGlassSurface liquidGlassSurface--icon ${shortcuts.length ? '' : 'empty'}`}>{shortcuts.slice(0, 9).map((shortcut) => <span key={shortcut.id}><ShortcutIcon shortcutId={shortcut.id} url={shortcut.url} /></span>)}</span><strong>{group?.name ?? ''}</strong></button>;
}

function samePiecePlacement(left: Piece, right?: Piece): boolean {
  if (!right) return false;
  return left.container.kind === right.container.kind && left.position?.x === right.position?.x && left.position?.y === right.position?.y && left.position?.width === right.position?.width && left.position?.height === right.position?.height;
}

function samePosition(left?: PiecePosition, right?: PiecePosition): boolean {
  return left?.x === right?.x && left?.y === right?.y && left?.width === right?.width && left?.height === right?.height;
}

function sameIdOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function requiredPieceRows(pieces: readonly Piece[]): number {
  return Math.max(18, ...pieces.filter((piece) => piece.container.kind === 'desktop')
    .map((piece) => (piece.position?.y ?? 0) + (piece.position?.height ?? 1))) + 2;
}
