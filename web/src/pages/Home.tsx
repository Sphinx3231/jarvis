import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Brain, CircleCheck, Clock, Cpu, ListChecks, MessageSquarePlus, Mic, SendHorizontal, Sparkles, Square, TriangleAlert, Volume2, Wrench, Zap } from 'lucide-react';
import { ApprovalsCard } from '../components/Approvals';
import { Dragon, DRAGON_LABEL } from '../components/Dragon';
import { Card, Progress } from '../components/ui';
import { api, type ActivityEntry, type ChatMessage, type ChatResult, type DragonState, type StatusResponse, type Task } from '../lib/api';
import { bytes, clock, timeAgo, uptime } from '../lib/format';
import { useLive, useResource } from '../lib/live';
import { navigate } from '../lib/router';
import { useVoice, voiceSupport } from '../lib/voice';

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

function useDragonState(): DragonState {
  const { state } = useLive();
  const voice = useVoice();
  if (voice.listening) return 'listening';
  if (voice.speaking) return 'speaking';
  return state.state;
}

function Actions({ message }: { message: ChatMessage }) {
  const actions = message.meta.actions ?? [];
  if (!actions.length) return null;
  return (
    <div className="msg__actions">
      {actions.map((a, i) => {
        if (a.type === 'task_created')
          return (
            <button key={i} className="chip chip--task" onClick={() => navigate({ page: 'tasks', id: a.taskId })}>
              <ListChecks size={13} /> {a.deduplicated ? 'Already running' : a.scheduledFor ? `Scheduled ${clock(a.scheduledFor)}` : 'Task queued'}: {a.title}
              {a.needsApproval.length > 0 && <span className="chip__warn">needs approval</span>}
            </button>
          );
        if (a.type === 'memory_saved')
          return (
            <button key={i} className="chip" onClick={() => navigate({ page: 'memory' })}>
              <Brain size={13} /> {a.merged ? 'Memory updated' : a.verified ? 'Remembered' : 'Saved to memory (unverified)'}
            </button>
          );
        if (a.type === 'task_control')
          return (
            <span key={i} className="chip">
              <ListChecks size={13} /> Task {a.action}
            </span>
          );
        return (
          <span key={i} className={`chip chip--tool ${a.ok ? '' : 'chip--bad'}`}>
            <Wrench size={13} /> {a.skill}
          </span>
        );
      })}
    </div>
  );
}

function Conversation({ messages, sending }: { messages: ChatMessage[]; sending: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [messages.length, sending]);
  return (
    <div className="conversation" aria-live="polite">
      {messages.map((m) => (
        <div key={m.id} className={`msg msg--${m.role} ${m.meta.error ? 'msg--error' : ''}`}>
          <div className="msg__bubble">{m.content}</div>
          {m.role === 'assistant' && <Actions message={m} />}
          <div className="msg__time">
            {clock(m.createdAt)}
            {m.meta.via === 'voice' ? ' · voice' : ''}
          </div>
        </div>
      ))}
      {sending && (
        <div className="msg msg--assistant">
          <div className="msg__bubble msg__typing" aria-label="Jarvis is thinking">
            <span />
            <span />
            <span />
          </div>
        </div>
      )}
      <div ref={end} />
    </div>
  );
}

