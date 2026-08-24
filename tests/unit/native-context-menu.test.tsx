import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { createInitialConfig } from '../../core/domain/defaults';
import {
  CONTEXT_MENU_IDS,
  DESKTOP_CONTEXT_PORT,
  isDesktopContextActionAllowed,
  nativeMenuState,
  type DesktopContextPortMessage,
} from '../../core/browser/native-context-menu';
import { registerDesktopContextMenus } from '../../core/browser/context-menu-controller';
import { DashboardBoard } from '../../entrypoints/newtab/widgets/DashboardBoard';
import { PieceBoard } from '../../entrypoints/newtab/widgets/PieceBoard';
import type { Piece } from '../../core/domain/pieces';
import { targetFromPointer } from '../../entrypoints/newtab/hooks/useNativeDesktopContextMenu';
import { FolderDialog } from '../../entrypoints/newtab/components/FolderDialog';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('native desktop context menu', () => {
  it('maps desktop target kinds to only their valid native commands', () => {
    const shortcut = nativeMenuState({ kind: 'shortcut', key: 'shortcut:a' });
    expect(shortcut[CONTEXT_MENU_IDS.edit]?.visible).toBe(true);
    expect(shortcut[CONTEXT_MENU_IDS.delete]?.visible).toBe(true);
    expect(shortcut[CONTEXT_MENU_IDS.newFolder]?.visible).toBe(false);
    expect(shortcut[CONTEXT_MENU_IDS.addShortcut]?.visible).toBe(false);
    expect(isDesktopContextActionAllowed('rename', { kind: 'shortcut', key: 'shortcut:a' })).toBe(false);

    const board = nativeMenuState({ kind: 'board', position: { column: 4, row: 6, width: 4, height: 3, gridVersion: 3 } });
    expect(board[CONTEXT_MENU_IDS.addShortcut]?.visible).toBe(true);
    expect(isDesktopContextActionAllowed('add-shortcut', { kind: 'board', position: { column: 4, row: 6, width: 4, height: 3, gridVersion: 3 } })).toBe(true);

    const widget = nativeMenuState({ kind: 'system-widget', key: 'widget:clock', widgetId: 'clock', sizePreset: 'medium' });
    expect(widget[CONTEXT_MENU_IDS.size]?.visible).toBe(true);
    expect(widget[CONTEXT_MENU_IDS.sizeMedium]?.checked).toBe(true);
    expect(nativeMenuState({ kind: 'system-widget', key: 'widget:search', widgetId: 'search', sizePreset: 'medium' })[CONTEXT_MENU_IDS.size]?.visible).toBe(false);

    expect(nativeMenuState({ kind: 'folder', key: 'folder:full', empty: false })[CONTEXT_MENU_IDS.delete]?.enabled).toBe(false);
    expect(nativeMenuState({ kind: 'folder', key: 'folder:full', empty: false })[CONTEXT_MENU_IDS.addShortcut]?.visible).toBe(true);
    expect(isDesktopContextActionAllowed('delete', { kind: 'folder', key: 'folder:full', empty: false })).toBe(false);
    expect(nativeMenuState({ kind: 'folder', key: 'folder:empty', empty: true })[CONTEXT_MENU_IDS.delete]?.enabled).toBe(true);

    const folderContents = nativeMenuState({ kind: 'folder-contents', groupId: 'work' });
    expect(folderContents[CONTEXT_MENU_IDS.addShortcut]?.visible).toBe(true);
    expect(folderContents[CONTEXT_MENU_IDS.open]?.visible).toBe(false);
    expect(folderContents[CONTEXT_MENU_IDS.rename]?.visible).toBe(false);
    expect(isDesktopContextActionAllowed('add-shortcut', { kind: 'folder-contents', groupId: 'work' })).toBe(true);

    const folderShortcut = nativeMenuState({ kind: 'folder-shortcut', shortcutId: 'docs', groupId: 'work' });
    expect(folderShortcut[CONTEXT_MENU_IDS.edit]?.visible).toBe(true);
    expect(folderShortcut[CONTEXT_MENU_IDS.delete]?.visible).toBe(true);
    expect(folderShortcut[CONTEXT_MENU_IDS.addShortcut]?.visible).toBe(false);
    expect(folderShortcut[CONTEXT_MENU_IDS.center]?.visible).toBe(false);
    expect(isDesktopContextActionAllowed('edit', { kind: 'folder-shortcut', shortcutId: 'docs', groupId: 'work' })).toBe(true);
  });

  it('registers the Isu menu and routes only valid clicks to the matching tab port', async () => {
    registerDesktopContextMenus();
    const installed = vi.mocked(browser.runtime.onInstalled.addListener).mock.calls.at(-1)![0];
    installed({ reason: 'install' } as Browser.runtime.InstalledDetails);
    await vi.waitFor(() => expect(browser.contextMenus.removeAll).toHaveBeenCalled());
    expect(browser.contextMenus.create).toHaveBeenCalledWith(expect.objectContaining({ id: CONTEXT_MENU_IDS.root, title: 'Isu', documentUrlPatterns: ['chrome-extension://test/newtab.html*'] }));
    expect(browser.contextMenus.create).toHaveBeenCalledWith(expect.objectContaining({ id: CONTEXT_MENU_IDS.addShortcut, parentId: CONTEXT_MENU_IDS.root }));

    const messageListeners: Array<(message: DesktopContextPortMessage) => void> = [];
    const disconnectListeners: Array<() => void> = [];
    const port = {
      name: DESKTOP_CONTEXT_PORT,
      sender: { tab: { id: 7 } },
      postMessage: vi.fn(),
      onMessage: { addListener: (listener: (message: DesktopContextPortMessage) => void) => messageListeners.push(listener) },
      onDisconnect: { addListener: (listener: () => void) => disconnectListeners.push(listener) },
    };
    const connected = vi.mocked(browser.runtime.onConnect.addListener).mock.calls.at(-1)![0];
    connected(port as never);
    messageListeners[0]!({ type: 'target', target: { kind: 'shortcut', key: 'shortcut:a' } });

    const clicked = vi.mocked(browser.contextMenus.onClicked.addListener).mock.calls[0]![0];
    clicked({ menuItemId: CONTEXT_MENU_IDS.edit } as Browser.contextMenus.OnClickData, { id: 7 } as Browser.tabs.Tab);
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'action', action: 'edit', target: { kind: 'shortcut', key: 'shortcut:a' } });
    clicked({ menuItemId: CONTEXT_MENU_IDS.rename } as Browser.contextMenus.OnClickData, { id: 7 } as Browser.tabs.Tab);
    expect(port.postMessage).toHaveBeenCalledTimes(1);

    const replacementMessageListeners: Array<(message: DesktopContextPortMessage) => void> = [];
    const replacementPort = {
      name: DESKTOP_CONTEXT_PORT,
      sender: { tab: { id: 7 } },
      postMessage: vi.fn(),
      onMessage: { addListener: (listener: (message: DesktopContextPortMessage) => void) => replacementMessageListeners.push(listener) },
      onDisconnect: { addListener: vi.fn() },
    };
    connected(replacementPort as never);
    disconnectListeners[0]!();
    replacementMessageListeners[0]!({ type: 'target', target: { kind: 'shortcut', key: 'shortcut:b' } });
    clicked({ menuItemId: CONTEXT_MENU_IDS.edit } as Browser.contextMenus.OnClickData, { id: 7 } as Browser.tabs.Tab);
    expect(replacementPort.postMessage).toHaveBeenCalledWith({ type: 'action', action: 'edit', target: { kind: 'shortcut', key: 'shortcut:b' } });
  });

  it('waits for initial menu creation before applying a port target update', async () => {
    let finishInitialCreation: (() => void) | undefined;
    vi.mocked(browser.contextMenus.removeAll).mockImplementationOnce(() => new Promise<void>((resolve) => { finishInitialCreation = resolve; }));
    registerDesktopContextMenus();
    await vi.waitFor(() => expect(browser.contextMenus.removeAll).toHaveBeenCalledTimes(1));

    const messageListeners: Array<(message: DesktopContextPortMessage) => void> = [];
    const port = {
      name: DESKTOP_CONTEXT_PORT,
      sender: { tab: { id: 19 } },
      postMessage: vi.fn(),
      onMessage: { addListener: (listener: (message: DesktopContextPortMessage) => void) => messageListeners.push(listener) },
      onDisconnect: { addListener: vi.fn() },
    };
    const connected = vi.mocked(browser.runtime.onConnect.addListener).mock.calls.at(-1)![0];
    connected(port as never);
    messageListeners[0]!({ type: 'target', target: { kind: 'shortcut', key: 'shortcut:queued' } });
    await Promise.resolve();
    expect(browser.contextMenus.update).not.toHaveBeenCalled();

    finishInitialCreation?.();
    await vi.waitFor(() => expect(browser.contextMenus.create).toHaveBeenCalledWith(expect.objectContaining({ id: CONTEXT_MENU_IDS.root })));
    await vi.waitFor(() => expect(browser.contextMenus.update).toHaveBeenCalledWith(CONTEXT_MENU_IDS.root, { visible: true }));
  });

  it('rebuilds once and retries the target update when a menu item is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    registerDesktopContextMenus();
    await vi.waitFor(() => expect(browser.contextMenus.create).toHaveBeenCalledWith(expect.objectContaining({ id: CONTEXT_MENU_IDS.root })));
    const rootCreationsBeforeRecovery = vi.mocked(browser.contextMenus.create).mock.calls
      .filter(([item]) => item.id === CONTEXT_MENU_IDS.root).length;
    vi.mocked(browser.contextMenus.update).mockRejectedValueOnce(new Error('Cannot find menu item with id isu-root'));

    const messageListeners: Array<(message: DesktopContextPortMessage) => void> = [];
    const port = {
      name: DESKTOP_CONTEXT_PORT,
      sender: { tab: { id: 23 } },
      postMessage: vi.fn(),
      onMessage: { addListener: (listener: (message: DesktopContextPortMessage) => void) => messageListeners.push(listener) },
      onDisconnect: { addListener: vi.fn() },
    };
    const connected = vi.mocked(browser.runtime.onConnect.addListener).mock.calls.at(-1)![0];
    connected(port as never);
    messageListeners[0]!({ type: 'target', target: { kind: 'shortcut', key: 'shortcut:recover' } });

    await vi.waitFor(() => expect(vi.mocked(browser.contextMenus.create).mock.calls
      .filter(([item]) => item.id === CONTEXT_MENU_IDS.root).length).toBe(rootCreationsBeforeRecovery + 1));
    await vi.waitFor(() => expect(browser.contextMenus.update).toHaveBeenCalledWith(CONTEXT_MENU_IDS.root, { visible: true }));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not prevent the browser context menu on the board', () => {
    const config = createInitialConfig({ deviceId: 'test', counter: 0, epoch: 0 });
    config.shortcuts.push({
      id: 'a', groupId: 'default', name: 'A', url: 'https://a.example', sortKey: 'a0',
      revision: { counter: 2, deviceId: 'test' }, position: { column: 0, row: 30, width: 4, height: 3, gridVersion: 3 },
    });
    const onEditShortcut = vi.fn();
    const context = {
      now: new Date(), config, searchPreferences: config.appearance.search.value, searchHistorySource: 'local' as const,
      onAddShortcut: vi.fn(), onAddGroup: vi.fn(), onEditShortcut, onDeleteShortcut: vi.fn(),
      onRenameGroup: vi.fn(), onDeleteGroup: vi.fn(), onMoveShortcut: vi.fn(), onMoveGroup: vi.fn(),
    };
    const { container } = render(<DashboardBoard layout={config.appearance.widgetLayout.value} context={context}
      onDesktopCommit={vi.fn()} onWidgetEnabledChange={vi.fn()} />);
    const board = container.querySelector('.dashboardBoard')!;
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    board.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(container.querySelector('.desktopContextMenu')).toBeNull();
    const port = vi.mocked(browser.runtime.connect).mock.results.at(-1)?.value;
    const actionListener = vi.mocked(port!.onMessage.addListener).mock.calls[0]![0];
    act(() => actionListener({ type: 'action', action: 'edit', target: { kind: 'shortcut', key: 'shortcut:a' } }));
    expect(onEditShortcut).toHaveBeenCalledWith(config.shortcuts[0]);
    fireEvent.pointerMove(document.body);
  });

  it('opens folders and starts shortcuts with the board or folder context', () => {
    const config = createInitialConfig({ deviceId: 'test', counter: 0, epoch: 0 });
    const revision = { counter: 1, deviceId: 'test' };
    config.groups.push({ id: 'work', name: 'Work', collapsed: false, sortKey: 'work', revision, position: { column: 22, row: 4, width: 4, height: 3, gridVersion: 3 } });
    const folderShortcut = { id: 'docs', groupId: 'work', name: 'Docs', url: 'https://example.com/docs', sortKey: 'docs', revision };
    config.shortcuts.push(folderShortcut);
    const folderPiece: Piece = {
      id: 'piece:folder:work', kind: 'folder', payloadRef: 'work', container: { kind: 'desktop' },
      position: { x: -2, y: 4, width: 4, height: 3 }, revision,
    };
    const onAddShortcut = vi.fn();
    const onEditShortcut = vi.fn();
    const onDeleteShortcut = vi.fn().mockResolvedValue(undefined);
    const context = {
      now: new Date(), config, searchPreferences: config.appearance.search.value, searchHistorySource: 'local' as const,
      onAddShortcut, onAddGroup: vi.fn(), onEditShortcut, onDeleteShortcut,
      onRenameGroup: vi.fn(), onDeleteGroup: vi.fn().mockResolvedValue(undefined), onMoveShortcut: vi.fn().mockResolvedValue(undefined), onMoveGroup: vi.fn().mockResolvedValue(undefined),
    };
    render(<PieceBoard pieces={[folderPiece]} context={context} />);
    const port = vi.mocked(browser.runtime.connect).mock.results.at(-1)?.value;
    const actionListener = vi.mocked(port!.onMessage.addListener).mock.calls.at(-1)![0];

    act(() => actionListener({ type: 'action', action: 'add-shortcut', target: { kind: 'board', position: { column: 8, row: 9, width: 4, height: 3, gridVersion: 3 } } }));
    expect(onAddShortcut).toHaveBeenLastCalledWith({ position: { column: 8, row: 9, width: 4, height: 3, gridVersion: 3 } });

    act(() => actionListener({ type: 'action', action: 'add-shortcut', target: { kind: 'folder', key: 'folder:work', empty: true } }));
    expect(onAddShortcut).toHaveBeenLastCalledWith({ groupId: 'work' });

    act(() => actionListener({ type: 'action', action: 'add-shortcut', target: { kind: 'folder-contents', groupId: 'work' } }));
    expect(onAddShortcut).toHaveBeenLastCalledWith({ groupId: 'work' });

    act(() => actionListener({ type: 'action', action: 'edit', target: { kind: 'folder-shortcut', shortcutId: 'docs', groupId: 'work' } }));
    expect(onEditShortcut).toHaveBeenCalledWith(folderShortcut);
    act(() => actionListener({ type: 'action', action: 'delete', target: { kind: 'folder-shortcut', shortcutId: 'docs', groupId: 'work' } }));
    expect(onDeleteShortcut).toHaveBeenCalledWith('docs');
    act(() => actionListener({ type: 'action', action: 'edit', target: { kind: 'folder-shortcut', shortcutId: 'docs', groupId: 'default' } }));
    expect(onEditShortcut).toHaveBeenCalledTimes(1);

    act(() => actionListener({ type: 'action', action: 'open', target: { kind: 'folder', key: 'folder:work', empty: true } }));
    expect(screen.getByRole('dialog', { name: 'Work' })).toBeInTheDocument();
  });

  it('recognizes the entire folder dialog as a folder context without blocking native right-clicks', () => {
    const { container } = render(<FolderDialog
      folder={{ id: 'work', name: 'Work', collapsed: false, sortKey: 'work', revision: { counter: 1, deviceId: 'test' } }}
      shortcuts={[{ id: 'docs', groupId: 'work', name: 'Docs', url: 'https://example.com/docs', sortKey: 'docs', revision: { counter: 1, deviceId: 'test' } }]}
      onClose={vi.fn()}
    />);
    const surface = container.querySelector<HTMLElement>('[data-folder-context-id="work"]')!;
    const member = screen.getByRole('link', { name: 'Docs' });
    expect(targetFromPointer({ target: surface, clientX: 0, clientY: 0 }, null, [])).toEqual({ kind: 'folder-contents', groupId: 'work' });
    expect(targetFromPointer({ target: member, clientX: 0, clientY: 0 }, null, [])).toEqual({ kind: 'folder-shortcut', shortcutId: 'docs', groupId: 'work' });
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    member.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
