import { DEFAULT_GROUP_ID, type AppConfig } from '../domain/types';
import { buildDesktopSnapshot, desktopLayoutFingerprint, desktopPlacements, type DesktopPlacement } from '../domain/desktop';
import type { WidgetPosition } from '../domain/widgets';
import { executePieceDesktopCommand } from './piece-desktop-adapter';
import { compareBySortKey } from '../domain/sort';
import { generateKeyBetween } from 'fractional-indexing';

/** A layout result calculated from the snapshot after a folder member joins the desktop. */
export type FolderShortcutDesktopDropPlan = {
  kind: 'folder-shortcut-desktop-drop';
  postTransitionLayoutFingerprint: string;
  placements: DesktopPlacement[];
  sortKey: string;
};

/**
 * Plans a folder-member desktop drop without mutating the stored configuration.
 * The repository validates this post-transition snapshot before using it.
 */
export function planFolderShortcutDesktopDrop(config: AppConfig, shortcutId: string, target: WidgetPosition, beforeId?: string, afterId?: string): FolderShortcutDesktopDropPlan {
  const nextConfig = structuredClone(config);
  const shortcut = nextConfig.shortcuts.find((item) => item.id === shortcutId);
  if (!shortcut) throw new Error('SHORTCUT_NOT_FOUND');
  const destination = nextConfig.shortcuts.filter((item) => item.id !== shortcutId && item.groupId === DEFAULT_GROUP_ID).sort(compareBySortKey);
  const append = !beforeId && !afterId;
  const before = beforeId ? nextConfig.shortcuts.find((item) => item.id === beforeId)?.sortKey ?? null : append ? destination.at(-1)?.sortKey ?? null : null;
  const after = afterId ? nextConfig.shortcuts.find((item) => item.id === afterId)?.sortKey ?? null : null;
  shortcut.groupId = DEFAULT_GROUP_ID;
  shortcut.position = target;
  shortcut.sortKey = generateKeyBetween(before, after);
  const snapshot = buildDesktopSnapshot(nextConfig);
  const result = executePieceDesktopCommand(snapshot, { type: 'move', key: `shortcut:${shortcutId}`, target });
  return {
    kind: 'folder-shortcut-desktop-drop',
    postTransitionLayoutFingerprint: desktopLayoutFingerprint(snapshot.nodes),
    placements: desktopPlacements(result.items),
    sortKey: shortcut.sortKey,
  };
}
