import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Activity, Bug, Crosshair, Play, Radio, Settings, ShieldCheck, Sparkles, TrendingUp, Volume2, X } from 'lucide-react';
import { Core, CORE_LABEL } from './Core';
import { api, type AgentInfo, type CoreState } from '../lib/api';
import { timeAgo } from '../lib/format';
import { useAction } from '../lib/live';
import { navigate } from '../lib/router';

export const AGENT_ICON: Record<string, (size: number) => ReactNode> = {
  friday: (s) => <TrendingUp size={s} />,
  tom: (s) => <Crosshair size={s} />,
  neo: (s) => <Activity size={s} />,
  sentinel: (s) => <ShieldCheck size={s} />,
  echo: (s) => <Radio size={s} />,
  trinity: (s) => <Bug size={s} />,
};
export const agentIcon = (id: string, size = 20) => (AGENT_ICON[id] ?? ((s: number) => <Sparkles size={s} />))(size);

export type AgentStatusKey = 'working' | 'ready' | 'paused' | 'error';

/** The agent's real state: running now, failed last run, paused with the team, or ready. */
export function agentStatus(a: AgentInfo, enabled: boolean): { key: AgentStatusKey; label: string } {
  if (a.state === 'working') return { key: 'working', label: 'Working' };
  if (a.error) return { key: 'error', label: 'Error' };
  if (!enabled) return { key: 'paused', label: 'Paused' };
  return { key: 'ready', label: 'Ready' };
}

/** The role reads "Title — what it does": split it for the detail view. */
export function splitRole(role: string): { title: string; text: string } {
  const i = role.indexOf(' — ');
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  return i > 0 ? { title: role.slice(0, i), text: cap(role.slice(i + 3)) } : { title: '', text: role };
}

// Slots on the ellipse (degrees, y down): top-left, top-right, left, right, bottom-left, bottom-right —
// the same order as the roster (Friday, Tom, Neo, Sentinel, Echo, Trinity).
const SLOT_DEG = [-130, -50, 180, 0, 130, 50];
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const ellipsePath = (cx: number, cy: number, rx: number, ry: number) => `M ${cx - rx} ${cy} a ${rx} ${ry} 0 1 0 ${2 * rx} 0 a ${rx} ${ry} 0 1 0 ${-2 * rx} 0`;

const CORE_TAG: Record<CoreState, string> = {
  idle: 'READY',
  thinking: 'THINKING',
  listening: 'LISTENING',
  speaking: 'SPEAKING',
  working: 'EXECUTING',
  success: 'DONE',
  error: 'NEEDS ATTENTION',
};

