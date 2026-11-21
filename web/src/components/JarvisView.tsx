import { useLayoutEffect, useRef, useState } from 'react';
import { LayoutDashboard, ShieldAlert } from 'lucide-react';
import { Core, CORE_LABEL } from './Core';
import type { AgentsResponse, Approval, ChatMessage, CoreState } from '../lib/api';
import { useChat, useCoreState } from '../lib/chat';
import { useLive, useResource } from '../lib/live';
import { useMetrics } from '../lib/metrics';
import { navigate } from '../lib/router';
import { useVoice } from '../lib/voice';
import { CommandBar } from '../pages/Home';
import { gsap, reducedMotion, useGSAP } from '../motion/gsap';
import { agentEvents } from '../motion/orbitMotion';
import type { AgentInfo } from '../lib/api';

/**
 * Jarvis and nothing else: the core, a targeting HUD built around it, what Jarvis is doing, its
 * latest answer, and the voice/command bar. The full interface is one key away (\) or the button
 * in the corner. Everything the HUD shows is live — the core's state, CPU and memory, the six
 * agents (lit only while they really work) — and its rings turn faster while Jarvis is busy.
 */

// HUD geometry in a 1000 × 1000 view box; the core is drawn at half the box (radius ≈ 335).
const C = 500;
const R = 335;
const polar = (r: number, deg: number) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [C + r * Math.cos(a), C + r * Math.sin(a)] as const;
};
const arc = (r: number, a0: number, a1: number) => {
  const [x0, y0] = polar(r, a0);
  const [x1, y1] = polar(r, a1);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
};
const TICKS = Array.from({ length: 180 }, (_, i) => {
  const deg = i * 2;
  const major = i % 15 === 0;
  const [x1, y1] = polar(R + 16, deg);
  const [x2, y2] = polar(R + (major ? 30 : 22), deg);
  return { x1, y1, x2, y2, major };
});
// The six agents sit on the outer ring, in roster order.
const SAT_DEG = [-50, 50, -90, 90, -130, 130];
const SAT_R = 452;
const NO_AGENTS: AgentInfo[] = [];

/** How fast the rings turn, by Jarvis's real state. */
const PACE: Record<CoreState, number> = { idle: 1, listening: 1.7, thinking: 3.2, working: 2.6, speaking: 1.9, success: 1.2, error: 0.35 };

function useStageSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize(Math.max(320, Math.min(el.clientWidth * 0.94, el.clientHeight)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

function lastExchange(messages: ChatMessage[]): { asked: ChatMessage | null; answer: ChatMessage | null } {
  let answer: ChatMessage | null = null;
  let asked: ChatMessage | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!answer && m.role === 'assistant') answer = m;
    else if (m.role === 'user') {
      asked = m;
      break;
    }
  }
  return { asked, answer: answer && asked && answer.createdAt < asked.createdAt ? null : answer };
}

