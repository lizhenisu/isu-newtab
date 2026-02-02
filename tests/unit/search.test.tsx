import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { DEFAULT_SEARCH_PREFERENCES, createDeviceIdentity, createInitialConfig } from '../../core/domain/defaults';
import { appConfigSchema, syncEnvelopeSchema } from '../../core/domain/schema';
import { clearSearchHistory, getSearchHistory, recordSearch } from '../../core/search/history';
import { clearChromeSearchHistoryCache } from '../../core/search/chrome-history';
import { fetchSearchSuggestions, parseBingSuggestionFragment } from '../../core/search/suggestions';
import { navigateCurrentTab } from '../../core/search/current-tab-navigation';
import { createVoiceRecognitionSession, requestVoiceMicrophoneAccess, type VoiceRecognitionCallbacks } from '../../core/search/voice-recognition';
import { createEnvelope } from '../../core/sync/engine';
import { SearchWidget, buildSuggestionItems, scrollSuggestionIntoView } from '../../entrypoints/newtab/components/SearchWidget';

vi.mock('../../core/search/current-tab-navigation', () => ({ navigateCurrentTab: vi.fn() }));
vi.mock('../../core/search/voice-recognition', () => ({
  createVoiceRecognitionSession: vi.fn(),
  requestVoiceMicrophoneAccess: vi.fn(() => Promise.resolve(undefined)),
}));

type HistorySearch = (query: { text: string; startTime?: number; maxResults?: number }) => Promise<Browser.history.HistoryItem[]>;
const historySearch = vi.mocked(browser.history.search as unknown as HistorySearch);
const createVoiceSession = vi.mocked(createVoiceRecognitionSession);
const requestVoiceAccess = vi.mocked(requestVoiceMicrophoneAccess);

