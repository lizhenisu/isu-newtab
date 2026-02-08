import { describe, expect, it, vi } from 'vitest';
import { createVoiceRecognitionSession, isVoiceRecognitionSupported, normalizeVoiceMicrophoneAccessError, normalizeVoiceRecognitionError, requestVoiceMicrophoneAccess } from '../../core/search/voice-recognition';

class MockRecognition {
  static latest: MockRecognition | undefined;
  lang = '';
  continuous = true;
  interimResults = false;
  maxAlternatives = 0;
  onstart: (() => void) | null = null;
  onresult: ((event: { resultIndex?: number; results?: { length: number; [index: number]: { isFinal?: boolean; [index: number]: { transcript?: string } | undefined } | undefined } }) => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn(() => this.onstart?.());
  stop = vi.fn();
  abort = vi.fn();

  constructor() {
    MockRecognition.latest = this;
  }
}

describe('voice recognition adapter', () => {
  it('detects the standard and WebKit browser recognition APIs', () => {
    expect(isVoiceRecognitionSupported({})).toBe(false);
    expect(isVoiceRecognitionSupported({ SpeechRecognition: MockRecognition })).toBe(true);
    expect(isVoiceRecognitionSupported({ webkitSpeechRecognition: MockRecognition })).toBe(true);
  });

  it('configures the browser recognizer and keeps interim and final text separate', () => {
    const onStart = vi.fn();
    const onFinalResult = vi.fn();
    const onInterimResult = vi.fn();
    const session = createVoiceRecognitionSession('zh-TW', { onStart, onFinalResult, onInterimResult, onError: vi.fn(), onEnd: vi.fn() }, { webkitSpeechRecognition: MockRecognition });
    expect(session).toBeDefined();
    session?.start();
    const recognition = MockRecognition.latest!;
    expect(recognition).toMatchObject({ lang: 'zh-TW', continuous: true, interimResults: true, maxAlternatives: 1 });
    expect(onStart).toHaveBeenCalledOnce();

    recognition.onresult?.({ resultIndex: 0, results: {
      length: 1,
      0: { isFinal: false, 0: { transcript: 'interim' } },
    } });
    expect(onInterimResult).toHaveBeenLastCalledWith('interim');
    expect(onFinalResult).not.toHaveBeenCalled();

    recognition.onresult?.({ resultIndex: 0, results: {
      length: 2,
      0: { isFinal: true, 0: { transcript: '  final words  ' } },
      1: { isFinal: false, 0: { transcript: 'next interim' } },
    } });
    expect(onFinalResult).toHaveBeenCalledWith('final words');
    expect(onInterimResult).toHaveBeenLastCalledWith('next interim');
    session?.stop();
    session?.abort();
    expect(recognition.stop).toHaveBeenCalledOnce();
    expect(recognition.abort).toHaveBeenCalledOnce();
  });

  it('normalizes browser errors to a finite local error set', () => {
    expect(normalizeVoiceRecognitionError('not-allowed')).toBe('not-allowed');
    expect(normalizeVoiceRecognitionError('audio-capture')).toBe('audio-capture');
    expect(normalizeVoiceRecognitionError('unexpected-browser-error')).toBe('unknown');
  });

  it('requests microphone access only long enough to trigger the browser permission flow', async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] });
    await expect(requestVoiceMicrophoneAccess({ navigator: { mediaDevices: { getUserMedia } } })).resolves.toBeUndefined();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(stop).toHaveBeenCalledOnce();
  });

  it('maps media permission and microphone failures to local recovery states', async () => {
    const denied = new DOMException('blocked', 'NotAllowedError');
    const unavailable = new DOMException('missing', 'NotFoundError');
    await expect(requestVoiceMicrophoneAccess({ navigator: { mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(denied) } } })).resolves.toBe('permission-denied');
    await expect(requestVoiceMicrophoneAccess({ navigator: { mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(unavailable) } } })).resolves.toBe('microphone-unavailable');
    expect(normalizeVoiceMicrophoneAccessError(new Error('unknown'))).toBe('unavailable');
    await expect(requestVoiceMicrophoneAccess({})).resolves.toBe('unsupported');
  });
});
