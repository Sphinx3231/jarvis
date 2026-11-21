import { useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import { STATUS_LABEL } from '../lib/format';
import SpotlightCard from './bits/SpotlightCard';
import SplitText from './bits/SplitText';
import LatticeLoader from './bits/LatticeLoader';
import Counter from './bits/Counter';
import { gsap, reducedMotion, useGSAP } from '../motion/gsap';

/** The pointer light every Jarvis panel uses (React Bits SpotlightCard, embedded in the panel's own box). */
export const PANEL_LIGHT = { embed: true, spotlightColor: '#a78bfa', intensity: 0.1, spotlightSize: 320, softness: 0.85, borderGlow: 0.55, proximity: 60, flare: false } as const;

export function Card({ title, icon, action, children, className = '', pad = true }: { title?: ReactNode; icon?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <SpotlightCard as="section" {...PANEL_LIGHT} className={`card ${className}`} data-reveal="">
      {title && (
        <header className="card__head">
          {icon && <span className="card__icon">{icon}</span>}
          <h2 className="card__title">{title}</h2>
          {action && <div className="card__action">{action}</div>}
        </header>
      )}
      <div className={pad ? 'card__body' : ''}>{children}</div>
    </SpotlightCard>
  );
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({ variant = 'secondary', size = 'md', icon, busy, children, className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; icon?: ReactNode; busy?: boolean }) {
  return (
    <button className={`btn btn--${variant} btn--${size} ${className}`} disabled={busy || rest.disabled} {...rest}>
      {busy ? <LoaderCircle size={15} className="spin" /> : icon}
      {children && <span>{children}</span>}
    </button>
  );
}

export function Badge({ tone = 'neutral', children, title }: { tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge--${tone}`} title={title}>
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'> = {
  queued: 'info',
  running: 'accent',
  paused: 'neutral',
  awaiting_approval: 'warning',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{STATUS_LABEL[status] ?? status}</Badge>;
}

export function PolicyBadge({ policy }: { policy: string }) {
  if (policy === 'allow') return <Badge tone="success">Allowed</Badge>;
  if (policy === 'deny') return <Badge tone="danger">Denied</Badge>;
  return <Badge tone="warning">Asks first</Badge>;
}

export function Toggle({ checked, onChange, label, ariaLabel, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; ariaLabel?: string; disabled?: boolean }) {
  return (
    <label className={`toggle ${disabled ? 'toggle--disabled' : ''}`} title={ariaLabel}>
      <input type="checkbox" checked={checked} disabled={disabled} aria-label={ariaLabel ?? label} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle__track" aria-hidden>
        <span className="toggle__thumb" />
      </span>
      {label && <span className="toggle__label">{label}</span>}
    </label>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <div className="field__text">
        <div className="field__label">{label}</div>
        {hint && <div className="field__hint">{hint}</div>}
      </div>
      <div className="field__control">{children}</div>
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty__icon">{icon}</div>}
      <div className="empty__title">{title}</div>
      {children && <div className="empty__body">{children}</div>}
    </div>
  );
}

export function Progress({ value, tone = 'accent' }: { value: number; tone?: 'accent' | 'success' | 'warning' | 'danger' }) {
  const bar = useRef<HTMLDivElement>(null);
  const shown = useRef<number | null>(null);
  const pct = Math.max(0, Math.min(1, value)) * 100;
  // The bar eases from the last real value to the new one; it never moves on its own.
  useGSAP(
    () => {
      const from = shown.current;
      shown.current = pct;
      if (!bar.current || from === null || from === pct || reducedMotion()) return;
      gsap.fromTo(bar.current, { width: `${from}%` }, { width: `${pct}%`, duration: 0.7, ease: 'jarvis.out' });
    },
    { dependencies: [pct] },
  );
  return (
    <div className={`progress progress--${tone}`} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className="progress__bar" ref={bar} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** A live number that rolls to its new value when it really changes (React Bits Counter). */
export function Num({ value }: { value: number }) {
  return <Counter value={value} fontSize="1em" intro={false} duration={0.6} className="num" />;
}

/** A compact animated mark beside things that are really running right now (React Bits LatticeLoader). */
export function WorkingMark({ color = '#a78bfa' }: { color?: string }) {
  return (
    <span className="working-mark" aria-hidden>
      <LatticeLoader className="lattice-loader--bare" label="" doneLabel="" errorLabel="" showTimer={false} cellSize={3} gap={1} color={color} glow />
    </span>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: Array<{ id: T; label: ReactNode; count?: number }> }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={`tabs__tab ${value === t.id ? 'is-active' : ''}`} onClick={() => onChange(t.id)}>
          {t.label}
          {t.count !== undefined && t.count > 0 && <span className="tabs__count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        {/* key: a new page title plays its own entrance */}
        <SplitText key={title} text={title} tag="h1" className="page-head__title" trigger="load" effect="rise" splitType="chars" delay={22} duration={0.7} ease="jarvis.out" textAlign="left" />
        {subtitle && <p className="page-head__sub" data-reveal="">{subtitle}</p>}
      </div>
      {actions && <div className="page-head__actions" data-reveal="">{actions}</div>}
    </div>
  );
}

export function Loading() {
  return (
    <div className="loading">
      <LoaderCircle size={18} className="spin" /> Loading…
    </div>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return <div className="note note--danger">{message}</div>;
}
