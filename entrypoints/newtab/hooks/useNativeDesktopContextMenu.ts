import { useEffect, useRef, type RefObject } from 'react';
import { browser } from 'wxt/browser';
import {
  DESKTOP_CONTEXT_PORT,
  contextTargetSignature,
  type DesktopContextAction,
  type DesktopContextPortMessage,
  type DesktopContextTarget,
} from '../../../core/browser/native-context-menu';
import type { DesktopItem } from '../../../core/domain/desktop';
import { DASHBOARD_COLUMNS, DASHBOARD_ROW_HEIGHT, type WidgetPosition } from '../../../core/domain/widgets';

type ActionHandler = (action: DesktopContextAction, target: DesktopContextTarget) => void | Promise<void>;

export function useNativeDesktopContextMenu(
  boardRef: RefObject<HTMLDivElement | null>,
  items: DesktopItem[],
  onAction: ActionHandler,
): void {
  const itemsRef = useRef(items);
  const actionRef = useRef(onAction);
  itemsRef.current = items;
  actionRef.current = onAction;

  useEffect(() => {
    let disposed = false;
    let retryTimer: number | undefined;
    let port: ReturnType<typeof browser.runtime.connect> | undefined;
    let lastSignature = '';

    const postTarget = (target: DesktopContextTarget, force = false) => {
      const signature = contextTargetSignature(target);
      if (!force && signature === lastSignature) return;
      lastSignature = signature;
      port?.postMessage({ type: 'target', target } satisfies DesktopContextPortMessage);
    };
    const connect = () => {
      if (disposed) return;
      port = browser.runtime.connect({ name: DESKTOP_CONTEXT_PORT });
      port.onMessage.addListener((message: DesktopContextPortMessage) => {
        if (message.type === 'action') void actionRef.current(message.action, message.target);
      });
      port.onDisconnect.addListener(() => {
        port = undefined;
        lastSignature = '';
        if (!disposed) retryTimer = window.setTimeout(connect, 250);
      });
      postTarget({ kind: 'none' }, true);
    };
    const updateFromPointer = (event: PointerEvent) => {
      postTarget(targetFromPointer(event, boardRef.current, itemsRef.current), event.button === 2);
    };

    connect();
    document.addEventListener('pointermove', updateFromPointer, true);
    document.addEventListener('pointerdown', updateFromPointer, true);
    return () => {
      disposed = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      document.removeEventListener('pointermove', updateFromPointer, true);
      document.removeEventListener('pointerdown', updateFromPointer, true);
      port?.disconnect();
    };
  }, [boardRef]);
}

export function targetFromPointer(event: Pick<PointerEvent, 'target' | 'clientX' | 'clientY'>, board: HTMLDivElement | null, items: DesktopItem[]): DesktopContextTarget {
  const element = event.target instanceof Element ? event.target : undefined;
  if (!element) return { kind: 'none' };
  const folderMember = element.closest<HTMLElement>('[data-folder-shortcut-id]');
  const folderContents = element.closest<HTMLElement>('[data-folder-context-id]');
  const groupId = folderContents?.dataset.folderContextId;
  const shortcutId = folderMember?.dataset.folderShortcutId;
  if (shortcutId && groupId) return { kind: 'folder-shortcut', shortcutId, groupId };
  if (groupId) return { kind: 'folder-contents', groupId };
  if (!board || !board.contains(element)) return { kind: 'none' };
  const cell = element.closest<HTMLElement>('[data-desktop-key]');
  const key = cell?.dataset.desktopKey;
  const item = key ? items.find((candidate) => candidate.key === key) : undefined;
  if (!item) return { kind: 'board', position: boardPosition(board, event.clientX, event.clientY) };
  if (item.kind === 'system-widget') return { kind: 'system-widget', key: item.key, widgetId: item.id, sizePreset: item.sizePreset };
  if (item.kind === 'shortcut') return { kind: 'shortcut', key: item.key };
  if (item.kind === 'folder') return { kind: 'folder', key: item.key, empty: item.children.length === 0 };
  return { kind: 'add-shortcut', key: 'add-shortcut' };
}

function boardPosition(board: HTMLDivElement, clientX: number, clientY: number): WidgetPosition {
  const rect = board.getBoundingClientRect();
  return {
    column: Math.max(0, Math.min(44, Math.floor(((clientX - rect.left) / rect.width) * DASHBOARD_COLUMNS))),
    row: Math.max(0, Math.floor((clientY - rect.top) / DASHBOARD_ROW_HEIGHT)),
    width: 4,
    height: 3,
    gridVersion: 3,
  };
}
