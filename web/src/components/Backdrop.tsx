import { memo, useRef } from 'react';
import { gsap, reducedMotion, useGSAP } from '../motion/gsap';
import Noise from './bits/Noise';

/**
 * The command-center environment behind the whole app: light sources, a holographic grid, a
 * perspective floor, concentric HUD rings, sweeping orbital arcs and a field of distant particles.
 *
 * Performance: the large SVG is static, so it is painted once. The only motion is a few twinkling
 * points and one slow HUD ring, each on its own layer and animated with opacity/transform only
 * (compositor work, no repaints). Everything stops with reduced motion.
 */

// Deterministic pseudo-random, so the field is identical on every render (no layout flicker).
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const W = 1600;
const H = 1000;
const CX = 800;
const CY = 470;

const STARS = (() => {
  const r = rng(7);
  return Array.from({ length: 110 }, () => ({ x: r() * W, y: r() * H, r: 0.4 + r() * 1.1, o: 0.12 + r() * 0.5 }));
})();
const TWINKLES = (() => {
  const r = rng(42);
  return Array.from({ length: 16 }, (_, i) => ({ x: 4 + r() * 92, y: 4 + r() * 88, s: 2 + r() * 2.5, d: (i * 0.73) % 6, dur: 4 + r() * 5 }));
})();

// Perspective floor: rays from the vanishing point, and rungs that crowd toward the horizon.
const HORIZON = 640;
const FLOOR_RAYS = Array.from({ length: 29 }, (_, i) => {
  const k = i - 14;
  const bx = CX + k * 170;
  const t = (HORIZON - CY) / (H + 120 - CY);
  return { x1: CX + (bx - CX) * t, y1: HORIZON, x2: bx, y2: H + 120 };
});
const FLOOR_RUNGS = Array.from({ length: 11 }, (_, i) => HORIZON + (H - HORIZON) * ((i + 1) / 11) ** 1.9);

const ticks = (r: number, n: number, long: number) =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    const len = i % long === 0 ? 9 : 4;
    return { x1: CX + Math.cos(a) * r, y1: CY + Math.sin(a) * r, x2: CX + Math.cos(a) * (r + len), y2: CY + Math.sin(a) * (r + len), major: i % long === 0 };
  });
const RING_TICKS = ticks(430, 120, 10);

// Orthogonal traces with 45° chamfers, like a circuit board, from the window edges toward the core.
const CIRCUITS: Array<{ d: string; nodes: Array<[number, number]>; o: number }> = [
  { d: 'M 0 210 H 150 L 190 250 H 300 L 330 280', nodes: [[150, 210], [300, 250], [330, 280]], o: 0.16 },
  { d: 'M 0 300 H 90 L 120 330 H 250', nodes: [[90, 300], [250, 330]], o: 0.12 },
  { d: 'M 0 760 H 120 L 170 710 H 290 L 320 680', nodes: [[120, 760], [290, 710], [320, 680]], o: 0.14 },
  { d: 'M 1600 240 H 1450 L 1410 280 H 1300 L 1270 310', nodes: [[1450, 240], [1300, 280], [1270, 310]], o: 0.16 },
  { d: 'M 1600 700 H 1490 L 1450 660 H 1330', nodes: [[1490, 700], [1330, 660]], o: 0.13 },
  { d: 'M 1600 790 H 1520 L 1480 830 H 1380 L 1350 800', nodes: [[1520, 790], [1380, 830], [1350, 800]], o: 0.11 },
  { d: 'M 560 0 V 60 L 600 100 V 150', nodes: [[560, 60], [600, 150]], o: 0.12 },
  { d: 'M 1040 0 V 50 L 1000 90 V 140', nodes: [[1040, 50], [1000, 140]], o: 0.12 },
];
const BEARINGS = Array.from({ length: 12 }, (_, i) => {
  const deg = i * 30;
  const a = ((deg - 90) * Math.PI) / 180;
  return { t: String(deg).padStart(3, '0'), x: (CX + Math.cos(a) * 456).toFixed(1), y: (CY + Math.sin(a) * 456).toFixed(1) };
});

