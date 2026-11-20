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

// ---------------------------------------------------------------- the neural core (hero)

/*
 * A point cloud on a sphere (Fibonacci lattice) joined to its nearest neighbours: a rotating
 * neural network. Neighbour pairs never change under rotation, so they are computed once; each
 * frame only rotates and projects the points, then draws lines and points in three depth batches
 * (a handful of canvas calls). Pulses run along the links, and how many there are follows Jarvis's
 * state: a few at rest, many while thinking or working.
 */
const PLEX_N = 220;
const PLEX_PTS = (() => {
  const pts: Array<[number, number, number]> = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < PLEX_N; i++) {
    const y = 1 - (i / (PLEX_N - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const a = i * golden;
    pts.push([Math.cos(a) * r, y, Math.sin(a) * r]);
  }
  return pts;
})();
const PLEX_EDGES = (() => {
  const edges: Array<[number, number]> = [];
  const lim = Math.cos(0.29);
  for (let i = 0; i < PLEX_N; i++)
    for (let j = i + 1; j < PLEX_N; j++) {
      const [a, b] = [PLEX_PTS[i], PLEX_PTS[j]];
      if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] > lim) edges.push([i, j]);
    }
  return edges;
})();
const PULSES: Record<CoreState, number> = { idle: 7, listening: 12, speaking: 16, thinking: 26, working: 30, success: 18, error: 10 };
const rgb = (hex: string) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)].join(',');
const proj = new Float32Array(PLEX_N * 3);

