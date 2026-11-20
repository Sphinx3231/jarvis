import { useId } from 'react';

/** A small area sparkline of real samples. `max` fixes the scale (e.g. 100 for percentages). */
export function Sparkline({ values, max, width = 120, height = 34, label }: { values: number[]; max?: number; width?: number; height?: number; label: string }) {
  const id = useId().replace(/:/g, '');
  if (values.length < 2) return <svg className="spark spark--empty" width={width} height={height} role="img" aria-label={`${label}: collecting samples`} />;
  const top = max ?? (Math.max(...values) * 1.15 || 1);
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => [i * step, height - 2 - (Math.min(v, top) / top) * (height - 4)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${line} L${width} ${height} L0 ${height} Z`;
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label} trend`}>
      <defs>
        <linearGradient id={`sg-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--spark, #8b5cf6)" stopOpacity="0.42" />
          <stop offset="100%" stopColor="var(--spark, #8b5cf6)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#sg-${id})`} />
      <path d={line} fill="none" stroke="var(--spark, #8b5cf6)" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx} cy={ly} r="2.4" fill="var(--spark-dot, #c4b5fd)" />
    </svg>
  );
}
