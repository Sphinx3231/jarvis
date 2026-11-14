import { useState } from 'react';
import { Check, ShieldAlert, X } from 'lucide-react';
import { api, type Approval } from '../lib/api';
import { timeAgo } from '../lib/format';
import { useAction, useResource } from '../lib/live';
import { navigate } from '../lib/router';
import { Button, Card } from './ui';

function ApprovalItem({ approval, compact }: { approval: Approval; compact?: boolean }) {
  const act = useAction();
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const decide = async (decision: 'approve' | 'deny') => {
    setBusy(decision);
    await act(() => api.post(`/api/approvals/${approval.id}/${decision}`, { remember: decision === 'approve' ? remember : false }), decision === 'approve' ? 'Approved' : 'Denied — nothing was done');
    setBusy(null);
  };
  return (
    <li className="approval">
      <div className="approval__summary">{approval.summary}</div>
      {approval.reason && <div className="approval__reason small">{approval.reason}</div>}
      <div className="approval__meta">
        <button className="link" onClick={() => navigate({ page: 'tasks', id: approval.taskId })}>
          {approval.taskTitle}
        </button>
        <span>· step {approval.stepIndex + 1}</span>
        <span>· {timeAgo(approval.createdAt)}</span>
      </div>
      {!compact && (
        <details className="approval__input">
          <summary>Exact input</summary>
          <pre>{JSON.stringify(approval.input, null, 2)}</pre>
        </details>
      )}
      <div className="approval__actions">
        <label className="check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Always allow this exact action
        </label>
        <div className="approval__buttons">
          <Button size="sm" variant="ghost" icon={<X size={15} />} busy={busy === 'deny'} onClick={() => decide('deny')}>
            Deny
          </Button>
          <Button size="sm" variant="primary" icon={<Check size={15} />} busy={busy === 'approve'} onClick={() => decide('approve')}>
            Approve
          </Button>
        </div>
      </div>
    </li>
  );
}

/** Pending authorizations. The only place where consequential actions can be approved. */
export function ApprovalsCard({ compact = false, hideWhenEmpty = false }: { compact?: boolean; hideWhenEmpty?: boolean }) {
  const { data } = useResource<{ approvals: Approval[] }>('/api/approvals?status=pending', ['approval.updated', 'task.updated']);
  const approvals = data?.approvals ?? [];
  if (hideWhenEmpty && approvals.length === 0) return null;
  return (
    <Card title="Pending approvals" icon={<ShieldAlert size={18} />} className="card--attention">
      {approvals.length === 0 ? (
        <p className="muted">Nothing is waiting for your approval.</p>
      ) : (
        <ul className="approvals">
          {approvals.map((a) => (
            <ApprovalItem key={a.id} approval={a} compact={compact} />
          ))}
        </ul>
      )}
    </Card>
  );
}
