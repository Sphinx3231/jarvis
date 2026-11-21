import { useRef, useState } from 'react';
import { Check, ShieldAlert, X } from 'lucide-react';
import { api, type Approval } from '../lib/api';
import { timeAgo } from '../lib/format';
import { useAction, useLiveEvent, useResource } from '../lib/live';
import { gsap, reducedMotion } from '../motion/gsap';
import { useFresh } from '../motion/useFresh';
import ElectricBorder from './bits/ElectricBorder';
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
    <li className="approval" data-approval={approval.id}>
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

/**
 * Pending authorizations. The only place where consequential actions can be approved.
 * While something is waiting, the card carries a live electric border (React Bits ElectricBorder),
 * so a pending decision is hard to miss; it goes quiet the moment nothing is pending.
 */
export function ApprovalsCard({ compact = false, hideWhenEmpty = false }: { compact?: boolean; hideWhenEmpty?: boolean }) {
  const { data } = useResource<{ approvals: Approval[] }>('/api/approvals?status=pending', ['approval.updated', 'task.updated']);
  const approvals = data?.approvals ?? [];
  const ref = useRef<HTMLDivElement>(null);
  useFresh(ref, 'approval', approvals.map((a) => a.id), { y: 0, x: -10 });
  // A decision that was just made (here, on the phone, or by a rule) pulses the card once.
  useLiveEvent('approval.updated', (ev) => {
    const card = ref.current?.querySelector('.card');
    if (card && ev.status !== 'pending' && !reducedMotion()) gsap.fromTo(card, { boxShadow: '0 0 0 1px rgba(251,191,36,0.7), 0 0 30px -6px rgba(251,191,36,0.6)' }, { boxShadow: '0 0 0 1px rgba(251,191,36,0), 0 0 30px -6px rgba(251,191,36,0)', duration: 1.1, ease: 'power2.out', clearProps: 'boxShadow' });
  });
  if (hideWhenEmpty && approvals.length === 0) return null;
  const pending = approvals.length > 0;
  return (
    <div ref={ref} className="approvals-wrap">
      <ElectricBorder active={pending} color="#fbbf24" glowColor="#f59e0b" borderRadius={10} intensity={0.55} speed={0.6} chaos={0.35} thickness={1.2} interactive={false}>
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
      </ElectricBorder>
    </div>
  );
}
