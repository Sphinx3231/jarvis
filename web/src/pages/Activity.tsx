import { useState } from 'react';
import { Activity, Play, ScrollText, Timer } from 'lucide-react';
import { Badge, Button, Card, ErrorNote, Loading, PageHeader, Tabs } from '../components/ui';
import { api, type ActivityEntry, type JobStatus, type NotificationEntry } from '../lib/api';
import { dateTime, duration, timeAgo } from '../lib/format';
import { useAction, useResource } from '../lib/live';
import { navigate } from '../lib/router';

type Tab = 'activity' | 'audit' | 'jobs' | 'notifications';

interface AuditRow {
  id: number;
  ts: number;
  actor: string;
  skill: string;
  task_id: string | null;
  input: string;
  decision: string;
  outcome: string;
  verified: number | null;
  duration_ms: number | null;
  error: string | null;
}

function ActivityList() {
  const [category, setCategory] = useState('');
  const { data, error } = useResource<{ activity: ActivityEntry[] }>(`/api/activity?limit=200${category ? `&category=${category}` : ''}`, ['activity']);
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Loading />;
  const categories = ['', 'tasks', 'memory', 'permissions', 'integrations', 'llm', 'scheduler', 'system', 'jarvis'];
  return (
    <>
      <div className="card__toolbar">
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
          {categories.map((c) => (
            <option key={c} value={c}>
              {c ? c[0].toUpperCase() + c.slice(1) : 'All categories'}
            </option>
          ))}
        </select>
      </div>
      <ul className="feed feed--full">
        {data.activity.map((a) => (
          <li key={a.id} className={`feed__item lvl-${a.level}`}>
            <span className="feed__dot" />
            <span className="feed__cat">{a.category}</span>
            <span className="feed__msg">{a.message}</span>
            <span className="feed__time" title={new Date(a.ts).toLocaleString()}>
              {timeAgo(a.ts)}
            </span>
          </li>
        ))}
        {data.activity.length === 0 && <li className="muted">No activity.</li>}
      </ul>
    </>
  );
}

function AuditLog() {
  const { data, error } = useResource<{ audit: AuditRow[] }>('/api/audit?limit=200', ['task.event', 'activity']);
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Loading />;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Agent</th>
            <th>Skill</th>
            <th>Authorization</th>
            <th>Outcome</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          {data.audit.map((r) => (
            <tr key={r.id}>
              <td className="nowrap">{dateTime(r.ts)}</td>
              <td>{r.actor}</td>
              <td>
                <code>{r.skill}</code>
                {r.task_id && (
                  <button className="link small" onClick={() => navigate({ page: 'tasks', id: r.task_id! })}>
                    task
                  </button>
                )}
                <details>
                  <summary className="small muted">input</summary>
                  <pre className="small">{r.input}</pre>
                </details>
              </td>
              <td>{r.decision.replace('allow:', 'allowed by ')}</td>
              <td>
                <Badge tone={r.outcome === 'success' ? 'success' : r.outcome === 'awaiting_approval' ? 'warning' : r.outcome === 'denied' || r.outcome === 'error' || r.outcome === 'unverified' ? 'danger' : 'neutral'}>
                  {r.outcome.replace('_', ' ')}
                </Badge>
                {r.error && <div className="small bad">{r.error}</div>}
              </td>
              <td className="nowrap">{r.duration_ms !== null ? duration(r.duration_ms) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.audit.length === 0 && <p className="muted pad">No skill executions recorded yet.</p>}
    </div>
  );
}

function Jobs() {
  const act = useAction();
  const { data, error } = useResource<{ jobs: JobStatus[] }>('/api/jobs', ['job.ran', 'settings.changed']);
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Loading />;
  return (
    <ul className="jobs">
      {data.jobs.map((j) => (
        <li key={j.name} className="job">
          <div className="job__head">
            <div>
              <div className="job__title">{j.title}</div>
              <div className="muted small">{j.description}</div>
            </div>
            {j.running ? <Badge tone="accent">Running</Badge> : j.paused ? <Badge>Paused</Badge> : <Badge tone="success">Scheduled</Badge>}
            <Button size="sm" icon={<Play size={14} />} disabled={j.running} onClick={() => act(() => api.post(`/api/jobs/${j.name}/run`), `${j.title} finished`)}>
              Run now
            </Button>
          </div>
          <div className="job__meta small">
            <span>every {duration(j.intervalMs)}</span>
            <span>· runs: {j.runCount}</span>
            <span>· last: {j.lastRunAt ? `${timeAgo(j.lastRunAt)} (${j.lastDurationMs ?? 0} ms)` : 'never'}</span>
            {j.nextRunAt && <span>· next: {timeAgo(j.nextRunAt)}</span>}
          </div>
          {j.lastMessage && <div className={`small ${j.lastStatus === 'error' ? 'bad' : 'muted'}`}>{j.lastMessage}</div>}
        </li>
      ))}
    </ul>
  );
}

function Notifications() {
  const act = useAction();
  const { data } = useResource<{ notifications: NotificationEntry[]; unread: number }>('/api/notifications', ['notification']);
  if (!data) return <Loading />;
  return (
    <>
      <div className="card__toolbar">
        <Button size="sm" disabled={!data.unread} onClick={() => act(() => api.post('/api/notifications/read-all'))}>
          Mark all read
        </Button>
      </div>
      <ul className="feed feed--full">
        {data.notifications.map((n) => (
          <li key={n.id} className={`feed__item lvl-${n.level} ${n.read ? '' : 'is-unread'}`}>
            <span className="feed__dot" />
            <span className="feed__msg">
              <strong>{n.title}</strong> {n.body}
              {n.taskId && (
                <button className="link small" onClick={() => navigate({ page: 'tasks', id: n.taskId! })}>
                  {' '}
                  view task
                </button>
              )}
            </span>
            <span className="feed__time">{timeAgo(n.ts)}</span>
          </li>
        ))}
        {data.notifications.length === 0 && <li className="muted">No notifications.</li>}
      </ul>
    </>
  );
}

export function ActivityPage() {
  const [tab, setTab] = useState<Tab>('activity');
  return (
    <div className="page">
      <PageHeader title="Activity" subtitle="What Jarvis has been doing — including every authorization decision and background job." />
      <Card pad={false}>
        <div className="card__toolbar">
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'activity', label: <><Activity size={14} /> Activity</> },
              { id: 'audit', label: <><ScrollText size={14} /> Audit log</> },
              { id: 'jobs', label: <><Timer size={14} /> Background jobs</> },
              { id: 'notifications', label: 'Notifications' },
            ]}
          />
        </div>
        {tab === 'activity' && <ActivityList />}
        {tab === 'audit' && <AuditLog />}
        {tab === 'jobs' && <Jobs />}
        {tab === 'notifications' && <Notifications />}
      </Card>
    </div>
  );
}
