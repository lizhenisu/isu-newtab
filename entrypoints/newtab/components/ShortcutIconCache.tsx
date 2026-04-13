import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { appRepositories } from '../../../core/storage/repository';

const ShortcutIconCacheContext = createContext<ReadonlyMap<string, string>>(new Map());

type CacheState = { ready: boolean; urls: ReadonlyMap<string, string> };
export type ShortcutIconRefresh = { shortcutId: string; version: number };

/** Loads cache entries before first render, then replaces only explicitly refreshed icon IDs. */
export function useShortcutIconCache(shortcutIds: readonly string[], refresh?: ShortcutIconRefresh): CacheState {
  const idsKey = useMemo(() => [...shortcutIds].sort().join('\u0000'), [shortcutIds]);
  const urlsRef = useRef(new Map<string, string>());
  const requestVersion = useRef(0);
  const releaseTimers = useRef(new Set<number>());
  const [state, setState] = useState<CacheState>({ ready: false, urls: urlsRef.current });

  const retireUrl = (url: string) => {
    const timer = window.setTimeout(() => {
      URL.revokeObjectURL(url);
      releaseTimers.current.delete(timer);
    }, 2_100);
    releaseTimers.current.add(timer);
  };

  useEffect(() => {
    let active = true;
    const version = ++requestVersion.current;
    const ids = idsKey ? idsKey.split('\u0000') : [];
    void appRepositories.assets.getShortcutIcons(ids).then((blobs) => {
      if (!active || version !== requestVersion.current) return;
      const next = new Map<string, string>();
      for (const [id, blob] of blobs) next.set(id, urlsRef.current.get(id) ?? URL.createObjectURL(blob));
      for (const [id, cachedUrl] of urlsRef.current) {
        if (!next.has(id)) retireUrl(cachedUrl);
      }
      urlsRef.current = next;
      setState({ ready: true, urls: next });
    });
    return () => { active = false; };
  }, [idsKey]);

  useEffect(() => {
    if (!refresh) return;
    let active = true;
    const version = ++requestVersion.current;
    void appRepositories.assets.getShortcutIcon(refresh.shortcutId).then((blob) => {
      if (!active || version !== requestVersion.current) return;
      const next = new Map(urlsRef.current);
      const previous = next.get(refresh.shortcutId);
      if (blob) next.set(refresh.shortcutId, URL.createObjectURL(blob));
      else next.delete(refresh.shortcutId);
      urlsRef.current = next;
      setState({ ready: true, urls: next });
      if (previous) retireUrl(previous);
    });
    return () => { active = false; };
  }, [refresh?.version]);

  useEffect(() => () => {
    for (const timer of releaseTimers.current) window.clearTimeout(timer);
    for (const cachedUrl of urlsRef.current.values()) URL.revokeObjectURL(cachedUrl);
    urlsRef.current.clear();
  }, []);

  return state;
}

export function ShortcutIconCacheProvider({ urls, children }: { urls: ReadonlyMap<string, string>; children: ReactNode }) {
  return <ShortcutIconCacheContext.Provider value={urls}>{children}</ShortcutIconCacheContext.Provider>;
}

export function useCachedShortcutIcon(shortcutId: string): string | undefined {
  return useContext(ShortcutIconCacheContext).get(shortcutId);
}
