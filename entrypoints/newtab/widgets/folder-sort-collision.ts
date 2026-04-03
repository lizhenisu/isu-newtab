type RectLike = Pick<DOMRectReadOnly, 'left' | 'top' | 'width' | 'height'>;

type Translate = { x: number; y: number };

export function isFolderShortcutDrag(id: unknown): boolean {
  return String(id).startsWith('folder-shortcut:');
}

export function isPointerInsideFolderSurface(pointer: { x: number; y: number } | null, surface?: RectLike): boolean {
  return Boolean(pointer && surface
    && pointer.x >= surface.left && pointer.x <= surface.left + surface.width
    && pointer.y >= surface.top && pointer.y <= surface.top + surface.height);
}

/** `closestCenter` keeps a sortable target in blank grid space; only card overlap is a reorder drop. */
export function isDraggedCenterWithinFolderMember(initial: RectLike | null, delta: Translate, member?: RectLike | null): boolean {
  if (!initial || !member) return false;
  const centerX = initial.left + delta.x + initial.width / 2;
  const centerY = initial.top + delta.y + initial.height / 2;
  return centerX >= member.left && centerX <= member.left + member.width
    && centerY >= member.top && centerY <= member.top + member.height;
}

export function folderSortableContainers<T extends { id: unknown }>(containers: readonly T[]): T[] {
  return containers.filter((container) => isFolderShortcutDrag(container.id));
}
