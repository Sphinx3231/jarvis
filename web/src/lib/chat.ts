import { useCallback, useEffect, useState } from 'react';
import { api, type ChatMessage, type ChatResult, type CoreState } from './api';
import { useLive } from './live';
import { useVoice } from './voice';

const CONV_KEY = 'jarvis.conversationId';
const readConv = () => {
  try {
    return localStorage.getItem(CONV_KEY);
  } catch {
    return null;
  }
};
const writeConv = (id: string | null) => {
  try {
    if (id) localStorage.setItem(CONV_KEY, id);
    else localStorage.removeItem(CONV_KEY);
  } catch {
    /* storage unavailable */
  }
};

/** Jarvis's live state, with the microphone and speaker folded in. */
export function useCoreState(): CoreState {
  const { state } = useLive();
  const voice = useVoice();
  if (voice.listening) return 'listening';
  if (voice.transcribing) return 'thinking';
  if (voice.speaking) return 'speaking';
  return state.state;
}

/**
 * The conversation with Jarvis: the same one in the full interface and the Jarvis-only view (the
 * conversation id is remembered), so switching views never loses the thread. Whichever view is
 * mounted also takes the wake word.
 */
export function useChat() {
  const { settings } = useLive();
  const voice = useVoice();
  const [conversationId, setConversationId] = useState<string | null>(readConv);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!conversationId) return;
    api
      .get<{ messages: ChatMessage[] }>(`/api/conversations/${conversationId}/messages`)
      .then((r) => setMessages(r.messages))
      .catch(() => {
        writeConv(null);
        setConversationId(null);
      });
  }, [conversationId]);

  const send = useCallback(
    async (text: string, via: 'text' | 'voice') => {
      setSending(true);
      const temp: ChatMessage = { id: `tmp-${Date.now()}`, conversationId: conversationId ?? '', role: 'user', content: text, meta: { via }, createdAt: Date.now() };
      setMessages((m) => [...m, temp]);
      try {
        const res = await api.post<ChatResult>('/api/chat', { conversationId, message: text, via });
        if (res.conversationId !== conversationId) {
          writeConv(res.conversationId);
          setConversationId(res.conversationId);
        }
        setMessages((m) => [...m.filter((x) => x.id !== temp.id), res.userMessage, res.reply]);
        if (settings?.voice.enabled && (via === 'voice' || settings.voice.autoSpeak)) voice.speak(res.reply.content);
      } catch (e) {
        setMessages((m) => [
          ...m,
          { id: `err-${Date.now()}`, conversationId: conversationId ?? '', role: 'assistant', content: `I couldn't reach the Jarvis service: ${(e as Error).message}`, meta: { error: 'network' }, createdAt: Date.now() },
        ]);
      } finally {
        setSending(false);
      }
    },
    [conversationId, settings, voice],
  );

  // Wake word ("Jarvis, …") routes spoken commands here when enabled in Settings.
  useEffect(() => {
    voice.setWakeHandler((cmd) => void send(cmd, 'voice'));
    return () => voice.setWakeHandler(null);
  }, [send, voice]);

  const newConversation = useCallback(() => {
    writeConv(null);
    setConversationId(null);
    setMessages([]);
    voice.stopSpeaking();
  }, [voice]);

  return { messages, sending, send, newConversation };
}
