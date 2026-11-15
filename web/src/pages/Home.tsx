import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowRight, Brain, Bug, CircleCheck, Clock, Cpu, Crosshair, Keyboard, ListChecks, MessageSquarePlus, Mic, Radio, SendHorizontal, ShieldCheck, Sparkles, Square, TrendingUp, TriangleAlert, Volume2, Wrench, Zap } from 'lucide-react';
import type { ReactNode } from 'react';
import { ApprovalsCard } from '../components/Approvals';
import { Core, CORE_LABEL, type OrbAgent } from '../components/Core';
import { Card, Progress } from '../components/ui';
import { api, type ActivityEntry, type AgentsResponse, type ChatMessage, type ChatResult, type CoreState, type StatusResponse, type Task } from '../lib/api';
import { bytes, clock, timeAgo, uptime } from '../lib/format';
import { useAction, useLive, useResource } from '../lib/live';
import { navigate } from '../lib/router';
import { useVoice } from '../lib/voice';

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

function useCoreState(): CoreState {
  const { state } = useLive();
  const voice = useVoice();
  if (voice.listening) return 'listening';
  if (voice.transcribing) return 'thinking';
  if (voice.speaking) return 'speaking';
  return state.state;
}

function AgentsCard() {
  const act = useAction();
  const { data } = useResource<AgentsResponse>('/api/subagents', ['agents.changed', 'settings.changed']);
  if (!data) return null;
  return (
    <Card title="Agents" icon={<Sparkles size={18} />}>
      <ul className="agents">
        {data.agents.map((a) => (
          <li key={a.id} className="agents__row">
            <span className="agents__dot" style={{ background: a.color, boxShadow: `0 0 8px ${a.color}` }} />
            <div className="agents__text">
              <div className="agents__name">
                {a.name}
                {a.state === 'working' && <span className="agents__busy"> · working…</span>}
              </div>
              <div className="muted small agents__summary" title={a.role}>{a.lastSummary}</div>
            </div>
            <button className="agents__run" onClick={() => act(() => api.post(`/api/subagents/${a.id}/run`), `${a.name} ran`)} aria-label={`Run ${a.name} now`} title={`Run ${a.name} now`}>
              <ArrowRight size={14} />
            </button>
          </li>
        ))}
      </ul>
      {!data.enabled && <p className="muted small">Agents are paused (Settings → turn them on).</p>}
    </Card>
  );
}

const AGENT_ICON: Record<string, ReactNode> = {
  friday: <TrendingUp size={20} />,
  tom: <Crosshair size={20} />,
  neo: <Activity size={20} />,
  sentinel: <ShieldCheck size={20} />,
  echo: <Radio size={20} />,
  trinity: <Bug size={20} />,
};
// Fixed slots around the core so the ring reads like the reference. `tx` anchors the pill
// (left edge / right edge / centered) so side nodes never clip in the narrower windowed layout.
const ANCHOR = { l: 'translate(0, -50%)', r: 'translate(-100%, -50%)', c: 'translate(-50%, -50%)' };
const AGENT_SLOTS = [
  { left: '8%', top: '19%', a: 'l' as const }, // Friday — top-left
  { left: '92%', top: '19%', a: 'r' as const }, // Tom — top-right
  { left: '2%', top: '49%', a: 'l' as const }, // Neo — mid-left
  { left: '98%', top: '49%', a: 'r' as const }, // Sentinel — mid-right
  { left: '16%', top: '79%', a: 'l' as const }, // Echo — bottom-left
  { left: '84%', top: '79%', a: 'r' as const }, // Trinity — bottom-right
];

