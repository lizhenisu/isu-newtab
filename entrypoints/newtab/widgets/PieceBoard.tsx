import { DndContext, PointerSensor, pointerWithin, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragMoveEvent } from '@dnd-kit/core';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { t } from '../../../core/browser/i18n';
import { faviconUrl } from '../../../core/domain/url';
import { pieceGridStyle, PIECE_SIZE_PRESETS, searchPercentToPieceWidth, type Piece, type PiecePosition } from '../../../core/domain/pieces';
import type { SystemWidgetId } from '../../../core/domain/widgets';
import { PieceLayoutEngine, type PieceDragDirection } from '../../../core/layout/piece-layout-engine';
import { appRepositories } from '../../../core/storage/repository';
import { FolderDialog } from '../components/FolderDialog';
import { useDragClickGuard } from '../hooks/useDragClickGuard';
import { useDampedLayoutMotion } from '../hooks/useDampedLayoutMotion';
import { useNativeDesktopContextMenu } from '../hooks/useNativeDesktopContextMenu';
import type { DesktopContextAction, DesktopContextTarget } from '../../../core/browser/native-context-menu';
import type { DesktopItem } from '../../../core/domain/desktop';
import { WIDGET_REGISTRY, type DashboardWidgetContext } from './registry';

type Props = { pieces: Piece[]; context: DashboardWidgetContext; onPiecesChanged?: () => Promise<void> };

