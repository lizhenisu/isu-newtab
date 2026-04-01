export type FolderReorderNeighbors = { beforeId?: string; afterId?: string };

export function reorderFolderIds(ids: readonly string[], activeId: string, overId?: string): string[] | undefined {
  if (!overId || activeId === overId) return undefined;
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from < 0 || to < 0) return undefined;
  const reordered = [...ids];
  reordered.splice(from, 1);
  reordered.splice(to, 0, activeId);
  return reordered;
}

/** Returns the persisted neighbours after moving one folder member over another. */
export function folderReorderNeighbors(ids: readonly string[], activeId: string, overId?: string): FolderReorderNeighbors | undefined {
  const reordered = reorderFolderIds(ids, activeId, overId);
  if (!reordered) return undefined;
  const index = reordered.indexOf(activeId);
  return { beforeId: reordered[index - 1], afterId: reordered[index + 1] };
}
