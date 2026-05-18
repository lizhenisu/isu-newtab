import type { PropsWithChildren } from 'react';
import { t } from '../../../core/browser/i18n';
import { useAppStore } from '../../../core/state/store';
import { CloseIcon } from './CloseIcon';

type ModalProps = PropsWithChildren<{
  title: string;
  onClose(): void;
  variant?: 'center' | 'drawer' | 'editor';
  showCloseButton?: boolean;
}>;

export function Modal({ title, onClose, children, variant = 'center', showCloseButton = true }: ModalProps) {
  const theme = useAppStore((state) => state.config?.appearance.theme.value ?? 'system');

  return (
    <div className={`modalBackdrop modalBackdrop--${variant}`} data-theme={theme} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`modal modal--${variant}`} data-theme={theme} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modalHeader">
          <h2>{title}</h2>
          {showCloseButton && <button className="iconButton" type="button" onClick={onClose} aria-label={t('close')}>
            <CloseIcon />
          </button>}
        </header>
        {children}
      </section>
    </div>
  );
}
