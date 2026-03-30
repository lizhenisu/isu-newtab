export type FolderDropRect = Pick<DOMRectReadOnly, 'left' | 'top' | 'width' | 'height'>;

/** Returns whether the dragged piece's center is within the visible folder preview. */
export function isDraggedPieceCenterWithinFolder(initial: FolderDropRect, delta: { x: number; y: number }, folderPreview: FolderDropRect): boolean {
  const centerX = initial.left + delta.x + initial.width / 2;
  const centerY = initial.top + delta.y + initial.height / 2;
  return centerX >= folderPreview.left && centerX <= folderPreview.left + folderPreview.width
    && centerY >= folderPreview.top && centerY <= folderPreview.top + folderPreview.height;
}