/** The agents as labeled satellite nodes ringing Jarvis — click one to run it now. */
function AgentNodes({ agents }: { agents: AgentsResponse['agents'] }) {
  const act = useAction();
  return (
    <div className="stage__agents">
      {agents.map((a, i) => {
        const slot = AGENT_SLOTS[i] ?? { left: `${50 + 44 * Math.cos((i / agents.length) * 2 * Math.PI - Math.PI / 2)}%`, top: `${46 + 40 * Math.sin((i / agents.length) * 2 * Math.PI - Math.PI / 2)}%`, a: 'c' as const };
        const working = a.state === 'working';
        return (
          <button
            key={a.id}
            className={`anode ${working ? 'is-working' : ''}`}
            style={{ left: slot.left, top: slot.top, transform: ANCHOR[slot.a], ['--c' as string]: a.color }}
            onClick={() => act(() => api.post(`/api/subagents/${a.id}/run`), `${a.name} ran`)}
            title={`${a.role}\n${a.lastSummary}`}
            aria-label={`${a.name} — ${working ? 'working' : 'online'}. Run now.`}
          >
            <span className="anode__icon">{AGENT_ICON[a.id] ?? <Sparkles size={20} />}</span>
            <span className="anode__body">
              <span className="anode__name">{a.name}</span>
              <span className="anode__status">
                <i className="anode__dot" /> {working ? 'Working' : 'Online'}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Actions({ message }: { message: ChatMessage }) {
  const { settings } = useLive();
  // With "do what I ask" on, what you asked for runs; only extra steps ask (shown under Pending approvals).
  const asks = !(settings?.permissions.followRequests ?? true);
  const actions = message.meta.actions ?? [];
  if (!actions.length) return null;
  return (
    <div className="msg__actions">
      {actions.map((a, i) => {
        if (a.type === 'task_created')
          return (
            <button key={i} className="chip chip--task" onClick={() => navigate({ page: 'tasks', id: a.taskId })}>
              <ListChecks size={13} /> {a.deduplicated ? 'Already running' : a.scheduledFor ? `Scheduled ${clock(a.scheduledFor)}` : 'Task queued'}: {a.title}
              {asks && a.needsApproval.length > 0 && <span className="chip__warn">needs approval</span>}
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
  const [typing, setTyping] = useState(false);
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

  // Voice-first: the microphone is the primary way in; typing is a fallback a tap away.
  const voicePrimary = voiceOn && voice.inputMethod !== 'none' && !typing;

  return (
    <div className="command">
      {voice.error && <div className="command__note">{voice.error}</div>}
      {voicePrimary ? (
        <div className={`command__voice ${voice.listening ? 'is-listening' : ''}`}>
          <button className={`command__talk ${voice.listening ? 'is-on' : ''}`} onClick={mic} aria-label={voice.listening ? 'Stop listening' : 'Talk to Jarvis'}>
            <Mic size={26} />
          </button>
          <div className="command__voicehint">
            {voice.listening ? voice.interim || 'Listening… (pause to finish)' : voice.transcribing ? 'Transcribing…' : voice.wakeActive ? 'Say “Hey Jarvis”, or tap to talk' : 'Tap to talk'}
          </div>
          {voice.speaking && (
            <button className="command__stop" onClick={voice.stopSpeaking} aria-label="Stop speaking" title="Stop speaking">
              <Square size={15} />
            </button>
          )}
          <button className="command__type" onClick={() => setTyping(true)} aria-label="Type instead" title="Type instead">
            <Keyboard size={17} />
          </button>
        </div>
      ) : (
        <div className={`command__bar ${voice.listening ? 'is-listening' : ''}`}>
          {voiceOn && voice.inputMethod !== 'none' && (
            <button className={`command__mic ${voice.listening ? 'is-on' : ''}`} onClick={() => { setTyping(false); void mic(); }} aria-label={voice.listening ? 'Stop listening' : 'Speak to Jarvis'} title={voice.listening ? 'Stop listening' : 'Speak to Jarvis'}>
              <Mic size={20} />
            </button>
          )}
          <textarea
            ref={inputRef}
            className="command__input"
            rows={1}
            placeholder={voice.listening ? voice.interim || 'Listening… (pause to finish)' : voice.transcribing ? 'Transcribing…' : 'Tell Jarvis what to do…'}
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
      )}
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
  const coreState = useCoreState();
  const agentsRes = useResource<AgentsResponse>('/api/subagents', ['agents.changed', 'settings.changed']);
  const orbAgents: OrbAgent[] = (agentsRes.data?.agents ?? []).map((a) => ({ id: a.id, name: a.name, color: a.color, summary: a.lastSummary, working: a.state === 'working' }));
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
  const statusLine = coreState === 'listening' ? voice.interim || 'Listening…' : coreState === 'speaking' ? 'Speaking…' : state.detail;

  return (
    <div className="home">
      <div className={`home__main ${hasConversation ? 'has-conversation' : ''}`}>
        {hasConversation ? (
          <div className="hero hero--compact">
            <Core state={coreState} size={140} reduceMotion={settings?.appearance.reduceMotion} agents={orbAgents} />
            <div className="hero__text">
              <h1 className="hero__title">
                Hello{name ? `, ${name}` : ''}. I’m <span className="accent">Jarvis.</span>
              </h1>
              <div className={`state-pill state-pill--${coreState}`}>
                <span className="state-pill__dot" />
                {CORE_LABEL[coreState]}
                <span className="state-pill__detail">· {statusLine}</span>
                {voice.wakeActive && (
                  <span className="state-pill__detail" title="Wake word is on: say “Hey Jarvis…”">
                    · <Volume2 size={12} /> wake word on
                  </span>
                )}
              </div>
            </div>
            <button className="btn btn--ghost btn--sm hero__new" onClick={newConversation} title="Start a new conversation">
              <MessageSquarePlus size={15} /> <span>New chat</span>
            </button>
          </div>
        ) : (
          <div className="stage">
            <AgentNodes agents={agentsRes.data?.agents ?? []} />
            <div className="stage__core">
              <Core state={coreState} size={440} reduceMotion={settings?.appearance.reduceMotion} wordmark />
            </div>
            <div className="stage__portal" aria-hidden>
              <i />
              <i />
              <i />
            </div>
            <div className={`state-pill state-pill--${coreState} stage__state`}>
              <span className="state-pill__dot" />
              {CORE_LABEL[coreState]}
              <span className="state-pill__detail">· {statusLine}</span>
              {voice.wakeActive && (
                <span className="state-pill__detail" title="Wake word is on: say “Hey Jarvis…”">
                  · <Volume2 size={12} /> wake word on
                </span>
              )}
            </div>
          </div>
        )}
        {hasConversation && <Conversation messages={messages} sending={sending} />}
        <CommandBar onSend={send} sending={sending} />
      </div>
      <aside className="home__side">
        <AgentsCard />
        <ApprovalsCard compact hideWhenEmpty />
        <ActiveTasksCard />
        <StatusCard status={status} />
        <InsightsCard status={status} />
        <ActivityCard />
      </aside>
    </div>
  );
}
