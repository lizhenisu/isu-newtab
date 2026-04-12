import { useEffect, useRef, useState } from 'react';
import { nativeShortcutIconUrl } from '../../../core/domain/shortcut-icons';
import { useCachedShortcutIcon } from './ShortcutIconCache';
import { loadShortcutIcon } from './shortcut-icon-loader';

type Props = {
  shortcutId: string;
  url: string;
  alt?: string;
  className?: string;
  onNativeUnavailable?: () => void;
  onHighResolutionAvailable?: () => void;
};

type Visual = { src: string; owned: boolean };

/** Shows a local high-resolution cache on startup; only uncached shortcuts use the remote refresh chain. */
export function ShortcutIcon({ shortcutId, url, alt = '', className, onNativeUnavailable, onHighResolutionAvailable }: Props) {
  const cachedUrl = useCachedShortcutIcon(shortcutId);
  const [visual, setVisual] = useState<Visual>(() => ({ src: cachedUrl ?? nativeShortcutIconUrl(url), owned: false }));
  const [incoming, setIncoming] = useState<Visual>();
  const visualRef = useRef(visual);
  const incomingRef = useRef(incoming);
  const highResolutionCallbackRef = useRef(onHighResolutionAvailable);
  visualRef.current = visual;
  incomingRef.current = incoming;
  highResolutionCallbackRef.current = onHighResolutionAvailable;

  useEffect(() => {
    let disposed = false;
    const ownedUrls = new Set<string>();
    const release = (item?: Visual) => {
      if (item?.owned) {
        URL.revokeObjectURL(item.src);
        ownedUrls.delete(item.src);
      }
    };

    release(visualRef.current);
    release(incomingRef.current);
    if (cachedUrl) {
      if (visualRef.current.src === cachedUrl) {
        setIncoming(undefined);
        setVisual({ src: cachedUrl, owned: false });
      } else {
        highResolutionCallbackRef.current?.();
        setIncoming({ src: cachedUrl, owned: false });
      }
      return () => { disposed = true; };
    }
    setIncoming(undefined);
    setVisual({ src: nativeShortcutIconUrl(url), owned: false });

    void loadShortcutIcon(shortcutId, url).then(({ blob }) => {
      if (disposed) return;
      const next = { src: URL.createObjectURL(blob), owned: true };
      ownedUrls.add(next.src);
      highResolutionCallbackRef.current?.();
      setIncoming(next);
    }).catch(() => {
      // Providers are best-effort; the local favicon or initial remains visible.
    });

    return () => {
      disposed = true;
      release(visualRef.current);
      release(incomingRef.current);
      for (const ownedUrl of ownedUrls) URL.revokeObjectURL(ownedUrl);
    };
  }, [cachedUrl, shortcutId, url]);

  const promoteIncoming = () => {
    if (!incoming) return;
    const previous = visualRef.current;
    setVisual(incoming);
    setIncoming(undefined);
    if (previous.owned) URL.revokeObjectURL(previous.src);
  };

  return <span className="shortcutIconMedia">
    <img className={className} src={visual.src} alt={alt} referrerPolicy="no-referrer" onError={() => onNativeUnavailable?.()} />
    {incoming && <img className={`${className ?? ''} shortcutIconMedia--incoming`} src={incoming.src} alt="" onAnimationEnd={promoteIncoming} />}
  </span>;
}