/** The desktop only knows pieces; business widgets are rendered inside them. */
export function PieceBoard({ pieces, context, onPiecesChanged }: Props) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { delay: 500, tolerance: 6 } }));
  const boardRef = useRef<HTMLDivElement>(null);
  const dragBaseRef = useRef<Piece[]>(pieces);
  const activeDragId = useRef<string | undefined>(undefined);
  const pendingDropRef = useRef<{ id: string; position: PiecePosition } | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const [activeDragPieceId, setActiveDragPieceId] = useState<string>();
  const [preview, setPreview] = useState<Piece[]>();
  const [openFolderId, setOpenFolderId] = useState<string>();
  const [folderTargetId, setFolderTargetId] = useState<string>();
  const previewTimer = useRef<number | undefined>(undefined);
  const { blockClicks, blockNextClick } = useDragClickGuard();
  const derivedPieces = useMemo(() => augmentPieces(pieces, context), [pieces, context]);
  useEffect(() => {
    const pending = pendingDropRef.current;
    if (!pending) return;
    const persisted = pieces.find((piece) => piece.id === pending.id);
    if (!persisted || !samePosition(persisted.position, pending.position)) return;
    pendingDropRef.current = undefined;
    setActiveDragPieceId((current) => current === pending.id ? undefined : current);
  }, [pieces]);
  const shown = preview
    ? preview.map((piece) => piece.id === activeDragId.current && dragging ? dragBaseRef.current.find((basePiece) => basePiece.id === piece.id) ?? piece : piece)
    : derivedPieces;
  useNativeDesktopContextMenu(boardRef, useMemo(() => shown.filter((piece) => piece.container.kind === 'desktop' && piece.position).map((piece) => pieceToDesktopItem(piece, context)), [shown, context]), (action, target) => void handleContextAction(action, target, shown, context, setOpenFolderId));
  const rows = Math.max(18, ...shown.filter((piece) => piece.container.kind === 'desktop').map((piece) => (piece.position?.y ?? 0) + (piece.position?.height ?? 1))) + 2;

  const finish = async (event: DragEndEvent) => {
    if (previewTimer.current) window.clearTimeout(previewTimer.current);
    const id = String(event.active.id);
    blockNextClick(id);
    const base = dragBaseRef.current;
    if (id.startsWith('folder-shortcut:')) {
      const shortcutId = id.slice('folder-shortcut:'.length);
      const board = boardRef.current?.getBoundingClientRect();
      const initial = event.active.rect.current.initial;
      const droppedOnBoard = Boolean(board && initial && initial.left + event.delta.x + initial.width / 2 >= board.left && initial.left + event.delta.x + initial.width / 2 <= board.right && initial.top + event.delta.y + initial.height / 2 >= board.top);
      setDragging(false);
      activeDragId.current = undefined;
      setFolderTargetId(undefined);
      setPreview(undefined);
      if (droppedOnBoard && board && initial) {
        const columnWidth = board.width / 48;
        const centerX = initial.left + event.delta.x + initial.width / 2;
        const centerY = initial.top + event.delta.y + initial.height / 2;
        try {
          await context.onMoveShortcut(shortcutId, 'default', undefined, undefined, { column: Math.max(0, Math.min(44, Math.round((centerX - board.left) / columnWidth) - 2)), row: Math.max(0, Math.round((centerY - board.top) / 40) - 1), width: 4, height: 3, gridVersion: 3 });
        } finally {
          setActiveDragPieceId(undefined);
        }
      } else {
        setActiveDragPieceId(undefined);
      }
      return;
    }
    const active = base.find((piece) => piece.id === id);
    setDragging(false);
    setFolderTargetId(undefined);
    if (!active?.position) { setPreview(undefined); activeDragId.current = undefined; setActiveDragPieceId(undefined); return; }
    const folder = findFolderDrop(id, event);
    if (active.kind === 'shortcut' && folder) {
      setPreview(undefined);
      activeDragId.current = undefined;
      try {
        await context.onMoveShortcut(active.payloadRef, folder);
      } finally {
        setActiveDragPieceId(undefined);
      }
      return;
    }
    const board = boardRef.current?.getBoundingClientRect();
    const initial = event.active.rect.current.initial;
    if (!board || !initial) { setPreview(undefined); activeDragId.current = undefined; setActiveDragPieceId(undefined); return; }
    const columnWidth = board.width / 48;
    const target: PiecePosition = { ...active.position, x: active.position.x + Math.round(event.delta.x / columnWidth), y: active.position.y + Math.round(event.delta.y / 40) };
    const direction: PieceDragDirection = Math.abs(event.delta.x) >= Math.abs(event.delta.y)
      ? { x: event.delta.x > 0 ? 1 : event.delta.x < 0 ? -1 : 0, y: 0 }
      : { x: 0, y: event.delta.y > 0 ? 1 : -1 };
    const result = new PieceLayoutEngine().place(base, id, target, direction);
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
    const folderPiece = dragBaseRef.current.find((piece) => piece.kind === 'folder' && dragRectFullyInsideFolder(event, piece.id));
    return folderPiece && dragRectFullyInsideFolder(event, folderPiece.id) ? folderPiece.payloadRef : undefined;
  };

  function dragRectFullyInsideFolder(event: DragMoveEvent | DragEndEvent, folderPieceId: string): boolean {
    const initial = event.active.rect.current.initial;
    const folder = boardRef.current?.querySelector<HTMLElement>(`[data-piece-id="${CSS.escape(folderPieceId)}"]`);
    if (!initial || !folder) return false;
    const folderRect = folder.getBoundingClientRect();
    const left = initial.left + event.delta.x;
    const top = initial.top + event.delta.y;
    const right = left + initial.width;
    const bottom = top + initial.height;
    // Grid tracks can differ by a fractional pixel after the browser rounds
    // a responsive board width. Treat that sub-pixel seam as containment,
    // while still requiring the whole piece (not merely its pointer) inside.
    const epsilon = 1.5;
    return left >= folderRect.left - epsilon && top >= folderRect.top - epsilon
      && right <= folderRect.right + epsilon && bottom <= folderRect.bottom + epsilon;
  }

  return <DndContext sensors={sensors} collisionDetection={pointerWithin}
    onDragStart={({ active }) => { activeDragId.current = String(active.id); setActiveDragPieceId(String(active.id)); blockClicks(String(active.id)); dragBaseRef.current = derivedPieces.map((piece) => structuredClone(piece)); setDragging(true); }}
    onDragMove={(event) => {
      const base = dragBaseRef.current;
      const active = base.find((piece) => piece.id === String(event.active.id));
      if (!active?.position || !boardRef.current) return;
      const overFolderId = active.kind === 'shortcut'
        ? base.find((piece) => piece.kind === 'folder' && dragRectFullyInsideFolder(event, piece.id))?.payloadRef
        : undefined;
      setFolderTargetId(overFolderId);
      if (overFolderId) { if (previewTimer.current) window.clearTimeout(previewTimer.current); setPreview(undefined); return; }
      const target = { ...active.position, x: active.position.x + Math.round(event.delta.x / (boardRef.current.getBoundingClientRect().width / 48)), y: active.position.y + Math.round(event.delta.y / 40) };
      const result = new PieceLayoutEngine().place(base, active.id, target, { x: (Math.abs(event.delta.x) >= Math.abs(event.delta.y) ? event.delta.x > 0 ? 1 : -1 : 0) as -1 | 0 | 1, y: (Math.abs(event.delta.x) < Math.abs(event.delta.y) ? event.delta.y > 0 ? 1 : -1 : 0) as -1 | 0 | 1 });
      const changed = result.pieces.some((piece) => !samePiecePlacement(piece, base.find((item) => item.id === piece.id)));
      if (!changed) { setPreview(undefined); return; }
      if (result.movedPieceIds.length === 1) { setPreview(result.pieces); return; }
      if (previewTimer.current) window.clearTimeout(previewTimer.current);
      previewTimer.current = window.setTimeout(() => { setPreview(result.pieces); previewTimer.current = undefined; }, 400);
    }}
    onDragCancel={({ active }) => { if (previewTimer.current) window.clearTimeout(previewTimer.current); blockNextClick(String(active.id)); activeDragId.current = undefined; setActiveDragPieceId(undefined); setDragging(false); setFolderTargetId(undefined); setPreview(undefined); }}
    onDragEnd={(event) => void finish(event)}>
    <div ref={boardRef} className={`pieceBoard dashboardBoard ${dragging ? 'pieceBoard--dragging' : ''} ${preview ? 'reflowPreview' : ''}`} style={{ '--piece-rows': rows, gridTemplateRows: `repeat(${rows}, 40px)`, minHeight: `${rows * 40}px` } as React.CSSProperties}>
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
    {openFolderId && <FolderDialog folder={context.config.groups.find((group) => group.id === openFolderId)!} shortcuts={context.config.shortcuts.filter((shortcut) => shortcut.groupId === openFolderId)} onClose={() => setOpenFolderId(undefined)} />}
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
        : <button type="button" className="pieceAdd" onClick={onAdd}><span>＋</span><strong>{t('addShortcut')}</strong></button>;
  return <section ref={(node) => { draggable.setNodeRef(node); droppable.setNodeRef(node); nodeRef.current = node; }} data-piece-id={piece.id} data-desktop-key={pieceKey(piece)} data-drag-click-key={piece.id} data-widget-id={piece.kind === 'system-widget' ? piece.payloadRef : undefined}
    className={`piece dashboardWidget desktopItem--${piece.kind} piece--${piece.kind} ${piece.kind === 'system-widget' ? `dashboardWidget--${piece.payloadRef}` : ''} ${folderTarget ? 'isFolderTarget' : ''} ${displaced ? 'isDisplaced' : ''} ${draggable.isDragging ? 'piece--dragging' : ''} ${dragging ? 'piece--editable' : ''}`}
    style={{ ...pieceGridStyle(position), transform: dragging && draggable.transform ? `translate3d(${draggable.transform.x}px,${draggable.transform.y}px,0)` : undefined }}
    onPointerDown={(event) => {
      if (piece.kind !== 'add-shortcut' && (event.target as HTMLElement).closest('button,input,textarea,select,[contenteditable="true"]')) return;
      draggable.listeners?.onPointerDown?.(event);
    }}>
    <div className={`pieceContent ${piece.kind === 'system-widget' && piece.payloadRef === 'search' ? 'pieceContent--search' : ''}`}>{content}</div>
  </section>;
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

