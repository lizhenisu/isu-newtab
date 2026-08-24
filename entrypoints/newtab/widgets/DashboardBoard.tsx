import {
  DndContext,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
} from '@dnd-kit/core';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { isDesktopContextActionAllowed, type DesktopContextAction, type DesktopContextTarget } from '../../../core/browser/native-context-menu';
import { t } from '../../../core/browser/i18n';
import {
  buildDesktopSnapshot,
  centeredGridSpan,
  desktopItems,
  desktopPlacements,
  samePosition,
  snapshotWithDesktopItems,
  type DesktopCommit,
  type DesktopItem,
  type DesktopSnapshot,
} from '../../../core/domain/desktop';
import { DEFAULT_GROUP_ID } from '../../../core/domain/types';
import { faviconUrl } from '../../../core/domain/url';
import {
  DASHBOARD_COLUMNS,
  DASHBOARD_ROW_HEIGHT,
  WIDGET_SIZE_PRESETS,
  snapGridCoordinate,
  type SystemWidgetId,
  type WidgetLayout,
  type WidgetPosition,
  type WidgetSizePreset,
} from '../../../core/domain/widgets';
import { desktopItemsIntersect, type DesktopLayoutResult, type DragDirection } from '../../../core/layout/desktop-layout-engine';
import { executeDesktopCommand } from '../../../core/layout/desktop-lifecycle';
import { collisionGeometryForRects, type DesktopCollisionGeometry } from '../../../core/layout/desktop-collision';
import { FolderDialog } from '../components/FolderDialog';
import { useDragClickGuard } from '../hooks/useDragClickGuard';
import { useNativeDesktopContextMenu } from '../hooks/useNativeDesktopContextMenu';
import { useDampedLayoutMotion } from '../hooks/useDampedLayoutMotion';
import { useTightCollisionBox } from '../hooks/useTightCollisionBox';
import { WIDGET_REGISTRY, type DashboardWidgetContext } from './registry';

type Props = {
  layout: WidgetLayout;
  context: DashboardWidgetContext;
  onDesktopCommit(commit: DesktopCommit): Promise<void>;
  onWidgetEnabledChange(id: SystemWidgetId, enabled: boolean): Promise<void>;
};

type DragCandidate = {
  activeId: string;
  position: WidgetPosition;
  direction: DragDirection;
  source: 'desktop' | 'folder';
};

type AcceptedPreview = { key: string; result: DesktopLayoutResult };
const FOLDER_SHORTCUT_PREFIX = 'folder-shortcut:';
const candidateKey = (candidate: DragCandidate | undefined) => candidate
  ? `${candidate.activeId}:${candidate.position.column}:${candidate.position.row}`
  : undefined;

