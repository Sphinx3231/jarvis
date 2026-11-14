import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import { STATUS_LABEL } from '../lib/format';

export function Card({ title, icon, action, children, className = '', pad = true }: { title?: ReactNode; icon?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={`card ${className}`}>
      {title && (
        <header className="card__head">
          {icon && <span className="card__icon">{icon}</span>}
          <h2 className="card__title">{title}</h2>
          {action && <div className="card__action">{action}</div>}
        </header>
      )}
      <div className={pad ? 'card__body' : ''}>{children}</div>
    </section>
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
  return (
    <div className={`progress progress--${tone}`} role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className="progress__bar" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
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
        <h1 className="page-head__title">{title}</h1>
        {subtitle && <p className="page-head__sub">{subtitle}</p>}
      </div>
      {actions && <div className="page-head__actions">{actions}</div>}
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
