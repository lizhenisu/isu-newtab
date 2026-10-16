import type { BrowserTarget } from '../browser/browser-target';
import type { SyncMode } from '../domain/types';
import type { SyncRepository } from '../storage/ports';

export const EDGE_GOOGLE_DRIVE_FALLBACK_NOTICE_KEY = 'syncProviderCompatibilityNotice';

const CHROME_SYNC_MODES = ['chrome', 'google-drive', 'local'] as const satisfies readonly SyncMode[];
const EDGE_SYNC_MODES = ['chrome', 'local'] as const satisfies readonly SyncMode[];

/** Returns only the sync providers that can operate in the target browser. */
export function supportedSyncModes(target: BrowserTarget): readonly SyncMode[] {
  return target === 'edge' ? EDGE_SYNC_MODES : CHROME_SYNC_MODES;
}

/** Keeps legacy values readable while preventing an unsupported provider from running. */
export function normalizeSyncModeForTarget(mode: SyncMode, target: BrowserTarget): SyncMode {
  return supportedSyncModes(target).includes(mode) ? mode : 'local';
}

export async function normalizeStoredSyncModeForTarget(
  repository: Pick<SyncRepository, 'getSyncMode' | 'setSyncMode'>,
  target: BrowserTarget,
): Promise<{ previous: SyncMode; current: SyncMode; changed: boolean }> {
  const previous = await repository.getSyncMode();
  const current = normalizeSyncModeForTarget(previous, target);
  if (current !== previous) await repository.setSyncMode(current);
  return { previous, current, changed: current !== previous };
}