export function DashboardBoard({ layout, context, onDesktopCommit, onWidgetEnabledChange }: Props) {
  const snapshot = useMemo(
    () => buildDesktopSnapshot({ ...context.config, appearance: { ...context.config.appearance, widgetLayout: { ...context.config.appearance.widgetLayout, value: layout } } }),
    [context.config, layout],
  );
  const resolvedItems = useMemo(() => desktopItems(snapshot), [snapshot]);
  const [items, setItems] = useState(resolvedItems);
  const [preview, setPreview] = useState<DesktopItem[]>();
  const [dragging, setDragging] = useState(false);
  const [openFolderId, setOpenFolderId] = useState<string>();
  const [acceptedFolderId, setAcceptedFolderId] = useState<string>();
  const boardRef = useRef<HTMLDivElement>(null);
  const dragBaseSnapshotRef = useRef(snapshot);
  const dragBaseItemsRef = useRef<DesktopItem[]>(resolvedItems);
  const pendingRef = useRef<DragCandidate | undefined>(undefined);
  const acceptedRef = useRef<AcceptedPreview | undefined>(undefined);
  const timerRef = useRef<number | undefined>(undefined);
  const pendingFolderRef = useRef<string | undefined>(undefined);
  const acceptedFolderRef = useRef<string | undefined>(undefined);
  const pendingCommitRef = useRef<DesktopItem[] | undefined>(undefined);
  const draggedVisualRectRef = useRef<DOMRect | undefined>(undefined);
  const folderVisualRectsRef = useRef(new Map<string, DOMRect>());
  const dragGeometryRef = useRef<DesktopCollisionGeometry | undefined>(undefined);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { delay: 500, tolerance: 6 } }));
  const { blockClicks, blockNextClick } = useDragClickGuard();

  useEffect(() => {
    if (dragging) return;
    const pending = pendingCommitRef.current;
    if (pending) {
      // Keep the committed preview visible while the repository notification
      // catches up. Otherwise setting dragging=false would immediately restore
      // the previous snapshot for one render and make a valid drop appear to
      // snap back.
      if (desktopItemsMatch(resolvedItems, pending)) {
        pendingCommitRef.current = undefined;
        setItems(resolvedItems);
      }
      return;
    }
    setItems(resolvedItems);
  }, [dragging, resolvedItems]);
  useEffect(() => () => { clearTimer(timerRef); }, []);

  const displayed = preview ?? items;
  const rows = Math.max(18, ...displayed.map((item) => item.position.row + item.position.height)) + 2;

  const candidateFromDrag = (event: DragMoveEvent | DragEndEvent): DragCandidate | undefined => {
    const activeId = String(event.active.id);
    const direction = dragDirection(event.delta.x, event.delta.y);
    const item = dragBaseItemsRef.current.find((candidate) => candidate.key === activeId);
    const source = activeId.startsWith(FOLDER_SHORTCUT_PREFIX) ? 'folder' : 'desktop';
    const initial = event.active.rect.current.initial;
    const board = boardRef.current?.getBoundingClientRect();
    if (!initial || !board) return;
    const itemPosition = item?.position ?? { column: 0, row: 0, width: 4, height: 3, gridVersion: 3 as const };
    const geometryKey = source === 'folder' ? `shortcut:${activeId.slice(FOLDER_SHORTCUT_PREFIX.length)}` : activeId;
    const metrics = dragGeometryRef.current?.nodes[geometryKey];
    const columnWidth = dragGeometryRef.current?.columnWidth ?? board.width / DASHBOARD_COLUMNS;
    const rowHeight = dragGeometryRef.current?.rowHeight ?? DASHBOARD_ROW_HEIGHT;
    const draggedLeft = initial.left + event.delta.x;
    const draggedTop = initial.top + event.delta.y;
    const previous = pendingRef.current?.activeId === activeId ? pendingRef.current.position : undefined;
    const targetColumn = (draggedLeft - board.left - (metrics?.offsetX ?? 0)) / columnWidth;
    const targetRow = (draggedTop - board.top - (metrics?.offsetY ?? 0)) / rowHeight;
    const position = {
      ...itemPosition,
      column: Math.max(0, Math.min(DASHBOARD_COLUMNS - itemPosition.width, snapGridCoordinate(targetColumn, previous?.column))),
      row: Math.max(0, snapGridCoordinate(targetRow, previous?.row)),
    };
    return {
      activeId,
      source,
      direction,
      position,
    };
  };

  const solveCandidate = (candidate: DragCandidate): DesktopLayoutResult => {
    if (candidate.source === 'desktop') {
      return executeDesktopCommand(dragBaseSnapshotRef.current, { type: 'move', key: candidate.activeId, target: candidate.position, direction: candidate.direction, geometry: dragGeometryRef.current });
    }
    const shortcutId = candidate.activeId.slice(FOLDER_SHORTCUT_PREFIX.length);
    const shortcut = context.config.shortcuts.find((item) => item.id === shortcutId);
    if (!shortcut) throw new Error('SHORTCUT_NOT_FOUND');
    return executeDesktopCommand(dragBaseSnapshotRef.current, { type: 'insert', node: {
      kind: 'shortcut',
      key: `shortcut:${shortcut.id}`,
      entity: { ...shortcut, groupId: DEFAULT_GROUP_ID, position: candidate.position },
      movable: true,
      revision: shortcut.revision,
      container: { kind: 'desktop' },
      position: candidate.position,
    }, target: candidate.position, direction: candidate.direction, geometry: dragGeometryRef.current });
  };

  const renderAcceptedPreview = (accepted: AcceptedPreview, candidate: DragCandidate) => {
    const activeKey = candidate.source === 'folder' ? `shortcut:${candidate.activeId.slice(FOLDER_SHORTCUT_PREFIX.length)}` : candidate.activeId;
    if (!accepted.result.movedKeys.some((key) => key !== activeKey)) {
      setPreview(undefined);
      return;
    }
    if (candidate.source === 'folder') {
      setPreview(accepted.result.items.filter((item) => item.key !== activeKey));
      return;
    }
    const originalActive = dragBaseItemsRef.current.find((item) => item.key === activeKey)!;
    setPreview(accepted.result.items.map((item) => item.key === candidate.activeId ? originalActive : item));
  };

  const updateFolderIntent = (folderId: string | undefined) => {
    if (pendingFolderRef.current === folderId) return;
    clearTimer(timerRef);
    pendingFolderRef.current = folderId;
    acceptedFolderRef.current = folderId;
    setAcceptedFolderId(folderId);
    pendingRef.current = undefined;
    acceptedRef.current = undefined;
    setPreview(undefined);
  };

  const fullyContainingFolder = (event: DragMoveEvent): string | undefined => {
    const activeItem = dragBaseItemsRef.current.find((item) => item.key === event.active.id);
    const visualRect = draggedVisualRectRef.current;
    if (activeItem?.kind !== 'shortcut' || !visualRect) return;
    const draggedRect = translatedRect(visualRect, event.delta.x, event.delta.y);
    const folder = dragBaseItemsRef.current.find((item): item is Extract<DesktopItem, { kind: 'folder' }> => {
      if (item.kind !== 'folder') return false;
      const folderRect = folderVisualRectsRef.current.get(item.entity.id);
      if (!folderRect) return false;
      return rectFullyContains(folderRect, draggedRect);
    });
    return folder?.entity.id;
  };

  const onDragMove = (event: DragMoveEvent) => {
    const folderId = fullyContainingFolder(event);
    updateFolderIntent(folderId);
    // A folder is a semantic drop target, so it must keep its committed position
    // while the pointer is deciding whether to enter it. Letting the desktop
    // solver run here would move the droppable out from under the pointer.
    if (folderId) {
      clearTimer(timerRef);
      pendingRef.current = undefined;
      acceptedRef.current = undefined;
      setPreview(undefined);
      return;
    }
    const candidate = candidateFromDrag(event);
    if (!candidate) {
      clearTimer(timerRef);
      pendingRef.current = undefined;
      acceptedRef.current = undefined;
      setPreview(undefined);
      return;
    }
    const key = candidateKey(candidate)!;
    if (key === candidateKey(pendingRef.current)) return;
    clearTimer(timerRef);
    pendingRef.current = candidate;
    const activeKey = candidate.source === 'folder' ? `shortcut:${candidate.activeId.slice(FOLDER_SHORTCUT_PREFIX.length)}` : candidate.activeId;
    const collides = dragBaseItemsRef.current.some((item) => item.key !== activeKey
      && desktopItemsIntersect(item.key, item.position, activeKey, candidate.position, dragGeometryRef.current));
    if (!collides) {
      const accepted = { key, result: solveCandidate(candidate) };
      acceptedRef.current = accepted;
      renderAcceptedPreview(accepted, candidate);
      return;
    }
    timerRef.current = window.setTimeout(() => {
      if (candidateKey(pendingRef.current) !== key) return;
      const accepted = { key, result: solveCandidate(candidate) };
      acceptedRef.current = accepted;
      renderAcceptedPreview(accepted, candidate);
      timerRef.current = undefined;
    }, 400);
  };

  const resolveFinalCandidate = (candidate: DragCandidate): AcceptedPreview | undefined => {
    const key = candidateKey(candidate)!;
    const activeKey = candidate.source === 'folder' ? `shortcut:${candidate.activeId.slice(FOLDER_SHORTCUT_PREFIX.length)}` : candidate.activeId;
    const collides = dragBaseItemsRef.current.some((item) => item.key !== activeKey
      && desktopItemsIntersect(item.key, item.position, activeKey, candidate.position, dragGeometryRef.current));
    const accepted = !collides
      ? { key, result: solveCandidate(candidate) }
      : acceptedRef.current?.key === key ? acceptedRef.current : undefined;
    return accepted && !desktopLayoutHasCollisions(accepted.result.items, dragGeometryRef.current) ? accepted : undefined;
  };

  const finishDrag = async (event: DragEndEvent) => {
    clearTimer(timerRef);
    setDragging(false);
    const activeId = String(event.active.id);
    blockNextClick(activeId);
    const activeItem = dragBaseItemsRef.current.find((item) => item.key === activeId);
    const acceptedFolder = acceptedFolderRef.current;
    if (activeItem?.kind === 'shortcut' && acceptedFolder) {
      resetDragState();
      await context.onMoveShortcut(activeItem.entity.id, acceptedFolder);
      return;
    }

    if (activeId.startsWith(FOLDER_SHORTCUT_PREFIX)) {
      const shortcutId = activeId.slice(FOLDER_SHORTCUT_PREFIX.length);
      const candidate = candidateFromDrag(event);
      const accepted = candidate ? resolveFinalCandidate(candidate) : undefined;
      if (accepted && isDraggedRectOutsideFolder(event)) {
        const geometry = dragGeometryRef.current;
        pendingCommitRef.current = accepted.result.items;
        setItems(accepted.result.items);
        resetDragState();
        try {
          await context.onMoveShortcut(shortcutId, DEFAULT_GROUP_ID, undefined, undefined, candidate!.position, {
            fingerprint: dragBaseSnapshotRef.current.fingerprint,
            placements: desktopPlacements(accepted.result.items),
            collisionGeometry: geometry,
          });
        } catch (error) {
          pendingCommitRef.current = undefined;
          if (!isStaleDesktopError(error)) throw error;
          setItems(resolvedItems);
        }
        return;
      }
      const targetId = typeof event.over?.id === 'string' && event.over.id.startsWith('folder-item:')
        ? event.over.id.slice('folder-item:'.length)
        : undefined;
      if (targetId && targetId !== shortcutId && openFolderId) {
        const ordered = context.config.shortcuts.filter((item) => item.groupId === openFolderId).sort((left, right) => left.sortKey.localeCompare(right.sortKey));
        const without = ordered.filter((item) => item.id !== shortcutId);
        const index = without.findIndex((item) => item.id === targetId);
        resetDragState();
        await context.onMoveShortcut(shortcutId, openFolderId, without[index - 1]?.id, without[index]?.id);
        return;
      }
      setItems(dragBaseItemsRef.current);
      resetDragState();
      return;
    }

    const candidate = candidateFromDrag(event);
    const accepted = candidate ? resolveFinalCandidate(candidate) : undefined;
    if (!accepted) {
      pendingCommitRef.current = undefined;
      setItems(dragBaseItemsRef.current);
      resetDragState();
      return;
    }
    pendingCommitRef.current = accepted.result.items;
    setItems(accepted.result.items);
    const geometry = dragGeometryRef.current;
    resetDragState();
    try {
      await onDesktopCommit({ fingerprint: dragBaseSnapshotRef.current.fingerprint, placements: desktopPlacements(accepted.result.items), collisionGeometry: geometry });
    } catch (error) {
      pendingCommitRef.current = undefined;
      if (!isStaleDesktopError(error)) throw error;
      setItems(resolvedItems);
    }
  };

  const resetDragState = () => {
    pendingFolderRef.current = undefined;
    acceptedFolderRef.current = undefined;
    draggedVisualRectRef.current = undefined;
    dragGeometryRef.current = undefined;
    folderVisualRectsRef.current.clear();
    setAcceptedFolderId(undefined);
    pendingRef.current = undefined;
    acceptedRef.current = undefined;
    setPreview(undefined);
  };

  const cancelDrag = () => {
    clearTimer(timerRef);
    setDragging(false);
    pendingCommitRef.current = undefined;
    setItems(dragBaseItemsRef.current);
    resetDragState();
  };

  const commitReflow = async (item: DesktopItem, position: WidgetPosition, sizePreset?: WidgetSizePreset) => {
    const sized = items.map((candidate) => {
      if (candidate.key !== item.key) return candidate;
      if (candidate.kind === 'system-widget' && sizePreset) {
        return { ...candidate, sizePreset, position: { ...position, ...WIDGET_SIZE_PRESETS[candidate.id][sizePreset] } } as DesktopItem;
      }
      return { ...candidate, position } as DesktopItem;
    });
    const workingSnapshot = snapshotWithDesktopItems(snapshot, sized);
    const target = sized.find((candidate) => candidate.key === item.key)!;
    const result = executeDesktopCommand(workingSnapshot, { type: 'move', key: item.key, target: target.position });
    setItems(result.items);
    try {
      await onDesktopCommit({ fingerprint: snapshot.fingerprint, placements: desktopPlacements(result.items) });
    } catch (error) {
      if (!isStaleDesktopError(error)) throw error;
      setItems(resolvedItems);
    }
  };

  const executeContextAction = async (action: DesktopContextAction, target: DesktopContextTarget) => {
    if (!isDesktopContextActionAllowed(action, target)) return;
    if (target.kind === 'board') {
      if (action === 'new-folder') context.onAddGroup(target.position);
      if (action === 'add-shortcut') context.onAddShortcut({ position: target.position });
      return;
    }
    if (target.kind === 'folder-contents') {
      if (action === 'add-shortcut' && context.config.groups.some((group) => group.id === target.groupId)) context.onAddShortcut({ groupId: target.groupId });
      return;
    }
    if (target.kind === 'folder-shortcut') {
      const shortcut = context.config.shortcuts.find((item) => item.id === target.shortcutId && item.groupId === target.groupId);
      if (shortcut && action === 'edit') context.onEditShortcut(shortcut);
      if (shortcut && action === 'delete') await context.onDeleteShortcut(shortcut.id);
      return;
    }
    if (target.kind === 'none') return;
    const item = items.find((candidate) => candidate.key === target.key);
    if (!item || item.kind !== target.kind) return;
    if (action === 'center') {
      const width = centeredGridSpan(item.position.width);
      await commitReflow(item, { ...item.position, width, column: (DASHBOARD_COLUMNS - width) / 2 });
    } else if (action === 'edit' && item.kind === 'shortcut') context.onEditShortcut(item.entity);
    else if (action === 'delete' && item.kind === 'shortcut') await context.onDeleteShortcut(item.entity.id);
    else if (action === 'open' && item.kind === 'folder') setOpenFolderId(item.entity.id);
    else if (action === 'rename' && item.kind === 'folder') context.onRenameGroup(item.entity);
    else if (action === 'delete' && item.kind === 'folder') await context.onDeleteGroup(item.entity);
    else if (action === 'hide' && item.kind === 'system-widget') await onWidgetEnabledChange(item.id, false);
    else if (action.startsWith('size-') && item.kind === 'system-widget' && item.id !== 'search') {
      await commitReflow(item, item.position, action.slice('size-'.length) as WidgetSizePreset);
    }
  };
  useNativeDesktopContextMenu(boardRef, displayed, executeContextAction);
  const folder = openFolderId ? context.config.groups.find((group) => group.id === openFolderId) : undefined;

  return (
    <DndContext sensors={sensors} collisionDetection={pointerWithin}
      onDragStart={({ active }) => {
        const activeId = String(active.id);
        blockClicks(activeId);
        dragBaseSnapshotRef.current = snapshot;
        dragBaseItemsRef.current = items;
        const activeNode = [...(boardRef.current?.querySelectorAll<HTMLElement>('[data-desktop-key]') ?? [])]
          .find((node) => node.dataset.desktopKey === activeId);
        draggedVisualRectRef.current = activeNode?.querySelector('.desktopIcon')?.getBoundingClientRect();
        const board = boardRef.current?.getBoundingClientRect();
        if (board && boardRef.current) {
          const sections = [...boardRef.current.querySelectorAll<HTMLElement>('[data-desktop-key]')].flatMap((node) => {
            const key = node.dataset.desktopKey;
            const position = key ? dragBaseItemsRef.current.find((item) => item.key === key)?.position : undefined;
            const rect = node.getBoundingClientRect();
            return key && position ? [{ key, position, rect }] : [];
          });
          const geometry = collisionGeometryForRects(board, DASHBOARD_ROW_HEIGHT, sections);
          if (activeId.startsWith(FOLDER_SHORTCUT_PREFIX)) {
            const source = document.querySelector<HTMLElement>(`[data-drag-click-key="${activeId}"]`);
            const sourceRect = source?.getBoundingClientRect();
            const shortcutKey = `shortcut:${activeId.slice(FOLDER_SHORTCUT_PREFIX.length)}`;
            if (sourceRect) {
              draggedVisualRectRef.current = source?.querySelector('.desktopIcon')?.getBoundingClientRect() ?? sourceRect;
              const sourceGeometry = collisionGeometryForRects(board, DASHBOARD_ROW_HEIGHT, [{
                key: shortcutKey,
                rect: sourceRect,
                position: { column: 0, row: 0, width: 4, height: 3, gridVersion: 3 },
              }]);
              geometry.nodes[shortcutKey] = sourceGeometry.nodes[shortcutKey]!;
            }
          }
          dragGeometryRef.current = geometry;
        }
        folderVisualRectsRef.current = new Map(
          [...(boardRef.current?.querySelectorAll<HTMLElement>('.desktopItem--folder') ?? [])].flatMap((node) => {
            const key = node.dataset.desktopKey;
            const rect = node.querySelector('.folderPreview')?.getBoundingClientRect();
            return key?.startsWith('folder:') && rect ? [[key.slice('folder:'.length), rect] as const] : [];
          }),
        );
        setDragging(true);
      }}
      onDragMove={onDragMove}
      onDragEnd={(event) => void finishDrag(event)}
      onDragCancel={({ active }) => { blockNextClick(String(active.id)); cancelDrag(); }}>
      <div ref={boardRef} className={`dashboardBoard ${dragging ? 'dragging' : ''} ${preview ? 'reflowPreview' : ''}`}
        style={{ '--board-rows': rows } as React.CSSProperties}>
        {displayed.map((item) => {
          const committed = items.find((candidate) => candidate.key === item.key);
          const displaced = Boolean(committed && (committed.position.column !== item.position.column || committed.position.row !== item.position.row));
          return <DesktopCell key={item.key} item={item} context={context} displaced={displaced}
            folderAccepted={item.kind === 'folder' && acceptedFolderId === item.entity.id}
            onAdd={() => context.onAddShortcut()} onOpenFolder={setOpenFolderId} />;
        })}
      </div>
      {folder && <FolderDialog folder={folder} shortcuts={context.config.shortcuts.filter((item) => item.groupId === folder.id)}
        onClose={() => setOpenFolderId(undefined)} />}
    </DndContext>
  );
}

