import { useState } from 'react';
import { Activity, DollarSign, ExternalLink, RefreshCw, Search, Sparkles, Target, TrendingUp } from 'lucide-react';
import { Badge, Button, Card, Empty, Loading, PageHeader, Toggle } from '../components/ui';
import { api, type PipelineProgram, type PipelineSummary } from '../lib/api';
import { timeAgo } from '../lib/format';
import { navigate } from '../lib/router';
import { useAction, useResource } from '../lib/live';

const PIPELINE_EVENTS = ['pipeline.updated', 'integrations.changed', 'settings.changed', 'job.ran'];

const money = (n: number, currency: string) => {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${currency} ${n.toLocaleString()}`;
  }
};

const STATE_TONE: Record<string, 'success' | 'warning' | 'info' | 'danger' | 'neutral'> = {
  resolved: 'success',
  triaged: 'info',
  new: 'warning',
  'needs-more-info': 'warning',
  duplicate: 'neutral',
  informative: 'neutral',
  'not-applicable': 'danger',
  spam: 'danger',
};

function EarningsChart({ monthly, currency }: { monthly: PipelineSummary['earnings']['monthly']; currency: string }) {
  if (!monthly.length) return <p className="muted small">No bounties recorded yet.</p>;
  const max = Math.max(...monthly.map((m) => m.amount), 1);
  return (
    <div className="pl-chart" role="img" aria-label="Monthly bounty earnings">
      {monthly.map((m) => (
        <div key={m.month} className="pl-chart__col" title={`${m.month}: ${money(m.amount, currency)}`}>
          <div className="pl-chart__bar" style={{ height: `${Math.max(4, (m.amount / max) * 100)}%` }} />
          <span className="pl-chart__label">{m.month.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}

function Programs({ initial, bountyOnly }: { initial: PipelineProgram[]; bountyOnly: boolean }) {
  const [query, setQuery] = useState('');
  const [onlyNew, setOnlyNew] = useState(true);
  const q = query.trim();
  const newOnly = onlyNew && !q;
  const res = useResource<{ programs: PipelineProgram[] }>(
    `/api/pipeline/programs?query=${encodeURIComponent(q)}&bountyOnly=${bountyOnly}&newOnly=${newOnly}`,
    ['pipeline.updated'],
  );
  const list = res.data?.programs ?? initial;
  return (
    <Card
      title="Programs"
      icon={<Target size={18} />}
      action={
        <label className="pl-newtoggle">
          <input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} disabled={Boolean(query.trim())} /> New only
        </label>
      }
    >
      <div className="pl-search">
        <Search size={15} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search all discovered programs by name or handle" aria-label="Search programs" />
      </div>
      {list.length === 0 ? (
        <p className="muted small">{query.trim() ? 'No programs match.' : 'No newly discovered programs. New programs that pay bounties will appear here as Jarvis finds them.'}</p>
      ) : (
        <ul className="pl-programs">
          {list.map((p) => (
            <li key={p.handle}>
              <div className="pl-programs__main">
                <a href={p.url} target="_blank" rel="noreferrer">
                  {p.name} <ExternalLink size={12} />
                </a>
                <span className="muted small">{p.handle}</span>
              </div>
              <div className="pl-programs__tags">
                {p.isNew && <Badge tone="accent">New</Badge>}
                {p.offersBounties ? <Badge tone="success">Pays bounties</Badge> : <Badge>VDP</Badge>}
                <span className="muted small">seen {timeAgo(p.firstSeen)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function PipelinePage() {
  const act = useAction();
  const { data, error } = useResource<{ pipeline: PipelineSummary }>('/api/pipeline', PIPELINE_EVENTS);
  const [syncing, setSyncing] = useState(false);
  if (error) return <Empty icon={<Target size={28} />} title="Pipeline unavailable">{error}</Empty>;
  if (!data) return <Loading />;
  const p = data.pipeline;

  const setRun = (autoRun: boolean) => act(() => api.put('/api/integrations/hackerone', { autoRun }), autoRun ? 'Pipeline running' : 'Pipeline paused');
  const sync = async () => {
    setSyncing(true);
    await act(() => api.post('/api/pipeline/sync'), 'Refreshed');
    setSyncing(false);
  };

  if (!p.connected) {
    return (
      <div className="page">
        <PageHeader title="Bug-bounty pipeline" subtitle="Track your HackerOne earnings and reports, and discover new programs." />
        <Empty icon={<Target size={28} />} title="Connect HackerOne">
          <p>{p.missing}</p>
          <Button variant="primary" onClick={() => navigate({ page: 'integrations' })}>
            Connect on Integrations
          </Button>
        </Empty>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="Bug-bounty pipeline"
        subtitle={`HackerOne — ${p.username}`}
        actions={
          <>
            <Button icon={<RefreshCw size={15} />} busy={syncing} onClick={() => void sync()}>
              Refresh now
            </Button>
          </>
        }
      />

      <Card className="pl-run" icon={<Activity size={18} />} title="Autonomous monitoring">
        <div className="pl-run__row">
          <div>
            <p className="pl-run__state">
              {p.running ? <Badge tone="success">Running</Badge> : <Badge>Paused</Badge>}{' '}
              <span className="muted small">
                {p.running
                  ? `Jarvis keeps discovering programs and refreshing earnings every ${p.intervalMin} min for as long as this is on.`
                  : 'Turn this on to let Jarvis keep the pipeline up to date on its own.'}
              </span>
            </p>
            {p.lastCheck && <p className="muted small">Last run {timeAgo(p.lastCheck.at)}{p.lastCheck.ok ? '' : ` — ${p.lastCheck.detail}`}</p>}
          </div>
          <Toggle checked={p.autoRun} onChange={(v) => void setRun(v)} ariaLabel="Keep the pipeline running" />
        </div>
      </Card>

      <div className="pl-stats">
        <div className="pl-stat">
          <DollarSign size={18} />
          <div className="pl-stat__num">{money(p.earnings.total, p.earnings.currency)}</div>
          <div className="muted small">earned from {p.earnings.count} bounties</div>
        </div>
        <div className="pl-stat">
          <TrendingUp size={18} />
          <div className="pl-stat__num">{money(p.earnings.last30d, p.earnings.currency)}</div>
          <div className="muted small">last 30 days</div>
        </div>
        <div className="pl-stat">
          <Sparkles size={18} />
          <div className="pl-stat__num">{money(p.earnings.averageBounty, p.earnings.currency)}</div>
          <div className="muted small">average bounty</div>
        </div>
        <div className="pl-stat">
          <Target size={18} />
          <div className="pl-stat__num">{p.programs.newCount}</div>
          <div className="muted small">new programs</div>
        </div>
      </div>

      <div className="grid-2">
        <Card title="Earnings by month" icon={<TrendingUp size={18} />}>
          <EarningsChart monthly={p.earnings.monthly} currency={p.earnings.currency} />
        </Card>
        <Card title="Reports" icon={<Activity size={18} />}>
          {p.reports.total === 0 ? (
            <p className="muted small">No reports yet.</p>
          ) : (
            <>
              <div className="pl-states">
                {Object.entries(p.reports.byState).map(([state, n]) => (
                  <Badge key={state} tone={STATE_TONE[state] ?? 'neutral'}>
                    {state} · {n}
                  </Badge>
                ))}
              </div>
              <ul className="pl-reports">
                {p.reports.recent.map((r) => (
                  <li key={r.id}>
                    <span className="pl-reports__title">{r.title}</span>
                    <span className="pl-reports__meta muted small">
                      <Badge tone={STATE_TONE[r.state] ?? 'neutral'}>{r.state}</Badge>
                      {r.program && <span>{r.program}</span>}
                      {r.bounty ? <span>{money(r.bounty, r.currency ?? p.earnings.currency)}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      </div>

      <Programs initial={p.programs.discovered} bountyOnly={p.bountyOnly} />

      <p className="muted small center">
        Jarvis only reads your HackerOne data and discovers programs. Testing a target is always a task you approve — nothing is scanned or attacked from here.
      </p>
    </div>
  );
}
