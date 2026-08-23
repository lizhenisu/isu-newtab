import { act, cleanup, fireEvent, render } from '@testing-library/react';
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

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('native desktop context menu', () => {
  it('maps desktop target kinds to only their valid native commands', () => {
    const shortcut = nativeMenuState({ kind: 'shortcut', key: 'shortcut:a' });
    expect(shortcut[CONTEXT_MENU_IDS.edit]?.visible).toBe(true);
    expect(shortcut[CONTEXT_MENU_IDS.delete]?.visible).toBe(true);
    expect(shortcut[CONTEXT_MENU_IDS.newFolder]?.visible).toBe(false);
    expect(isDesktopContextActionAllowed('rename', { kind: 'shortcut', key: 'shortcut:a' })).toBe(false);

    const widget = nativeMenuState({ kind: 'system-widget', key: 'widget:clock', widgetId: 'clock', sizePreset: 'medium' });
    expect(widget[CONTEXT_MENU_IDS.size]?.visible).toBe(true);
    expect(widget[CONTEXT_MENU_IDS.sizeMedium]?.checked).toBe(true);
    expect(nativeMenuState({ kind: 'system-widget', key: 'widget:search', widgetId: 'search', sizePreset: 'medium' })[CONTEXT_MENU_IDS.size]?.visible).toBe(false);

    expect(nativeMenuState({ kind: 'folder', key: 'folder:full', empty: false })[CONTEXT_MENU_IDS.delete]?.enabled).toBe(false);
    expect(isDesktopContextActionAllowed('delete', { kind: 'folder', key: 'folder:full', empty: false })).toBe(false);
    expect(nativeMenuState({ kind: 'folder', key: 'folder:empty', empty: true })[CONTEXT_MENU_IDS.delete]?.enabled).toBe(true);
  });

  it('registers the Isu menu and routes only valid clicks to the matching tab port', async () => {
    registerDesktopContextMenus();
    const installed = vi.mocked(browser.runtime.onInstalled.addListener).mock.calls[0]![0];
    installed({ reason: 'install' } as Browser.runtime.InstalledDetails);
    await vi.waitFor(() => expect(browser.contextMenus.removeAll).toHaveBeenCalled());
    expect(browser.contextMenus.create).toHaveBeenCalledWith(expect.objectContaining({ id: CONTEXT_MENU_IDS.root, title: 'Isu', documentUrlPatterns: ['chrome-extension://test/newtab.html*'] }));

    const messageListeners: Array<(message: DesktopContextPortMessage) => void> = [];
    const disconnectListeners: Array<() => void> = [];
    const port = {
      name: DESKTOP_CONTEXT_PORT,
      sender: { tab: { id: 7 } },
      postMessage: vi.fn(),
      onMessage: { addListener: (listener: (message: DesktopContextPortMessage) => void) => messageListeners.push(listener) },
      onDisconnect: { addListener: (listener: () => void) => disconnectListeners.push(listener) },
    };
    const connected = vi.mocked(browser.runtime.onConnect.addListener).mock.calls[0]![0];
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
});