function DesktopCell({ item, context, displaced, folderAccepted, onAdd, onOpenFolder }: {
  item: DesktopItem;
  context: DashboardWidgetContext;
  displaced: boolean;
  folderAccepted: boolean;
  onAdd(): void;
  onOpenFolder(id: string): void;
}) {
  const draggable = useDraggable({ id: item.key, disabled: !item.movable });
  const folderDrop = useDroppable({ id: item.kind === 'folder' ? `folder-drop:${item.entity.id}` : `drop:${item.key}`, disabled: item.kind !== 'folder' });
  const nodeRef = useRef<HTMLElement | null>(null);
  const transform = draggable.transform ? `translate3d(${draggable.transform.x}px, ${draggable.transform.y}px, 0)` : undefined;
  const preserveWidth = item.kind === 'system-widget' && (item.id === 'search' || item.id === 'quickNote');
  useTightCollisionBox(nodeRef, { enabled: true, preserveWidth, position: item.position });
  useDampedLayoutMotion(nodeRef, item.position, draggable.isDragging);
  const content: ReactNode = item.kind === 'system-widget'
    ? WIDGET_REGISTRY[item.id].render(context)
    : item.kind === 'shortcut'
      ? <ShortcutTile shortcut={item.entity} />
      : item.kind === 'folder'
        ? <FolderTile item={item} onOpen={() => onOpenFolder(item.entity.id)} active={folderAccepted} />
        : <button type="button" className="desktopAddTile" onClick={onAdd}><span>＋</span><strong>{t('addShortcut')}</strong></button>;
  return <section ref={(node) => { draggable.setNodeRef(node); folderDrop.setNodeRef(node); nodeRef.current = node; }}
    className={`dashboardWidget desktopItem--${item.kind} ${item.kind === 'system-widget' ? `dashboardWidget--${item.id}` : ''} ${draggable.isDragging ? 'isDragging' : ''} ${displaced ? 'isDisplaced' : ''} ${folderAccepted ? 'isFolderTarget' : ''}`}
    data-desktop-key={item.key} data-drag-click-key={item.key}
    data-widget-id={item.kind === 'system-widget' ? item.id : undefined}
    style={{ gridColumn: `${item.position.column + 1} / span ${item.position.width}`, gridRow: `${item.position.row + 1} / span ${item.position.height}`, transform }}
    onPointerDown={(event) => { if (item.movable) draggable.listeners?.onPointerDown?.(event); }}>
    {content}
  </section>;
}

