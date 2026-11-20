import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowRight, Brain, ChevronRight, CircleCheck, Clock, Cpu, Globe, Keyboard, ListChecks, Maximize2, MemoryStick, MessageSquarePlus, Mic, Play, SendHorizontal, Sparkles, Square, SquareTerminal, FolderOpen, Network, TriangleAlert, Volume2, Wrench, Zap, BookmarkPlus } from 'lucide-react';
import { ApprovalsCard } from '../components/Approvals';
import { Core, CORE_LABEL, type OrbAgent } from '../components/Core';
import { AgentDetail, agentIcon, agentStatus, OrbitStage } from '../components/Orbit';
import { Sparkline } from '../components/Sparkline';
import { Progress } from '../components/ui';
import { api, type ActivityEntry, type AgentsResponse, type ChatMessage, type ChatResult, type CoreState, type StatusResponse, type Task } from '../lib/api';
import { bytes, clock, timeAgo, uptime } from '../lib/format';
import { useAction, useLive, useResource } from '../lib/live';
import { useMetrics, type MetricsHistory } from '../lib/metrics';
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

export interface Draft {
  text: string;
  /** Where to put the cursor (defaults to the end). */
  caret?: number;
  n: number;
}

function CommandBar({ onSend, sending, draft }: { onSend: (text: string, via: 'text' | 'voice') => void; sending: boolean; draft: Draft | null }) {
  const [text, setText] = useState('');
  const [typing, setTyping] = useState(false);
  const voice = useVoice();
  const { settings } = useLive();
  const voiceOn = Boolean(settings?.voice.enabled);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // A quick action fills the box (switching to typing) and puts the cursor where the user types next.
  useEffect(() => {
    if (!draft) return;
    setTyping(true);
    setText(draft.text);
    const t = setTimeout(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const at = draft.caret ?? draft.text.length;
      el.setSelectionRange(at, at);
    }, 0);
    return () => clearTimeout(t);
  }, [draft]);

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


// ---------------------------------------------------------------- panels

function Panel({ title, icon, action, children, className = '' }: { title: string; icon?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`hud ${className}`}>
      <header className="hud__head">
        {icon && <span className="hud__icon">{icon}</span>}
        <h2 className="hud__title">{title}</h2>
        {action && <div className="hud__action">{action}</div>}
      </header>
      {children}
    </section>
  );
}

