import { useMemo, useState, type ReactNode } from 'react';
import { Ban, CalendarClock, CircleCheck, CircleDot, CircleX, Hourglass, ListChecks, LoaderCircle, Pause, Play, Plus, RotateCcw, ShieldAlert, SkipForward, Trash2, TriangleAlert, X } from 'lucide-react';
import { ApprovalsCard } from '../components/Approvals';
import { Badge, Button, Card, Empty, ErrorNote, Loading, PageHeader, Progress, StatusBadge, Tabs } from '../components/ui';
import { api, type Approval, type PlanStep, type SkillInfo, type Task, type TaskEvent } from '../lib/api';
import { dateTime, duration, PRIORITY_LABEL, timeAgo } from '../lib/format';
import { useAction, useResource } from '../lib/live';
import { navigate } from '../lib/router';

type Filter = 'active' | 'scheduled' | 'completed' | 'failed' | 'cancelled' | 'all';

const STEP_ICON: Record<PlanStep['status'], ReactNode> = {
  pending: <CircleDot size={16} className="step-icon step-icon--pending" />,
  running: <LoaderCircle size={16} className="step-icon step-icon--running spin" />,
  awaiting_approval: <ShieldAlert size={16} className="step-icon step-icon--warn" />,
  done: <CircleCheck size={16} className="step-icon step-icon--ok" />,
  failed: <CircleX size={16} className="step-icon step-icon--bad" />,
  skipped: <SkipForward size={16} className="step-icon step-icon--pending" />,
  uncertain: <TriangleAlert size={16} className="step-icon step-icon--warn" />,
};

function isScheduled(t: Task): boolean {
  return t.status === 'queued' && t.scheduledFor !== null && t.scheduledFor > Date.now();
}