function drawPlexus(canvas: HTMLCanvasElement, t: number, animate: boolean, cur: { spinRate: number; tint: string; glowAmp: number }, state: CoreState, speech: number, frame: number) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const css = canvas.clientWidth;
  if (!css) return;
  const px = Math.round(css * dpr);
  if (canvas.width !== px) {
    canvas.width = px;
    canvas.height = px;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = canvas.width;
  const c = W / 2;
  const R = W * 0.43 * (1 + speech * 0.05);
  const ay = animate ? t * (0.16 + cur.spinRate * 0.012) : 0.7;
  const ax = -0.42 + (animate ? Math.sin(t * 0.27) * 0.06 : 0);
  const [sy, cy, sx, cx] = [Math.sin(ay), Math.cos(ay), Math.sin(ax), Math.cos(ax)];
  for (let i = 0; i < PLEX_N; i++) {
    const [x, y, z] = PLEX_PTS[i];
    const x1 = x * cy + z * sy;
    const z1 = -x * sy + z * cy;
    const y2 = y * cx - z1 * sx;
    const z2 = y * sx + z1 * cx;
    const k = 1 / (1 - z2 * 0.16);
    proj[i * 3] = c + x1 * R * k;
    proj[i * 3 + 1] = c + y2 * R * k;
    proj[i * 3 + 2] = z2;
  }
  const tint = rgb(cur.tint === C.accent ? C.soft : cur.tint);
  ctx.clearRect(0, 0, W, W);
  ctx.lineCap = 'round';
  // links, back to front
  const bands: Array<[number, number, number]> = [
    [-1.1, -0.25, 0.1],
    [-0.25, 0.35, 0.24],
    [0.35, 1.1, 0.46],
  ];
  ctx.lineWidth = 0.75 * dpr;
  for (const [lo, hi, alpha] of bands) {
    ctx.beginPath();
    for (const [a, b] of PLEX_EDGES) {
      const z = (proj[a * 3 + 2] + proj[b * 3 + 2]) / 2;
      if (z < lo || z >= hi) continue;
      ctx.moveTo(proj[a * 3], proj[a * 3 + 1]);
      ctx.lineTo(proj[b * 3], proj[b * 3 + 1]);
    }
    ctx.strokeStyle = `rgba(${tint},${alpha})`;
    ctx.stroke();
  }
  // signal pulses along links (how many: Jarvis's state)
  const n = PULSES[state] ?? 8;
  ctx.lineWidth = 1.6 * dpr;
  for (let k = 0; k < n; k++) {
    const life = animate ? t * 0.9 + k * 0.61 : k * 0.61;
    const gen = Math.floor(life);
    const ph = life - gen;
    const [a, b] = PLEX_EDGES[(k * 7919 + gen * 104729) % PLEX_EDGES.length];
    const z = (proj[a * 3 + 2] + proj[b * 3 + 2]) / 2;
    if (z < -0.2) continue;
    const ax0 = proj[a * 3];
    const ay0 = proj[a * 3 + 1];
    const bx = proj[b * 3];
    const by = proj[b * 3 + 1];
    const p0 = Math.max(0, ph - 0.35);
    ctx.strokeStyle = `rgba(237,233,254,${(Math.sin(ph * Math.PI) * 0.9).toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(ax0 + (bx - ax0) * p0, ay0 + (by - ay0) * p0);
    ctx.lineTo(ax0 + (bx - ax0) * ph, ay0 + (by - ay0) * ph);
    ctx.stroke();
  }
  // nodes, back to front, nearer ones larger and brighter
  for (const [lo, hi, alpha, r] of [
    [-1.1, -0.25, 0.25, 0.8],
    [-0.25, 0.35, 0.55, 1.1],
    [0.35, 1.1, 0.95, 1.5],
  ] as const) {
    ctx.beginPath();
    for (let i = 0; i < PLEX_N; i++) {
      const z = proj[i * 3 + 2];
      if (z < lo || z >= hi) continue;
      ctx.moveTo(proj[i * 3] + r * dpr, proj[i * 3 + 1]);
      ctx.arc(proj[i * 3], proj[i * 3 + 1], r * dpr, 0, Math.PI * 2);
    }
    ctx.fillStyle = `rgba(${tint},${alpha})`;
    ctx.fill();
  }
  if (frame % 15 === 0) canvas.dataset.frame = String(frame);
}

// Hero geometry (viewBox units; the core's centre is 110,110).
const GYRO_R = 46;
const HERO_TICKS = Array.from({ length: 120 }, (_, i) => {
  const a = (i / 120) * Math.PI * 2;
  const major = i % 10 === 0;
  const r0 = major ? 114 : 116;
  return { x1: (110 + Math.cos(a) * r0).toFixed(2), y1: (110 + Math.sin(a) * r0).toFixed(2), x2: (110 + Math.cos(a) * 120).toFixed(2), y2: (110 + Math.sin(a) * 120).toFixed(2), major };
});
const HERO_BRACKET = (() => {
  const p = (ang: number, r: number) => `${(110 + Math.cos(ang) * r).toFixed(2)} ${(110 + Math.sin(ang) * r).toFixed(2)}`;
  const a = -Math.PI / 2;
  return `M ${p(a - 0.16, 124)} L ${p(a - 0.16, 128)} A 128 128 0 0 1 ${p(a + 0.16, 128)} L ${p(a + 0.16, 124)}`;
})();
const NUM_KEYS = ['spinRate', 'arcRate', 'arcLen', 'coreBase', 'pulseAmp', 'pulseRate', 'glowAmp', 'ringOp', 'spokesOp', 'ripple', 'spark', 'bang'] as const;

export interface OrbAgent { id: string; name: string; color: string; summary: string; working: boolean; }

export function Core({ state, size = 220, reduceMotion = false, agents, hero = false }: { state: CoreState; size?: number; reduceMotion?: boolean; agents?: OrbAgent[]; hero?: boolean }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const plexRef = useRef<HTMLCanvasElement>(null);
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
      ticks: $('c-ticks'), segs: $('c-segs'), sphere: $('c-sphere'),
    };
    const ringEls = [parts.ringOuter, parts.ringMid, parts.ringInner, parts.arc].filter(Boolean) as SVGElement[];
    const set = (el: SVGElement | null, t: string) => el && el.setAttribute('transform', t);
    const op = (el: SVGElement | null, v: number) => el && el.setAttribute('opacity', v.toFixed(3));

    const plex = plexRef.current;
    let frame = 0;
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
      // Hero layers: tick ring and segmented arcs turn slowly in opposite directions (faster while
      // working), and the wireframe sphere's meridians sweep like a turning globe.
      rot(parts.ticks, t * cur.spinRate * 0.35);
      rot(parts.segs, -t * cur.spinRate * 0.6);
      const isHero = Boolean(plex);
      if (plex) drawPlexus(plex, t, animate, cur, stateRef.current, speech, ++frame);
      if (isHero && parts.sphere) parts.sphere.setAttribute('opacity', (0.38 + cur.glowAmp * 0.22 + (animate ? breath * 0.05 : 0) + speech * 0.15).toFixed(3));
      // In the hero the aura stays tight around the sphere so the network reads crisply.
      if (isHero && parts.glow) parts.glow.setAttribute('opacity', (0.16 + cur.glowAmp * 0.2 + (animate ? breath * 0.03 : 0) + speech * 0.1).toFixed(3));
      // Saturn ring (legacy, hidden): kept for the compact core.
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
  const nSpokes = hero ? 48 : SPOKES;
  const spokes = Array.from({ length: nSpokes }, (_, i) => {
    const a = (i / nSpokes) * Math.PI * 2;
    // In the hero the filaments radiate from the sphere's surface out to the inner ring.
    const r0 = hero ? GYRO_R + 6 + (i % 3) * 2 : 30 + (i % 3) * 3;
    const r1 = hero ? 58 + (i % 5) * 5 : 52 + (i % 5) * 7;
    return { x1: 110 + Math.cos(a) * r0, y1: 110 + Math.sin(a) * r0, x2: 110 + Math.cos(a) * r1, y2: 110 + Math.sin(a) * r1, o: 0.3 + (i % 4) * 0.18 };
  });
  const particles = Array.from({ length: PARTICLES }, (_, i) => {
    const a = (i / PARTICLES) * Math.PI * 2;
    return { cx: 110 + Math.cos(a) * 96, cy: 110 + Math.sin(a) * 96, r: 1 + (i % 3) * 0.7 };
  });

  return (
    <div className={`core core--${state} ${hero ? 'core--hero' : ''}`} style={{ ['--size' as string]: `${size}px` }} role="img" aria-label={`Jarvis is ${CORE_LABEL[state].toLowerCase()}`}>
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
          <radialGradient id="c-grad-sphere" cx="42%" cy="36%" r="62%">
            <stop offset="0%" stopColor={C.soft} stopOpacity="0.6" />
            <stop offset="35%" stopColor={C.accent} stopOpacity="0.38" />
            <stop offset="75%" stopColor={C.deep} stopOpacity="0.3" />
            <stop offset="100%" stopColor="#2e1065" stopOpacity="0.55" />
          </radialGradient>
          <linearGradient id="c-saturn-grad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor={C.deep} stopOpacity="0.15" />
            <stop offset="35%" stopColor={C.bright} />
            <stop offset="50%" stopColor={C.soft} />
            <stop offset="65%" stopColor={C.bright} />
            <stop offset="100%" stopColor={C.deep} stopOpacity="0.15" />
          </linearGradient>
        </defs>

        <circle id="c-glow" cx="110" cy="110" r="70" fill={C.accent} opacity="0.4" filter="url(#c-blur)" />

        {hero && (
          <>
            {/* static HUD frame: outer ring, cardinal markers and bracket arcs */}
            <g className="core__frame" fill="none" stroke={C.soft}>
              <circle cx="110" cy="110" r="131" strokeOpacity="0.16" strokeWidth="0.6" />
              <circle cx="110" cy="110" r="126" strokeOpacity="0.08" strokeWidth="0.6" strokeDasharray="1 4" />
              {[0, 90, 180, 270].map((d) => (
                <path key={d} d="M110 -24 l-3.2 -5.5 h6.4 Z" transform={`rotate(${d} 110 110)`} fill={C.soft} fillOpacity="0.55" stroke="none" />
              ))}
              {[45, 135, 225, 315].map((d) => (
                <path key={d} d={HERO_BRACKET} transform={`rotate(${d} 110 110)`} strokeOpacity="0.45" strokeWidth="0.9" />
              ))}
            </g>
            {/* precision tick ring */}
            <g id="c-ticks" stroke={C.soft}>
              {HERO_TICKS.map((k, i) => (
                <line key={i} x1={k.x1} y1={k.y1} x2={k.x2} y2={k.y2} strokeOpacity={k.major ? 0.6 : 0.22} strokeWidth={k.major ? 0.9 : 0.6} />
              ))}
            </g>
            {/* segmented arcs */}
            <g id="c-segs" fill="none" strokeLinecap="round">
              <circle cx="110" cy="110" r="108" stroke={C.soft} strokeOpacity="0.55" strokeWidth="2.2" strokeDasharray="70 14 6 14 120 22 18 22 60 300" />
              <circle cx="110" cy="110" r="102" stroke={C.accent} strokeOpacity="0.35" strokeWidth="0.8" strokeDasharray="4 6" />
            </g>
          </>
        )}
        {/* luminous sphere (hero) */}
        <circle id="c-sphere" cx="110" cy="110" r={GYRO_R + 2} fill={hero ? 'url(#c-grad-sphere)' : 'url(#c-grad-core)'} opacity="0" />
        <circle id="c-sphereEdge" cx="110" cy="110" r={GYRO_R + 2} fill="none" stroke={C.bright} strokeWidth="0.8" opacity="0" />

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

      </svg>
      {hero && <canvas ref={plexRef} className="core__plexus" aria-hidden />}
    </div>
  );
}
