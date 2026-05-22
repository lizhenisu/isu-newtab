import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { t } from '../../../core/browser/i18n';
import type { Shortcut, ShortcutGroup, ShortcutInput } from '../../../core/domain/types';
import { validateShortcutIconBlob } from '../../../core/domain/shortcut-icons';
import { CloseIcon } from './CloseIcon';
import { Modal } from './Modal';
import { PlusIcon } from './PlusIcon';

type Props = {
  shortcut?: Shortcut;
  groups: ShortcutGroup[];
  defaultGroupId: string;
  onSave(input: ShortcutInput, iconFile?: File): Promise<void>;
  onClose(): void;
};

export function ShortcutEditor({ shortcut, groups, defaultGroupId, onSave, onClose }: Props) {
  const [name, setName] = useState(shortcut?.name ?? '');
  const [url, setUrl] = useState(shortcut?.url ?? '');
  const [groupId, setGroupId] = useState(shortcut?.groupId ?? defaultGroupId);
  const [iconFile, setIconFile] = useState<File>();
  const [error, setError] = useState('');
  const [iconValidationError, setIconValidationError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [iconPreview, setIconPreview] = useState<string>();

  useEffect(() => {
    if (!iconFile) {
      setIconPreview(undefined);
      return;
    }
    const preview = URL.createObjectURL(iconFile);
    setIconPreview(preview);
    return () => URL.revokeObjectURL(preview);
  }, [iconFile]);

  const selectIcon = () => inputRef.current?.click();
  const clearIcon = () => {
    setIconFile(undefined);
    setError('');
    setIconValidationError(false);
    if (inputRef.current) inputRef.current.value = '';
  };

  const selectIconFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      await validateShortcutIconBlob(file);
      setIconFile(file);
      setError('');
      setIconValidationError(false);
    } catch (reason) {
      setIconFile(undefined);
      setError(iconValidationMessage(reason));
      setIconValidationError(true);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (iconValidationError) return;
    try {
      const input = { name, url, groupId };
      if (iconFile) await onSave(input, iconFile);
      else await onSave(input);
      onClose();
    } catch (reason) {
      setIconValidationError(false);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <Modal title={shortcut ? t('edit') : t('addShortcut')} onClose={onClose} variant="editor">
      <form className="form shortcutEditorForm" onSubmit={submit}>
        <label>{t('name')}<input required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} autoFocus /></label>
        <label>{t('url')}<input required inputMode="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com" /></label>
        <div className="shortcutIconPicker">
          <span className="shortcutIconPicker__label">{t('shortcutIconUpload')}</span>
          <input ref={inputRef} type="file" aria-label={t('shortcutIconChoose')} accept="image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon,image/vnd.microsoft.icon" hidden onChange={selectIconFile} />
          {iconFile && iconPreview
            ? <div className="shortcutIconPicker__selection">
                <img src={iconPreview} alt="" />
                <span className="shortcutIconPicker__fileName" title={iconFile.name}>{iconFile.name}</span>
                <button type="button" className="shortcutIconPicker__action" onClick={selectIcon}>{t('shortcutIconChange')}</button>
                <button type="button" className="shortcutIconPicker__clear" aria-label={t('shortcutIconClear')} onClick={clearIcon}><CloseIcon /></button>
              </div>
            : <button type="button" className="shortcutIconPicker__empty" onClick={selectIcon}><PlusIcon className="shortcutIconPicker__plus" />{t('shortcutIconChoose')}</button>}
        </div>
        <label>{t('group')}<select value={groupId} onChange={(event) => setGroupId(event.target.value)}>{groups.map((group) => <option key={group.id} value={group.id}>{group.id === 'default' && ['Default', '默认分组'].includes(group.name) ? t('defaultGroup') : group.name}</option>)}</select></label>
        {error && <p className="errorText" role="alert">{error}</p>}
        <footer className="formActions"><button type="button" className="secondary" onClick={onClose}>{t('cancel')}</button><button type="submit">{t('save')}</button></footer>
      </form>
    </Modal>
  );
}

function iconValidationMessage(reason: unknown): string {
  if (reason instanceof Error && ['ICON_UNSUPPORTED_FORMAT', 'ICON_TOO_LARGE', 'ICON_TOO_SMALL'].includes(reason.message)) return t('shortcutIconInvalid');
  return reason instanceof Error ? reason.message : String(reason);
}
