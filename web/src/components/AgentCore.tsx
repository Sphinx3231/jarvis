import { useEffect, useRef } from 'react';
import type { CoreState } from '../lib/api';
import { drawPlexus } from './Core';
import { gsap, reducedMotion, useGSAP } from '../motion/gsap';

/**
 * A sub-agent drawn the way Jarvis is: a miniature intelligence core — the same 3D neural sphere
 * (Core's plexus renderer) inside tick and segment rings and a sweeping arc — in the agent's own
 * colour. It reflects the agent's real state: at rest it turns slowly with a few signals on its
 * links; while the agent works it spins up, fills with signals and its arc opens; a failed last run
 * shows red. All the mini cores share one GSAP ticker and redraw at 30 fps.
 */

export type AgentCoreStatus = 'ready' | 'working' | 'paused' | 'error';

const TICKS = Array.from({ length: 48 }, (_, i) => {
  const a = (i / 48) * Math.PI * 2;
  const major = i % 6 === 0;
  const r0 = major ? 43.5 : 45;
  return { x1: 50 + Math.cos(a) * r0, y1: 50 + Math.sin(a) * r0, x2: 50 + Math.cos(a) * 47.5, y2: 50 + Math.sin(a) * 47.5, major };
});
const BRACKET = (deg: number) => {
  const p = (d: number, r: number) => {
    const a = ((d - 90) * Math.PI) / 180;
    return `${(50 + Math.cos(a) * r).toFixed(2)} ${(50 + Math.sin(a) * r).toFixed(2)}`;
  };
  return `M ${p(deg - 12, 47.5)} L ${p(deg - 12, 50)} A 50 50 0 0 1 ${p(deg + 12, 50)} L ${p(deg + 12, 47.5)}`;
};

// One shared draw loop for every mini core on screen.
type Entry = { canvas: HTMLCanvasElement; get: () => { state: CoreState; spin: number; tint: string } };
const entries = new Set<Entry>();
let frame = 0;
const tick = (time: number) => {
  frame++;
  if (frame % 2) return; // 30 fps is plenty at this size
  for (const e of entries) {
    const s = e.get();
    drawPlexus(e.canvas, time, true, { spinRate: s.spin, tint: s.tint, glowAmp: 0.6 }, s.state, 0, frame);
  }
};
function register(e: Entry) {
  if (!entries.size) gsap.ticker.add(tick);
  entries.add(e);
  return () => {
    entries.delete(e);
    if (!entries.size) gsap.ticker.remove(tick);
  };
}

const PLEX_STATE: Record<AgentCoreStatus, CoreState> = { ready: 'idle', working: 'working', paused: 'idle', error: 'error' };
const PACE: Record<AgentCoreStatus, number> = { ready: 1, working: 3.4, paused: 0.3, error: 0.6 };

export function AgentCore({ color, status, size, still = false }: { color: string; status: AgentCoreStatus; size: number; still?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef({ status, color });
  live.current = { status, color };
  const tint = status === 'error' ? '#f87171' : color;

  // The sphere: animated with everyone else's, or drawn once when motion is off.
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const get = () => {
      const s = live.current.status;
      return { state: PLEX_STATE[s], spin: s === 'working' ? 30 : 4, tint: s === 'error' ? '#f87171' : live.current.color };
    };
    if (still || reducedMotion()) {
      const s = get();
      drawPlexus(c, 0, false, { spinRate: s.spin, tint: s.tint, glowAmp: 0.6 }, s.state, 0, 0);
      return;
    }
    return register({ canvas: c, get });
  }, [still, status, color]);

  // The rings turn; how fast follows the agent's real state.
  const spins = useRef<gsap.core.Tween[]>([]);
  useGSAP(
    () => {
      if (still || reducedMotion()) return;
      const q = gsap.utils.selector(root);
      spins.current = [
        gsap.to(q('.acore__ticks'), { rotation: 360, svgOrigin: '50 50', duration: 60, repeat: -1, ease: 'none' }),
        gsap.to(q('.acore__segs'), { rotation: -360, svgOrigin: '50 50', duration: 34, repeat: -1, ease: 'none' }),
        gsap.to(q('.acore__arc'), { rotation: 360, svgOrigin: '50 50', duration: 7, repeat: -1, ease: 'none' }),
      ];
    },
    { scope: root, dependencies: [still] },
  );
  useGSAP(
    () => {
      for (const t of spins.current) gsap.to(t, { timeScale: PACE[status], duration: 1.2, ease: 'power2.inOut', overwrite: true });
    },
    { scope: root, dependencies: [status] },
  );

  return (
    <div className={`acore acore--${status}`} ref={root} style={{ width: size, height: size, ['--c' as string]: tint }} aria-hidden>
      <span className="acore__glow" />
      <span className="acore__well" />
      <canvas ref={canvas} className="acore__plexus" />
      <svg className="acore__svg" viewBox="0 0 100 100">
        <circle className="acore__base" cx="50" cy="50" r="41" />
        <g className="acore__ticks">
          {TICKS.map((t, i) => (
            <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} className={t.major ? 'is-major' : ''} />
          ))}
        </g>
        <circle className="acore__segs" cx="50" cy="50" r="40" />
        <circle className="acore__arc" cx="50" cy="50" r="36" pathLength="100" />
        <g className="acore__brackets">
          {[45, 135, 225, 315].map((d) => (
            <path key={d} d={BRACKET(d)} />
          ))}
        </g>
        <circle className="acore__dot" cx="50" cy="50" r="3.2" />
      </svg>
    </div>
  );
}
