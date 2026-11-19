import { useEffect, useRef, useState } from 'react';
import { Check, Eye, Globe, GraduationCap, MonitorSmartphone, OctagonX, Play, Square, X } from 'lucide-react';
import { api, type ComputerAction, type ComputerResponse, type ComputerState } from '../lib/api';
import { useAction, useResource } from '../lib/live';
import { navigate } from '../lib/router';
import { timeAgo } from '../lib/format';

/**
 * Computer Access — the compact top-bar indicator and its detail panel.
 *
 * Always visible: whether Computer Access is ON (and at what level), what Jarvis is doing on the
 * computer right now (OBSERVING / INTERACTING / LEARNING / WAITING FOR APPROVAL …), and a STOP button
 * that is one click away whenever it is on. The panel shows the current task, active app, learning
 * session, critical actions waiting for the user's confirmation (approve / refuse), the browser
 * connection and the recent action log. Everything else (the toggle, the level) lives in Settings.
 */

const STATE_LABEL: Record<ComputerState, string> = {
  IDLE: 'Idle',
  OBSERVING: 'Observing',
  ANALYZING: 'Analyzing',
  PLANNING: 'Planning',
  INTERACTING: 'Interacting',
  VERIFYING: 'Verifying',
  LEARNING: 'Learning',
  WAITING_FOR_APPROVAL: 'Waiting for approval',
  PAUSED: 'Paused',
  COMPLETED: 'Completed',
  ERROR: 'Error',
};

const ACTIVE: ComputerState[] = ['OBSERVING', 'ANALYZING', 'PLANNING', 'INTERACTING', 'VERIFYING', 'LEARNING'];

function tone(state: ComputerState): 'busy' | 'wait' | 'err' | 'idle' {
  if (state === 'WAITING_FOR_APPROVAL') return 'wait';
  if (state === 'ERROR') return 'err';
  if (ACTIVE.includes(state)) return 'busy';
  return 'idle';
}

function outcomeMark(a: ComputerAction): string {
  if (a.outcome === 'ok') return a.verified === true ? '✓' : '•';
  if (a.outcome === 'unverified') return '?';
  if (a.outcome === 'needs_confirmation') return '⏸';
  if (a.outcome === 'cancelled') return '■';
  return '✕';
}

