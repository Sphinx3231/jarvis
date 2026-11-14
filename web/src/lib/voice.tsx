import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLive } from './live';

/**
 * Voice I/O using the browser's Web Speech API.
 * - Recognition: SpeechRecognition (Chromium-based browsers; may use the browser vendor's cloud service).
 * - Synthesis: speechSynthesis with the user's chosen local voice. Speech is always interruptible.
 * Voice input is just another way to type: it can never approve an action.
 */

interface RecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: RecognitionResultEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type RecognitionCtor = new () => Recognition;

const RecognitionImpl: RecognitionCtor | undefined =
  (window as unknown as { SpeechRecognition?: RecognitionCtor }).SpeechRecognition ??
  (window as unknown as { webkitSpeechRecognition?: RecognitionCtor }).webkitSpeechRecognition;

export const voiceSupport = {
  recognition: Boolean(RecognitionImpl),
  synthesis: typeof window !== 'undefined' && 'speechSynthesis' in window,
};

interface VoiceContextValue {
  listening: boolean;
  speaking: boolean;
  wakeActive: boolean;
  interim: string;
  error: string | null;
  /** Listen for one utterance; resolves with the final transcript (or '' if nothing was heard). */
  listenOnce: () => Promise<string>;
  stopListening: () => void;
  speak: (text: string) => void;
  stopSpeaking: () => void;
  voices: SpeechSynthesisVoice[];
  /** Called with commands spoken after the wake word, when wake word mode is enabled. */
  setWakeHandler: (fn: ((command: string) => void) | null) => void;
}

const VoiceContext = createContext<VoiceContextValue | null>(null);

function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/[*_#>•]/g, '')
    .slice(0, 1500);
}

export function VoiceProvider({ children }: { children: ReactNode }) {
  const { settings } = useLive();
  const voiceSettings = settings?.voice;
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [wakeActive, setWakeActive] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const recRef = useRef<Recognition | null>(null);
  const wakeRef = useRef<Recognition | null>(null);
  const wakeHandler = useRef<((command: string) => void) | null>(null);
  const listeningRef = useRef(false);

  useEffect(() => {
    if (!voiceSupport.synthesis) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener('voiceschanged', load);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load);
  }, []);

  const stopSpeaking = useCallback(() => {
    if (voiceSupport.synthesis) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (!voiceSupport.synthesis || !voiceSettings?.enabled) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(cleanForSpeech(text));
      const voice = voices.find((v) => v.name === voiceSettings.voiceName);
      if (voice) u.voice = voice;
      u.lang = voice?.lang ?? voiceSettings.lang;
      u.rate = voiceSettings.rate;
      u.pitch = voiceSettings.pitch;
      u.onstart = () => setSpeaking(true);
      u.onend = () => setSpeaking(false);
      u.onerror = () => setSpeaking(false);
      window.speechSynthesis.speak(u);
    },
    [voiceSettings, voices],
  );

  const stopListening = useCallback(() => {
    recRef.current?.stop();
  }, []);

  const listenOnce = useCallback(() => {
    return new Promise<string>((resolve) => {
      if (!RecognitionImpl) {
        setError('Speech recognition is not supported in this browser.');
        return resolve('');
      }
      if (listeningRef.current) return resolve('');
      stopSpeaking(); // interrupt Jarvis when the user starts talking
      wakeRef.current?.abort();
      const rec = new RecognitionImpl();
      rec.lang = voiceSettings?.lang ?? 'en-US';
      rec.continuous = false;
      rec.interimResults = true;
      let finalText = '';
      rec.onresult = (e) => {
        let text = '';
        for (let i = 0; i < e.results.length; i++) {
          text += e.results[i][0].transcript;
          if (e.results[i].isFinal) finalText = text;
        }
        setInterim(text);
      };
      rec.onerror = (e) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') setError('Microphone access was blocked. Allow it in your browser to use voice.');
        else if (e.error !== 'no-speech' && e.error !== 'aborted') setError(`Voice input error: ${e.error}`);
      };
      rec.onend = () => {
        listeningRef.current = false;
        setListening(false);
        setInterim('');
        recRef.current = null;
        resolve(finalText.trim());
      };
      setError(null);
      recRef.current = rec;
      listeningRef.current = true;
      setListening(true);
      rec.start();
    });
  }, [stopSpeaking, voiceSettings?.lang]);

  // Wake word mode: only when the user explicitly enables it.
  useEffect(() => {
    const enabled = Boolean(voiceSettings?.enabled && voiceSettings.wakeWord && RecognitionImpl);
    if (!enabled || !RecognitionImpl) {
      setWakeActive(false);
      return;
    }
    let stopped = false;
    const startWake = () => {
      if (stopped || listeningRef.current) return;
      const rec = new RecognitionImpl();
      rec.lang = voiceSettings?.lang ?? 'en-US';
      rec.continuous = true;
      rec.interimResults = false;
      rec.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (!e.results[i].isFinal) continue;
          const said = e.results[i][0].transcript.trim();
          const m = said.match(/^(?:hey |ok |okay )?jarvis[,.!]?\s*(.*)$/i);
          if (m && m[1]) wakeHandler.current?.(m[1]);
        }
      };
      rec.onerror = (e) => {
        if (e.error === 'not-allowed') {
          setError('Microphone access was blocked, so the wake word is off.');
          stopped = true;
        }
      };
      rec.onend = () => {
        wakeRef.current = null;
        if (!stopped) setTimeout(startWake, 800);
      };
      wakeRef.current = rec;
      try {
        rec.start();
        setWakeActive(true);
      } catch {
        setWakeActive(false);
      }
    };
    startWake();
    return () => {
      stopped = true;
      wakeRef.current?.abort();
      setWakeActive(false);
    };
  }, [voiceSettings?.enabled, voiceSettings?.wakeWord, voiceSettings?.lang]);

  const setWakeHandler = useCallback((fn: ((command: string) => void) | null) => {
    wakeHandler.current = fn;
  }, []);

  return (
    <VoiceContext.Provider value={{ listening, speaking, wakeActive, interim, error, listenOnce, stopListening, speak, stopSpeaking, voices, setWakeHandler }}>
      {children}
    </VoiceContext.Provider>
  );
}

export function useVoice(): VoiceContextValue {
  const ctx = useContext(VoiceContext);
  if (!ctx) throw new Error('useVoice outside VoiceProvider');
  return ctx;
}