function ShortcutContent({ shortcut }: { shortcut?: { name: string; url: string } }) {
  if (!shortcut) return null;
  return <a className="pieceShortcut" href={shortcut.url}><span className="pieceIcon desktopIcon"><img src={faviconUrl(shortcut.url)} alt="" onError={(event) => { event.currentTarget.hidden = true; }} /></span><span>{shortcut.name}</span></a>;
}

function FolderContent({ group, shortcuts, onOpen }: { group?: { name: string }; shortcuts: { id: string; url: string }[]; onOpen(): void }) {
  return <button type="button" className="pieceFolder desktopFolder" onClick={onOpen}><span className={`pieceFolderPreview folderPreview ${shortcuts.length ? '' : 'empty'}`}>{shortcuts.slice(0, 9).map((shortcut) => <span key={shortcut.id}><img src={faviconUrl(shortcut.url)} alt="" /></span>)}</span><strong>{group?.name ?? ''}</strong></button>;
}

function samePiecePlacement(left: Piece, right?: Piece): boolean {
  if (!right) return false;
  return left.container.kind === right.container.kind && left.position?.x === right.position?.x && left.position?.y === right.position?.y && left.position?.width === right.position?.width && left.position?.height === right.position?.height;
}

function samePosition(left?: PiecePosition, right?: PiecePosition): boolean {
  return left?.x === right?.x && left?.y === right?.y && left?.width === right?.width && left?.height === right?.height;
}