function useSize(ref: React.RefObject<HTMLElement | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/**
 * Jarvis at the centre with its six sub-agents in orbit. Geometry is computed from the real size of
 * the stage, so the orbit paths, connection lines and nodes always line up at any window size.
 * Motion is restrained (slow drift on the orbits, a gentle float on the nodes, data pulses on the
 * links of agents that are working) and stops entirely with reduced motion.
 */
export function OrbitStage({
  agents,
  enabled,
  state,
  detail,
  wakeActive,
  reduceMotion,
  onSelect,
}: {
  agents: AgentInfo[];
  enabled: boolean;
  state: CoreState;
  detail: string;
  wakeActive: boolean;
  reduceMotion: boolean;
  onSelect: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { w, h } = useSize(ref);
  const ready = w > 0 && h > 0;
  const node = clamp(Math.min(w * 0.12, h * 0.17), 76, 112);
  const cx = w / 2;
  const cy = h / 2 - 6;
  const core = clamp(Math.min(w * 0.4, h * 0.6), 170, 430);
  const rx = clamp(w / 2 - node / 2 - 12, core * 0.62, w * 0.43);
  const ry = clamp(h / 2 - node / 2 - 18, core * 0.52, h * 0.42);
  const pts = agents.map((_, i) => {
    const deg = SLOT_DEG[i] ?? (i / agents.length) * 360;
    const a = (deg * Math.PI) / 180;
    return { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a), a };
  });
  const motion = !reduceMotion;

  return (
    <div className={`orbit ${motion ? '' : 'orbit--still'}`} ref={ref}>
      {ready && (
        <>
          <svg className="orbit__svg" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
            <defs>
              <radialGradient id="orbit-haze" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#7c3aed" stopOpacity="0.28" />
                <stop offset="55%" stopColor="#5b21b6" stopOpacity="0.08" />
                <stop offset="100%" stopColor="#09070f" stopOpacity="0" />
              </radialGradient>
              {agents.map((a, i) => (
                <linearGradient key={a.id} id={`orbit-link-${a.id}`} gradientUnits="userSpaceOnUse" x1={cx} y1={cy} x2={pts[i].x} y2={pts[i].y}>
                  <stop offset="0%" stopColor="#a78bfa" stopOpacity="0.05" />
                  <stop offset="100%" stopColor={a.color} stopOpacity="0.75" />
                </linearGradient>
              ))}
            </defs>
            <ellipse cx={cx} cy={cy} rx={rx * 1.25} ry={ry * 1.1} fill="url(#orbit-haze)" />
            {/* the agents' orbit, plus two tilted outer orbits for depth */}
            <ellipse className="orbit__ring orbit__ring--main" cx={cx} cy={cy} rx={rx} ry={ry} />
            <g transform={`rotate(-12 ${cx} ${cy})`}>
              <ellipse className="orbit__ring orbit__ring--tilt" cx={cx} cy={cy} rx={rx * 1.04} ry={ry * 0.5} />
              {motion && (
                <circle r="2.6" className="orbit__mote">
                  <animateMotion dur="26s" repeatCount="indefinite" path={ellipsePath(cx, cy, rx * 1.04, ry * 0.5)} />
                </circle>
              )}
            </g>
            <g transform={`rotate(14 ${cx} ${cy})`}>
              <ellipse className="orbit__ring orbit__ring--tilt2" cx={cx} cy={cy} rx={rx * 0.86} ry={ry * 0.36} />
              {motion && (
                <circle r="2" className="orbit__mote orbit__mote--dim">
                  <animateMotion dur="34s" repeatCount="indefinite" keyPoints="1;0" keyTimes="0;1" calcMode="linear" path={ellipsePath(cx, cy, rx * 0.86, ry * 0.36)} />
                </circle>
              )}
            </g>
            <circle className="orbit__halo" cx={cx} cy={cy} r={core * 0.6} style={{ transformOrigin: `${cx}px ${cy}px` }} />
            {/* links from Jarvis to each agent; a pulse travels along the link while the agent works */}
            {agents.map((a, i) => {
              const p = pts[i];
              const dx = p.x - cx;
              const dy = p.y - cy;
              const len = Math.hypot(dx, dy) || 1;
              const x1 = cx + (dx / len) * core * 0.47;
              const y1 = cy + (dy / len) * core * 0.47;
              const x2 = p.x - (dx / len) * (node / 2 + 6);
              const y2 = p.y - (dy / len) * (node / 2 + 6);
              const working = a.state === 'working';
              return (
                <g key={a.id} className={`orbit__link ${working ? 'is-working' : ''}`}>
                  <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={`url(#orbit-link-${a.id})`} />
                  {working && motion && (
                    <circle r="3.2" fill={a.color} className="orbit__pulse">
                      <animateMotion dur="1.4s" repeatCount="indefinite" path={`M ${x1} ${y1} L ${x2} ${y2}`} />
                    </circle>
                  )}
                  <circle cx={x2} cy={y2} r="2.2" fill={a.color} opacity="0.8" />
                </g>
              );
            })}
          </svg>

          <div className="orbit__core" style={{ left: cx, top: cy }}>
            <Core state={state} size={core} reduceMotion={reduceMotion} wordmark tag={CORE_TAG[state]} />
          </div>

          <div className={`state-pill state-pill--${state} orbit__state`} style={{ left: cx, top: Math.min(h - 18, cy + core / 2 + 4), maxWidth: Math.max(160, rx * 1.15 - node) }}>
            <span className="state-pill__dot" />
            {CORE_LABEL[state]}
            <span className="state-pill__detail">· {detail}</span>
            {wakeActive && (
              <span className="state-pill__detail" title="Wake word is on: say “Hey Jarvis…”">
                · <Volume2 size={12} /> wake word on
              </span>
            )}
          </div>

          {agents.map((a, i) => {
            const st = agentStatus(a, enabled);
            const style = { left: pts[i].x, top: pts[i].y, width: node, height: node, ['--c' as string]: a.color, ['--d' as string]: `${-i * 1.3}s` } as CSSProperties;
            return (
              <button key={a.id} className={`anode anode--${st.key}`} style={style} onClick={() => onSelect(a.id)} aria-label={`${a.name} — ${st.label}. Open details.`} title={`${a.name}: ${a.lastSummary || splitRole(a.role).text}`}>
                <span className="anode__disc">
                  <span className="anode__icon">{agentIcon(a.id, node > 96 ? 22 : 19)}</span>
                  <span className="anode__name">{a.name}</span>
                  <span className="anode__status">
                    <i className="anode__dot" />
                    {st.label}
                  </span>
                </span>
              </button>
            );
          })}
        </>
      )}
    </div>
  );
}

/** What an agent is, what it last did, and running it now. */
export function AgentDetail({ agent, enabled, onClose }: { agent: AgentInfo; enabled: boolean; onClose: () => void }) {
  const act = useAction();
  const [busy, setBusy] = useState(false);
  const st = agentStatus(agent, enabled);
  const role = splitRole(agent.role);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const run = async () => {
    setBusy(true);
    await act(() => api.post(`/api/subagents/${agent.id}/run`), `${agent.name} ran`);
    setBusy(false);
  };
  return (
    <div className="adetail__backdrop" onMouseDown={onClose}>
      <div className="adetail" role="dialog" aria-modal="true" aria-label={`${agent.name} details`} style={{ ['--c' as string]: agent.color }} onMouseDown={(e) => e.stopPropagation()}>
        <header className="adetail__head">
          <span className="adetail__icon">{agentIcon(agent.id, 24)}</span>
          <div className="adetail__id">
            <h2>{agent.name}</h2>
            {role.title && <span className="adetail__role">{role.title}</span>}
          </div>
          <span className={`adetail__status adetail__status--${st.key}`}>
            <i /> {st.label}
          </span>
          <button ref={closeRef} className="icon-btn icon-btn--sm" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <p className="adetail__text">{role.text}</p>
        <div className="adetail__latest">
          <span className="adetail__label">Latest</span>
          <p>{agent.lastSummary || 'Has not run yet.'}</p>
          {agent.error && <p className="adetail__error">Last run failed: {agent.error}</p>}
        </div>
        <dl className="adetail__facts">
          <div>
            <dt>Last run</dt>
            <dd>{agent.lastRunAt ? timeAgo(agent.lastRunAt) : 'Never'}</dd>
          </div>
          <div>
            <dt>Runs</dt>
            <dd>{agent.runs}</dd>
          </div>
          <div>
            <dt>Team</dt>
            <dd>{enabled ? 'Running in the background' : 'Paused'}</dd>
          </div>
        </dl>
        {!enabled && <p className="adetail__note">The agents are paused. Turn them on in Settings → Sub-agents to run them on their schedule.</p>}
        <footer className="adetail__foot">
          <button className="btn btn--ghost btn--sm" onClick={() => (onClose(), navigate({ page: 'settings' }))}>
            <Settings size={15} /> <span>Agent settings</span>
          </button>
          <button className="btn btn--primary btn--sm" onClick={run} disabled={busy || agent.state === 'working'}>
            <Play size={15} /> <span>{agent.state === 'working' ? 'Working…' : busy ? 'Running…' : 'Run now'}</span>
          </button>
        </footer>
      </div>
    </div>
  );
}
