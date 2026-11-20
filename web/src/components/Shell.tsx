import { useEffect, useState } from 'react';
import { ComputerIndicator } from './ComputerAccess';
import { ArcReactor } from './Hud';
import { Activity, Bell, Brain, House, ListChecks, Maximize2, Minimize2, Plug, Settings, Target, Wrench, X } from 'lucide-react';
import { api, type NotificationEntry, type StatusResponse } from '../lib/api';
import { timeAgo } from '../lib/format';
import { useLive, useResource } from '../lib/live';
import { navigate, type Route } from '../lib/router';

const NAV: Array<{ id: Route['page']; label: string; icon: typeof House }> = [
  { id: 'home', label: 'Home', icon: House },
  { id: 'tasks', label: 'Tasks', icon: ListChecks },
  { id: 'pipeline', label: 'Pipeline', icon: Target },
  { id: 'memory', label: 'Memory', icon: Brain },
  { id: 'skills', label: 'Skills', icon: Wrench },
  { id: 'integrations', label: 'Integrations', icon: Plug },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export function Sidebar({ page, status }: { page: Route['page']; status: StatusResponse | null }) {
  const approvals = status?.status.approvalsPending ?? 0;
  const unverified = status?.status.memory.unverified ?? 0;
  return (
    <nav className="sidebar" aria-label="Main">
      <ul className="nav">
        {NAV.map((item) => {
          const Icon = item.icon;
          const badge = item.id === 'tasks' ? approvals : item.id === 'memory' ? unverified : 0;
          return (
            <li key={item.id}>
              <a
                href={`#/${item.id === 'home' ? '' : item.id}`}
                className={`nav__item ${page === item.id ? 'is-active' : ''}`}
                aria-current={page === item.id ? 'page' : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  navigate({ page: item.id });
                }}
              >
                <Icon size={19} />
                <span className="nav__label">{item.label}</span>
                {badge > 0 && (
                  <span className={`nav__badge ${item.id === 'tasks' ? 'nav__badge--warn' : ''}`} title={item.id === 'tasks' ? 'Pending approvals' : 'Unverified memories'}>
                    {badge}
                  </span>
                )}
              </a>
            </li>
          );
        })}
      </ul>
      <div className="sidebar__foot" title={`Jarvis OS v${status?.status.version ?? '…'}`}>
        v{status?.status.version ?? '…'}
      </div>
    </nav>
  );
}

function useClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);
  return now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** A miniature of the core, for the app's identity in the top bar. */
function BrandOrb() {
  return (
    <span className="brand__orb" aria-hidden>
      <ArcReactor size="100%" />
    </span>
  );
}

export function TopBar({ immersive, onToggleImmersive }: { immersive: boolean; onToggleImmersive: () => void }) {
  const { connected } = useLive();
  const time = useClock();
  const [open, setOpen] = useState(false);
  const notes = useResource<{ notifications: NotificationEntry[]; unread: number }>('/api/notifications', ['notification']);
  const unread = notes.data?.unread ?? 0;
  return (
    <header className="topbar">
      <div className="brand">
        <BrandOrb />
        <div className="brand__text">
          <span className="brand__name">JARVIS</span>
          <span className="brand__sub">AI Operating System</span>
        </div>
      </div>
      <div className={`conn ${connected ? 'conn--on' : 'conn--off'}`} title={connected ? 'Connected to the Jarvis service' : 'Reconnecting to the Jarvis service…'}>
        <span className="conn__dot" />
        {connected ? 'Online' : 'Offline'}
      </div>
      <div className="topbar__spacer" />
      <ComputerIndicator />
      <span className="topbar__sep" />
      <div className="topbar__time">{time}</div>
      <span className="topbar__sep" />
      <div className="notif">
        <button className="icon-btn" aria-label={`Notifications${unread ? ` (${unread} unread)` : ''}`} onClick={() => setOpen((o) => !o)}>
          <Bell size={18} />
          {unread > 0 && <span className="icon-btn__dot">{unread > 9 ? '9+' : unread}</span>}
        </button>
        {open && (
          <div className="notif__panel" role="dialog" aria-label="Notifications">
            <div className="notif__head">
              <strong>Notifications</strong>
              <button className="link" onClick={() => void api.post('/api/notifications/read-all')} disabled={!unread}>
                Mark all read
              </button>
              <button className="icon-btn icon-btn--sm" aria-label="Close" onClick={() => setOpen(false)}>
                <X size={15} />
              </button>
            </div>
            <ul className="notif__list">
              {(notes.data?.notifications ?? []).length === 0 && <li className="notif__empty">No notifications yet.</li>}
              {(notes.data?.notifications ?? []).slice(0, 12).map((n) => (
                <li key={n.id} className={`notif__item ${n.read ? '' : 'is-unread'} lvl-${n.level}`}>
                  <button
                    onClick={() => {
                      if (!n.read) void api.post(`/api/notifications/${n.id}/read`);
                      if (n.taskId) navigate({ page: 'tasks', id: n.taskId });
                      setOpen(false);
                    }}
                  >
                    <span className="notif__title">{n.title}</span>
                    {n.body && <span className="notif__body">{n.body}</span>}
                    <span className="notif__time">{timeAgo(n.ts)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <button className="icon-btn" aria-label="Settings" title="Settings" onClick={() => navigate({ page: 'settings' })}>
        <Settings size={18} />
      </button>
      <button className="icon-btn" onClick={onToggleImmersive} aria-label={immersive ? 'Exit immersive mode (backslash)' : 'Immersive mode (backslash)'} title={immersive ? 'Exit immersive (\\)' : 'Make Jarvis the whole screen (\\)'}>
        {immersive ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
      </button>
    </header>
  );
}

export function Toasts() {
  const { toasts, dismissToast } = useLive();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.level}`}>
          <div className="toast__text">
            <strong>{t.title}</strong>
            {t.body && <span>{t.body}</span>}
          </div>
          <button className="icon-btn icon-btn--sm" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