function CommandBar({ onSend, sending }: { onSend: (text: string, via: 'text' | 'voice') => void; sending: boolean }) {
  const [text, setText] = useState('');
  const voice = useVoice();
  const { settings } = useLive();
  const voiceOn = Boolean(settings?.voice.enabled);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const t = text.trim();
    if (!t || sending) return;
    onSend(t, 'text');
    setText('');
  };

  const mic = async () => {
    if (voice.listening) return voice.stopListening();
    const heard = await voice.listenOnce();
    if (heard) onSend(heard, 'voice');
  };

  return (
    <div className="command">
      {voice.error && <div className="command__note">{voice.error}</div>}
      <div className={`command__bar ${voice.listening ? 'is-listening' : ''}`}>
        {voiceOn && voiceSupport.recognition && (
          <button className={`command__mic ${voice.listening ? 'is-on' : ''}`} onClick={mic} aria-label={voice.listening ? 'Stop listening' : 'Speak to Jarvis'} title={voice.listening ? 'Stop listening' : 'Speak to Jarvis'}>
            <Mic size={20} />
          </button>
        )}
        <textarea
          ref={inputRef}
          className="command__input"
          rows={1}
          placeholder={voice.listening ? voice.interim || 'Listening…' : 'Tell Jarvis what to do…'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          aria-label="Message Jarvis"
          maxLength={20000}
          autoFocus
        />
        {voice.speaking && (
          <button className="command__stop" onClick={voice.stopSpeaking} aria-label="Stop speaking" title="Stop speaking">
            <Square size={15} />
          </button>
        )}
        <button className="command__send" onClick={submit} disabled={!text.trim() || sending} aria-label="Send">
          <SendHorizontal size={19} />
        </button>
      </div>
    </div>
  );
}

