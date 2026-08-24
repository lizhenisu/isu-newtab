import { browser } from 'wxt/browser';
import { t } from './i18n';
import {
  ACTION_BY_MENU_ID,
  CONTEXT_MENU_IDS,
  DESKTOP_CONTEXT_PORT,
  isDesktopContextActionAllowed,
  nativeMenuState,
  type DesktopContextPortMessage,
  type DesktopContextTarget,
  type NativeMenuItemState,
} from './native-context-menu';

type RuntimePort = ReturnType<typeof browser.runtime.connect>;

const ports = new Map<number, RuntimePort>();
const targets = new Map<number, DesktopContextTarget>();
let menuLifecycleQueue = Promise.resolve();

export function registerDesktopContextMenus(): void {
  void refreshDesktopContextMenus();
  browser.runtime.onInstalled.addListener(() => { void refreshDesktopContextMenus(); });
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== DESKTOP_CONTEXT_PORT || port.sender?.tab?.id === undefined) return;
    const tabId = port.sender.tab.id;
    ports.set(tabId, port);
    targets.set(tabId, { kind: 'none' });
    port.onMessage.addListener((message: DesktopContextPortMessage) => {
      if (message.type !== 'target') return;
      targets.set(tabId, message.target);
      queueDesktopContextMenuUpdate(message.target);
    });
    port.onDisconnect.addListener(() => {
      if (ports.get(tabId) !== port) return;
      ports.delete(tabId);
      targets.delete(tabId);
    });
  });
  browser.contextMenus.onClicked.addListener((info, tab) => {
    const action = ACTION_BY_MENU_ID[String(info.menuItemId)];
    const tabId = tab?.id;
    if (!action || tabId === undefined) return;
    const target = targets.get(tabId);
    if (!target || !isDesktopContextActionAllowed(action, target)) return;
    ports.get(tabId)?.postMessage({ type: 'action', action, target } satisfies DesktopContextPortMessage);
  });
}

export async function refreshDesktopContextMenus(): Promise<void> {
  await queueMenuLifecycle(() => createDesktopContextMenus());
}

async function createDesktopContextMenus(): Promise<void> {
  await browser.contextMenus.removeAll();
  const documentUrlPatterns = [`${browser.runtime.getURL('/newtab.html')}*`];
  const common = { contexts: ['all'] as ['all'], documentUrlPatterns, visible: false };
  browser.contextMenus.create({ id: CONTEXT_MENU_IDS.root, title: 'Isu', ...common });
  browser.contextMenus.create({ id: CONTEXT_MENU_IDS.newFolder, parentId: CONTEXT_MENU_IDS.root, title: t('newFolder'), ...common });
  browser.contextMenus.create({ id: CONTEXT_MENU_IDS.addShortcut, parentId: CONTEXT_MENU_IDS.root, title: t('addShortcut'), ...common });
  browser.contextMenus.create({ id: CONTEXT_MENU_IDS.open, parentId: CONTEXT_MENU_IDS.root, title: t('open'), ...common });
  browser.contextMenus.create({ id: CONTEXT_MENU_IDS.edit, parentId: CONTEXT_MENU_IDS.root, title: t('edit'), ...common });
  browser.contextMenus.create({ id: CONTEXT_MENU_IDS.rename, parentId: CONTEXT_MENU_IDS.root, title: t('rename'), ...common });
  browser.contextMenus.create({ id: CONTEXT_MENU_IDS.delete, parentId: CONTEXT_MENU_IDS.root, title: t('delete'), ...common });
  browser.contextMenus.create({ id: CONTEXT_MENU_IDS.hide, parentId: CONTEXT_MENU_IDS.root, title: t('hide'), ...common });
  browser.contextMenus.create({ id: CONTEXT_MENU_IDS.size, parentId: CONTEXT_MENU_IDS.root, title: t('cardSize'), ...common });
  browser.contextMenus.create({ id: CONTEXT_MENU_IDS.sizeSmall, parentId: CONTEXT_MENU_IDS.size, type: 'radio', title: t('small'), ...common });
  browser.contextMenus.create({ id: CONTEXT_MENU_IDS.sizeMedium, parentId: CONTEXT_MENU_IDS.size, type: 'radio', title: t('medium'), ...common });
  browser.contextMenus.create({ id: CONTEXT_MENU_IDS.sizeLarge, parentId: CONTEXT_MENU_IDS.size, type: 'radio', title: t('large'), ...common });
  browser.contextMenus.create({ id: CONTEXT_MENU_IDS.center, parentId: CONTEXT_MENU_IDS.root, title: t('centerHorizontally'), ...common });
}

function queueDesktopContextMenuUpdate(target: DesktopContextTarget): void {
  void queueMenuLifecycle(() => updateDesktopContextMenus(target));
}

async function updateDesktopContextMenus(target: DesktopContextTarget): Promise<void> {
  const entries = Object.entries(nativeMenuState(target));
  try {
    await updateMenuEntries(entries);
  } catch (error) {
    if (!isMissingMenuItemError(error)) throw error;
    await createDesktopContextMenus();
    await updateMenuEntries(entries);
  }
}

function updateMenuEntries(entries: Array<[string, NativeMenuItemState]>): Promise<void> {
  return Promise.all(entries.map(([id, state]) => browser.contextMenus.update(id, state))).then(() => undefined);
}

function queueMenuLifecycle(operation: () => Promise<void>): Promise<void> {
  menuLifecycleQueue = menuLifecycleQueue
    .catch((error) => reportMenuError('previous menu operation', error))
    .then(operation)
    .catch((error) => reportMenuError('menu operation', error));
  return menuLifecycleQueue;
}

function isMissingMenuItemError(error: unknown): boolean {
  return /cannot find menu item/i.test(error instanceof Error ? error.message : String(error));
}

function reportMenuError(operation: string, error: unknown): void {
  console.warn(`Isu ${operation} failed.`, error);
}
