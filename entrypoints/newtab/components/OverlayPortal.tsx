import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

/** Renders transient UI outside the board's clipping and stacking contexts. */
export function OverlayPortal({ children, className }: { children: ReactNode; className: string }): ReactNode {
  if (typeof document === 'undefined') return null;
  return createPortal(<div className={className}>{children}</div>, document.body);
}