function SystemPanel({ m }: { m: MetricsHistory }) {
  const l = m.latest;
  const rows: Array<{ id: string; label: string; icon: ReactNode; value: string; sub: string; values: number[]; max?: number; tone: string }> = [
    { id: 'cpu', label: 'CPU', icon: <Cpu size={14} />, value: l ? `${Math.round(l.cpuPercent)}%` : '—', sub: l ? `${l.cores} threads` : '', values: m.cpu, max: 100, tone: l && l.cpuPercent > 90 ? 'bad' : 'ok' },
    { id: 'mem', label: 'Memory', icon: <MemoryStick size={14} />, value: l ? `${Math.round(l.memUsedPercent)}%` : '—', sub: l ? `${bytes(l.memUsedBytes)} of ${bytes(l.memTotalBytes)}` : '', values: m.mem, max: 100, tone: l && l.memUsedPercent > 92 ? 'bad' : 'ok' },
    { id: 'rss', label: 'Jarvis', icon: <Zap size={14} />, value: l ? bytes(l.rssBytes) : '—', sub: 'harness RAM', values: m.rss.map((b) => b / 1048576), tone: 'ok' },
  ];
  return (
    <Panel title="System overview" icon={<Cpu size={15} />}>
      <ul className="sysm">
        {rows.map((r) => (
          <li key={r.id} className={`sysm__row sysm__row--${r.id} is-${r.tone}`}>
            <div className="sysm__text">
              <span className="sysm__label">
                {r.icon} {r.label}
              </span>
              <span className="sysm__value">{r.value}</span>
              <span className="sysm__sub">{r.sub}</span>
            </div>
            <Sparkline values={r.values} max={r.max} label={r.label} width={112} height={38} />
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function TasksPanel() {
  const { data } = useResource<{ tasks: Task[] }>('/api/tasks?status=active&limit=6', ['task.updated']);
  const tasks = data?.tasks ?? [];
  return (
    <Panel
      title="Active tasks"
      icon={<ListChecks size={15} />}
      action={
        <button className="hud__count" onClick={() => navigate({ page: 'tasks' })} title="Open Tasks" aria-label={`${tasks.length} active tasks — open Tasks`}>
          {tasks.length}
        </button>
      }
    >
      {tasks.length === 0 ? (
        <div className="hud__empty">
          <CircleCheck size={18} /> No active tasks
        </div>
      ) : (
        <ul className="mini-tasks">
          {tasks.map((t) => (
            <li key={t.id}>
              <button onClick={() => navigate({ page: 'tasks', id: t.id })}>
                <span className={`dot dot--${t.status}`} />
                <span className="mini-tasks__title">{t.title}</span>
                <span className="mini-tasks__meta">{t.status === 'queued' && t.scheduledFor && t.scheduledFor > Date.now() ? clock(t.scheduledFor) : t.status.replace('_', ' ')}</span>
                <ChevronRight size={14} className="mini-tasks__chev" />
              </button>
              {t.status === 'running' && t.plan && <Progress value={t.progress} />}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function ActivityPanel() {
  const { data } = useResource<{ activity: ActivityEntry[] }>('/api/activity?limit=14', ['activity']);
  return (
    <Panel
      title="Recent activity"
      icon={<Clock size={15} />}
      action={
        <button className="link link--accent" onClick={() => navigate({ page: 'activity' })}>
          All <ArrowRight size={13} />
        </button>
      }
    >
      <ul className="feed">
        {(data?.activity ?? []).map((a) => (
          <li key={a.id} className={`feed__item lvl-${a.level}`}>
            <span className="feed__dot" />
            <span className="feed__msg" title={a.message}>
              {a.message}
            </span>
            <span className="feed__time">{timeAgo(a.ts)}</span>
          </li>
        ))}
        {data && data.activity.length === 0 && <li className="hud__empty">Nothing yet.</li>}
      </ul>
    </Panel>
  );
}

function CorePanel({ status, coreState, detail, agents }: { status: StatusResponse | null; coreState: CoreState; detail: string; agents: AgentsResponse | null }) {
  const s = status?.status;
  const list = agents?.agents ?? [];
  const ready = list.filter((a) => ['ready', 'working'].includes(agentStatus(a, agents?.enabled ?? false).key)).length;
  const working = list.filter((a) => a.state === 'working').length;
  const model = s?.model;
  return (
    <Panel title="Jarvis core" icon={<Sparkles size={15} />} className="hud--core">
      <div className={`corestat corestat--${coreState}`}>
        <span className="corestat__dot" />
        <div>
          <div className="corestat__state">{CORE_LABEL[coreState]}</div>
          <div className="corestat__detail" title={detail}>
            {detail}
          </div>
        </div>
      </div>
      <dl className="kv">
        <div className="kv__row">
          <dt>Brain</dt>
          <dd className={model ? (model.healthy === false ? 'bad' : 'ok') : 'warn'} title={model ? `${model.model} via ${model.provider}` : 'No model configured'}>
            {model ? (model.healthy === false ? 'Unreachable' : model.model) : 'No model'}
          </dd>
        </div>
        <div className="kv__row kv__row--bar">
          <dt>Agent network</dt>
          <dd className={!agents?.enabled ? 'warn' : ready === list.length ? 'ok' : 'warn'}>
            {agents ? (agents.enabled ? `${ready}/${list.length} ready${working ? ` · ${working} working` : ''}` : 'Paused') : '…'}
          </dd>
          <Progress value={list.length ? ready / list.length : 0} tone={agents?.enabled && ready === list.length ? 'accent' : 'warning'} />
        </div>
        <div className="kv__row">
          <dt>Memory</dt>
          <dd>
            <button className="link link--accent" onClick={() => navigate({ page: 'memory' })}>
              {s ? `${s.memory.total - (s.memory.byKind.tool_doc ?? 0)} items${s.memory.unverified ? ` · ${s.memory.unverified} to confirm` : ''}` : '…'}
            </button>
          </dd>
        </div>
        <div className="kv__row">
          <dt>Tools</dt>
          <dd className={s && s.skills.available === s.skills.total ? 'ok' : 'warn'}>{s ? `${s.skills.available}/${s.skills.total} ready` : '…'}</dd>
        </div>
        <div className="kv__row">
          <dt>Background</dt>
          <dd className={s?.background.enabled ? 'ok' : 'warn'}>{s ? (s.background.enabled ? 'Monitoring' : 'Paused') : '…'}</dd>
        </div>
        <div className="kv__row">
          <dt>Uptime</dt>
          <dd>{s ? uptime(s.uptimeSec) : '…'}</dd>
        </div>
      </dl>
    </Panel>
  );
}

function AgentsPanel({ agents, onSelect }: { agents: AgentsResponse | null; onSelect: (id: string) => void }) {
  if (!agents) return null;
  return (
    <Panel title="Agents" icon={<Network size={15} />}>
      <ul className="agentlist">
        {agents.agents.map((a) => {
          const st = agentStatus(a, agents.enabled);
          return (
            <li key={a.id} className={`agents__row agents__row--${st.key}`} style={{ ['--c' as string]: a.color }}>
              <button onClick={() => onSelect(a.id)} title={a.role} aria-label={`${a.name} — ${st.label}. Open details.`}>
                <span className="agents__icon">{agentIcon(a.id, 14)}</span>
                <span className="agents__text">
                  <span className="agents__name">{a.name}</span>
                  <span className="agents__summary">{a.lastSummary || 'Has not run yet'}</span>
                </span>
                <span className={`agents__state agents__state--${st.key}`}>{st.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {!agents.enabled && <p className="hud__note">Agents are paused — turn them on in Settings → Sub-agents.</p>}
    </Panel>
  );
}

function InsightsPanel({ status }: { status: StatusResponse | null }) {
  const items = (status?.insights ?? []).filter((i) => i.id !== 'approvals');
  if (!items.length) return null;
  return (
    <Panel title="Jarvis noticed" icon={<TriangleAlert size={15} />}>
      <ul className="insights">
        {items.map((i) => (
          <li key={i.id} className={`insight insight--${i.level}`}>
            <button onClick={() => navigate({ page: i.page as never })}>
              {i.text} <ArrowRight size={13} />
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function QuickActions({ onDraft, onNewChat, onImmersive, agents, hasConversation }: { onDraft: (text: string, caret?: number) => void; onNewChat: () => void; onImmersive: () => void; agents: AgentsResponse | null; hasConversation: boolean }) {
  const act = useAction();
  const [running, setRunning] = useState(false);
  const runAll = async () => {
    if (!agents) return;
    setRunning(true);
    await act(async () => {
      for (const a of agents.agents) await api.post(`/api/subagents/${a.id}/run`);
    }, 'All agents ran');
    setRunning(false);
  };
  const items: Array<{ id: string; label: string; icon: ReactNode; run: () => void; disabled?: boolean; title: string }> = [
    { id: 'cmd', label: 'Run command', icon: <SquareTerminal size={16} />, run: () => onDraft('run ``', 5), title: 'Run a shell command (you type it)' },
    { id: 'web', label: 'Search web', icon: <Globe size={16} />, run: () => onDraft('Search the web for '), title: 'Ask Jarvis to search the web' },
    { id: 'files', label: 'Browse files', icon: <FolderOpen size={16} />, run: () => onDraft('list files'), title: 'List the files in your workspace' },
    { id: 'remember', label: 'Remember', icon: <BookmarkPlus size={16} />, run: () => onDraft('remember that '), title: 'Tell Jarvis something to remember' },
    { id: 'agents', label: running ? 'Running…' : 'Run agents', icon: <Play size={16} />, run: () => void runAll(), disabled: running || !agents, title: 'Run all six agents now' },
    hasConversation
      ? { id: 'new', label: 'New chat', icon: <MessageSquarePlus size={16} />, run: onNewChat, title: 'Start a new conversation' }
      : { id: 'immersive', label: 'Immersive', icon: <Maximize2 size={16} />, run: onImmersive, title: 'Make Jarvis the whole screen (\\)' },
  ];
  return (
    <Panel title="Quick actions" icon={<Zap size={15} />}>
      <div className="qa">
        {items.map((q) => (
          <button key={q.id} className="qa__btn" onClick={q.run} disabled={q.disabled} title={q.title}>
            {q.icon}
            <span>{q.label}</span>
          </button>
        ))}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- page

export function HomePage({ status, onImmersive }: { status: StatusResponse | null; onImmersive: () => void }) {
  const { state, settings } = useLive();
  const voice = useVoice();
  const coreState = useCoreState();
  const agentsRes = useResource<AgentsResponse>('/api/subagents', ['agents.changed', 'settings.changed']);
  const agents = agentsRes.data;
  const orbAgents: OrbAgent[] = (agents?.agents ?? []).map((a) => ({ id: a.id, name: a.name, color: a.color, summary: a.lastSummary, working: a.state === 'working' }));
  const [conversationId, setConversationId] = useState<string | null>(readConv);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const metrics = useMetrics();
  const tasksRes = useResource<{ tasks: Task[] }>('/api/tasks?status=active&limit=50', ['task.updated']);
  const reduceMotion = Boolean(settings?.appearance.reduceMotion) || (typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches));

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
  const onDraft = useCallback((text: string, caret?: number) => setDraft((d) => ({ text, caret, n: (d?.n ?? 0) + 1 })), []);
  const closeDetail = useCallback(() => setSelected(null), []);

  const hasConversation = messages.length > 0;
  const name = settings?.assistant.userName;
  const statusLine = coreState === 'listening' ? voice.interim || 'Listening…' : coreState === 'speaking' ? 'Speaking…' : state.detail;
  const selectedAgent = useMemo(() => agents?.agents.find((a) => a.id === selected) ?? null, [agents, selected]);

  return (
    <div className={`dash ${hasConversation ? 'dash--chat' : ''}`}>
      <aside className="dash__col dash__left" aria-label="System">
        <SystemPanel m={metrics} />
        <TasksPanel />
        <ActivityPanel />
      </aside>

      <section className="dash__center" aria-label="Jarvis">
        {hasConversation ? (
          <>
            <div className="chathead">
              <Core state={coreState} size={92} reduceMotion={reduceMotion} agents={orbAgents} />
              <div className="chathead__text">
                <h1 className="chathead__title">
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
              <button className="btn btn--ghost btn--sm" onClick={newConversation} title="Start a new conversation">
                <MessageSquarePlus size={15} /> <span>New chat</span>
              </button>
            </div>
            <Conversation messages={messages} sending={sending} />
          </>
        ) : (
          <OrbitStage
            agents={agents?.agents ?? []}
            enabled={agents?.enabled ?? false}
            state={coreState}
            detail={statusLine}
            wakeActive={voice.wakeActive}
            reduceMotion={reduceMotion}
            onSelect={setSelected}
            telemetry={{
              cpu: metrics.latest?.cpuPercent ?? null,
              mem: metrics.latest?.memUsedPercent ?? null,
              cores: metrics.latest?.cores ?? status?.status.host.cpus ?? null,
              tasksRunning: (tasksRes.data?.tasks ?? []).filter((t) => t.status === 'running').length,
              tasksActive: tasksRes.data?.tasks.length ?? 0,
              tasksMax: settings?.background.maxConcurrentTasks ?? 3,
              monitoring: status?.status.background.enabled ?? false,
              startedAt: status?.status.startedAt ?? null,
              platform: status?.status.host.platform ?? null,
              version: status?.status.version ?? null,
            }}
          />
        )}
        <CommandBar onSend={send} sending={sending} draft={draft} />
      </section>

      <aside className="dash__col dash__right" aria-label="Jarvis status">
        <CorePanel status={status} coreState={coreState} detail={statusLine} agents={agents} />
        <ApprovalsCard compact hideWhenEmpty />
        <QuickActions onDraft={onDraft} onNewChat={newConversation} onImmersive={onImmersive} agents={agents} hasConversation={hasConversation} />
        <AgentsPanel agents={agents} onSelect={setSelected} />
        <InsightsPanel status={status} />
      </aside>

      {selectedAgent && <AgentDetail agent={selectedAgent} enabled={agents?.enabled ?? false} onClose={closeDetail} />}
    </div>
  );
}
