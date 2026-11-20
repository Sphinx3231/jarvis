import { useEffect, useState } from 'react';
import { BatteryCharging, BatteryFull, BatteryLow, BatteryMedium, Plug } from 'lucide-react';

/*
 * Dial-style HUD pieces: the arc-reactor emblem, the clock dial and segmented ring gauges.
 * Pure SVG, sized by their container; motion is CSS (transform only) and stops with reduced motion.
 */

const P = (cx: number, cy: number, r: number, deg: number) => [cx + r * Math.cos((deg * Math.PI) / 180), cy + r * Math.sin((deg * Math.PI) / 180)] as const;

/** An annular sector from a0 to a1 degrees between radii r0 and r1, as a path. */
function sector(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const [x0, y0] = P(cx, cy, r1, a0);
  const [x1, y1] = P(cx, cy, r1, a1);
  const [x2, y2] = P(cx, cy, r0, a1);
  const [x3, y3] = P(cx, cy, r0, a0);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r1} ${r1} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} L${x2.toFixed(2)} ${y2.toFixed(2)} A${r0} ${r0} 0 ${large} 0 ${x3.toFixed(2)} ${y3.toFixed(2)} Z`;
}

/** The arc reactor: rings, a segmented collar and a glowing inverted triangle. */
export function ArcReactor({ size = 40, className = '' }: { size?: number | string; className?: string }) {
  const tri = (r: number) =>
    [90, 210, 330]
      .map((a) => P(50, 50, r, a))
      .map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`)
      .join(' ') + ' Z';
  return (
    <svg className={`reactor ${className}`} viewBox="0 0 100 100" width={size} height={size} aria-hidden>
      <defs>
        <radialGradient id="reactor-core" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#fff" />
          <stop offset="40%" stopColor="#ddd6fe" />
          <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="reactor-seg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#c4b5fd" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#6d28d9" stopOpacity="0.6" />
        </linearGradient>
      </defs>
      <circle cx="50" cy="50" r="47" fill="rgba(12,7,28,0.85)" stroke="#a78bfa" strokeOpacity="0.55" strokeWidth="1.2" />
      <g className="reactor__collar">
        {Array.from({ length: 10 }, (_, i) => (
          <path key={i} d={sector(50, 50, 33, 42, i * 36 + 3, i * 36 + 33)} fill="url(#reactor-seg)" stroke="#ddd6fe" strokeOpacity="0.5" strokeWidth="0.5" />
        ))}
      </g>
      <circle cx="50" cy="50" r="30" fill="none" stroke="#c4b5fd" strokeOpacity="0.7" strokeWidth="1" />
      <circle cx="50" cy="50" r="27" fill="rgba(76,29,149,0.35)" />
      <path d={tri(24)} fill="rgba(139,92,246,0.25)" stroke="#ddd6fe" strokeWidth="2.6" strokeLinejoin="round" className="reactor__tri" />
      <path d={tri(13)} fill="#c4b5fd" fillOpacity="0.55" stroke="#ede9fe" strokeWidth="1" strokeLinejoin="round" />
      <circle cx="50" cy="50" r="11" fill="url(#reactor-core)" className="reactor__core" />
    </svg>
  );
}

/** Battery / mains state from the Battery Status API, when the platform reports one. */
type Power = { level: number; charging: boolean } | null;
function usePower(): Power {
  const [power, setPower] = useState<Power>(null);
  useEffect(() => {
    const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number; charging: boolean; addEventListener: (e: string, f: () => void) => void; removeEventListener: (e: string, f: () => void) => void }> };
    if (!nav.getBattery) return;
    let bat: Awaited<ReturnType<NonNullable<typeof nav.getBattery>>> | null = null;
    const update = () => bat && setPower({ level: bat.level, charging: bat.charging });
    nav
      .getBattery()
      .then((b) => {
        bat = b;
        update();
        b.addEventListener('levelchange', update);
        b.addEventListener('chargingchange', update);
      })
      .catch(() => {});
    return () => {
      bat?.removeEventListener('levelchange', update);
      bat?.removeEventListener('chargingchange', update);
    };
  }, []);
  return power;
}

const two = (n: number) => String(n).padStart(2, '0');