export function JarvisView({ onExit }: { onExit: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const size = useStageSize(stageRef);
  const { connected, state: live, settings } = useLive();
  const voice = useVoice();
  const state = useCoreState();
  const { messages, sending, send } = useChat();
  const metrics = useMetrics();
  const agents = useResource<AgentsResponse>('/api/subagents', ['agents.changed', 'settings.changed']).data?.agents ?? NO_AGENTS;
  const approvals = useResource<{ approvals: Approval[] }>('/api/approvals?status=pending', ['approval.updated', 'task.updated']).data?.approvals ?? [];
  const reduce = Boolean(settings?.appearance.reduceMotion) || (typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches));
  const detail = state === 'listening' ? voice.interim || 'Listening…' : state === 'speaking' ? 'Speaking…' : sending ? 'Working on it…' : live.detail;
  const { asked, answer } = lastExchange(messages);
  const cpu = metrics.latest?.cpuPercent ?? null;
  const mem = metrics.latest?.memUsedPercent ?? null;
  const spins = useRef<gsap.core.Tween[]>([]);
  const ready = size > 0;

  // Power-on, then the rings' slow turn (its pace follows the state below).
  useGSAP(
    () => {
      if (!ready) return;
      const q = gsap.utils.selector(root);
      if (reducedMotion()) return;
      spins.current = [
        gsap.to(q('[data-spin="ticks"]'), { rotation: 360, svgOrigin: `${C} ${C}`, duration: 180, repeat: -1, ease: 'none' }),
        gsap.to(q('[data-spin="segments"]'), { rotation: -360, svgOrigin: `${C} ${C}`, duration: 95, repeat: -1, ease: 'none' }),
        gsap.to(q('[data-spin="brackets"]'), { rotation: 360, svgOrigin: `${C} ${C}`, duration: 60, repeat: -1, ease: 'none' }),
        gsap.to(q('.jv__sweep'), { rotation: 360, duration: 9, repeat: -1, ease: 'none' }),
      ];
      const tl = gsap.timeline({ defaults: { ease: 'jarvis.out' } });
      tl.from(q('.jv__core'), { scale: 0.7, autoAlpha: 0, duration: 1.2, ease: 'expo.out', clearProps: 'transform,opacity,visibility' }, 0)
        .from(q('.jv__draw'), { drawSVG: '50% 50%', duration: 1.1, stagger: 0.05, onComplete() { for (const el of this.targets() as SVGElement[]) el.style.removeProperty('stroke-dasharray'), el.style.removeProperty('stroke-dashoffset'); } }, 0.2)
        .from(q('.jv__ticks line'), { autoAlpha: 0, duration: 0.02, stagger: { each: 0.004, from: 'random' } }, 0.3)
        .from(q('.jv__sat'), { scale: 0, autoAlpha: 0, svgOrigin: `${C} ${C}`, duration: 0.7, stagger: 0.07, ease: 'back.out(1.6)', clearProps: 'transform,opacity,visibility' }, 0.7)
        .from(q('.jv__axis'), { scaleX: 0, autoAlpha: 0, duration: 1, clearProps: 'transform,opacity,visibility' }, 0.4)
        .from(q('.jv__frame'), { autoAlpha: 0, scale: 1.06, duration: 0.8, stagger: 0.05, clearProps: 'transform,opacity,visibility' }, 0.5)
        .from(q('.jv__mark, .jv__toggle, .jv__readout, .jv__dock'), { autoAlpha: 0, y: 10, duration: 0.7, stagger: 0.06, clearProps: 'transform,opacity,visibility' }, 0.8);
    },
    { scope: root, dependencies: [ready] },
  );

  // Busy Jarvis, faster HUD; the state word decodes into the new state.
  useGSAP(
    () => {
      if (reducedMotion()) return;
      for (const t of spins.current) gsap.to(t, { timeScale: PACE[state], duration: 1.4, ease: 'power2.inOut', overwrite: true });
      const word = root.current?.querySelector('.jv__state');
      if (word) gsap.to(word, { scrambleText: { text: CORE_LABEL[state].toUpperCase(), chars: 'XJ01<>/#', speed: 0.7 }, duration: 0.6 });
    },
    { scope: root, dependencies: [state] },
  );

  // Real agent events (a run started, finished or failed — even one too quick to be seen working)
  // flash that agent's satellite and send a pulse along its bearing.
  const prevAgents = useRef<Map<string, Pick<AgentInfo, 'state' | 'runs' | 'error'>> | null>(null);
  useGSAP(
    () => {
      const before = prevAgents.current;
      prevAgents.current = new Map(agents.map((a) => [a.id, { state: a.state, runs: a.runs, error: a.error }]));
      if (!before || !root.current || reducedMotion()) return;
      for (const { id, event } of agentEvents(before, agents)) {
        const ring = root.current.querySelector(`[data-sat="${id}"] .jv__satflash`);
        if (!ring) continue;
        const color = event === 'failed' ? '#f87171' : event === 'completed' ? '#4ade80' : getComputedStyle(ring).color;
        gsap.fromTo(ring, { attr: { r: 8 }, stroke: color, opacity: 1, strokeWidth: 3 }, { attr: { r: 46 }, opacity: 0, strokeWidth: 0.5, duration: 1.1, ease: 'expo.out' });
      }
    },
    { scope: root, dependencies: [agents] },
  );

  // A new answer types itself in.
  useGSAP(
    () => {
      const el = root.current?.querySelector('.jv__answer');
      if (el && answer && !reducedMotion()) gsap.from(el, { autoAlpha: 0, y: 12, filter: 'blur(6px)', duration: 0.7, ease: 'jarvis.out', clearProps: 'transform,opacity,visibility,filter' });
    },
    { scope: root, dependencies: [answer?.id] },
  );

  const core = size * 0.5;
  const gauge = (frac: number | null, a0: number, span: number, r: number) => arc(r, a0, a0 + span * Math.max(0.01, Math.min(1, (frac ?? 0) / 100)));

  return (
    <div className={`jv jv--${state} ${reduce ? 'jv--still' : ''}`} ref={root}>
      <div className="jv__grid" aria-hidden />
      <div className="jv__scan" aria-hidden />
      {(['tl', 'tr', 'bl', 'br'] as const).map((c) => (
        <span key={c} className={`jv__frame jv__frame--${c}`} aria-hidden />
      ))}

      <header className="jv__mark">
        <span className="jv__name">J.A.R.V.I.S</span>
        <span className={`jv__conn ${connected ? 'is-on' : ''}`}>
          <i /> {connected ? 'Online' : 'Reconnecting'}
        </span>
      </header>
      <button className="jv__toggle" onClick={onExit} title="Show the full interface (\\)" aria-label="Show the full interface (backslash)">
        <LayoutDashboard size={15} /> <span>Interface</span> <kbd>\</kbd>
      </button>

      {approvals.length > 0 && (
        <button
          className="jv__approval"
          onClick={() => {
            onExit();
            navigate({ page: 'tasks', id: approvals[0].taskId });
          }}
        >
          <ShieldAlert size={15} /> {approvals.length === 1 ? 'An action is waiting for your approval' : `${approvals.length} actions are waiting for your approval`} — review
        </button>
      )}

      <div className="jv__stage" ref={stageRef}>
        {ready && (
          <div className="jv__rig" style={{ width: size, height: size }}>
            <span className="jv__axis jv__axis--h" aria-hidden />
            <div className="jv__sweep" aria-hidden />
            <svg className="jv__hud" viewBox="0 0 1000 1000" aria-hidden>
              <defs>
                <radialGradient id="jv-glow" cx="50%" cy="50%" r="50%">
                  <stop offset="55%" stopColor="#7c3aed" stopOpacity="0" />
                  <stop offset="78%" stopColor="#7c3aed" stopOpacity="0.12" />
                  <stop offset="100%" stopColor="#7c3aed" stopOpacity="0" />
                </radialGradient>
              </defs>
              <circle cx={C} cy={C} r={490} fill="url(#jv-glow)" />
              <circle className="jv__ring jv__draw" cx={C} cy={C} r={R + 8} />
              <g className="jv__ticks" data-spin="ticks">
                {TICKS.map((t, i) => (
                  <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} className={t.major ? 'is-major' : ''} />
                ))}
              </g>
              <g data-spin="segments">
                <circle className="jv__segments jv__draw" cx={C} cy={C} r={R + 62} />
              </g>
              <g data-spin="brackets" className="jv__brackets">
                {[0, 90, 180, 270].map((d) => (
                  <path key={d} className="jv__draw" d={arc(R + 76, d - 14, d + 14)} />
                ))}
              </g>
              <circle className="jv__ring jv__ring--outer jv__draw" cx={C} cy={C} r={R + 96} />

              {/* live load: CPU on the left, memory on the right */}
              <path className="jv__gtrack" d={arc(R + 84, 228, 312)} />
              <path className="jv__gfill" d={gauge(cpu, 228, 84, R + 84)} />
              <path className="jv__gtrack" d={arc(R + 84, 48, 132)} />
              <path className="jv__gfill jv__gfill--mem" d={gauge(mem, 48, 84, R + 84)} />
              <text className="jv__glabel" x={polar(R + 136, 270)[0]} y={C - 10} textAnchor="end">CPU</text>
              <text className="jv__gvalue" x={polar(R + 136, 270)[0]} y={C + 14} textAnchor="end">{cpu === null ? '—' : `${Math.round(cpu)}%`}</text>
              <text className="jv__glabel" x={polar(R + 136, 90)[0]} y={C - 10}>MEM</text>
              <text className="jv__gvalue" x={polar(R + 136, 90)[0]} y={C + 14}>{mem === null ? '—' : `${Math.round(mem)}%`}</text>

              {/* the six agents: dim at rest, lit with a link to the core only while they really work */}
              {agents.slice(0, 6).map((a, i) => {
                const [x, y] = polar(SAT_R, SAT_DEG[i] ?? i * 60);
                const [lx, ly] = polar(R + 100, SAT_DEG[i] ?? i * 60);
                const working = a.state === 'working';
                return (
                  <g key={a.id} data-sat={a.id} className={`jv__sat ${working ? 'is-working' : ''} ${a.error ? 'is-error' : ''}`} style={{ color: a.color }}>
                    <title>{`${a.name}: ${working ? 'working' : a.error ? 'last run failed' : 'ready'}`}</title>
                    {working && <line className="jv__satlink" x1={lx} y1={ly} x2={x} y2={y} />}
                    <circle className="jv__satring" cx={x} cy={y} r={14} />
                    <circle className="jv__satdot" cx={x} cy={y} r={6} />
                    <circle className="jv__satflash" cx={x} cy={y} r={8} />
                  </g>
                );
              })}
            </svg>
            <div className="jv__core" style={{ width: core, height: core }}>
              <Core state={state} size={core} reduceMotion={reduce} hero />
            </div>
          </div>
        )}
      </div>

      <div className="jv__readout" aria-live="polite">
        {/* keyed: each state gets a fresh element for GSAP to decode (React never rewrites it) */}
        <div key={state} className="jv__state">
          {CORE_LABEL[state].toUpperCase()}
        </div>
        <div className="jv__detail">{detail}</div>
        {asked && (
          <div className="jv__caption">
            <div className="jv__asked">“{asked.content}”</div>
            {answer ? <div className={`jv__answer ${answer.meta.error ? 'is-error' : ''}`}>{answer.content}</div> : sending && <div className="jv__answer jv__answer--wait">…</div>}
          </div>
        )}
      </div>

      <div className="dash jv__dock">
        <CommandBar onSend={send} sending={sending} draft={null} />
      </div>
    </div>
  );
}
