import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { t } from '../../../core/browser/i18n';
import { QUICK_NOTE_SYNC_LIMIT_BYTES, quickNoteByteLength } from '../../../core/domain/types';

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

export function QuickNote({ value: providedValue, onChange = async () => undefined, expanded = false }: { value?: string; onChange?: (note: string) => Promise<void>; expanded?: boolean }) {
  const [note, setNote] = useState(() => providedValue === undefined ? loadNote() : providedValue);
  const initialized = useRef(false);
  const lastValue = useRef(providedValue);
  const noteRef = useRef(note);
  const onChangeRef = useRef(onChange);
  const writeTail = useRef(Promise.resolve());
  const timerRef = useRef<number | undefined>(undefined);
  const measureRef = useRef<HTMLDivElement>(null);
  const [lineCount, setLineCount] = useState(0);
  const [composing, setComposing] = useState(false);
  const openingRef = useRef(false);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState(false);
  noteRef.current = note;
  onChangeRef.current = onChange;
  useEffect(() => {
    if (!initialized.current) { initialized.current = true; return; }
    // Keep the legacy local cache as a crash-safe fallback during migration;
    // synchronized state is owned by the repository.
    localStorage.setItem(NOTE_STORAGE_KEY, note);
    const timer = window.setTimeout(() => {
      timerRef.current = undefined;
      writeTail.current = writeTail.current.catch(() => undefined).then(() => onChangeRef.current(note));
    }, 300);
    timerRef.current = timer;
    return () => { window.clearTimeout(timer); if (timerRef.current === timer) timerRef.current = undefined; };
  }, [note]);
  useEffect(() => () => {
    if (!initialized.current) return;
    writeTail.current = writeTail.current.catch(() => undefined).then(() => onChangeRef.current(noteRef.current));
  }, []);
  useEffect(() => {
    if (providedValue !== lastValue.current) setNote(providedValue ?? '');
    lastValue.current = providedValue;
  }, [providedValue]);

  useLayoutEffect(() => {
    if (expanded) return;
    const measure = () => {
      const element = measureRef.current;
      if (!element) return;
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
      if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;
      setLineCount(Math.max(1, Math.round(element.getBoundingClientRect().height / lineHeight)));
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    if (observer && measureRef.current) observer.observe(measureRef.current);
    return () => observer?.disconnect();
  }, [expanded, note]);

  const overflowing = !expanded && !composing && lineCount > 6;
  const flush = async () => {
    if (timerRef.current !== undefined) { window.clearTimeout(timerRef.current); timerRef.current = undefined; }
    writeTail.current = writeTail.current.catch(() => undefined).then(() => onChangeRef.current(noteRef.current));
    await writeTail.current;
  };
  const openExpanded = () => {
    if (openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    setOpenError(false);
    void (async () => {
      try {
        await flush();
        await browser.tabs.create({ url: browser.runtime.getURL('/note.html') });
      } catch {
        setOpenError(true);
      } finally {
        openingRef.current = false;
        setOpening(false);
      }
    })();
  };

  return (
    <section className={`quickNote liquidGlassSurface ${expanded ? 'quickNote--expanded' : ''} ${overflowing ? 'quickNote--overflowing' : ''}`}>
      <div className="quickNote__body">
      <div ref={measureRef} className="quickNote__measure" aria-hidden="true">{`${note}\u200b`}</div>
      {expanded || !overflowing
        ? <textarea id={expanded ? 'quick-note-expanded' : 'quick-note'} aria-label={t('quickNote')} value={note} onChange={(event) => setNote(event.target.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} placeholder={t('quickNotePlaceholder')} />
        : <div className="quickNote__preview" aria-label={t('quickNote')}>{note}</div>}
      </div>
      {overflowing && <button type="button" className="quickNote__expand" disabled={opening} onClick={openExpanded} aria-label={t('expandQuickNote')}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M8 3H3v5M16 21h5v-5M3 3l7 7m11 11-7-7" /></svg>{t('expandQuickNote')}</button>}
      {openError ? <small role="alert">{t('quickNoteOpenError')}</small> : quickNoteByteLength(note) > QUICK_NOTE_SYNC_LIMIT_BYTES && <small role="status">{t('quickNoteLocalOnly')}</small>}
    </section>
  );
}
