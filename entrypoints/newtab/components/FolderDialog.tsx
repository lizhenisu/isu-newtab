import { SortableContext, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { t } from '../../../core/browser/i18n';
import { compareBySortKey } from '../../../core/domain/sort';
import type { Shortcut, ShortcutGroup } from '../../../core/domain/types';
import { Modal } from './Modal';
import { ShortcutIcon } from './ShortcutIcon';
import type { WaterBubbleKick } from '../water-bubble-motion';

type Props = {
  folder: ShortcutGroup;
  shortcuts: Shortcut[];
  orderedIds?: readonly string[];
  pendingShortcutId?: string;
  dragDisabled?: boolean;
  onClose(): void;
};

export function FolderDialog({ folder, shortcuts, orderedIds, pendingShortcutId, dragDisabled = false, onClose }: Props) {
  const ordered = useMemo(() => {
    const sorted = [...shortcuts].sort(compareBySortKey);
    if (!orderedIds) return sorted;
    const byId = new Map(sorted.map((shortcut) => [shortcut.id, shortcut]));
    return [...orderedIds.flatMap((id) => byId.get(id) ?? []), ...sorted.filter((shortcut) => !orderedIds.includes(shortcut.id))];
  }, [shortcuts, orderedIds]);
  return <Modal title={folder.name} onClose={onClose} showCloseButton={false}>
    <div className="folderSurface liquidGlassSurface" data-folder-context-id={folder.id}>
      <SortableContext items={ordered.map((shortcut) => `folder-shortcut:${shortcut.id}`)} strategy={rectSortingStrategy}>
        <div className="folderDialogGrid">
          {ordered.map((shortcut) => <FolderMember key={shortcut.id} shortcut={shortcut} pendingDesktopDrop={shortcut.id === pendingShortcutId} dragDisabled={dragDisabled} />)}
          {!ordered.length && <p className="emptyFolder">{t('emptyGroup')}</p>}
        </div>
      </SortableContext>
    </div>
  </Modal>;
}

function FolderMember({ shortcut, pendingDesktopDrop, dragDisabled }: { shortcut: Shortcut; pendingDesktopDrop: boolean; dragDisabled: boolean }) {
  const dragId = `folder-shortcut:${shortcut.id}`;
  const sortable = useSortable(dragDisabled ? { id: dragId, disabled: true } : { id: dragId });
  const [iconUnavailable, setIconUnavailable] = useState(false);
  useEffect(() => setIconUnavailable(false), [shortcut.id, shortcut.url]);
  return <article ref={sortable.setNodeRef} className={`folderDialogItem ${sortable.isDragging ? 'isDragging' : ''} ${pendingDesktopDrop ? 'isPendingDesktopDrop' : ''}`}
    data-drag-click-key={dragId}
    data-folder-shortcut-id={shortcut.id}
    style={{ transform: sortable.isDragging ? undefined : CSS.Transform.toString(sortable.transform), transition: sortable.transition }}
    {...sortable.attributes}
    onPointerDown={(event) => { if (!dragDisabled) sortable.listeners?.onPointerDown?.(event); }}>
    <FolderShortcutVisual shortcut={shortcut} iconUnavailable={iconUnavailable} onIconUnavailable={() => setIconUnavailable(true)} onHighResolutionAvailable={() => setIconUnavailable(false)} />
  </article>;
}

export function FolderShortcutOverlay({ shortcut, bubbleKick }: { shortcut: Shortcut; bubbleKick?: WaterBubbleKick }) {
  const [iconUnavailable, setIconUnavailable] = useState(false);
  useEffect(() => setIconUnavailable(false), [shortcut.id, shortcut.url]);
  return <div className="folderDragOverlay" data-folder-drag-overlay data-water-bubble-kick={bubbleKick ? bubbleKick.sequence % 2 === 0 ? 'a' : 'b' : undefined} style={bubbleKick ? { '--water-bubble-kick-x': `${bubbleKick.x}px`, '--water-bubble-kick-y': `${bubbleKick.y}px`, '--water-bubble-rebound-x': `${-bubbleKick.x * .35}px`, '--water-bubble-rebound-y': `${-bubbleKick.y * .35}px`, '--water-bubble-settle-x': `${bubbleKick.x * .12}px`, '--water-bubble-settle-y': `${bubbleKick.y * .12}px` } as CSSProperties : undefined} aria-hidden="true">
    <FolderShortcutVisual shortcut={shortcut} iconUnavailable={iconUnavailable} onIconUnavailable={() => setIconUnavailable(true)} onHighResolutionAvailable={() => setIconUnavailable(false)} />
  </div>;
}

function FolderShortcutVisual({ shortcut, iconUnavailable, onIconUnavailable, onHighResolutionAvailable }: { shortcut: Shortcut; iconUnavailable: boolean; onIconUnavailable(): void; onHighResolutionAvailable(): void }) {
  return <a href={shortcut.url} className="desktopShortcut" aria-label={shortcut.name}>
    <span className="desktopIcon shortcutWaterShell"><ShortcutIcon shortcutId={shortcut.id} url={shortcut.url} onNativeUnavailable={onIconUnavailable} onHighResolutionAvailable={onHighResolutionAvailable} /><b hidden={!iconUnavailable}>{shortcut.name.slice(0, 1).toUpperCase()}</b></span>
    <span>{shortcut.name}</span>
  </a>;
}