const bracket = (deg: number, r: number) => {
  const a = (deg * Math.PI) / 180;
  const span = 0.09;
  const p = (ang: number, rr: number) => `${(CX + Math.cos(ang) * rr).toFixed(1)} ${(CY + Math.sin(ang) * rr).toFixed(1)}`;
  return `M ${p(a - span, r - 10)} L ${p(a - span, r)} A ${r} ${r} 0 0 1 ${p(a + span, r)} L ${p(a + span, r - 10)}`;
};

/**
 * Depth: the room's layers drift a few pixels against the pointer, deeper layers less (GSAP
 * quickTo, so a stream of pointer events costs one tween per layer). Passive listener; it never
 * touches the event, so nothing above can lose a click or a keystroke. Off with reduced motion.
 */
function useParallax(scope: React.RefObject<HTMLDivElement | null>) {
  useGSAP(
    () => {
      const root = scope.current;
      if (!root || reducedMotion()) return;
      const layers = ([['.backdrop__light', 18], ['.backdrop__grid', 7], ['.backdrop__svg', 11]] as const).flatMap(([sel, depth]) => {
        const el = root.querySelector<HTMLElement>(sel);
        if (!el) return [];
        gsap.set(el, { scale: 1.04 }); // a little bleed so a shifted layer never shows its edge
        return [{ x: gsap.quickTo(el, 'x', { duration: 1.6, ease: 'power3.out' }), y: gsap.quickTo(el, 'y', { duration: 1.6, ease: 'power3.out' }), depth }];
      });
      const move = (e: PointerEvent) => {
        if (reducedMotion()) return;
        const nx = e.clientX / window.innerWidth - 0.5;
        const ny = e.clientY / window.innerHeight - 0.5;
        for (const l of layers) {
          l.x(-nx * l.depth);
          l.y(-ny * l.depth);
        }
      };
      window.addEventListener('pointermove', move, { passive: true });
      return () => window.removeEventListener('pointermove', move);
    },
    { scope },
  );
}

