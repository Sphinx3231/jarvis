import { Bot, Brain, Cpu, FileText, Globe, ListChecks, Plug, Sparkles, Terminal } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge, Card, ErrorNote, Loading, PageHeader, PolicyBadge } from '../components/ui';
import type { SkillInfo } from '../lib/api';
import { useResource } from '../lib/live';
import { navigate } from '../lib/router';

const CATEGORY: Record<string, { label: string; icon: ReactNode }> = {
  memory: { label: 'Memory', icon: <Brain size={18} /> },
  tasks: { label: 'Tasks', icon: <ListChecks size={18} /> },
  system: { label: 'System', icon: <Cpu size={18} /> },
  model: { label: 'Language model', icon: <Sparkles size={18} /> },
  files: { label: 'Local files', icon: <FileText size={18} /> },
  web: { label: 'Web', icon: <Globe size={18} /> },
  shell: { label: 'Shell', icon: <Terminal size={18} /> },
  mcp: { label: 'MCP integrations', icon: <Plug size={18} /> },
};

const RISK_TONE = { internal: 'neutral', read: 'info', write: 'warning', consequential: 'danger' } as const;

function SkillCard({ s }: { s: SkillInfo }) {
  const props = Object.entries(s.inputSchema.properties ?? {});
  return (
    <li className={`skill ${s.available ? '' : 'skill--off'}`}>
      <div className="skill__head">
        <div>
          <div className="skill__title">{s.title}</div>
          <code className="skill__name">{s.name}</code>
        </div>
        {s.available ? <Badge tone="success">Ready</Badge> : <Badge tone="danger">Unavailable</Badge>}
      </div>
      <p className="skill__desc">{s.description}</p>
      {!s.available && s.unavailableReason && <div className="note note--warning small">{s.unavailableReason}</div>}
      <div className="skill__meta">
        <span title={`Permission scope: ${s.scope}`}>
          {s.scopeLabel}: <PolicyBadge policy={s.policy} />
        </span>
        <Badge tone={RISK_TONE[s.risk]}>{s.risk}</Badge>
        {s.idempotent ? <Badge>safe to repeat</Badge> : <Badge tone="warning">never auto-repeated</Badge>}
        {s.untrustedOutput && <Badge tone="warning">external content</Badge>}
        {s.dependsOn && <span className="muted small">needs {s.dependsOn}</span>}
      </div>
      {props.length > 0 && (
        <details className="skill__schema">
          <summary>Inputs</summary>
          <ul>
            {props.map(([k, v]) => (
              <li key={k}>
                <code>{k}</code>
                {s.inputSchema.required?.includes(k) && <span className="req">required</span>} <span className="muted">{v.type ?? ''}</span>
                {v.description && <span className="muted"> — {v.description}</span>}
              </li>
            ))}
          </ul>
          <div className="muted small">Returns: {s.outputDescription}</div>
        </details>
      )}
    </li>
  );
}

export function SkillsPage() {
  const skills = useResource<{ skills: SkillInfo[] }>('/api/skills', ['integrations.changed', 'settings.changed']);
  const agents = useResource<{ agents: Array<{ name: string; title: string; responsibility: string }>; active: Array<{ taskId: string; title: string; agent: string | null }> }>('/api/agents', ['task.updated']);
  const list = skills.data?.skills ?? [];
  const groups = Object.keys(CATEGORY).filter((c) => list.some((s) => s.category === c));
  const ready = list.filter((s) => s.available).length;

  return (
    <div className="page">
      <PageHeader title="Skills" subtitle={skills.data ? `${ready} of ${list.length} skills ready. Every call is checked by the permission engine, verified, and audited.` : 'Loading…'} />
      <Card title="Agents" icon={<Bot size={18} />}>
        <ul className="agents">
          {(agents.data?.agents ?? []).map((a) => {
            const working = (agents.data?.active ?? []).filter((t) => t.agent === a.name);
            return (
              <li key={a.name} className={working.length ? 'is-working' : ''}>
                <div className="agents__title">
                  {a.title} {working.length > 0 && <Badge tone="accent">working</Badge>}
                </div>
                <div className="muted small">{a.responsibility}</div>
                {working.map((t) => (
                  <button key={t.taskId} className="link small" onClick={() => navigate({ page: 'tasks', id: t.taskId })}>
                    → {t.title}
                  </button>
                ))}
              </li>
            );
          })}
        </ul>
      </Card>
      {skills.error && <ErrorNote message={skills.error} />}
      {!skills.data && !skills.error && <Loading />}
      {groups.map((g) => (
        <Card key={g} title={CATEGORY[g].label} icon={CATEGORY[g].icon}>
          <ul className="skills">
            {list
              .filter((s) => s.category === g)
              .map((s) => (
                <SkillCard key={s.name} s={s} />
              ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}