function ShortcutTile({ shortcut }: { shortcut: Extract<DesktopItem, { kind: 'shortcut' }>['entity'] }) {
  return <a className="desktopShortcut" href={shortcut.url}><DesktopIcon name={shortcut.name} url={shortcut.url} /><span>{shortcut.name}</span></a>;
}

function DesktopIcon({ name, url }: { name: string; url: string }) {
  return <span className="desktopIcon"><img src={faviconUrl(url)} alt="" onError={(event) => { event.currentTarget.hidden = true; event.currentTarget.nextElementSibling?.removeAttribute('hidden'); }} /><b hidden>{name.slice(0, 1).toUpperCase()}</b></span>;
}

function FolderTile({ item, onOpen, active }: { item: Extract<DesktopItem, { kind: 'folder' }>; onOpen(): void; active: boolean }) {
  return <button type="button" className={`desktopFolder ${active ? 'active' : ''}`} onClick={onOpen}>
    <span className={`folderPreview ${item.children.length ? '' : 'empty'}`}>
      {item.children.slice(0, 9).map((shortcut) => <span key={shortcut.id}><img src={faviconUrl(shortcut.url)} alt="" /></span>)}
    </span>
    <strong>{item.entity.name}</strong>
  </button>;
}

function clearTimer(ref: React.MutableRefObject<number | undefined>): void {
  if (ref.current) window.clearTimeout(ref.current);
  ref.current = undefined;
}

