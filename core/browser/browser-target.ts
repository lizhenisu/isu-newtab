export type BrowserTarget = 'chrome' | 'edge';

/** The browser target is fixed by WXT at build time, never inferred from the user agent. */
export function currentBrowserTarget(): BrowserTarget {
  return import.meta.env.EDGE ? 'edge' : 'chrome';
}

export function isEdgeTarget(target: BrowserTarget = currentBrowserTarget()): boolean {
  return target === 'edge';
}