afterEach(async () => {
  cleanup();
  await clearSearchHistory();
  clearChromeSearchHistoryCache();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('search experience', () => {
  it('adds search preferences to older local and remote data', () => {
    const config = createInitialConfig(createDeviceIdentity());
    const oldConfig = structuredClone(config) as Record<string, unknown> & { appearance: Record<string, unknown> };
    delete oldConfig.appearance.search;
    expect(appConfigSchema.parse(oldConfig).appearance.search.value).toEqual(DEFAULT_SEARCH_PREFERENCES);

    const envelope = createEnvelope(config, { tombstones: [] }, { counter: 2, deviceId: 'remote' }, 0);
    const oldEnvelope = structuredClone(envelope) as unknown as { config: { appearance: Record<string, unknown> } };
    delete oldEnvelope.config.appearance.search;
    expect(syncEnvelopeSchema.parse(oldEnvelope).config.appearance.search.value).toEqual(DEFAULT_SEARCH_PREFERENCES);

    const missingEngine = structuredClone(config);
    delete (missingEngine.appearance.search.value as Partial<typeof missingEngine.appearance.search.value>).engine;
    expect(appConfigSchema.parse(missingEngine).appearance.search.value.engine).toBe('google');
  });

  it('stores only the 20 newest unique local history entries', async () => {
    for (let index = 0; index < 22; index += 1) await recordSearch(`query ${index}`);
    await recordSearch('QUERY 21');
    const history = await getSearchHistory();
    expect(history).toHaveLength(20);
    expect(history[0]?.query).toBe('QUERY 21');
    expect(history.filter((entry) => entry.query.toLowerCase() === 'query 21')).toHaveLength(1);
    expect(history.some((entry) => entry.query === 'query 0')).toBe(false);
  });

  it('deduplicates local history and remote suggestions with history first', () => {
    expect(buildSuggestionItems('co', [
      { query: 'Codex', searchedAt: new Date().toISOString() },
      { query: 'Chrome', searchedAt: new Date().toISOString() },
    ], ['codex', 'coding'])).toEqual([
      { value: 'Codex', source: 'history' },
      { value: 'coding', source: 'remote' },
    ]);
  });

  it('requests and validates Google suggestions', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(['cod', ['codex', 'coding']]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchSearchSuggestions('google', ' cod ', 'en')).resolves.toEqual(['codex', 'coding']);
    const target = new URL(fetchMock.mock.calls[0]![0]);
    expect(target.origin).toBe('https://suggestqueries.google.com');
    expect(target.searchParams.get('q')).toBe('cod');
  });

  it('uses Bing suggestions without falling back to Google', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('<ul><li query="Isu NewTab"></li><li query="isu newtab"></li><li query="Bing 搜索"></li></ul>', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchSearchSuggestions('bing', ' isu ', 'zh-CN')).resolves.toEqual(['Isu NewTab', 'Bing 搜索']);
    const target = new URL(fetchMock.mock.calls[0]![0]);
    expect(target.origin).toBe('https://www.bing.com');
    expect(target.pathname).toBe('/AS/Suggestions');
    expect(target.searchParams.get('q')).toBe('isu');
    expect(target.searchParams.get('mkt')).toBe('zh-CN');
    expect(target.searchParams.get('cvid')).toMatch(/^[0-9A-F]{32}$/);
  });

  it('safely ignores malformed Bing suggestion fragments and caps valid results', () => {
    expect(parseBingSuggestionFragment('<p>not a suggestion</p>')).toEqual([]);
    expect(parseBingSuggestionFragment(`<ul>${Array.from({ length: 10 }, (_, index) => `<li query="Suggestion ${index}"></li>`).join('')}</ul>`)).toHaveLength(8);
  });

  it('applies visual preferences and records a submitted query before searching', async () => {
    render(<SearchWidget preferences={{ ...DEFAULT_SEARCH_PREFERENCES, widthPercent: 70, backgroundOpacity: 40, suggestionsEnabled: false }} historySource="local" />);
    const shell = screen.getByRole('search').parentElement!;
    expect(screen.getByLabelText('searchPlaceholder')).toHaveAttribute('placeholder', 'searchGooglePrompt');
    expect(screen.getByRole('search').firstElementChild).toHaveClass('searchSubmit');
    expect(screen.getByRole('search').querySelectorAll('.googleSearchActions svg')).toHaveLength(2);
    expect(shell.style.getPropertyValue('--search-width')).toBe('56vw');
    expect(shell.style.getPropertyValue('--search-background-alpha')).toBe('0.4');
    fireEvent.change(screen.getByLabelText('searchPlaceholder'), { target: { value: 'Chrome extensions' } });
    fireEvent.submit(screen.getByRole('search'));
    await waitFor(() => expect(navigateCurrentTab).toHaveBeenCalledWith(expect.stringContaining('https://www.google.com/search?q=Chrome+extensions&hl=en')));
    expect((await getSearchHistory())[0]?.query).toBe('Chrome extensions');
  });

  it('freezes suggestion order and selection while an Enter submission records history', async () => {
    const suggestions = ['freeze one', 'freeze two', 'freeze three', 'freeze four', 'freeze five'];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(['freeze', suggestions]), { status: 200 })));
    render(<SearchWidget preferences={DEFAULT_SEARCH_PREFERENCES} historySource="local" />);
    const input = screen.getByLabelText('searchPlaceholder');
    fireEvent.change(input, { target: { value: 'freeze' } });
    await screen.findByRole('option', { name: 'freeze five' });
    for (let index = 0; index < 5; index += 1) fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: 'freeze five' })).toHaveAttribute('aria-selected', 'true');
    const before = screen.getAllByRole('option').map((option) => option.textContent);

    fireEvent.submit(screen.getByRole('search'));
    await waitFor(() => expect(navigateCurrentTab).toHaveBeenCalledWith(expect.stringContaining('q=freeze+five')));

    expect((await getSearchHistory())[0]?.query).toBe('freeze five');
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(before);
    expect(screen.getByRole('option', { name: 'freeze five' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getByRole('option', { name: 'freeze five' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.change(input, { target: { value: 'replacement' } });
    expect(input).toHaveValue('freeze');
    fireEvent.submit(screen.getByRole('search'));
    expect(navigateCurrentTab).toHaveBeenCalledTimes(1);
  });

  it('freezes the clicked suggestion as the active item until navigation', async () => {
    const suggestions = ['click first', 'click second'];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(['click', suggestions]), { status: 200 })));
    render(<SearchWidget preferences={DEFAULT_SEARCH_PREFERENCES} historySource="local" />);
    const input = screen.getByLabelText('searchPlaceholder');
    fireEvent.change(input, { target: { value: 'click' } });
    const selected = await screen.findByRole('option', { name: 'click second' });
    const before = screen.getAllByRole('option').map((option) => option.textContent);

    fireEvent.click(selected.querySelector('button')!);
    await waitFor(() => expect(navigateCurrentTab).toHaveBeenCalledWith(expect.stringContaining('q=click+second')));

    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(before);
    expect(selected).toHaveAttribute('aria-selected', 'true');
    expect((await getSearchHistory())[0]?.query).toBe('click second');
  });

  it('maps the new 25%–100% range to a 20vw–80vw visual width', () => {
    const { rerender } = render(<SearchWidget preferences={{ ...DEFAULT_SEARCH_PREFERENCES, widthPercent: 25, suggestionsEnabled: false }} historySource="local" />);
    const shell = screen.getByRole('search').parentElement!;
    expect(shell.style.getPropertyValue('--search-width')).toBe('20vw');

    rerender(<SearchWidget preferences={{ ...DEFAULT_SEARCH_PREFERENCES, widthPercent: 50, suggestionsEnabled: false }} historySource="local" />);
    expect(shell.style.getPropertyValue('--search-width')).toBe('40vw');
    rerender(<SearchWidget preferences={{ ...DEFAULT_SEARCH_PREFERENCES, widthPercent: 100, suggestionsEnabled: false }} historySource="local" />);
    expect(shell.style.getPropertyValue('--search-width')).toBe('80vw');
  });

  it('uses the selected engine for visual search without rendering an upload panel', () => {
    const { rerender } = render(<SearchWidget preferences={{ ...DEFAULT_SEARCH_PREFERENCES, suggestionsEnabled: false }} historySource="local" />);
    expect(screen.getByLabelText('openGoogleVisualSearch').querySelector('.googleLensIcon')).not.toBeNull();
    fireEvent.click(screen.getByLabelText('openGoogleVisualSearch'));
    expect(navigateCurrentTab).toHaveBeenLastCalledWith(expect.stringContaining('https://images.google.com/?hl=en'));
    expect(screen.queryByRole('dialog')).toBeNull();

    rerender(<SearchWidget preferences={{ ...DEFAULT_SEARCH_PREFERENCES, engine: 'bing', suggestionsEnabled: false }} historySource="local" />);
    expect(screen.getByLabelText('searchPlaceholder')).toHaveAttribute('placeholder', 'searchBingPrompt');
    expect(screen.getByLabelText('openBingVisualSearch').querySelector('.googleLensIcon')).not.toBeNull();
    fireEvent.click(screen.getByLabelText('openBingVisualSearch'));
    expect(navigateCurrentTab).toHaveBeenLastCalledWith(expect.stringContaining('https://www.bing.com/images?setlang=en-US'));
  });

  it('fills the query from browser voice recognition without searching, then submits through Google', async () => {
    let callbacks: VoiceRecognitionCallbacks | undefined;
    const stop = vi.fn();
    const abort = vi.fn();
    createVoiceSession.mockImplementation((language, nextCallbacks) => {
      expect(language).toBe('en');
      callbacks = nextCallbacks;
      return { start: vi.fn(), stop, abort };
    });
    render(<SearchWidget preferences={{ ...DEFAULT_SEARCH_PREFERENCES, suggestionsEnabled: false }} historySource="local" />);

    const voiceButton = screen.getByLabelText('startVoiceSearch');
    expect(voiceButton).toHaveAttribute('aria-pressed', 'false');
    expect(voiceButton.querySelector('.googleVoiceIcon')).not.toBeNull();
    fireEvent.click(voiceButton);
    await waitFor(() => expect(requestVoiceAccess).toHaveBeenCalledOnce());
    await waitFor(() => expect(callbacks).toBeDefined());
    expect(screen.getByLabelText('stopVoiceSearch')).toHaveAttribute('aria-pressed', 'true');
    act(() => callbacks?.onInterimResult('voice realtime'));
    expect(screen.getByLabelText('searchPlaceholder')).toHaveValue('voice realtime');
    act(() => callbacks?.onFinalResult('voice populated query'));
    expect(screen.getByLabelText('searchPlaceholder')).toHaveValue('voice populated query');
    act(() => callbacks?.onFinalResult('after a pause'));
    expect(screen.getByLabelText('searchPlaceholder')).toHaveValue('voice populated query after a pause');
    act(() => callbacks?.onInterimResult('draft before stopping'));
    expect(screen.getByLabelText('searchPlaceholder')).toHaveValue('voice populated query after a pause draft before stopping');
    expect(navigateCurrentTab).not.toHaveBeenCalled();
    expect(await getSearchHistory()).toEqual([]);

    fireEvent.click(screen.getByLabelText('stopVoiceSearch'));
    expect(stop).toHaveBeenCalledOnce();
    act(() => callbacks?.onEnd());
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.submit(screen.getByRole('search'));
    await waitFor(() => expect(navigateCurrentTab).toHaveBeenCalledWith(expect.stringContaining('https://www.google.com/search?q=voice+populated+query+after+a+pause+draft+before+stopping&hl=en')));
    expect(abort).not.toHaveBeenCalled();
  });

  it('shows the same voice button for Bing and submits its recognized text to Bing', async () => {
    let callbacks: VoiceRecognitionCallbacks | undefined;
    createVoiceSession.mockImplementation((_language, nextCallbacks) => {
      callbacks = nextCallbacks;
      return { start: vi.fn(), stop: vi.fn(), abort: vi.fn() };
    });
    render(<SearchWidget preferences={{ ...DEFAULT_SEARCH_PREFERENCES, engine: 'bing', historyEnabled: false, suggestionsEnabled: false }} historySource="local" />);

    const voiceButton = screen.getByLabelText('startVoiceSearch');
    expect(voiceButton.querySelector('.googleVoiceIcon')).not.toBeNull();
    fireEvent.click(voiceButton);
    await waitFor(() => expect(callbacks).toBeDefined());
    act(() => callbacks?.onFinalResult('Bing voice query'));
    fireEvent.click(screen.getByLabelText('stopVoiceSearch'));
    act(() => callbacks?.onEnd());
    fireEvent.submit(screen.getByRole('search'));
    await waitFor(() => expect(navigateCurrentTab).toHaveBeenCalledWith(expect.stringContaining('https://www.bing.com/search?q=Bing+voice+query&setlang=en-US')));
  });

  it('uses graceful stop, restarts after silence, and recovers from a terminal recognition error', async () => {
    let callbacks: VoiceRecognitionCallbacks | undefined;
    const abort = vi.fn();
    const stop = vi.fn();
    createVoiceSession.mockImplementation((_language, nextCallbacks) => {
      callbacks = nextCallbacks;
      return { start: vi.fn(), stop, abort };
    });
    render(<SearchWidget preferences={{ ...DEFAULT_SEARCH_PREFERENCES, suggestionsEnabled: false }} historySource="local" />);

    fireEvent.click(screen.getByLabelText('startVoiceSearch'));
    await waitFor(() => expect(callbacks).toBeDefined());
    act(() => callbacks?.onInterimResult('draft before silence'));
    expect(screen.getByLabelText('searchPlaceholder')).toHaveValue('draft before silence');
    act(() => callbacks?.onError('no-speech'));
    act(() => callbacks?.onEnd());
    expect(screen.getByLabelText('searchPlaceholder')).toHaveValue('draft before silence');
    await new Promise((resolve) => window.setTimeout(resolve, 275));
    expect(createVoiceSession).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByLabelText('stopVoiceSearch'));
    expect(stop).toHaveBeenCalledOnce();
    act(() => callbacks?.onEnd());
    expect(screen.getByLabelText('startVoiceSearch')).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByLabelText('startVoiceSearch'));
    await waitFor(() => expect(createVoiceSession).toHaveBeenCalledTimes(3));
    act(() => callbacks?.onError('not-allowed'));
    act(() => callbacks?.onEnd());
    expect(screen.getByRole('status')).toHaveTextContent('voiceRecognitionPermissionDenied');
    expect(abort).not.toHaveBeenCalled();
  });

  it('does not start recognition when the browser microphone prompt is denied, and clears terminal status after three seconds', async () => {
    vi.useFakeTimers();
    requestVoiceAccess.mockResolvedValueOnce('permission-denied');
    render(<SearchWidget preferences={{ ...DEFAULT_SEARCH_PREFERENCES, suggestionsEnabled: false }} historySource="local" />);

    fireEvent.click(screen.getByLabelText('startVoiceSearch'));
    await act(async () => {});
    expect(createVoiceSession).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('voiceRecognitionPermissionDenied');
    act(() => vi.advanceTimersByTime(3_000));
    expect(screen.queryByRole('status')).toBeNull();
    vi.useRealTimers();
  });

  it('waits for explicit microphone access before creating a recognition session', async () => {
    let resolveAccess: ((result: undefined) => void) | undefined;
    requestVoiceAccess.mockImplementationOnce(() => new Promise((resolve) => { resolveAccess = resolve; }));
    createVoiceSession.mockReturnValue({ start: vi.fn(), stop: vi.fn(), abort: vi.fn() });
    render(<SearchWidget preferences={{ ...DEFAULT_SEARCH_PREFERENCES, suggestionsEnabled: false }} historySource="local" />);

    fireEvent.click(screen.getByLabelText('startVoiceSearch'));
    expect(requestVoiceAccess).toHaveBeenCalledOnce();
    expect(createVoiceSession).not.toHaveBeenCalled();
    await act(async () => resolveAccess?.(undefined));
    expect(createVoiceSession).toHaveBeenCalledOnce();
  });

  it('renders search history in the local Realbox surface', async () => {
    await recordSearch('history outside piece');
    render(<StrictMode><SearchWidget preferences={{ ...DEFAULT_SEARCH_PREFERENCES, backgroundOpacity: 42, suggestionsEnabled: false }} historySource="local" /></StrictMode>);
    vi.spyOn(screen.getByRole('search'), 'getBoundingClientRect').mockReturnValue({
      x: 40, y: 100, width: 320, height: 60, top: 100, right: 360, bottom: 160, left: 40, toJSON: () => ({}),
    } as DOMRect);
    const input = screen.getByLabelText('searchPlaceholder');
    fireEvent.focus(input);
    const list = await screen.findByRole('listbox');
    const surface = list.parentElement!;
    expect(surface).toHaveClass('searchSuggestionsSurface');
    expect(surface).toHaveClass('liquidGlassSurface');
    expect(surface.parentElement).toHaveClass('searchWidgetShell');
    expect(screen.getByRole('search')).toHaveClass('liquidGlassSurface');
    expect(surface.style.getPropertyValue('--search-suggestions-max-height')).toBe('660px');
    expect(screen.getByRole('search').parentElement?.style.getPropertyValue('--search-background-alpha')).toBe('0.42');
    expect(screen.getByRole('option', { name: 'history outside piece' })).toBeVisible();
  });

  it.each(['Enter', 'button'])('submits selected local history with empty input via %s', async (method) => {
    await recordSearch('older history');
    await recordSearch('newer history');
    render(<StrictMode><SearchWidget preferences={{ ...DEFAULT_SEARCH_PREFERENCES, suggestionsEnabled: false }} historySource="local" /></StrictMode>);
    const input = screen.getByLabelText('searchPlaceholder');
    const button = screen.getByRole('button', { name: 'submitSearch' });
    fireEvent.focus(input);
    await screen.findByRole('option', { name: 'older history' });
    expect(input).toHaveValue('');
    expect(button).toBeDisabled();
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(button).toBeEnabled();
    expect(screen.getByRole('option', { name: 'older history' })).toHaveAttribute('aria-selected', 'true');
    const order = screen.getAllByRole('option').map((option) => option.textContent);
    if (method === 'Enter') fireEvent.keyDown(input, { key: 'Enter' });
    else fireEvent.click(button);
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => expect(navigateCurrentTab).toHaveBeenCalledWith(expect.stringContaining('q=older+history')));
    expect(navigateCurrentTab).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(order);
    expect(screen.getByRole('option', { name: 'older history' })).toHaveAttribute('aria-selected', 'true');
    const history = await getSearchHistory();
    expect(history[0]?.query).toBe('older history');
    expect(history.filter((entry) => entry.query === 'older history')).toHaveLength(1);
  });

  it('does not submit empty input without an active history item', async () => {
    await recordSearch('unselected history');
    render(<SearchWidget preferences={{ ...DEFAULT_SEARCH_PREFERENCES, suggestionsEnabled: false }} historySource="local" />);
    const input = screen.getByLabelText('searchPlaceholder');
    fireEvent.focus(input);
    await screen.findByRole('option', { name: 'unselected history' });
    const history = await getSearchHistory();
    expect(screen.getByRole('button', { name: 'submitSearch' })).toBeDisabled();
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.submit(screen.getByRole('search'));
    expect(navigateCurrentTab).not.toHaveBeenCalled();
    expect(await getSearchHistory()).toEqual(history);
  });

  it('submits selected Chrome history with empty input without writing local history', async () => {
    await recordSearch('local-only phrase');
    const localHistory = await getSearchHistory();
    historySearch.mockResolvedValueOnce([{
      id: 'remote', url: 'https://www.google.com/search?q=synced+phrase', lastVisitTime: Date.now(),
    }]);
    render(<StrictMode><SearchWidget preferences={{ ...DEFAULT_SEARCH_PREFERENCES, suggestionsEnabled: false }} historySource="chrome" /></StrictMode>);
    const input = screen.getByLabelText('searchPlaceholder');
    fireEvent.focus(input);
    await screen.findByRole('option', { name: 'synced phrase' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveValue('');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(navigateCurrentTab).toHaveBeenCalledWith(expect.stringContaining('q=synced+phrase')));
    expect(await getSearchHistory()).toEqual(localHistory);
  });

  it('does not retain a submitted query when history is disabled', async () => {
    render(<SearchWidget preferences={{ ...DEFAULT_SEARCH_PREFERENCES, historyEnabled: false, suggestionsEnabled: false }} historySource="local" />);
    fireEvent.change(screen.getByLabelText('searchPlaceholder'), { target: { value: 'private search' } });
    fireEvent.submit(screen.getByRole('search'));
    await waitFor(() => expect(navigateCurrentTab).toHaveBeenCalled());
    expect(await getSearchHistory()).toEqual([]);
  });

  it('reads Chrome history without writing or falling back to local history', async () => {
    await recordSearch('local-only phrase');
    historySearch.mockResolvedValueOnce([{
      id: 'remote', url: 'https://www.google.com/search?q=synced+phrase', lastVisitTime: Date.now(),
    }]);
    render(<StrictMode><SearchWidget preferences={{ ...DEFAULT_SEARCH_PREFERENCES, suggestionsEnabled: false }} historySource="chrome" /></StrictMode>);
    const input = screen.getByLabelText('searchPlaceholder');
    fireEvent.focus(input);
    await waitFor(() => expect(historySearch).toHaveBeenCalled());
    await screen.findByRole('option', { name: /synced phrase/ });
    fireEvent.change(input, { target: { value: 'new Chrome search' } });
    fireEvent.submit(screen.getByRole('search'));
    await waitFor(() => expect(navigateCurrentTab).toHaveBeenCalledWith(expect.stringContaining('q=new+Chrome+search')));
    expect(await getSearchHistory()).toMatchObject([{ query: 'local-only phrase' }]);
    expect(screen.queryByRole('option', { name: /local-only phrase/ })).toBeNull();
  });

  it('ignores a stale Chrome history result after switching to local history', async () => {
    await recordSearch('current local phrase');
    let resolveChrome: ((items: Browser.history.HistoryItem[]) => void) | undefined;
    historySearch.mockImplementationOnce(() => new Promise((resolve) => { resolveChrome = resolve; }));
    const { rerender } = render(<SearchWidget preferences={{ ...DEFAULT_SEARCH_PREFERENCES, suggestionsEnabled: false }} historySource="chrome" />);
    await waitFor(() => expect(historySearch).toHaveBeenCalled());

    rerender(<SearchWidget preferences={{ ...DEFAULT_SEARCH_PREFERENCES, suggestionsEnabled: false }} historySource="local" />);
    const input = screen.getByLabelText('searchPlaceholder');
    fireEvent.focus(input);
    await screen.findByRole('option', { name: 'current local phrase' });
    resolveChrome?.([{ id: 'stale', url: 'https://www.google.com/search?q=stale+Chrome+phrase', lastVisitTime: Date.now() }]);
    await act(async () => {});

    expect(screen.queryByRole('option', { name: /stale Chrome phrase/ })).toBeNull();
    expect(screen.getByRole('option', { name: 'current local phrase' })).toBeVisible();
  });

  it('scrolls only the suggestion list until the active option is fully visible', () => {
    const list = document.createElement('ul');
    const option = document.createElement('li');
    list.append(option);
    list.scrollTop = 20;
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 232 } as DOMRect);
    vi.spyOn(option, 'getBoundingClientRect').mockReturnValue({ top: 244, bottom: 288 } as DOMRect);
    const pageScroll = window.scrollY;

    scrollSuggestionIntoView(list, option);

    expect(list.scrollTop).toBe(76);
    expect(window.scrollY).toBe(pageScroll);

    vi.spyOn(option, 'getBoundingClientRect').mockReturnValue({ top: 72, bottom: 116 } as DOMRect);
    scrollSuggestionIntoView(list, option);
    expect(list.scrollTop).toBe(48);
    expect(window.scrollY).toBe(pageScroll);
  });

  it('shows no history when Chrome history fails instead of using local records', async () => {
    await recordSearch('must stay local');
    historySearch.mockRejectedValueOnce(new Error('HISTORY_UNAVAILABLE'));
    render(<SearchWidget preferences={{ ...DEFAULT_SEARCH_PREFERENCES, suggestionsEnabled: false }} historySource="chrome" />);
    const input = screen.getByLabelText('searchPlaceholder');
    fireEvent.focus(input);
    await waitFor(() => expect(historySearch).toHaveBeenCalled());
    fireEvent.change(input, { target: { value: 'must stay local' } });
    await waitFor(() => expect(screen.queryByRole('option')).toBeNull());
  });
});
