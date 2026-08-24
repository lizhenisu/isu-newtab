import type { SystemWidgetId, WidgetPosition, WidgetSizePreset } from '../domain/widgets';

export const DESKTOP_CONTEXT_PORT = 'isu-desktop-context-menu';

export const CONTEXT_MENU_IDS = {
  root: 'isu-root',
  newFolder: 'isu-new-folder',
  addShortcut: 'isu-add-shortcut',
  open: 'isu-open',
  edit: 'isu-edit',
  rename: 'isu-rename',
  delete: 'isu-delete',
  hide: 'isu-hide',
  center: 'isu-center',
  size: 'isu-size',
  sizeSmall: 'isu-size-small',
  sizeMedium: 'isu-size-medium',
  sizeLarge: 'isu-size-large',
} as const;

export type DesktopContextAction =
  | 'new-folder'
  | 'add-shortcut'
  | 'open'
  | 'edit'
  | 'rename'
  | 'delete'
  | 'hide'
  | 'center'
  | 'size-small'
  | 'size-medium'
  | 'size-large';

export type DesktopContextTarget =
  | { kind: 'none' }
  | { kind: 'board'; position: WidgetPosition }
  | { kind: 'shortcut'; key: string }
  | { kind: 'folder'; key: string; empty: boolean }
  | { kind: 'folder-contents'; groupId: string }
  | { kind: 'folder-shortcut'; shortcutId: string; groupId: string }
  | { kind: 'system-widget'; key: string; widgetId: SystemWidgetId; sizePreset: WidgetSizePreset }
  | { kind: 'add-shortcut'; key: 'add-shortcut' };

export type DesktopContextPortMessage =
  | { type: 'target'; target: DesktopContextTarget }
  | { type: 'action'; action: DesktopContextAction; target: DesktopContextTarget };

export const ACTION_BY_MENU_ID: Readonly<Record<string, DesktopContextAction>> = {
  [CONTEXT_MENU_IDS.newFolder]: 'new-folder',
  [CONTEXT_MENU_IDS.addShortcut]: 'add-shortcut',
  [CONTEXT_MENU_IDS.open]: 'open',
  [CONTEXT_MENU_IDS.edit]: 'edit',
  [CONTEXT_MENU_IDS.rename]: 'rename',
  [CONTEXT_MENU_IDS.delete]: 'delete',
  [CONTEXT_MENU_IDS.hide]: 'hide',
  [CONTEXT_MENU_IDS.center]: 'center',
  [CONTEXT_MENU_IDS.sizeSmall]: 'size-small',
  [CONTEXT_MENU_IDS.sizeMedium]: 'size-medium',
  [CONTEXT_MENU_IDS.sizeLarge]: 'size-large',
};

export type NativeMenuItemState = { visible: boolean; checked?: boolean; enabled?: boolean };

export function nativeMenuState(target: DesktopContextTarget): Record<string, NativeMenuItemState> {
  const isSystemWidget = target.kind === 'system-widget';
  const isFolderShortcut = target.kind === 'folder-shortcut';
  const hasSizes = isSystemWidget && target.widgetId !== 'search';
  return {
    [CONTEXT_MENU_IDS.root]: { visible: target.kind !== 'none' },
    [CONTEXT_MENU_IDS.newFolder]: { visible: target.kind === 'board' },
    [CONTEXT_MENU_IDS.addShortcut]: { visible: target.kind === 'board' || target.kind === 'folder' || target.kind === 'folder-contents' },
    [CONTEXT_MENU_IDS.open]: { visible: target.kind === 'folder' },
    [CONTEXT_MENU_IDS.edit]: { visible: target.kind === 'shortcut' || isFolderShortcut },
    [CONTEXT_MENU_IDS.rename]: { visible: target.kind === 'folder' },
    [CONTEXT_MENU_IDS.delete]: { visible: target.kind === 'shortcut' || isFolderShortcut || target.kind === 'folder', enabled: target.kind !== 'folder' || target.empty },
    [CONTEXT_MENU_IDS.hide]: { visible: isSystemWidget },
    [CONTEXT_MENU_IDS.center]: { visible: target.kind !== 'none' && target.kind !== 'board' && target.kind !== 'folder-contents' && !isFolderShortcut },
    [CONTEXT_MENU_IDS.size]: { visible: hasSizes },
    [CONTEXT_MENU_IDS.sizeSmall]: { visible: hasSizes, checked: hasSizes && target.sizePreset === 'small' },
    [CONTEXT_MENU_IDS.sizeMedium]: { visible: hasSizes, checked: hasSizes && target.sizePreset === 'medium' },
    [CONTEXT_MENU_IDS.sizeLarge]: { visible: hasSizes, checked: hasSizes && target.sizePreset === 'large' },
  };
}

export function isDesktopContextActionAllowed(action: DesktopContextAction, target: DesktopContextTarget): boolean {
  if (action === 'new-folder') return target.kind === 'board';
  if (action === 'add-shortcut') return target.kind === 'board' || target.kind === 'folder' || target.kind === 'folder-contents';
  if (action === 'open' || action === 'rename') return target.kind === 'folder';
  if (action === 'edit') return target.kind === 'shortcut' || target.kind === 'folder-shortcut';
  if (action === 'delete') return target.kind === 'shortcut' || target.kind === 'folder-shortcut' || (target.kind === 'folder' && target.empty);
  if (action === 'hide') return target.kind === 'system-widget';
  if (action === 'center') return target.kind !== 'none' && target.kind !== 'board';
  return target.kind === 'system-widget' && target.widgetId !== 'search';
}

export function contextTargetSignature(target: DesktopContextTarget): string {
  if (target.kind === 'none' || target.kind === 'board') return target.kind;
  if (target.kind === 'folder-contents') return `${target.kind}:${target.groupId}`;
  if (target.kind === 'folder-shortcut') return `${target.kind}:${target.groupId}:${target.shortcutId}`;
  if (target.kind === 'system-widget') return `${target.kind}:${target.key}:${target.sizePreset}`;
  return target.kind === 'folder' ? `${target.kind}:${target.key}:${target.empty}` : `${target.kind}:${target.key}`;
}
