type Props = { className?: string };

/** Shared decorative add icon so visual plus controls never depend on glyph rendering. */
export function PlusIcon({ className }: Props) {
  return <svg className={className} viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>;
}
