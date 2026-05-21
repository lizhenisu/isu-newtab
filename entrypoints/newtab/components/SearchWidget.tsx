import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { currentLanguageTag, t } from '../../../core/browser/i18n';
import type { SearchHistorySource, SearchPreferences } from '../../../core/domain/types';
import { navigateCurrentTab } from '../../../core/search/current-tab-navigation';
import type { SearchHistoryEntry } from '../../../core/search/history';
import { getHistoryForSource, recordSearchForSource } from '../../../core/search/history-provider';
import { fetchSearchSuggestions } from '../../../core/search/suggestions';
import { buildTextSearchTarget, buildVisualSearchTarget } from '../../../core/search/search-target';
import { createVoiceRecognitionSession, requestVoiceMicrophoneAccess, type VoiceMicrophoneAccessError, type VoiceRecognitionError, type VoiceRecognitionSession } from '../../../core/search/voice-recognition';

type SuggestionItem = {
  value: string;
  source: 'history' | 'remote';
};

type SearchSubmissionSnapshot = {
  items: SuggestionItem[];
  activeIndex: number;
  value: string;
};

type VoiceMessageKey =
  | 'voiceListening'
  | 'voiceRequestingPermission'
  | 'voiceRecognitionMicrophoneUnavailable'
  | 'voiceRecognitionNetworkError'
  | 'voiceRecognitionNoSpeech'
  | 'voiceRecognitionPermissionDenied'
  | 'voiceRecognitionUnavailable'
  | 'voiceRecognitionUnsupported';

