import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from './api';
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

const isElectron = /Electron\//.test(navigator.userAgent);

export const voiceSupport = {
  /** Browser speech recognition. Electron exposes the API but has no recognition service behind it. */
  recognition: Boolean(RecognitionImpl) && !isElectron,
  /** Recording for server-side transcription. */
  recording: Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined',
  synthesis: typeof window !== 'undefined' && 'speechSynthesis' in window,
  isElectron,
};

export type InputMethod = 'browser' | 'transcription' | 'none';

interface VoiceContextValue {
  listening: boolean;
  /** Recording finished; waiting for the transcription service. */
  transcribing: boolean;
  /** Which voice input method the microphone button will use. */
  inputMethod: InputMethod;
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
  const [transcribing, setTranscribing] = useState(false);
  // Set when browser recognition turns out not to work here (auto mode then records instead).
  const [browserFailed, setBrowserFailed] = useState(false);
  const stopRecording = useRef<(() => void) | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [wakeActive, setWakeActive] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const recRef = useRef<Recognition | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
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
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setSpeaking(false);
  }, []);

  const speak = useCallback(
    async (text: string) => {
      if (!voiceSettings?.enabled) return;
      // Jarvis's own voice: local Kokoro through OpenJarvis (offline), or Fish Audio. Falls back to the
      // browser voice if it fails.
      if (voiceSettings.tts?.provider === 'fish' || voiceSettings.tts?.provider === 'local') {
        stopSpeaking();
        try {
          const blob = await api.postBlob('/api/voice/speak', { text: cleanForSpeech(text) });
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          audioRef.current = audio;
          audio.onplay = () => setSpeaking(true);
          audio.onended = () => {
            setSpeaking(false);
            URL.revokeObjectURL(url);
          };
          audio.onerror = () => setSpeaking(false);
          await audio.play();
          return;
        } catch (err) {
          setError(`${voiceSettings.tts?.provider === 'local' ? 'Local voice' : 'Fish Audio voice'} failed: ${(err as Error).message}. Using the browser voice.`);
        }
      }
      if (!voiceSupport.synthesis) return;
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
    [voiceSettings, voices, stopSpeaking],
  );

  const stopListening = useCallback(() => {
    recRef.current?.stop();
    stopRecording.current?.();
  }, []);

  // Local-only: browser speech recognition (Chrome sends audio to the vendor's cloud) is never used;
  // everything is recorded and transcribed by Whisper on this computer.
  const localOnly = Boolean(settings?.brain?.localOnly);
  const mode = localOnly ? 'transcription' : (voiceSettings?.inputMode ?? 'auto');
  const inputMethod: InputMethod =
    mode === 'browser'
      ? voiceSupport.recognition
        ? 'browser'
        : 'none'
      : mode === 'transcription'
        ? voiceSupport.recording
          ? 'transcription'
          : 'none'
        : voiceSupport.recognition && !browserFailed
          ? 'browser'
          : voiceSupport.recording
            ? 'transcription'
            : 'none';

  /** Record until the speaker pauses, then transcribe on the Jarvis service. */
  const recordOnce = useCallback(async (opts: { waitMs?: number; maxMs?: number; wake?: boolean; shouldStop?: () => boolean } = {}): Promise<string> => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      setError('Microphone access was blocked. Allow it to use voice.');
      return '';
    }
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m));
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const audioCtx = new AudioContext();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    audioCtx.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let heardSpeech = false;
    const started = Date.now();
    let lastLoud = started;
    const done = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
    const finish = () => recorder.state === 'recording' && recorder.stop();
    stopRecording.current = finish;
    const meter = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += v * v;
      const rms = Math.sqrt(sum / samples.length);
      const now = Date.now();
      if (rms > 0.015) {
        heardSpeech = true;
        lastLoud = now;
      }
      if (opts.shouldStop?.()) finish();
      if ((heardSpeech && now - lastLoud > (opts.wake ? 900 : 1500)) || (!heardSpeech && now - started > (opts.waitMs ?? 8000)) || now - started > (opts.maxMs ?? 60_000)) finish();
    }, 100);
    recorder.start(250);
    if (!opts.wake) {
      listeningRef.current = true;
      setListening(true);
    }
    await done;
    clearInterval(meter);
    stopRecording.current = null;
    stream.getTracks().forEach((t) => t.stop());
    void audioCtx.close();
    if (!opts.wake) {
      listeningRef.current = false;
      setListening(false);
    }
    // Nothing was said: don't send silence anywhere.
    if (!heardSpeech || !chunks.length) return '';
    if (!opts.wake) setTranscribing(true);
    try {
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      const { text } = await api.postAudio<{ text: string }>('/api/voice/transcribe', blob);
      return text;
    } catch (e) {
      if (!opts.wake) setError(`Transcription failed: ${(e as Error).message}`);
      return '';
    } finally {
      if (!opts.wake) setTranscribing(false);
    }
  }, []);

  const listenOnce = useCallback(() => {
    if (listeningRef.current) return Promise.resolve('');
    stopSpeaking(); // interrupt Jarvis when the user starts talking
    setError(null);
    if (inputMethod === 'transcription') {
      wakeRef.current?.abort();
      return recordOnce({});
    }
    return new Promise<string>((resolve) => {
      if (inputMethod === 'none' || !RecognitionImpl) {
        setError('Voice input is not available here. Choose a transcription service in Settings → Voice.');
        return resolve('');
      }
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
        if (e.error === 'not-allowed') setError('Microphone access was blocked. Allow it in your browser to use voice.');
        else if ((e.error === 'network' || e.error === 'service-not-allowed' || e.error === 'language-not-supported') && mode === 'auto' && voiceSupport.recording) {
          setBrowserFailed(true);
          setError('Browser speech recognition is unavailable here, so Jarvis will record and transcribe instead. Tap the microphone again.');
        }
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
  }, [stopSpeaking, voiceSettings?.lang, inputMethod, recordOnce, mode]);

  // Wake word mode: only when the user explicitly enables it.
  useEffect(() => {
    // The wake word needs continuous on-device/browser recognition; it never streams audio to a transcription service.
    const enabled = Boolean(voiceSettings?.enabled && voiceSettings.wakeWord && voiceSupport.recognition && inputMethod === 'browser');
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
  }, [voiceSettings?.enabled, voiceSettings?.wakeWord, voiceSettings?.lang, inputMethod]);

  // Local wake word ("Hey Jarvis") for local-only / recording setups: listen for speech on this
  // computer, transcribe only short bursts of actual speech with local Whisper, and act when it starts
  // with the wake word. Nothing leaves the computer; silence is never transcribed.
  const speakingRef = useRef(false);
  useEffect(() => {
    speakingRef.current = speaking;
  }, [speaking]);
  useEffect(() => {
    const enabled = Boolean(voiceSettings?.enabled && voiceSettings.wakeWord && inputMethod === 'transcription' && voiceSupport.recording);
    if (!enabled) return;
    let stopped = false;
    setWakeActive(true);
    const loop = async () => {
      while (!stopped) {
        if (listeningRef.current || speakingRef.current) {
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
        const said = (await recordOnce({ wake: true, waitMs: 30_000, maxMs: 9_000, shouldStop: () => stopped || listeningRef.current })).trim();
        if (stopped || !said) continue;
        const m = said.match(/^(?:hey|hi|ok|okay)?[,\s]*jarvis[,.!?]?\s*(.*)$/i);
        if (!m) continue;
        const command = m[1].trim();
        if (command) wakeHandler.current?.(command);
        else {
          // Just "Hey Jarvis": listen for the request itself.
          const next = await recordOnce({});
          if (next.trim()) wakeHandler.current?.(next.trim());
        }
      }
    };
    void loop();
    return () => {
      stopped = true;
      setWakeActive(false);
    };
  }, [voiceSettings?.enabled, voiceSettings?.wakeWord, inputMethod, recordOnce]);

  const setWakeHandler = useCallback((fn: ((command: string) => void) | null) => {
    wakeHandler.current = fn;
  }, []);

  return (
    <VoiceContext.Provider value={{ listening, transcribing, inputMethod, speaking, wakeActive, interim, error, listenOnce, stopListening, speak, stopSpeaking, voices, setWakeHandler }}>
      {children}
    </VoiceContext.Provider>
  );
}

export function useVoice(): VoiceContextValue {
  const ctx = useContext(VoiceContext);
  if (!ctx) throw new Error('useVoice outside VoiceProvider');
  return ctx;
}