/** The clock dial: segmented bezel, minute ticks, a sweeping seconds arc, time and date. */
export function HudClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const power = usePower();
  const sec = now.getSeconds();
  const secEnd = -90 + (sec / 60) * 360;
  const [tx, ty] = P(100, 100, 82, secEnd);
  // A desktop on mains reports a full, charging "battery": show it as AC power.
  const onMains = power && power.charging && power.level >= 0.999;
  const BatIcon = !power ? null : onMains ? Plug : power.charging ? BatteryCharging : power.level > 0.6 ? BatteryFull : power.level > 0.25 ? BatteryMedium : BatteryLow;
  return (
    <div className="hudclock" role="timer" aria-label={`${now.toLocaleTimeString()} ${now.toDateString()}`}>
      <svg viewBox="0 0 200 200" className="hudclock__dial" aria-hidden>
        {/* segmented bezel */}
        <g className="hudclock__bezel">
          {Array.from({ length: 12 }, (_, i) => (
            <path key={i} d={sector(100, 100, 92, 97, i * 30 - 88, i * 30 - 62)} className={i === Math.floor(now.getHours() % 12) ? 'is-hour' : ''} />
          ))}
        </g>
        {/* minute ticks */}
        <g className="hudclock__ticks">
          {Array.from({ length: 60 }, (_, i) => {
            const [x0, y0] = P(100, 100, i % 5 === 0 ? 74 : 77, i * 6 - 90);
            const [x1, y1] = P(100, 100, 80, i * 6 - 90);
            return <line key={i} x1={x0} y1={y0} x2={x1} y2={y1} className={i % 5 === 0 ? 'is-major' : ''} />;
          })}
        </g>
        {/* seconds sweep */}
        <circle cx="100" cy="100" r="82" className="hudclock__track" />
        {sec > 0 && <path d={`M100 18 A82 82 0 ${sec > 30 ? 1 : 0} 1 ${tx.toFixed(2)} ${ty.toFixed(2)}`} className="hudclock__sweep" />}
        <circle cx={tx} cy={ty} r="3" className="hudclock__tip" />
        <circle cx="100" cy="100" r="64" className="hudclock__inner" />
        <circle cx="100" cy="100" r="58" className="hudclock__spin" />
      </svg>
      <div className="hudclock__face">
        <span className="hudclock__time">
          {two(now.getHours())}:{two(now.getMinutes())}
          <small>{two(sec)}</small>
        </span>
        <span className="hudclock__date">{now.toLocaleDateString('en-US', { weekday: 'short', day: '2-digit', month: 'short' }).toUpperCase()}</span>
        {power && BatIcon && (
          <span className={`hudclock__power ${!onMains && !power.charging && power.level <= 0.2 ? 'is-low' : ''}`} title={onMains ? 'On mains power' : `Battery ${Math.round(power.level * 100)}%${power.charging ? ', charging' : ''}`}>
            <BatIcon size={12} /> {onMains ? 'AC POWER' : `${Math.round(power.level * 100)}%`}
          </span>
        )}
      </div>
    </div>
  );
}

/** A segmented ring gauge (like a launcher widget): filled segments show the live fraction. */
export function RingGauge({ value, label, display, sub, tone = '#a78bfa', segments = 36 }: { value: number | null; label: string; display: string; sub?: string; tone?: string; segments?: number }) {
  const frac = value === null ? 0 : Math.max(0, Math.min(1, value));
  const lit = Math.round(frac * segments);
  const step = 270 / segments;
  return (
    <div className="ringg" style={{ ['--tone' as string]: tone }} role="meter" aria-label={label} aria-valuenow={value === null ? undefined : Math.round(frac * 100)} aria-valuemin={0} aria-valuemax={100}>
      <svg viewBox="0 0 100 100" aria-hidden>
        {Array.from({ length: segments }, (_, i) => {
          const a0 = 135 + i * step + 0.8;
          return <path key={i} d={sector(50, 50, 38, 46, a0, a0 + step - 1.6)} className={i < lit ? 'is-lit' : ''} />;
        })}
        <circle cx="50" cy="50" r="33" className="ringg__inner" />
      </svg>
      <div className="ringg__face">
        <span className="ringg__value">{display}</span>
        <span className="ringg__label">{label}</span>
      </div>
      {sub && <div className="ringg__sub">{sub}</div>}
    </div>
  );
}
