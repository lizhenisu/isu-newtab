import { useDraggable, useDroppable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { useMemo } from 'react';
import { t } from '../../../core/browser/i18n';
import { compareBySortKey } from '../../../core/domain/sort';
import type { Shortcut, ShortcutGroup } from '../../../core/domain/types';
import { faviconUrl } from '../../../core/domain/url';
import { Modal } from './Modal';

type Props = {
  folder: ShortcutGroup;
  shortcuts: Shortcut[];
  onClose(): void;
};

export function FolderDialog({ folder, shortcuts, onClose }: Props) {
  const ordered = useMemo(() => [...shortcuts].sort(compareBySortKey), [shortcuts]);
  return <Modal title={folder.name} onClose={onClose} showCloseButton={false}>
    <div className="folderSurface" data-folder-context-id={folder.id}>
        <p className="folderDragHint">{t('folderDragHint')}</p>
        <div className="folderDialogGrid">
          {ordered.map((shortcut) => <FolderMember key={shortcut.id} shortcut={shortcut} />)}
          {!ordered.length && <p className="emptyFolder">{t('emptyGroup')}</p>}
        </div>
    </div>
  </Modal>;
}

function FolderMember({ shortcut }: { shortcut: Shortcut }) {
  const dragId = `folder-shortcut:${shortcut.id}`;
  const draggable = useDraggable({ id: dragId });
  const droppable = useDroppable({ id: `folder-item:${shortcut.id}` });
  return <article ref={(node) => { draggable.setNodeRef(node); droppable.setNodeRef(node); }} className={`folderDialogItem ${draggable.isDragging ? 'isDragging' : ''}`}
    data-drag-click-key={dragId}
    data-folder-shortcut-id={shortcut.id}
    style={{ transform: CSS.Translate.toString(draggable.transform) }}
    onPointerDown={(event) => draggable.listeners?.onPointerDown?.(event)}>
    <a href={shortcut.url} className="desktopShortcut" aria-label={shortcut.name}>
      <span className="desktopIcon"><img src={faviconUrl(shortcut.url)} alt="" onError={(event) => { event.currentTarget.hidden = true; event.currentTarget.nextElementSibling?.removeAttribute('hidden'); }} /><b hidden>{shortcut.name.slice(0, 1).toUpperCase()}</b></span>
      <span>{shortcut.name}</span>
    </a>
  </article>;
}