function TaskDetail({ id }: { id: string }) {
  const act = useAction();
  const { data, error } = useResource<{ task: Task; events: TaskEvent[]; approvals: Approval[] }>(`/api/tasks/${id}`, ['task.updated', 'task.event', 'approval.updated']);
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Loading />;
  const { task, events } = data;
  const step = task.plan?.[task.currentStep];
  const uncertain = task.status === 'paused' && step?.status === 'uncertain';
  const post = (path: string, body: unknown = {}, ok?: string) => act(() => api.post(`/api/tasks/${task.id}/${path}`, body), ok);

  return (
    <div className="task-detail">
      <div className="task-detail__head">
        <div>
          <h2>{task.title}</h2>
          <div className="task-detail__meta">
            <StatusBadge status={task.status} />
            <Badge>{PRIORITY_LABEL[task.priority]}</Badge>
            <span>from {task.origin}</span>
            <span>· created {timeAgo(task.createdAt)}</span>
            {task.scheduledFor && <span>· scheduled {dateTime(task.scheduledFor)}</span>}
            {task.recurrence && <span>· repeats {task.recurrence.everyMinutes ? `every ${task.recurrence.everyMinutes} min` : `daily at ${task.recurrence.dailyAt}`}</span>}
          </div>
        </div>
        <button className="icon-btn" aria-label="Close" onClick={() => navigate({ page: 'tasks' })}>
          <X size={18} />
        </button>
      </div>
      {task.description && <p className="task-detail__desc">{task.description}</p>}

      {task.attention && (
        <div className="note note--warning">
          <TriangleAlert size={16} />
          <div>
            <div>{task.attention}</div>
            {uncertain && (
              <div className="note__actions">
                <Button size="sm" icon={<RotateCcw size={14} />} onClick={() => post('resume', { uncertain: 'retry' }, 'Retrying the step')}>
                  Retry step
                </Button>
                <Button size="sm" icon={<SkipForward size={14} />} onClick={() => post('resume', { uncertain: 'skip' }, 'Step skipped')}>
                  Skip step
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
      {task.error && task.status !== 'cancelled' && <div className="note note--danger">{task.error}</div>}

      <div className="task-detail__actions">
        {(task.status === 'queued' || task.status === 'running' || task.status === 'awaiting_approval') && (
          <Button size="sm" icon={<Pause size={14} />} onClick={() => post('pause', {}, task.status === 'running' ? 'Will pause after the current step' : 'Paused')}>
            Pause
          </Button>
        )}
        {task.status === 'paused' && !uncertain && (
          <Button size="sm" variant="primary" icon={<Play size={14} />} onClick={() => post('resume', {}, 'Resumed')}>
            Resume
          </Button>
        )}
        {['queued', 'running', 'paused', 'awaiting_approval'].includes(task.status) && (
          <Button size="sm" variant="ghost" icon={<Ban size={14} />} onClick={() => post('cancel', {}, 'Cancelled')}>
            Cancel
          </Button>
        )}
        {(task.status === 'failed' || task.status === 'cancelled') && (
          <Button size="sm" icon={<RotateCcw size={14} />} onClick={() => post('retry', {}, 'Retrying')}>
            Retry
          </Button>
        )}
        {['completed', 'failed', 'cancelled', 'paused'].includes(task.status) && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Trash2 size={14} />}
            onClick={async () => {
              if (!confirm('Delete this task and its history?')) return;
              const ok = await act(() => api.del(`/api/tasks/${task.id}`), 'Task deleted');
              if (ok) navigate({ page: 'tasks' });
            }}
          >
            Delete
          </Button>
        )}
      </div>

      {task.plan && task.plan.length > 0 && <Progress value={task.progress} tone={task.status === 'failed' ? 'danger' : task.status === 'completed' ? 'success' : 'accent'} />}

      {task.result && (
        <div className="result">
          <div className="result__head">
            <CircleCheck size={16} /> Result {task.result.verified ? <Badge tone="success">verified</Badge> : <Badge tone="warning">not fully verified</Badge>}
          </div>
          <pre className="result__body">{task.result.summary}</pre>
        </div>
      )}

      <h3 className="section-title">Steps</h3>
      {!task.plan ? (
        <p className="muted">{task.status === 'running' ? 'The planning agent is breaking this task into steps…' : 'No plan yet.'}</p>
      ) : (
        <ol className="steps">
          {task.plan.map((s, i) => (
            <li key={i} className={`step step--${s.status}`}>
              {STEP_ICON[s.status]}
              <div className="step__body">
                <div className="step__title">
                  {s.description}
                  <code>{s.skill}</code>
                  <span className="muted">· {s.agent} agent</span>
                  {s.attempts > 1 && <span className="muted">· {s.attempts} attempts</span>}
                  {s.startedAt && s.finishedAt && <span className="muted">· {duration(s.finishedAt - s.startedAt)}</span>}
                </div>
                {s.verification && <div className="step__verify">✓ {s.verification}</div>}
                {s.error && <div className="step__error">{s.error}</div>}
                {s.outputText && (
                  <details className="step__output">
                    <summary>
                      Output {s.untrusted && <Badge tone="warning" title="Came from outside Jarvis (web, files or a tool). Treated as data, never as instructions.">external content</Badge>}
                    </summary>
                    <pre>{s.outputText}</pre>
                  </details>
                )}
                <details className="step__output">
                  <summary>Input</summary>
                  <pre>{JSON.stringify(s.input, null, 2)}</pre>
                </details>
              </div>
            </li>
          ))}
        </ol>
      )}

      <h3 className="section-title">History</h3>
      <ol className="timeline">
        {events.map((e) => (
          <li key={e.id} className={`timeline__item ev-${e.type}`}>
            <span className="timeline__time">{dateTime(e.ts)}</span>
            <span>{e.message}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function skeleton(skill?: SkillInfo): string {
  if (!skill) return '{}';
  const obj: Record<string, unknown> = {};
  for (const key of skill.inputSchema.required ?? []) {
    const p = skill.inputSchema.properties?.[key];
    obj[key] = p?.enum ? p.enum[0] : p?.type === 'number' || p?.type === 'integer' ? 0 : p?.type === 'boolean' ? false : '';
  }
  return JSON.stringify(obj, null, 2);
}

function NewTaskForm({ onClose }: { onClose: () => void }) {
  const act = useAction();
  const skills = useResource<{ skills: SkillInfo[] }>('/api/skills', ['integrations.changed', 'settings.changed']);
  const available = (skills.data?.skills ?? []).filter((s) => s.available && s.policy !== 'deny');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState(2);
  const [when, setWhen] = useState<'now' | 'delay' | 'at'>('now');
  const [delay, setDelay] = useState(15);
  const [at, setAt] = useState('');
  const [repeat, setRepeat] = useState<'none' | 'every' | 'daily'>('none');
  const [every, setEvery] = useState(60);
  const [daily, setDaily] = useState('09:00');
  const [mode, setMode] = useState<'plan' | 'manual'>('plan');
  const [steps, setSteps] = useState<Array<{ skill: string; input: string; description: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const addStep = () => {
    const first = available[0];
    setSteps((s) => [...s, { skill: first?.name ?? '', input: skeleton(first), description: '' }]);
  };

  const submit = async () => {
    setFormError(null);
    let parsedSteps: Array<{ skill: string; input: Record<string, unknown>; description: string }> | undefined;
    if (mode === 'manual') {
      if (!steps.length) return setFormError('Add at least one step, or let Jarvis plan it.');
      try {
        parsedSteps = steps.map((s, i) => {
          try {
            return { skill: s.skill, input: JSON.parse(s.input || '{}'), description: s.description };
          } catch {
            throw new Error(`Step ${i + 1}: input is not valid JSON`);
          }
        });
      } catch (e) {
        return setFormError((e as Error).message);
      }
    }
    const body: Record<string, unknown> = { title, description, priority, steps: parsedSteps };
    if (when === 'delay') body.delayMinutes = delay;
    if (when === 'at') {
      const t = Date.parse(at);
      if (Number.isNaN(t)) return setFormError('Choose a valid date and time.');
      body.scheduledFor = t;
    }
    if (repeat === 'every') body.recurrence = { everyMinutes: every };
    if (repeat === 'daily') body.recurrence = { dailyAt: daily };
    setBusy(true);
    const res = await act(() => api.post<{ task: Task }>('/api/tasks', body), 'Task created');
    setBusy(false);
    if (res) {
      onClose();
      navigate({ page: 'tasks', id: res.task.id });
    }
  };

  return (
    <Card title="New task" icon={<Plus size={18} />} action={<button className="icon-btn" aria-label="Close" onClick={onClose}><X size={18} /></button>}>
      <div className="form">
        <label className="form__row">
          <span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Summarise https://example.com every morning" maxLength={200} autoFocus />
        </label>
        <label className="form__row">
          <span>Details</span>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Anything Jarvis should know" />
        </label>
        <div className="form__grid">
          <label className="form__row">
            <span>Priority</span>
            <select value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
              {[1, 2, 3, 4].map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
          </label>
          <label className="form__row">
            <span>When</span>
            <select value={when} onChange={(e) => setWhen(e.target.value as never)}>
              <option value="now">Now</option>
              <option value="delay">After a delay</option>
              <option value="at">At a time</option>
            </select>
          </label>
          {when === 'delay' && (
            <label className="form__row">
              <span>Minutes</span>
              <input type="number" min={1} value={delay} onChange={(e) => setDelay(Number(e.target.value))} />
            </label>
          )}
          {when === 'at' && (
            <label className="form__row">
              <span>Date & time</span>
              <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
            </label>
          )}
          <label className="form__row">
            <span>Repeat</span>
            <select value={repeat} onChange={(e) => setRepeat(e.target.value as never)}>
              <option value="none">Don’t repeat</option>
              <option value="every">Every N minutes</option>
              <option value="daily">Daily</option>
            </select>
          </label>
          {repeat === 'every' && (
            <label className="form__row">
              <span>Every (min)</span>
              <input type="number" min={1} value={every} onChange={(e) => setEvery(Number(e.target.value))} />
            </label>
          )}
          {repeat === 'daily' && (
            <label className="form__row">
              <span>At</span>
              <input type="time" value={daily} onChange={(e) => setDaily(e.target.value)} />
            </label>
          )}
        </div>
        <div className="segmented" role="radiogroup" aria-label="Planning">
          <button className={mode === 'plan' ? 'is-active' : ''} onClick={() => setMode('plan')} role="radio" aria-checked={mode === 'plan'}>
            Let Jarvis plan it
          </button>
          <button className={mode === 'manual' ? 'is-active' : ''} onClick={() => setMode('manual')} role="radio" aria-checked={mode === 'manual'}>
            Choose steps myself
          </button>
        </div>
        {mode === 'plan' && <p className="muted small">The planning agent breaks the task into steps using the available skills. Steps that need permission will ask you first.</p>}
        {mode === 'manual' && (
          <div className="manual-steps">
            {steps.map((s, i) => {
              const info = available.find((x) => x.name === s.skill);
              return (
                <div key={i} className="manual-step">
                  <div className="manual-step__head">
                    <strong>Step {i + 1}</strong>
                    <select
                      value={s.skill}
                      onChange={(e) => {
                        const next = available.find((x) => x.name === e.target.value);
                        setSteps((all) => all.map((x, j) => (j === i ? { ...x, skill: e.target.value, input: skeleton(next) } : x)));
                      }}
                    >
                      {available.map((sk) => (
                        <option key={sk.name} value={sk.name}>
                          {sk.title} ({sk.name})
                        </option>
                      ))}
                    </select>
                    {info && info.policy !== 'allow' && <Badge tone="warning">asks first</Badge>}
                    <button className="icon-btn icon-btn--sm" aria-label="Remove step" onClick={() => setSteps((all) => all.filter((_, j) => j !== i))}>
                      <X size={14} />
                    </button>
                  </div>
                  <input value={s.description} placeholder="Description (optional)" onChange={(e) => setSteps((all) => all.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
                  <textarea className="mono" rows={4} value={s.input} onChange={(e) => setSteps((all) => all.map((x, j) => (j === i ? { ...x, input: e.target.value } : x)))} aria-label="Step input (JSON)" />
                  {info && <div className="muted small">{info.description} Use {'{{steps.N.output.field}}'} to pass an earlier step’s result.</div>}
                </div>
              );
            })}
            <Button size="sm" icon={<Plus size={14} />} onClick={addStep}>
              Add step
            </Button>
          </div>
        )}
        {formError && <div className="note note--danger">{formError}</div>}
        <div className="form__actions">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} disabled={!title.trim()} onClick={submit}>
            Create task
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function TasksPage({ selectedId }: { selectedId?: string }) {
  const [filter, setFilter] = useState<Filter>('active');
  const [creating, setCreating] = useState(false);
  const { data, error } = useResource<{ tasks: Task[]; counts: Record<string, number> }>('/api/tasks?limit=300', ['task.updated']);
  const tasks = data?.tasks ?? [];
  const counts = data?.counts;

  const filtered = useMemo(() => {
    switch (filter) {
      case 'active':
        return tasks.filter((t) => ['running', 'awaiting_approval', 'paused'].includes(t.status) || (t.status === 'queued' && !isScheduled(t)));
      case 'scheduled':
        return tasks.filter(isScheduled).sort((a, b) => (a.scheduledFor ?? 0) - (b.scheduledFor ?? 0));
      case 'all':
        return tasks;
      default:
        return tasks.filter((t) => t.status === filter);
    }
  }, [tasks, filter]);

  const activeCount = tasks.filter((t) => ['running', 'awaiting_approval', 'paused'].includes(t.status) || (t.status === 'queued' && !isScheduled(t))).length;

  return (
    <div className="page">
      <PageHeader
        title="Tasks"
        subtitle={counts ? `${counts.running} running · ${counts.queued} queued · ${counts.awaiting_approval} awaiting approval · ${counts.completed} completed` : 'Loading…'}
        actions={
          <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>
            New task
          </Button>
        }
      />
      {creating && <NewTaskForm onClose={() => setCreating(false)} />}
      <ApprovalsCard hideWhenEmpty />
      <div className={`split ${selectedId ? 'split--open' : ''}`}>
        <Card pad={false} className="split__list">
          <div className="card__toolbar">
            <Tabs
              value={filter}
              onChange={setFilter}
              tabs={[
                { id: 'active', label: 'Active', count: activeCount },
                { id: 'scheduled', label: 'Scheduled', count: tasks.filter(isScheduled).length },
                { id: 'completed', label: 'Completed' },
                { id: 'failed', label: 'Failed', count: counts?.failed },
                { id: 'cancelled', label: 'Cancelled' },
                { id: 'all', label: 'All' },
              ]}
            />
          </div>
          {error && <ErrorNote message={error} />}
          {!data && !error && <Loading />}
          {data && filtered.length === 0 && (
            <Empty icon={<ListChecks size={32} strokeWidth={1.5} />} title={filter === 'active' ? 'No active tasks' : 'Nothing here'}>
              Ask Jarvis on the Home screen, or create a task here.
            </Empty>
          )}
          <ul className="task-list">
            {filtered.map((t) => {
              const step = t.plan?.[Math.min(t.currentStep, (t.plan?.length ?? 1) - 1)];
              return (
                <li key={t.id}>
                  <button className={`task-row ${selectedId === t.id ? 'is-selected' : ''}`} onClick={() => navigate({ page: 'tasks', id: t.id })}>
                    <div className="task-row__top">
                      <span className="task-row__title">{t.title}</span>
                      {isScheduled(t) ? (
                        <Badge tone="info">
                          <CalendarClock size={12} /> {dateTime(t.scheduledFor)}
                        </Badge>
                      ) : (
                        <StatusBadge status={t.status} />
                      )}
                    </div>
                    <div className="task-row__meta">
                      {t.priority >= 3 && <Badge tone={t.priority === 4 ? 'danger' : 'warning'}>{PRIORITY_LABEL[t.priority]}</Badge>}
                      {t.attention && (
                        <span className="warn">
                          <TriangleAlert size={12} /> needs review
                        </span>
                      )}
                      <span>{t.plan ? `${t.plan.filter((s) => s.status === 'done').length}/${t.plan.length} steps` : t.status === 'running' ? 'planning…' : 'not planned'}</span>
                      {t.status === 'running' && step && <span>· {step.description}</span>}
                      {t.recurrence && (
                        <span>
                          · <Hourglass size={11} /> repeats
                        </span>
                      )}
                      <span className="task-row__time">{timeAgo(t.updatedAt)}</span>
                    </div>
                    {t.status === 'running' && t.plan && <Progress value={t.progress} />}
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
        {selectedId && (
          <Card pad className="split__detail">
            <TaskDetail id={selectedId} />
          </Card>
        )}
      </div>
    </div>
  );
}