function ActiveTasksCard() {
  const { data } = useResource<{ tasks: Task[] }>('/api/tasks?status=active&limit=6', ['task.updated']);
  const tasks = data?.tasks ?? [];
  return (
    <Card
      title="Active Tasks"
      icon={<ListChecks size={18} />}
      action={
        <button className="link link--accent" onClick={() => navigate({ page: 'tasks' })}>
          View all <ArrowRight size={14} />
        </button>
      }
    >
      {tasks.length === 0 ? (
        <div className="empty empty--compact">
          <CircleCheck size={34} strokeWidth={1.5} className="empty__icon" />
          <div className="muted">No active tasks</div>
        </div>
      ) : (
        <ul className="mini-tasks">
          {tasks.map((t) => (
            <li key={t.id}>
              <button onClick={() => navigate({ page: 'tasks', id: t.id })}>
                <span className={`dot dot--${t.status}`} />
                <span className="mini-tasks__title">{t.title}</span>
                <span className="mini-tasks__meta">{t.status === 'queued' && t.scheduledFor && t.scheduledFor > Date.now() ? clock(t.scheduledFor) : t.status.replace('_', ' ')}</span>
              </button>
              {t.status === 'running' && t.plan && <Progress value={t.progress} />}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function StatusCard({ status }: { status: StatusResponse | null }) {
  if (!status) return <Card title="System Status" icon={<Cpu size={18} />}>…</Card>;
  const s = status.status;
  const used = 1 - s.host.freeMemBytes / s.host.totalMemBytes;
  return (
    <Card title="System Status" icon={<Cpu size={18} />}>
      <dl className="stats">
        <div className="stats__row">
          <dt>
            <Cpu size={16} /> Memory
          </dt>
          <dd className="stats__bar" title={`Host RAM in use: ${bytes(s.host.totalMemBytes - s.host.freeMemBytes)} of ${bytes(s.host.totalMemBytes)} · Jarvis uses ${bytes(s.process.rssBytes)}`}>
            <Progress value={used} tone={used > 0.9 ? 'danger' : 'accent'} />
            <span>{Math.round(used * 100)}%</span>
          </dd>
        </div>
        <div className="stats__row">
          <dt>
            <Clock size={16} /> Uptime
          </dt>
          <dd className="accent">{uptime(s.uptimeSec)}</dd>
        </div>
        <div className="stats__row">
          <dt>
            <Wrench size={16} /> Tools
          </dt>
          <dd className={s.skills.available === s.skills.total ? 'ok' : 'warn'}>
            {s.skills.available}/{s.skills.total} ready
          </dd>
        </div>
        <div className="stats__row">
          <dt>
            <Sparkles size={16} /> Model
          </dt>
          <dd className={s.model ? (s.model.healthy === false ? 'bad' : 'ok') : 'warn'} title={s.model ? `${s.model.model} via ${s.model.provider}` : undefined}>
            {s.model ? (s.model.healthy === false ? 'Unreachable' : s.model.model) : 'Not configured'}
          </dd>
        </div>
        <div className="stats__row">
          <dt>
            <Zap size={16} /> Background
          </dt>
          <dd className={s.background.enabled ? 'ok' : 'warn'}>{s.background.enabled ? 'Monitoring' : 'Paused'}</dd>
        </div>
      </dl>
    </Card>
  );
}

function InsightsCard({ status }: { status: StatusResponse | null }) {
  const items = (status?.insights ?? []).filter((i) => i.id !== 'approvals');
  if (!items.length) return null;
  return (
    <Card title="Jarvis noticed" icon={<TriangleAlert size={18} />}>
      <ul className="insights">
        {items.map((i) => (
          <li key={i.id} className={`insight insight--${i.level}`}>
            <button onClick={() => navigate({ page: i.page as never })}>
              {i.text} <ArrowRight size={13} />
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ActivityCard() {
  const { data } = useResource<{ activity: ActivityEntry[] }>('/api/activity?limit=6', ['activity']);
  return (
    <Card title="Recent Activity" icon={<Clock size={18} />}>
      <ul className="feed">
        {(data?.activity ?? []).map((a) => (
          <li key={a.id} className={`feed__item lvl-${a.level}`}>
            <span className="feed__dot" />
            <span className="feed__msg">{a.message}</span>
            <span className="feed__time">{timeAgo(a.ts)}</span>
          </li>
        ))}
        {data && data.activity.length === 0 && <li className="muted">Nothing yet.</li>}
      </ul>
    </Card>
  );
}

export function HomePage({ status }: { status: StatusResponse | null }) {
  const { state, settings } = useLive();
  const voice = useVoice();
  const dragonState = useDragonState();
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

  const newConversation = () => {
    writeConv(null);
    setConversationId(null);
    setMessages([]);
    voice.stopSpeaking();
  };

  const hasConversation = messages.length > 0;
  const name = settings?.assistant.userName;
  const statusLine = dragonState === 'listening' ? voice.interim || 'Listening…' : dragonState === 'speaking' ? 'Speaking…' : state.detail;

  return (
    <div className="home">
      <div className={`home__main ${hasConversation ? 'has-conversation' : ''}`}>
        <div className="hero">
          <Dragon state={dragonState} size={hasConversation ? 92 : 248} reduceMotion={settings?.appearance.reduceMotion} />
          <div className="hero__text">
            <h1 className="hero__title">
              Hello{name ? `, ${name}` : ''}. I’m <span className="accent">Jarvis.</span>
            </h1>
            {!hasConversation && <p className="hero__sub">How can I help you today?</p>}
            <div className={`state-pill state-pill--${dragonState}`}>
              <span className="state-pill__dot" />
              {DRAGON_LABEL[dragonState]}
              <span className="state-pill__detail">· {statusLine}</span>
              {voice.wakeActive && (
                <span className="state-pill__detail" title="Wake word is on: say “Jarvis, …”">
                  · <Volume2 size={12} /> wake word on
                </span>
              )}
            </div>
          </div>
          {hasConversation && (
            <button className="btn btn--ghost btn--sm hero__new" onClick={newConversation} title="Start a new conversation">
              <MessageSquarePlus size={15} /> <span>New chat</span>
            </button>
          )}
        </div>
        {hasConversation && <Conversation messages={messages} sending={sending} />}
        <CommandBar onSend={send} sending={sending} />
      </div>
      <aside className="home__side">
        <ApprovalsCard compact hideWhenEmpty />
        <ActiveTasksCard />
        <StatusCard status={status} />
        <InsightsCard status={status} />
        <ActivityCard />
      </aside>
    </div>
  );
}
