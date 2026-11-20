import { useEffect, useRef } from 'react';
import type { CoreState } from '../lib/api';

export const CORE_LABEL: Record<CoreState, string> = {
  idle: 'Idle',
  thinking: 'Thinking',
  listening: 'Listening',
  speaking: 'Speaking',
  working: 'Working',
  success: 'Done',
  error: 'Needs attention',
};

/**
 * Jarvis's identity: a living energy core (inline SVG vector), not a picture.
 *
 * Concentric rings, a sweeping activity arc, radial filaments and a pulsing centre node are each
 * independent vector groups driven by one requestAnimationFrame rig. A small state machine sets
 * target parameters per assistant state and every value eases toward its target each frame, so
 * states blend smoothly. On top of the pose the rig runs continuous motion — rotation, a breathing
 * pulse, filament shimmer, listening ripples and a speech-driven core — matching our purple-on-dark
 * theme. It holds a calm static pose when the viewer prefers reduced motion.
 */

type State = CoreState;
const C = { accent: '#8b5cf6', soft: '#c4b5fd', bright: '#ede9fe', deep: '#6d28d9', ok: '#34d399', bad: '#f87171' };
const SPOKES = 30;
const PARTICLES = 12;
const ARC_R = 86;
const ARC_C = 2 * Math.PI * ARC_R;

interface Params {
  spinRate: number; // outer ring deg/s
  arcRate: number; // sweeping arc deg/s
  arcLen: number; // fraction of the circle the arc covers (0..1)
  coreBase: number; // resting core scale
  pulseAmp: number; // breathing amplitude
  pulseRate: number; // breaths/s (radians)
  glow: string;
  glowAmp: number;
  tint: string; // ring + arc colour
  ringOp: number;
  spokesOp: number;
  ripple: number; // listening 0..1
  wave: boolean; // speech-driven core
  spark: number; // success 0..1
  bang: number; // error 0..1
}

