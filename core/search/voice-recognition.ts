export type VoiceRecognitionError =
  | 'aborted'
  | 'audio-capture'
  | 'network'
  | 'no-speech'
  | 'not-allowed'
  | 'service-not-allowed'
  | 'unknown';

export type VoiceMicrophoneAccessError =
  | 'microphone-unavailable'
  | 'permission-denied'
  | 'unsupported'
  | 'unavailable';

export type VoiceRecognitionCallbacks = {
  onStart: () => void;
  onFinalResult: (text: string) => void;
  onInterimResult: (text: string) => void;
  onError: (error: VoiceRecognitionError) => void;
  onEnd: () => void;
};

export type VoiceRecognitionSession = {
  start: () => void;
  stop: () => void;
  abort: () => void;
};

export type VoiceRecognitionHost = {
  SpeechRecognition?: VoiceRecognitionConstructor;
  webkitSpeechRecognition?: VoiceRecognitionConstructor;
};

export type VoiceMicrophoneHost = {
  navigator?: {
    mediaDevices?: {
      getUserMedia: (constraints: MediaStreamConstraints) => Promise<VoiceMediaStream>;
    };
  };
};

type VoiceRecognitionConstructor = new () => NativeVoiceRecognition;

type VoiceMediaStream = {
  getTracks: () => Array<{ stop: () => void }>;
};

type NativeVoiceRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((event: NativeVoiceRecognitionEvent) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type NativeVoiceRecognitionEvent = {
  resultIndex?: number;
  results?: {
    length: number;
    [index: number]: {
      isFinal?: boolean;
      [index: number]: { transcript?: string } | undefined;
    } | undefined;
  };
};

export function isVoiceRecognitionSupported(host: VoiceRecognitionHost = globalThis as VoiceRecognitionHost): boolean {
  return Boolean(getRecognitionConstructor(host));
}

export function createVoiceRecognitionSession(
  language: string,
  callbacks: VoiceRecognitionCallbacks,
  host: VoiceRecognitionHost = globalThis as VoiceRecognitionHost,
): VoiceRecognitionSession | undefined {
  const Recognition = getRecognitionConstructor(host);
  if (!Recognition) return undefined;

  const recognition = new Recognition();
  recognition.lang = language;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  recognition.onstart = callbacks.onStart;
  recognition.onresult = (event) => {
    const { finalText, interimText } = collectRecognitionText(event);
    if (finalText) callbacks.onFinalResult(finalText);
    callbacks.onInterimResult(interimText);
  };
  recognition.onerror = (event) => callbacks.onError(normalizeVoiceRecognitionError(event.error));
  recognition.onend = callbacks.onEnd;

  return {
    start: () => recognition.start(),
    stop: () => recognition.stop(),
    abort: () => recognition.abort(),
  };
}

/** Requests microphone consent without retaining or processing the temporary stream. */
export async function requestVoiceMicrophoneAccess(
  host: VoiceMicrophoneHost = globalThis as VoiceMicrophoneHost,
): Promise<VoiceMicrophoneAccessError | undefined> {
  const mediaDevices = host.navigator?.mediaDevices;
  if (!mediaDevices) return 'unsupported';

  let stream: VoiceMediaStream | undefined;
  try {
    stream = await mediaDevices.getUserMedia({ audio: true });
    return undefined;
  } catch (error) {
    return normalizeVoiceMicrophoneAccessError(error);
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
  }
}

export function normalizeVoiceRecognitionError(error?: string): VoiceRecognitionError {
  switch (error) {
    case 'aborted':
    case 'audio-capture':
    case 'network':
    case 'no-speech':
    case 'not-allowed':
    case 'service-not-allowed':
      return error;
    default:
      return 'unknown';
  }
}

export function normalizeVoiceMicrophoneAccessError(error: unknown): VoiceMicrophoneAccessError {
  const name = error instanceof DOMException ? error.name : error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') return 'permission-denied';
  if (name === 'NotFoundError' || name === 'NotReadableError' || name === 'OverconstrainedError') return 'microphone-unavailable';
  return 'unavailable';
}

function getRecognitionConstructor(host: VoiceRecognitionHost): VoiceRecognitionConstructor | undefined {
  return host.SpeechRecognition ?? host.webkitSpeechRecognition;
}

function collectRecognitionText(event: NativeVoiceRecognitionEvent): { finalText: string; interimText: string } {
  const results = event.results;
  if (!results) return { finalText: '', interimText: '' };
  const finalText: string[] = [];
  const interimText: string[] = [];
  for (let index = event.resultIndex ?? 0; index < results.length; index += 1) {
    const result = results[index];
    const transcript = result?.[0]?.transcript?.trim();
    if (!transcript) continue;
    if (result?.isFinal) finalText.push(transcript);
    else interimText.push(transcript);
  }
  return { finalText: finalText.join(' '), interimText: interimText.join(' ') };
}
