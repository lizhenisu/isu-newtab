import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAppLanguage } from '../../core/browser/i18n';
import { ClockWidget } from '../../entrypoints/newtab/components/ClockWidget';
import { FocusTimer } from '../../entrypoints/newtab/components/FocusTimer';
import { QuickNote } from '../../entrypoints/newtab/components/QuickNote';
import { browser } from 'wxt/browser';

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  setAppLanguage('system');
});

describe('dashboard widgets', () => {
  it('saves before opening the note directly, blocks duplicate clicks, and allows retry', async () => {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 154 } as DOMRect);
    const computed = vi.spyOn(window, 'getComputedStyle').mockReturnValue({ lineHeight: '22px' } as CSSStyleDeclaration);
    const popup = vi.spyOn(window, 'open');
    const create = vi.mocked(browser.tabs.create);
    create.mockClear();
    let finish!: () => void;
    const save = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { container, unmount } = render(<QuickNote value={'line\n'.repeat(7)} onChange={save} />);
    try {
      const button = container.querySelector('button')!;
      await act(async () => { fireEvent.click(button); fireEvent.click(button); });
      expect(save).toHaveBeenCalledTimes(1);
      expect(create).not.toHaveBeenCalled();
      expect(button).toBeDisabled();
      await act(async () => { finish(); });
      expect(create).toHaveBeenCalledExactlyOnceWith({ url: 'chrome-extension://test/note.html' });
      expect(popup).not.toHaveBeenCalled();
      save.mockRejectedValueOnce(new Error('save failed'));
      await act(async () => { fireEvent.click(button); });
      expect(container.querySelector('[role="alert"]')).toHaveTextContent('quickNoteOpenError');
      expect(create).toHaveBeenCalledTimes(1);
      create.mockRejectedValueOnce(new Error('open failed'));
      await act(async () => { fireEvent.click(button); });
      expect(container.querySelector('[role="alert"]')).toBeInTheDocument();
      await act(async () => { fireEvent.click(button); });
      expect(container.querySelector('[role="alert"]')).not.toBeInTheDocument();
      expect(button).not.toBeDisabled();
    } finally { unmount(); rect.mockRestore(); computed.mockRestore(); popup.mockRestore(); }
  });
  it('formats the date with the selected app language', () => {
    const now = new Date(2026, 7, 16, 8, 3);
    setAppLanguage('en');
    const { rerender } = render(<ClockWidget now={now} />);
    expect(screen.getByText('Sunday, August 16')).toBeVisible();

    setAppLanguage('zh_CN');
    rerender(<ClockWidget now={now} />);
    expect(screen.getByText('8月16日星期日')).toBeVisible();

    setAppLanguage('ja');
    rerender(<ClockWidget now={now} />);
    expect(screen.getByText('8月16日日曜日')).toBeVisible();

    setAppLanguage('ko');
    rerender(<ClockWidget now={now} />);
    expect(screen.getByText('8월 16일 일요일')).toBeVisible();
  });

  it('starts and resets the focus timer', () => {
    vi.useFakeTimers();
    const { container } = render(<FocusTimer />);
    expect(container.querySelector('.timerModes')).toHaveClass('liquidGlassSurface');
    expect(container.querySelector('.roundControl')).toHaveClass('liquidGlassSurface');
    expect(container.querySelector('.focusState')).toHaveClass('liquidGlassSurface');
    expect(container.querySelector('.focusState > span')).toHaveTextContent('focus');
    fireEvent.click(screen.getByRole('button', { name: 'start' }));
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText('24:59')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'reset' }));
    expect(screen.getByText('25:00')).toBeVisible();
  });

  it('keeps the quick note in local-only browser storage', () => {
    const { container } = render(<QuickNote />);
    expect(container.querySelector('.quickNote')).toHaveClass('liquidGlassSurface');
    expect(screen.queryByText('savedLocally')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('quickNote'), { target: { value: 'Finish the dashboard' } });
    expect(localStorage.getItem('isu:quick-note')).toBe('Finish the dashboard');
  });

  it('keeps the full composition before switching to a six-line preview', () => {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 154 } as DOMRect);
    const computed = vi.spyOn(window, 'getComputedStyle').mockReturnValue({ lineHeight: '22px' } as CSSStyleDeclaration);
    try {
      const { container, rerender } = render(<QuickNote value={'a\n'.repeat(6)} />);
      expect(container.querySelector('.quickNote__preview')).toBeInTheDocument();
      expect(container.querySelector('.quickNote__body > .quickNote__measure')).toBeInTheDocument();
      expect(container.querySelector('.quickNote > label')).not.toBeInTheDocument();
      rect.mockReturnValue({ height: 132 } as DOMRect);
      rerender(<QuickNote value="short" />);
      const editor = container.querySelector('textarea')!;
      fireEvent.compositionStart(editor);
      rect.mockReturnValue({ height: 154 } as DOMRect);
      const content = '一\n二\n三\n四\n五\n六\n七';
      fireEvent.change(editor, { target: { value: content } });
      expect(editor).toHaveValue(content);
      fireEvent.compositionEnd(editor);
      expect(container.querySelector('textarea')).not.toBeInTheDocument();
      expect(container.querySelector('.quickNote__preview')).toHaveTextContent('七');
      expect(localStorage.getItem('isu:quick-note')).toBe(content);
    } finally {
      rect.mockRestore();
      computed.mockRestore();
    }
  });
});