function dragDirection(x: number, y: number): DragDirection {
  if (Math.abs(x) >= Math.abs(y) && x !== 0) return { x: x > 0 ? 1 : -1, y: 0 };
  if (y !== 0) return { x: 0, y: y > 0 ? 1 : -1 };
  return { x: 0, y: 1 };
}

function isDraggedRectOutsideFolder(event: DragEndEvent): boolean {
  const initial = event.active.rect.current.initial;
  const surface = document.querySelector('.folderSurface')?.getBoundingClientRect();
  if (!initial || !surface) return false;
  const final = {
    left: initial.left + event.delta.x,
    right: initial.right + event.delta.x,
    top: initial.top + event.delta.y,
    bottom: initial.bottom + event.delta.y,
  };
  return final.right <= surface.left || final.left >= surface.right || final.bottom <= surface.top || final.top >= surface.bottom;
}

function isStaleDesktopError(error: unknown): boolean {
  return error instanceof Error && error.message === 'DESKTOP_STALE';
}

function rectFullyContains(
  container: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>,
  item: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>,
): boolean {
  const roundingTolerance = 1;
  return item.left >= container.left - roundingTolerance
    && item.right <= container.right + roundingTolerance
    && item.top >= container.top - roundingTolerance
    && item.bottom <= container.bottom + roundingTolerance;
}

function translatedRect(rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>, x: number, y: number) {
  return { left: rect.left + x, right: rect.right + x, top: rect.top + y, bottom: rect.bottom + y };
}

function desktopItemsMatch(left: DesktopItem[], right: DesktopItem[]): boolean {
  if (left.length !== right.length) return false;
  const byKey = new Map(right.map((item) => [item.key, item]));
  return left.every((item) => {
    const candidate = byKey.get(item.key);
    return Boolean(candidate && samePosition(item.position, candidate.position));
  });
}

function desktopLayoutHasCollisions(items: DesktopItem[], geometry: DesktopCollisionGeometry | undefined): boolean {
  return items.some((left, index) => items.slice(index + 1).some((right) =>
    desktopItemsIntersect(left.key, left.position, right.key, right.position, geometry)));
}
