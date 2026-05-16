import { useEffect, useState } from 'react';
import { t } from '../../../core/browser/i18n';

type TimerMode = 'focus' | 'shortBreak' | 'longBreak';

const DURATIONS: Record<TimerMode, number> = { focus: 25 * 60, shortBreak: 5 * 60, longBreak: 15 * 60 };

export function FocusTimer() {
  const [mode, setMode] = useState<TimerMode>('focus');
  const [remaining, setRemaining] = useState(DURATIONS.focus);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setRemaining((value) => {
      if (value > 1) return value - 1;
      setRunning(false);
      return 0;
    }), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);

  const selectMode = (value: TimerMode) => {
    setMode(value);
    setRemaining(DURATIONS[value]);
    setRunning(false);
  };
  const reset = () => {
    setRemaining(DURATIONS[mode]);
    setRunning(false);
  };
  const minutes = Math.floor(remaining / 60).toString().padStart(2, '0');
  const seconds = (remaining % 60).toString().padStart(2, '0');

  return (
    <section className="focusTimer" aria-label={t('focusTimer')}>
      <div className="timerModes liquidGlassSurface liquidGlassSurface--control">{(['focus', 'shortBreak', 'longBreak'] as const).map((value) => <button type="button" key={value} className={mode === value ? 'active' : ''} onClick={() => selectMode(value)}>{t(value)}</button>)}</div>
      <time className="timerValue" dateTime={`PT${remaining}S`}>{minutes}:{seconds}</time>
      <div className="timerControls">
        <button type="button" className="roundControl liquidGlassSurface liquidGlassSurface--control" onClick={() => setRunning((value) => !value)} aria-label={running ? t('pause') : t('start')}><span>{running ? 'Ⅱ' : '▶'}</span></button>
        <button type="button" className="roundControl liquidGlassSurface liquidGlassSurface--control" onClick={reset} aria-label={t('reset')}><span>↻</span></button>
        <span className={`focusState liquidGlassSurface liquidGlassSurface--control ${running ? 'active' : ''}`}><i /><span>{t('focus')}</span></span>
      </div>
    </section>
  );
}