function targetsFor(s: State): Params {
  const base: Params = {
    spinRate: 6, arcRate: 26, arcLen: 0.12, coreBase: 1, pulseAmp: 0.06, pulseRate: 1.8,
    glow: C.accent, glowAmp: 0.5, tint: C.accent, ringOp: 0.5, spokesOp: 0.5, ripple: 0, wave: false, spark: 0, bang: 0,
  };
  switch (s) {
    case 'thinking':
      return { ...base, arcRate: 150, arcLen: 0.09, pulseRate: 2.6, glow: C.soft, glowAmp: 0.6, ringOp: 0.6 };
    case 'listening':
      return { ...base, spinRate: 10, coreBase: 1.05, pulseRate: 2.2, glow: C.soft, glowAmp: 0.72, ringOp: 0.72, ripple: 1 };
    case 'speaking':
      return { ...base, spinRate: 8, arcRate: 48, pulseRate: 2.4, glow: C.soft, glowAmp: 0.78, ringOp: 0.66, wave: true };
    case 'working':
      return { ...base, spinRate: 24, arcRate: 95, arcLen: 0.42, pulseRate: 2.6, glow: C.accent, glowAmp: 0.88, ringOp: 0.7, spokesOp: 0.7 };
    case 'success':
      return { ...base, spinRate: 10, arcLen: 1, coreBase: 1.12, pulseRate: 2, glow: C.ok, glowAmp: 1, tint: C.ok, ringOp: 0.85, spark: 1 };
    case 'error':
      return { ...base, spinRate: 4, arcLen: 1, pulseRate: 2.4, glow: C.bad, glowAmp: 0.95, tint: C.bad, ringOp: 0.8, bang: 1 };
    default:
      return base;
  }
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const NUM_KEYS = ['spinRate', 'arcRate', 'arcLen', 'coreBase', 'pulseAmp', 'pulseRate', 'glowAmp', 'ringOp', 'spokesOp', 'ripple', 'spark', 'bang'] as const;

export interface OrbAgent { id: string; name: string; color: string; summary: string; working: boolean; }

export function Core({ state, size = 220, reduceMotion = false, agents, wordmark = false, tag }: { state: CoreState; size?: number; reduceMotion?: boolean; agents?: OrbAgent[]; wordmark?: boolean; tag?: string }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const stateRef = useRef<State>(state);
  const osReduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const still = reduceMotion || Boolean(osReduce);
  const reduceRef = useRef(still);
  stateRef.current = state;
  reduceRef.current = still;

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const $ = (id: string) => svg.querySelector<SVGElement>(`#${id}`);
    const parts = {
      glow: $('c-glow'), ringOuter: $('c-ringOuter'), ringMid: $('c-ringMid'), ringInner: $('c-ringInner'),
      arc: $('c-arc'), spokes: $('c-spokes'), particles: $('c-particles'), core: $('c-core'), coreDot: $('c-coreDot'),
      waves: $('c-waves'), spark: $('c-spark'), bang: $('c-bang'),
    };
    const ringEls = [parts.ringOuter, parts.ringMid, parts.ringInner, parts.arc].filter(Boolean) as SVGElement[];
    const set = (el: SVGElement | null, t: string) => el && el.setAttribute('transform', t);
    const op = (el: SVGElement | null, v: number) => el && el.setAttribute('opacity', v.toFixed(3));

    const cur = targetsFor('idle');
    let sparkUntil = 0;
    let shakeUntil = 0;
    let prev: State = 'idle';
    let raf = 0;

    const render = (now: number, dt: number, animate: boolean) => {
      const st = stateRef.current;
      if (st !== prev) {
        if (st === 'success') sparkUntil = now + 1400;
        if (st === 'error') shakeUntil = now + 650;
        prev = st;
      }
      const tgt = targetsFor(st);
      const k = animate ? Math.min(1, dt * 7) : 1;
      const c = cur as unknown as Record<string, number>;
      const g = tgt as unknown as Record<string, number>;
      for (const key of NUM_KEYS) c[key] = animate ? lerp(c[key], g[key], k) : g[key];
      cur.wave = tgt.wave;
      cur.glow = tgt.glow;
      cur.tint = tgt.tint;

      const t = now / 1000;
      const breath = animate ? Math.sin(t * cur.pulseRate) : 0;
      const speech = cur.wave && animate ? Math.max(0, Math.sin(t * 13)) * (0.5 + 0.5 * Math.sin(t * 5.7 + 1)) : 0;
      const shake = now < shakeUntil ? Math.sin(now * 0.05) * 3 * ((shakeUntil - now) / 650) : 0;

      // Rotations.
      const rot = (el: SVGElement | null, deg: number) => set(el, `rotate(${(animate ? deg % 360 : 0).toFixed(2)} 110 110)`);
      rot(parts.ringOuter, t * cur.spinRate);
      rot(parts.ringMid, -t * cur.spinRate * 0.7);
      rot(parts.ringInner, t * cur.spinRate * 1.4);
      rot(parts.particles, t * cur.spinRate * 0.5);
      set(parts.spokes, `rotate(${(animate ? (t * cur.spinRate * 0.3) % 360 : 0).toFixed(2)} 110 110) translate(${shake.toFixed(2)} 0)`);

      // Sweeping activity arc (dash length from arcLen; colour from tint).
      if (parts.arc) {
        const len = Math.max(0, Math.min(1, cur.arcLen));
        parts.arc.setAttribute('stroke-dasharray', `${(len * ARC_C).toFixed(1)} ${ARC_C.toFixed(1)}`);
        parts.arc.setAttribute('stroke', cur.tint);
        set(parts.arc, `rotate(${(animate ? (t * cur.arcRate) % 360 : -90).toFixed(2)} 110 110)`);
      }
      for (const el of [parts.ringOuter, parts.ringMid, parts.ringInner]) el?.setAttribute('stroke', cur.tint);
      op(parts.ringOuter, cur.ringOp);
      op(parts.ringMid, cur.ringOp * 0.8);
      op(parts.ringInner, cur.ringOp * 0.7);

      // Core node: breathing + speech + success swell; slight shake offset on error.
      const coreScale = cur.coreBase + (animate ? breath * cur.pulseAmp : 0) + speech * 0.28;
      set(parts.core, `translate(${(shake * 0.5).toFixed(2)} 0) scale(${coreScale.toFixed(3)})`);
      if (parts.coreDot) parts.coreDot.setAttribute('fill', cur.tint === C.accent ? C.bright : cur.tint);
      op(parts.core, 0.9 + (animate ? breath * 0.1 : 0));

      // Radial filaments shimmer with the breath.
      op(parts.spokes, cur.spokesOp * (animate ? 0.65 + 0.35 * (breath * 0.5 + 0.5) : 1));

      // Aura.
      if (parts.glow) parts.glow.setAttribute('fill', cur.glow);
      op(parts.glow, 0.26 + cur.glowAmp * 0.32 + (animate ? breath * 0.04 : 0) + speech * 0.15);

      // Listening ripples: three expanding rings, phased.
      if (parts.waves) {
        op(parts.waves, cur.ripple);
        if (cur.ripple > 0.02 && animate) {
          for (let i = 0; i < 3; i++) {
            const el = parts.waves.children[i] as SVGElement | undefined;
            if (!el) continue;
            const ph = ((t * 0.6 + i / 3) % 1);
            el.setAttribute('transform', `translate(110 110) scale(${(0.4 + ph * 1.5).toFixed(3)}) translate(-110 -110)`);
            el.setAttribute('opacity', ((1 - ph) * 0.5 * cur.ripple).toFixed(3));
          }
        }
      }

      // Success sparkles (one-shot) and error flash.
      if (parts.spark) {
        const active = now < sparkUntil;
        const s = active ? Math.min(1, (now - (sparkUntil - 1400)) / 1400) : 0;
        op(parts.spark, active ? Math.sin(s * Math.PI) : 0);
        set(parts.spark, `translate(110 110) scale(${(0.7 + s * 0.6).toFixed(3)}) translate(-110 -110)`);
      }
      if (parts.bang) {
        op(parts.bang, cur.bang);
        const bp = animate && now < shakeUntil ? 1 + 0.15 * Math.sin(now * 0.05) : 1;
        set(parts.bang, `translate(110 110) scale(${bp.toFixed(3)}) translate(-110 -110)`);
      }
      // Saturn ring (wordmark/hero mode): a slow precession for a living, 3-D feel.
      const saturn = svg.querySelector('#c-saturn');
      if (saturn) set(saturn as SVGElement, `rotate(${(animate ? (t * 7) % 360 : -8).toFixed(2)} 110 110)`);

      // Satellite agent orbs: a slow orbit around Jarvis, each twinkling (brighter while working).
      const orbsG = svg.querySelector('#c-orbs');
      if (orbsG) set(orbsG as SVGElement, `rotate(${animate ? (t * 5) % 360 : 0} 110 110)`);
      svg.querySelectorAll('.c-orb').forEach((o, i) => {
        const el = o as SVGElement;
        const working = el.getAttribute('data-working') === '1';
        const tw = 0.55 + 0.35 * (animate ? Math.sin(t * (working ? 6 : 2) + i) * 0.5 + 0.5 : 1);
        el.setAttribute('opacity', (working ? Math.min(1, tw + 0.2) : tw).toFixed(3));
      });
      void ringEls;
    };

    if (still) {
      render(performance.now(), 0, false);
      return;
    }
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!document.hidden) render(now, dt, true);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [still]);

  // Radial filaments and particle dots, generated once.
  const spokes = Array.from({ length: SPOKES }, (_, i) => {
    const a = (i / SPOKES) * Math.PI * 2;
    const r0 = 30 + (i % 3) * 3;
    const r1 = 52 + (i % 5) * 7;
    return { x1: 110 + Math.cos(a) * r0, y1: 110 + Math.sin(a) * r0, x2: 110 + Math.cos(a) * r1, y2: 110 + Math.sin(a) * r1, o: 0.3 + (i % 4) * 0.18 };
  });
  const particles = Array.from({ length: PARTICLES }, (_, i) => {
    const a = (i / PARTICLES) * Math.PI * 2;
    return { cx: 110 + Math.cos(a) * 96, cy: 110 + Math.sin(a) * 96, r: 1 + (i % 3) * 0.7 };
  });

  return (
    <div className={`core core--${state} ${wordmark ? 'core--wordmark' : ''}`} style={{ ['--size' as string]: `${size}px` }} role="img" aria-label={`Jarvis is ${CORE_LABEL[state].toLowerCase()}`}>
      <svg ref={svgRef} viewBox="0 0 220 220" className="core__svg" aria-hidden>
        <defs>
          <radialGradient id="c-grad-core" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={C.bright} />
            <stop offset="45%" stopColor={C.soft} />
            <stop offset="100%" stopColor={C.accent} />
          </radialGradient>
          <filter id="c-blur" x="-70%" y="-70%" width="240%" height="240%">
            <feGaussianBlur stdDeviation="10" />
          </filter>
          <linearGradient id="c-wm-grad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor={C.bright} />
            <stop offset="55%" stopColor={C.soft} />
            <stop offset="100%" stopColor={C.accent} />
          </linearGradient>
          <linearGradient id="c-saturn-grad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor={C.deep} stopOpacity="0.15" />
            <stop offset="35%" stopColor={C.bright} />
            <stop offset="50%" stopColor={C.soft} />
            <stop offset="65%" stopColor={C.bright} />
            <stop offset="100%" stopColor={C.deep} stopOpacity="0.15" />
          </linearGradient>
        </defs>

        <circle id="c-glow" cx="110" cy="110" r="70" fill={C.accent} opacity="0.4" filter="url(#c-blur)" />

        {/* luminous planet body (shown in wordmark/hero mode, behind the JARVIS mark) */}
        <circle id="c-sphere" cx="110" cy="110" r="50" fill="url(#c-grad-core)" opacity="0" />
        <circle id="c-sphereEdge" cx="110" cy="110" r="50" fill="none" stroke={C.bright} strokeWidth="1" opacity="0" />

        {/* radial filaments (the "burst") */}
        <g id="c-spokes" stroke={C.soft} strokeWidth="1.1" strokeLinecap="round">
          {spokes.map((s, i) => (
            <line key={i} x1={s.x1.toFixed(1)} y1={s.y1.toFixed(1)} x2={s.x2.toFixed(1)} y2={s.y2.toFixed(1)} opacity={s.o.toFixed(2)} />
          ))}
        </g>

        {/* concentric rings + sweeping activity arc */}
        <circle id="c-ringInner" cx="110" cy="110" r="54" fill="none" stroke={C.accent} strokeWidth="1.2" strokeDasharray="2 7" opacity="0.5" />
        <circle id="c-ringMid" cx="110" cy="110" r="74" fill="none" stroke={C.accent} strokeWidth="1.6" strokeDasharray="14 10" opacity="0.5" />
        <circle id="c-ringOuter" cx="110" cy="110" r="96" fill="none" stroke={C.accent} strokeWidth="1.4" strokeDasharray="3 9" opacity="0.5" />
        <circle id="c-arc" cx="110" cy="110" r={ARC_R} fill="none" stroke={C.accent} strokeWidth="3" strokeLinecap="round" strokeDasharray="60 540" opacity="0.95" />

        {/* orbiting particles */}
        <g id="c-particles" fill={C.soft}>
          {particles.map((p, i) => (
            <circle key={i} cx={p.cx.toFixed(1)} cy={p.cy.toFixed(1)} r={p.r.toFixed(1)} opacity="0.8" />
          ))}
        </g>

        {/* listening ripples */}
        <g id="c-waves" opacity="0" fill="none" stroke={C.soft} strokeWidth="1.6">
          <circle cx="110" cy="110" r="40" />
          <circle cx="110" cy="110" r="40" />
          <circle cx="110" cy="110" r="40" />
        </g>

        {/* centre node */}
        <g id="c-core" style={{ transformOrigin: '110px 110px' }}>
          <circle cx="110" cy="110" r="22" fill="url(#c-grad-core)" opacity="0.35" />
          <circle id="c-coreDot" cx="110" cy="110" r="11" fill={C.bright} />
          <circle cx="110" cy="110" r="11" fill="none" stroke={C.deep} strokeWidth="1.2" opacity="0.6" />
          <path d="M110 101 L118 106 L118 114 L110 119 L102 114 L102 106 Z" fill={C.deep} opacity="0.55" />
        </g>

        {/* success sparkles */}
        <g id="c-spark" opacity="0" fill="#fff">
          <path d="M60 60 l2 6 6 2 -6 2 -2 6 -2 -6 -6 -2 6 -2 Z" />
          <path d="M162 66 l1.6 5 5 1.6 -5 1.6 -1.6 5 -1.6 -5 -5 -1.6 5 -1.6 Z" opacity="0.9" />
          <path d="M150 150 l1.4 4 4 1.4 -4 1.4 -1.4 4 -1.4 -4 -4 -1.4 4 -1.4 Z" opacity="0.8" />
        </g>

        {/* satellite sub-agent orbs, each in its own colour */}
        {agents && agents.length > 0 && (
          <g id="c-orbs">
            {agents.map((a, i) => {
              const ang = (i / agents.length) * Math.PI * 2 - Math.PI / 2;
              const r = 104;
              const cx = 110 + Math.cos(ang) * r;
              const cy = 110 + Math.sin(ang) * r;
              return (
                <g className="c-orb" data-working={a.working ? '1' : '0'} key={a.id} style={{ cursor: 'default' }}>
                  <title>{`${a.name}: ${a.summary}`}</title>
                  <circle cx={cx} cy={cy} r="16" fill={a.color} opacity="0.26" />
                  <circle cx={cx} cy={cy} r="10.5" fill="none" stroke={a.color} strokeWidth="1.4" strokeDasharray="3 4" />
                  <circle cx={cx} cy={cy} r="4.6" fill={a.color} />
                </g>
              );
            })}
          </g>
        )}

        {/* Saturn ring — the hero signature (wordmark mode) */}
        <g id="c-saturn" opacity="0">
          <ellipse cx="110" cy="110" rx="103" ry="30" fill="none" stroke="url(#c-saturn-grad)" strokeWidth="3.2" transform="rotate(-20 110 110)" />
          <ellipse cx="110" cy="110" rx="116" ry="35" fill="none" stroke={C.soft} strokeWidth="1" strokeDasharray="2 11" opacity="0.5" transform="rotate(-20 110 110)" />
          <ellipse cx="110" cy="110" rx="90" ry="25" fill="none" stroke={C.accent} strokeWidth="1" strokeDasharray="1 9" opacity="0.6" transform="rotate(-20 110 110)" />
        </g>

        {/* error exclamation */}
        <g id="c-bang" opacity="0">
          <circle cx="150" cy="58" r="13" fill={C.bad} />
          <rect x="148" y="51" width="4" height="9" rx="2" fill="#1a0540" />
          <circle cx="150" cy="64" r="2.2" fill="#1a0540" />
        </g>

        {/* JARVIS wordmark (hero mode) — in-SVG so it scales with the core */}
        {wordmark && (
          <g id="c-wordmark" style={{ pointerEvents: 'none' }}>
            <text x="110" y="110" textAnchor="middle" className="core__name">JARVIS</text>
            <text x="110" y="128" textAnchor="middle" className="core__tag">
              {tag ? `●\u00a0\u00a0${tag}` : 'AI\u00a0\u00a0PERSONAL\u00a0\u00a0ASSISTANT'}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}
