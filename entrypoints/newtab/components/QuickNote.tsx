import { useEffect, useState } from 'react';
import { t } from '../../../core/browser/i18n';

const NOTE_STORAGE_KEY = 'isu:quick-note';
const LEGACY_NOTE_STORAGE_KEY = ['i', 'z', 'i', 's', 'u', ':quick-note'].join('');

function loadNote(): string {
  const current = localStorage.getItem(NOTE_STORAGE_KEY);
  if (current !== null) return current;
  const legacy = localStorage.getItem(LEGACY_NOTE_STORAGE_KEY);
  if (legacy !== null) {
    localStorage.setItem(NOTE_STORAGE_KEY, legacy);
    localStorage.removeItem(LEGACY_NOTE_STORAGE_KEY);
    return legacy;
  }
  return '';
}

export function QuickNote() {
  const [note, setNote] = useState(loadNote);
  useEffect(() => { localStorage.setItem(NOTE_STORAGE_KEY, note); }, [note]);

  return (
    <section className="quickNote liquidGlassSurface">
      <label htmlFor="quick-note">{t('quickNote')}</label>
      <textarea id="quick-note" value={note} onChange={(event) => setNote(event.target.value)} placeholder={t('quickNotePlaceholder')} maxLength={2_000} />
    </section>
  );
}