export function SearchWidget({ preferences, historySource }: { preferences: SearchPreferences; historySource: SearchHistorySource }) {
  const [query, setQuery] = useState('');
  const [history, setHistory] = useState<SearchHistoryEntry[]>([]);
  const [remoteSuggestions, setRemoteSuggestions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [submissionSnapshot, setSubmissionSnapshot] = useState<SearchSubmissionSnapshot>();
  const inputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLFormElement>(null);
  const suggestionListRef = useRef<HTMLUListElement>(null);
  const suggestionOptionRefs = useRef(new Map<number, HTMLLIElement>());
  const mountedRef = useRef(true);
  const historyRequestRef = useRef(0);
  const submissionRef = useRef<SearchSubmissionSnapshot | undefined>(undefined);
  const voiceSessionRef = useRef<VoiceRecognitionSession | undefined>(undefined);
  const voiceSessionVersionRef = useRef(0);
  const voiceRestartTimerRef = useRef<number | undefined>(undefined);
  const voiceStatusTimerRef = useRef<number | undefined>(undefined);
  const voiceShouldListenRef = useRef(false);
  const voiceHasFinalResultRef = useRef(false);
  const voiceCommittedTranscriptRef = useRef('');
  const voiceInterimTranscriptRef = useRef('');
  const voiceStopRequestedRef = useRef(false);
  const [suggestionSurfaceMaxHeight, setSuggestionSurfaceMaxHeight] = useState<number>();
  const [voiceState, setVoiceState] = useState<'idle' | 'requesting' | 'listening' | 'stopping'>('idle');
  const [voiceMessage, setVoiceMessage] = useState<VoiceMessageKey>();

  const refreshHistory = useCallback(async (source: SearchHistorySource) => {
    const request = historyRequestRef.current + 1;
    historyRequestRef.current = request;
    try {
      const entries = await getHistoryForSource(source);
      if (mountedRef.current && historyRequestRef.current === request) setHistory(entries);
    } catch {
      if (mountedRef.current && historyRequestRef.current === request) setHistory([]);
    }
  }, []);

  useEffect(() => {
    if (!preferences.historyEnabled) {
      historyRequestRef.current += 1;
      setHistory([]);
      return;
    }
    void refreshHistory(historySource);
    return () => { historyRequestRef.current += 1; };
  }, [historySource, preferences.historyEnabled, refreshHistory]);

  useEffect(() => {
    setRemoteSuggestions([]);
  }, [preferences.engine]);

  const clearVoiceTimers = useCallback(() => {
    if (voiceRestartTimerRef.current !== undefined) window.clearTimeout(voiceRestartTimerRef.current);
    if (voiceStatusTimerRef.current !== undefined) window.clearTimeout(voiceStatusTimerRef.current);
    voiceRestartTimerRef.current = undefined;
    voiceStatusTimerRef.current = undefined;
  }, []);

  const showVoiceMessage = useCallback((message: VoiceMessageKey, transient = false) => {
    if (voiceStatusTimerRef.current !== undefined) window.clearTimeout(voiceStatusTimerRef.current);
    voiceStatusTimerRef.current = undefined;
    setVoiceMessage(message);
    if (!transient) return;
    voiceStatusTimerRef.current = window.setTimeout(() => {
      voiceStatusTimerRef.current = undefined;
      setVoiceMessage(undefined);
    }, 3_000);
  }, []);

  const abortVoiceRecognition = useCallback((clearMessage = true) => {
    voiceSessionVersionRef.current += 1;
    voiceShouldListenRef.current = false;
    voiceStopRequestedRef.current = false;
    voiceCommittedTranscriptRef.current = '';
    voiceInterimTranscriptRef.current = '';
    clearVoiceTimers();
    const session = voiceSessionRef.current;
    voiceSessionRef.current = undefined;
    session?.abort();
    setVoiceState('idle');
    if (clearMessage) setVoiceMessage(undefined);
  }, [clearVoiceTimers]);

  useEffect(() => {
    // React StrictMode performs a development-only setup/cleanup/setup cycle.
    // Restore the mounted flag on every setup so the second history request is
    // not mistaken for a result belonging to an unmounted component.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      historyRequestRef.current += 1;
      voiceSessionVersionRef.current += 1;
      voiceShouldListenRef.current = false;
      voiceCommittedTranscriptRef.current = '';
      voiceInterimTranscriptRef.current = '';
      clearVoiceTimers();
      voiceSessionRef.current?.abort();
      voiceSessionRef.current = undefined;
    };
  }, [clearVoiceTimers]);

  useEffect(() => {
    abortVoiceRecognition();
  }, [abortVoiceRecognition, preferences.engine]);

  useEffect(() => {
    setActiveIndex(-1);
    if (voiceState !== 'idle' || !open || !preferences.suggestionsEnabled || !query.trim()) {
      setRemoteSuggestions([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetchSearchSuggestions(preferences.engine, query, currentLanguageTag(), controller.signal).then(setRemoteSuggestions).catch((error) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setRemoteSuggestions([]);
      });
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [open, preferences.engine, preferences.suggestionsEnabled, query, voiceState]);

  const items = useMemo(() => buildSuggestionItems(query, preferences.historyEnabled ? history : [], remoteSuggestions), [history, preferences.historyEnabled, query, remoteSuggestions]);
  const displayedItems = submissionSnapshot?.items ?? items;
  const displayedActiveIndex = submissionSnapshot?.activeIndex ?? activeIndex;
  const suggestionsVisible = open && displayedItems.length > 0;
  const searchBackgroundAlpha = String(preferences.backgroundOpacity / 100);
  useLayoutEffect(() => {
    if (!suggestionsVisible) {
      setSuggestionSurfaceMaxHeight(undefined);
      return;
    }
    const updateAvailableHeight = () => {
      const search = searchRef.current;
      if (!search) return;
      const rect = search.getBoundingClientRect();
      const viewportPadding = 8;
      setSuggestionSurfaceMaxHeight(Math.max(rect.height + 44, window.innerHeight - rect.top - viewportPadding));
    };
    updateAvailableHeight();
    window.addEventListener('resize', updateAvailableHeight);
    window.addEventListener('scroll', updateAvailableHeight, true);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(updateAvailableHeight);
    if (observer && searchRef.current) observer.observe(searchRef.current);
    return () => {
      window.removeEventListener('resize', updateAvailableHeight);
      window.removeEventListener('scroll', updateAvailableHeight, true);
      observer?.disconnect();
    };
  }, [displayedItems.length, preferences.widthPercent, suggestionsVisible]);
  useLayoutEffect(() => {
    if (!suggestionsVisible || displayedActiveIndex < 0) return;
    const list = suggestionListRef.current;
    const option = suggestionOptionRefs.current.get(displayedActiveIndex);
    if (list && option) scrollSuggestionIntoView(list, option);
  }, [displayedActiveIndex, displayedItems, suggestionsVisible]);
  const style = {
    '--search-width': `${Number((preferences.widthPercent * 0.8).toFixed(2))}vw`,
    '--search-background-alpha': searchBackgroundAlpha,
  } as React.CSSProperties;

  const commitSearch = (value: string, selectedIndex = activeIndex) => {
    if (submissionRef.current) return;
    const normalized = value.trim();
    if (!normalized) return;
    const snapshot: SearchSubmissionSnapshot = {
      items: [...items],
      activeIndex: selectedIndex,
      value: normalized,
    };
    submissionRef.current = snapshot;
    setSubmissionSnapshot(snapshot);
    void persistSearchAndNavigate(snapshot);
  };

  const persistSearchAndNavigate = async (snapshot: SearchSubmissionSnapshot) => {
    if (preferences.historyEnabled) {
      const next = await recordSearchForSource(historySource, snapshot.value);
      if (next) {
        historyRequestRef.current += 1;
        setHistory(next);
      }
    }
    navigateCurrentTab(buildTextSearchTarget(preferences.engine, snapshot.value, currentLanguageTag()));
  };

  const startVoiceRecognition = useCallback(() => {
    const appendVoiceTranscript = (current: string, next: string) => current ? current.trimEnd() + ' ' + next : next;
    const renderVoiceTranscript = () => {
      const committed = voiceCommittedTranscriptRef.current;
      const interim = voiceInterimTranscriptRef.current;
      setQuery(interim ? appendVoiceTranscript(committed, interim) : committed);
    };
    const commitInterimTranscript = () => {
      const interim = voiceInterimTranscriptRef.current.trim();
      if (!interim) return;
      voiceCommittedTranscriptRef.current = appendVoiceTranscript(voiceCommittedTranscriptRef.current, interim);
      voiceInterimTranscriptRef.current = '';
      voiceHasFinalResultRef.current = true;
      renderVoiceTranscript();
    };

    if (voiceState !== 'idle') {
      if (voiceState === 'stopping') return;
      if (voiceState === 'requesting') {
        abortVoiceRecognition();
        inputRef.current?.focus();
        return;
      }
      voiceShouldListenRef.current = false;
      voiceStopRequestedRef.current = true;
      if (voiceRestartTimerRef.current !== undefined) window.clearTimeout(voiceRestartTimerRef.current);
      voiceRestartTimerRef.current = undefined;
      const session = voiceSessionRef.current;
      if (!session) {
        commitInterimTranscript();
        setVoiceState('idle');
        if (voiceHasFinalResultRef.current) setVoiceMessage(undefined);
        else showVoiceMessage('voiceRecognitionNoSpeech', true);
        inputRef.current?.focus();
        return;
      }
      setVoiceState('stopping');
      session.stop();
      return;
    }

    clearVoiceTimers();
    const version = voiceSessionVersionRef.current + 1;
    voiceSessionVersionRef.current = version;
    voiceShouldListenRef.current = true;
    voiceHasFinalResultRef.current = false;
    voiceCommittedTranscriptRef.current = '';
    voiceInterimTranscriptRef.current = '';
    voiceStopRequestedRef.current = false;
    const isCurrentSession = () => voiceSessionVersionRef.current === version;
    const finishVoiceRecognition = (message?: VoiceMessageKey) => {
      if (!isCurrentSession()) return;
      voiceShouldListenRef.current = false;
      voiceStopRequestedRef.current = false;
      if (voiceRestartTimerRef.current !== undefined) window.clearTimeout(voiceRestartTimerRef.current);
      voiceRestartTimerRef.current = undefined;
      voiceSessionRef.current = undefined;
      voiceSessionVersionRef.current += 1;
      voiceCommittedTranscriptRef.current = '';
      voiceInterimTranscriptRef.current = '';
      setVoiceState('idle');
      if (message) showVoiceMessage(message, true);
      else setVoiceMessage(undefined);
      inputRef.current?.focus();
      return;
    }
    let terminalMessage: VoiceMessageKey | undefined;
    const restartRecognition = () => {
      if (!isCurrentSession() || !voiceShouldListenRef.current) return;
      if (voiceRestartTimerRef.current !== undefined) window.clearTimeout(voiceRestartTimerRef.current);
      voiceRestartTimerRef.current = window.setTimeout(() => {
        voiceRestartTimerRef.current = undefined;
        startRecognizer();
      }, 250);
    };
    const startRecognizer = () => {
      if (!isCurrentSession() || !voiceShouldListenRef.current) return;
      terminalMessage = undefined;
      const session = createVoiceRecognitionSession(currentLanguageTag(), {
        onStart: () => {
          if (!isCurrentSession()) return;
          setVoiceState('listening');
          showVoiceMessage('voiceListening');
        },
        onFinalResult: (text) => {
          if (!isCurrentSession()) return;
          voiceHasFinalResultRef.current = true;
          voiceCommittedTranscriptRef.current = appendVoiceTranscript(voiceCommittedTranscriptRef.current, text);
          voiceInterimTranscriptRef.current = '';
          renderVoiceTranscript();
          setRemoteSuggestions([]);
          setOpen(false);
          setActiveIndex(-1);
        },
        onInterimResult: (text) => {
          if (!isCurrentSession()) return;
          voiceInterimTranscriptRef.current = text.trim();
          renderVoiceTranscript();
          setRemoteSuggestions([]);
          setOpen(false);
          setActiveIndex(-1);
        },
        onError: (error) => {
          if (!isCurrentSession() || error === 'no-speech') return;
          terminalMessage = voiceErrorMessage(error);
          voiceShouldListenRef.current = false;
        },
        onEnd: () => {
          if (!isCurrentSession()) return;
          voiceSessionRef.current = undefined;
          if (voiceStopRequestedRef.current) {
            commitInterimTranscript();
            finishVoiceRecognition(voiceHasFinalResultRef.current ? undefined : 'voiceRecognitionNoSpeech');
            return;
          }
          if (terminalMessage) {
            finishVoiceRecognition(terminalMessage);
            return;
          }
          commitInterimTranscript();
          restartRecognition();
        },
      });

      if (!session) {
        finishVoiceRecognition('voiceRecognitionUnsupported');
        return;
      }

      voiceSessionRef.current = session;
      try {
        session.start();
      } catch {
        finishVoiceRecognition('voiceRecognitionUnavailable');
      }
    };

    setVoiceState('requesting');
    showVoiceMessage('voiceRequestingPermission');
    setRemoteSuggestions([]);
    setOpen(false);
    setActiveIndex(-1);
    void requestVoiceMicrophoneAccess().then((error) => {
      if (!isCurrentSession()) return;
      if (error) {
        finishVoiceRecognition(voiceMicrophoneErrorMessage(error));
        return;
      }
      setVoiceState('listening');
      showVoiceMessage('voiceListening');
      startRecognizer();
    });
  }, [abortVoiceRecognition, clearVoiceTimers, showVoiceMessage, voiceState]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    commitSearch(items[activeIndex]?.value ?? query);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (submissionRef.current && (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter')) {
      event.preventDefault();
      return;
    }
    if (event.key === 'Enter' && items[activeIndex]) {
      event.preventDefault();
      commitSearch(items[activeIndex].value, activeIndex);
    } else if (event.key === 'ArrowDown' && items.length) {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => (index + 1) % items.length);
    } else if (event.key === 'ArrowUp' && items.length) {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => index <= 0 ? items.length - 1 : index - 1);
    } else if (event.key === 'Escape') {
      setOpen(false);
      setActiveIndex(-1);
    }
  };

  return (
    <div className={`searchWidgetShell ${suggestionsVisible ? 'hasSuggestions' : ''}`} style={style} onBlur={(event) => {
      const relatedTarget = event.relatedTarget;
      if (event.currentTarget.contains(relatedTarget)) return;
      setOpen(false);
    }}>
      {suggestionsVisible && suggestionSurfaceMaxHeight && <div className="searchSuggestionsSurface liquidGlassSurface" style={{ '--search-suggestions-max-height': `${suggestionSurfaceMaxHeight}px` } as React.CSSProperties}>
        <ul ref={suggestionListRef} id="search-suggestions" className="searchSuggestions" role="listbox">
          {displayedItems.map((item, index) => (
            <li ref={(node) => {
              if (node) suggestionOptionRefs.current.set(index, node);
              else suggestionOptionRefs.current.delete(index);
            }} key={`${item.source}:${item.value}`} id={`search-suggestion-${index}`} role="option" aria-selected={index === displayedActiveIndex}>
              <button type="button" className={index === displayedActiveIndex ? 'active' : ''} onMouseDown={(event) => event.preventDefault()} onClick={() => commitSearch(item.value, index)}>
                <span className="suggestionIcon" aria-hidden="true">{item.source === 'history' ? <HistoryIcon /> : <SearchIcon />}</span><span>{item.value}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>}
      <form ref={searchRef} className="search liquidGlassSurface" role="search" onSubmit={submit}>
        <button type="submit" className="searchSubmit" aria-label={t('submitSearch')} disabled={!query.trim() && !items[activeIndex]}>
          <SearchIcon />
        </button>
        <input
          ref={inputRef}
          className="searchInput"
          value={query}
          placeholder={t(preferences.engine === 'google' ? 'searchGooglePrompt' : 'searchBingPrompt')}
          onChange={(event) => { if (submissionRef.current) return; abortVoiceRecognition(); setQuery(event.target.value); setOpen(true); }}
          onFocus={() => { setOpen(true); if (preferences.historyEnabled) void refreshHistory(historySource); }}
          onKeyDown={onKeyDown}
          aria-label={t('searchPlaceholder')}
          aria-autocomplete="list"
          aria-expanded={suggestionsVisible}
          aria-controls="search-suggestions"
          aria-activedescendant={displayedActiveIndex >= 0 ? `search-suggestion-${displayedActiveIndex}` : undefined}
        />
        {query && <button type="button" className="searchClear" aria-label={t('clearSearchQuery')} onMouseDown={(event) => event.preventDefault()} onClick={() => { if (submissionRef.current) return; abortVoiceRecognition(); setQuery(''); setActiveIndex(-1); inputRef.current?.focus(); }}>×</button>}
        <span className="googleSearchActions"><button type="button" className={`voiceSearchButton ${voiceState !== 'idle' ? 'isListening' : ''}`} aria-label={t(voiceState === 'idle' ? 'startVoiceSearch' : 'stopVoiceSearch')} aria-pressed={voiceState !== 'idle'} onClick={startVoiceRecognition}><VoiceIcon /></button><button type="button" className="visualSearchButton" aria-label={t(preferences.engine === 'google' ? 'openGoogleVisualSearch' : 'openBingVisualSearch')} onClick={() => { abortVoiceRecognition(); setOpen(false); navigateCurrentTab(buildVisualSearchTarget(preferences.engine, currentLanguageTag())); }}><GoogleVisualSearchIcon /></button></span>
      </form>
      {voiceMessage && <p className={`searchVoiceStatus ${voiceState !== 'idle' ? 'isListening' : ''}`} role="status" aria-live="polite">{t(voiceMessage)}</p>}
    </div>
  );
}

function SearchIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.2" /><path d="m15.4 15.4 4.3 4.3" /></svg>;
}

function HistoryIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5v5h5" /><path d="M5.4 9.6a7.2 7.2 0 1 1-.2 4.9" /><path d="M12 8v4.3l3 1.8" /></svg>;
}

function VoiceIcon() {
  return <svg className="googleVoiceIcon" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285f4" d="M12 15a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v7a3 3 0 0 0 3 3Z" /><path fill="#34a853" d="M6.5 11.5h2A3.5 3.5 0 0 0 12 15v2a5.5 5.5 0 0 1-5.5-5.5Z" /><path fill="#fbbc04" d="M17.5 11.5h-2A3.5 3.5 0 0 1 12 15v2a5.5 5.5 0 0 0 5.5-5.5Z" /><path fill="#ea4335" d="M11 17h2v4h-2z" /></svg>;
}

function GoogleVisualSearchIcon() {
  return <svg className="googleLensIcon" viewBox="0 0 24 24"><path fill="#4285f4" d="M7 3h3v2H7a2 2 0 0 0-2 2v3H3V7a4 4 0 0 1 4-4Zm7 0h3a4 4 0 0 1 4 4v3h-2V7a2 2 0 0 0-2-2h-3V3Z" /><path fill="#ea4335" d="M3 14h2v3a2 2 0 0 0 2 2h3v2H7a4 4 0 0 1-4-4v-3Z" /><path fill="#34a853" d="M19 14h2v3a4 4 0 0 1-4 4h-3v-2h3a2 2 0 0 0 2-2v-3Z" /><circle cx="12" cy="12" r="3.2" fill="#4285f4" /><circle cx="18.5" cy="15.5" r="1.5" fill="#fbbc04" /></svg>;
}

export function scrollSuggestionIntoView(list: HTMLElement, option: HTMLElement): void {
  const listRect = list.getBoundingClientRect();
  const optionRect = option.getBoundingClientRect();
  if (optionRect.top < listRect.top) {
    list.scrollTop -= listRect.top - optionRect.top;
  } else if (optionRect.bottom > listRect.bottom) {
    list.scrollTop += optionRect.bottom - listRect.bottom;
  }
}

function voiceErrorMessage(error: VoiceRecognitionError): VoiceMessageKey {
  switch (error) {
    case 'no-speech': return 'voiceRecognitionNoSpeech';
    case 'not-allowed':
    case 'service-not-allowed': return 'voiceRecognitionPermissionDenied';
    case 'audio-capture': return 'voiceRecognitionMicrophoneUnavailable';
    case 'network': return 'voiceRecognitionNetworkError';
    case 'aborted':
    case 'unknown': return 'voiceRecognitionUnavailable';
  }
}

function voiceMicrophoneErrorMessage(error: VoiceMicrophoneAccessError): VoiceMessageKey {
  switch (error) {
    case 'permission-denied': return 'voiceRecognitionPermissionDenied';
    case 'microphone-unavailable': return 'voiceRecognitionMicrophoneUnavailable';
    case 'unsupported': return 'voiceRecognitionUnsupported';
    case 'unavailable': return 'voiceRecognitionUnavailable';
  }
}

export function buildSuggestionItems(query: string, history: SearchHistoryEntry[], remote: string[]): SuggestionItem[] {
  const normalized = query.trim().toLocaleLowerCase();
  const historyMatches = history.filter((entry) => !normalized || entry.query.toLocaleLowerCase().includes(normalized)).map((entry) => ({ value: entry.query, source: 'history' as const }));
  const candidates: SuggestionItem[] = [...historyMatches, ...remote.map((value) => ({ value, source: 'remote' as const }))];
  const seen = new Set<string>();
  return candidates.filter((item) => {
    const key = item.value.toLocaleLowerCase();
    if (!item.value.trim() || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}