export function ComputerIndicator() {
  const res = useResource<ComputerResponse>('/api/computer', ['computer.changed', 'settings.changed']);
  const act = useAction();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const d = res.data;
  if (!d) return null;
  const s = d.status;
  const live = s.live;
  const pending = live.pendingConfirmations;
  const t = s.enabled ? tone(live.state) : 'idle';
  const stop = () => act(() => api.post('/api/computer/stop', { reason: 'User pressed STOP' }), 'Computer Access stopped and turned off');

  return (
    <div className="ca" ref={ref}>
      <button
        className={`ca__chip ${s.enabled ? `ca__chip--on ca__chip--${t}` : 'ca__chip--off'}`}
        onClick={() => setOpen((o) => !o)}
        aria-label={`Computer Access ${s.enabled ? `on, ${s.level}, ${STATE_LABEL[live.state]}` : 'off'}`}
        aria-expanded={open}
      >
        <MonitorSmartphone size={15} />
        <span className="ca__label">{s.enabled ? `Computer: ${STATE_LABEL[live.state]}` : 'Computer: off'}</span>
        {s.enabled && <span className="ca__level">{s.level}</span>}
        {pending.length > 0 && <span className="ca__count" title="Waiting for your confirmation">{pending.length}</span>}
      </button>
      {s.enabled && (
        <button className="ca__stop" onClick={() => void stop()} title="Emergency stop: abort everything and turn Computer Access off" aria-label="Stop computer access">
          <OctagonX size={15} /> STOP
        </button>
      )}
      {open && (
        <div className="ca__panel" role="dialog" aria-label="Computer Access">
          <div className="ca__head">
            <strong>Computer Access</strong>
            <span className={`ca__pill ${s.enabled ? 'is-on' : ''}`}>{s.enabled ? `ON · ${s.level}` : 'OFF'}</span>
            <button className="icon-btn icon-btn--sm" aria-label="Close" onClick={() => setOpen(false)}>
              <X size={15} />
            </button>
          </div>

          {!s.enabled && (
            <div className="ca__section">
              <p className="ca__muted">Jarvis can’t see or use this computer. Turn it on and choose a level in Settings.</p>
              <button className="btn btn--secondary btn--sm" onClick={() => { setOpen(false); navigate({ page: 'settings' }); }}>
                <span>Open Settings</span>
              </button>
            </div>
          )}

          {s.enabled && (
            <>
              <div className="ca__section">
                <div className={`ca__state ca__state--${tone(live.state)}`}>
                  <span className="ca__dot" /> {STATE_LABEL[live.state]}
                  <span className="ca__muted"> · {timeAgo(live.since)}</span>
                </div>
                {live.task && <div className="ca__row"><span>Task</span><span>{live.task}</span></div>}
                {live.detail && <div className="ca__row"><span>Now</span><span>{live.detail}</span></div>}
                {live.activeApp && <div className="ca__row"><span>App</span><span>{live.activeApp}</span></div>}
                {d.telemetry?.activeWindow?.available && <div className="ca__row"><span>Window</span><span>{d.telemetry.activeWindow.title ?? d.telemetry.activeWindow.app}</span></div>}
                {live.learningSession && (
                  <div className="ca__row"><span><GraduationCap size={13} /> Learning</span><span>{live.learningSession.course}{live.learningSession.lesson ? ` — ${live.learningSession.lesson}` : ''}</span></div>
                )}
              </div>

              {pending.length > 0 && (
                <div className="ca__section ca__section--warn">
                  <div className="ca__title">Needs your confirmation</div>
                  {pending.map((c) => (
                    <div key={c.id} className="ca__confirm">
                      <div>
                        <strong>{c.summary}</strong>
                        <div className="ca__muted">{c.finding.reason}</div>
                      </div>
                      <div className="ca__confirm-actions">
                        <button className="btn btn--primary btn--sm" onClick={() => void act(() => api.post(`/api/computer/confirmations/${c.id}`, { approve: true }), 'Confirmed — Jarvis may do it once')}>
                          <Check size={14} /> <span>Allow once</span>
                        </button>
                        <button className="btn btn--ghost btn--sm" onClick={() => void act(() => api.post(`/api/computer/confirmations/${c.id}`, { approve: false }), 'Refused')}>
                          <span>Refuse</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="ca__section">
                <div className="ca__title"><Globe size={13} /> Browser</div>
                {d.browser?.ok ? (
                  <div className="ca__muted">Connected: {d.browser.detail}</div>
                ) : (
                  <>
                    <div className="ca__muted">{d.browserBinary ? `Not connected. Jarvis can open ${d.browserBinary.split(/[\\/]/).pop()} with its own profile (sign in to your sites there once).` : 'No Chrome / Edge / Brave / Chromium found.'}</div>
                    {d.browserBinary && s.level !== 'observe' && (
                      <button className="btn btn--secondary btn--sm" onClick={() => void act(() => api.post('/api/computer/browser/start', {}), 'Browser started')}>
                        <Play size={14} /> <span>Start browser</span>
                      </button>
                    )}
                  </>
                )}
              </div>

              <div className="ca__section">
                <div className="ca__title"><Eye size={13} /> Learning sessions</div>
                {d.learning.length === 0 && <div className="ca__muted">None yet. Open a course and tell Jarvis “watch this and learn”.</div>}
                {d.learning.slice(0, 4).map((l) => (
                  <div key={l.id} className="ca__learn">
                    <div>
                      <strong>{l.course}</strong> <span className="ca__muted">· {l.status} · {l.lessonsSeen} lesson(s) · {l.notesStored} note(s)</span>
                    </div>
                    {l.gaps.length > 0 && <div className="ca__muted ca__gap" title={l.gaps.join('\n')}>Not learned: {l.gaps[l.gaps.length - 1]}</div>}
                    {l.status === 'watching' && (
                      <button className="btn btn--ghost btn--sm" onClick={() => void act(() => api.post('/api/computer/watch/stop', { id: l.id }), 'Stopped watching')}>
                        <Square size={13} /> <span>Stop</span>
                      </button>
                    )}
                  </div>
                ))}
              </div>

              <div className="ca__section">
                <div className="ca__title">Recent actions</div>
                <ul className="ca__log">
                  {d.recent.length === 0 && <li className="ca__muted">Nothing yet.</li>}
                  {d.recent.slice(0, 15).map((a) => (
                    <li key={a.id} className={`ca__log-item is-${a.outcome}`} title={a.detail}>
                      <span className="ca__mark">{outcomeMark(a)}</span>
                      <span className="ca__kind">{a.kind}</span>
                      <span className="ca__target">{a.target ?? a.detail}</span>
                      {a.critical && <span className="ca__crit">{a.critical}</span>}
                      <span className="ca__time">{timeAgo(a.ts)}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="ca__foot">
                <button className="btn btn--danger btn--sm" onClick={() => void stop()}>
                  <OctagonX size={14} /> <span>STOP — abort and turn off</span>
                </button>
                <button className="link" onClick={() => { setOpen(false); navigate({ page: 'settings' }); }}>Settings</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
