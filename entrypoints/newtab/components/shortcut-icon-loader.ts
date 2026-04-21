import { SHORTCUT_ICON_MAX_BYTES, shortcutIconSources, validateShortcutIconBlob } from '../../../core/domain/shortcut-icons';
import { appRepositories } from '../../../core/storage/repository';

export type LoadedShortcutIcon = {
  blob: Blob;
  sourceUrl: string;
};

const resolvedLoads = new Map<string, LoadedShortcutIcon>();
const inFlightLoads = new Map<string, Promise<LoadedShortcutIcon>>();
const latestLoadByShortcut = new Map<string, string>();

function loadKey(shortcutId: string, url: string): string {
  return `${shortcutId}\u0000${url}`;
}

/**
 * Shares one remote favicon request across every visual instance of a shortcut.
 * Folder previews and drag overlays can mount independently, so the cache must
 * live outside React component lifetimes.
 */
export function loadShortcutIcon(shortcutId: string, url: string): Promise<LoadedShortcutIcon> {
  const key = loadKey(shortcutId, url);
  latestLoadByShortcut.set(shortcutId, key);

  const resolved = resolvedLoads.get(key);
  if (resolved) return Promise.resolve(resolved);
  const inFlight = inFlightLoads.get(key);
  if (inFlight) return inFlight;

  const task = (async () => {
    for (const source of shortcutIconSources(url)) {
      try {
        const blob = await fetchAndValidateIcon(source.url, source.timeoutMs);
        const result = { blob, sourceUrl: source.url };
        // A shortcut may have been edited while this request was in flight.
        // Never persist an icon that no longer belongs to the current URL.
        if (latestLoadByShortcut.get(shortcutId) === key) {
          await appRepositories.assets.putShortcutIcon(shortcutId, blob, source.url);
        }
        return result;
      } catch {
        // Providers are best-effort; continue with the next fallback source.
      }
    }
    throw new Error('ICON_FETCH_FAILED');
  })();

  inFlightLoads.set(key, task);
  void task.then(
    (result) => {
      resolvedLoads.set(key, result);
      if (inFlightLoads.get(key) === task) inFlightLoads.delete(key);
    },
    () => {
      if (inFlightLoads.get(key) === task) inFlightLoads.delete(key);
    },
  );
  return task;
}

/** Clears a session result after a locally uploaded/replaced icon. */
export function clearLoadedShortcutIcon(shortcutId: string, url?: string): void {
  for (const key of resolvedLoads.keys()) {
    if (key.startsWith(`${shortcutId}\u0000`) && (!url || key === loadKey(shortcutId, url))) resolvedLoads.delete(key);
  }
  const latest = latestLoadByShortcut.get(shortcutId);
  if (!url || latest === loadKey(shortcutId, url)) latestLoadByShortcut.delete(shortcutId);
}

async function fetchAndValidateIcon(url: string, timeoutMs: number): Promise<Blob> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error(`ICON_HTTP_${response.status}`);
    const blob = await response.blob();
    if (!blob.type.startsWith('image/') || blob.size > SHORTCUT_ICON_MAX_BYTES) throw new Error('ICON_INVALID_RESPONSE');
    await validateShortcutIconBlob(blob);
    return blob;
  } finally {
    window.clearTimeout(timeout);
  }
}