export const Backdrop = memo(function Backdrop() {
  const ref = useRef<HTMLDivElement>(null);
  useParallax(ref);
  return (
    <div className="backdrop" aria-hidden ref={ref}>
      <div className="backdrop__light" />
      <div className="backdrop__grid" />
      <svg className="backdrop__svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="bd-floor" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#8b5cf6" stopOpacity="0" />
            <stop offset="35%" stopColor="#8b5cf6" stopOpacity="0.16" />
            <stop offset="100%" stopColor="#a78bfa" stopOpacity="0.22" />
          </linearGradient>
          <radialGradient id="bd-fade" cx="50%" cy="60%" r="60%">
            <stop offset="0%" stopColor="#fff" stopOpacity="1" />
            <stop offset="70%" stopColor="#fff" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
          <mask id="bd-floor-mask">
            <rect x="0" y="0" width={W} height={H} fill="url(#bd-fade)" />
          </mask>
          <linearGradient id="bd-arc" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#c4b5fd" stopOpacity="0" />
            <stop offset="50%" stopColor="#c4b5fd" stopOpacity="0.32" />
            <stop offset="100%" stopColor="#c4b5fd" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* perspective floor */}
        <g mask="url(#bd-floor-mask)" stroke="url(#bd-floor)" strokeWidth="1">
          {FLOOR_RAYS.map((l, i) => (
            <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} />
          ))}
          {FLOOR_RUNGS.map((y, i) => (
            <line key={`r${i}`} x1="0" y1={y} x2={W} y2={y} strokeOpacity={0.35 + i * 0.06} />
          ))}
        </g>
        {/* the horizon line, lit in the middle */}
        <line x1={CX - 620} y1={HORIZON} x2={CX + 620} y2={HORIZON} stroke="url(#bd-arc)" strokeWidth="1" />

        {/* concentric HUD rings around the centre of the room */}
        <g fill="none" stroke="#a78bfa">
          <circle cx={CX} cy={CY} r="330" strokeOpacity="0.07" />
          <circle cx={CX} cy={CY} r="430" strokeOpacity="0.09" />
          <circle cx={CX} cy={CY} r="545" strokeOpacity="0.06" strokeDasharray="2 10" />
          <circle cx={CX} cy={CY} r="690" strokeOpacity="0.05" />
          <circle cx={CX} cy={CY} r="860" strokeOpacity="0.035" />
        </g>
        <g stroke="#c4b5fd">
          {RING_TICKS.map((t, i) => (
            <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} strokeOpacity={t.major ? 0.22 : 0.09} />
          ))}
        </g>
        <g fill="none" stroke="#c4b5fd" strokeOpacity="0.28" strokeWidth="1.2">
          {[-135, -45, 45, 135].map((d) => (
            <path key={d} d={bracket(d, 548)} />
          ))}
        </g>

        {/* sweeping orbital arcs */}
        <g fill="none">
          <ellipse cx={CX} cy={CY} rx="900" ry="250" transform={`rotate(-9 ${CX} ${CY})`} stroke="url(#bd-arc)" strokeWidth="1" />
          <ellipse cx={CX} cy={CY} rx="760" ry="180" transform={`rotate(11 ${CX} ${CY})`} stroke="#8b5cf6" strokeOpacity="0.1" strokeDasharray="1 9" />
          <ellipse cx={CX} cy={CY + 40} rx="1040" ry="330" transform={`rotate(4 ${CX} ${CY})`} stroke="#7c3aed" strokeOpacity="0.07" />
        </g>

        {/* small HUD marks */}
        <g stroke="#c4b5fd" strokeOpacity="0.3" strokeWidth="1">
          {[
            [CX - 560, CY - 300],
            [CX + 560, CY + 300],
            [CX + 600, CY - 250],
            [CX - 600, CY + 260],
          ].map(([x, y], i) => (
            <g key={i}>
              <line x1={x - 6} y1={y} x2={x + 6} y2={y} />
              <line x1={x} y1={y - 6} x2={x} y2={y + 6} />
            </g>
          ))}
        </g>
        <g stroke="#a78bfa" strokeOpacity="0.14">
          {Array.from({ length: 25 }, (_, i) => (
            <line key={i} x1={CX - 330 + i * 27.5} y1={CY + 440} x2={CX - 330 + i * 27.5} y2={CY + 440 + (i % 5 === 0 ? 10 : 5)} />
          ))}
        </g>

        {/* circuit traces running in from the edges, with junction nodes */}
        <g className="bd-circuits" fill="none" stroke="#a78bfa">
          {CIRCUITS.map((c, i) => (
            <g key={i}>
              <path d={c.d} strokeOpacity={c.o} strokeWidth="1" />
              {c.nodes.map(([x, y], j) => (
                <circle key={j} cx={x} cy={y} r={j === c.nodes.length - 1 ? 3 : 1.8} fill="#09060f" strokeOpacity={c.o * 1.6} />
              ))}
            </g>
          ))}
        </g>
        {/* numbered bearings on the big ring */}
        <g fill="#c4b5fd" fillOpacity="0.22" fontSize="11" fontFamily="ui-monospace, monospace" textAnchor="middle" dominantBaseline="middle">
          {BEARINGS.map((b) => (
            <text key={b.t} x={b.x} y={b.y}>
              {b.t}
            </text>
          ))}
        </g>

        {/* distant particles */}
        <g fill="#ddd6fe">
          {STARS.map((s, i) => (
            <circle key={i} cx={s.x.toFixed(1)} cy={s.y.toFixed(1)} r={s.r.toFixed(2)} opacity={s.o.toFixed(2)} />
          ))}
        </g>
      </svg>

      {/* the only moving parts: a slow HUD ring and a few twinkling lights */}
      <div className="backdrop__spin">
        <svg viewBox="0 0 200 200">
          <circle cx="100" cy="100" r="96" fill="none" stroke="#a78bfa" strokeOpacity="0.16" strokeWidth="0.6" strokeDasharray="22 6 3 6 40 12 3 12" />
        </svg>
      </div>
      {TWINKLES.map((t, i) => (
        <i key={i} className="backdrop__twinkle" style={{ left: `${t.x}%`, top: `${t.y}%`, width: t.s, height: t.s, animationDelay: `${-t.d}s`, animationDuration: `${t.dur}s` }} />
      ))}
      <div className="backdrop__vignette" />
      {/* static film grain (React Bits Noise at 0 fps: painted once, no animation loop) */}
      <Noise opacity={0.05} fps={0} size={1.4} contrast={0.5} blendMode="overlay" />
    </div>
  );
});
