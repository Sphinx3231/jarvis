import { Smartphone, QrCode, Trash2, X } from 'lucide-react';
import qrcode from 'qrcode-generator';
import { useEffect, useMemo, useState } from 'react';
import { api, type MobileStatus, type MobileScope } from '../lib/api';
import { dateTime } from '../lib/format';
import { useAction, useResource } from '../lib/live';
import { Badge, Button, Card, Field, Toggle } from './ui';

const SCOPES: Array<{ id: MobileScope; label: string; hint: string }> = [
  { id: 'observe', label: 'See status', hint: 'agents, tasks, approvals' },
  { id: 'command', label: 'Send commands', hint: 'runs through Jarvis with all its usual checks' },
  { id: 'approve', label: 'Approve / deny', hint: 'answer approval requests' },
  { id: 'stop', label: 'Emergency stop', hint: 'cancel tasks, stop Computer Access' },
];

/** A QR code drawn as one SVG path (no network, no canvas). */
function Qr({ text }: { text: string }) {
  const { path, size } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4},${r + 4}h1v1h-1z`;
    return { path: d, size: n + 8 };
  }, [text]);
  return (
    <svg className="mobile-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Pairing QR code" shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

function Countdown({ until }: { until: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((until - now) / 1000));
  return <span>{s > 0 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'expired'}</span>;
}

/**
 * Jarvis Mobile: pair Android phones through an end-to-end-encrypted relay. Nothing on this computer
 * listens on the network — Jarvis connects out to the relay. A paired phone stays paired (across
 * restarts of Jarvis, this computer, the relay or the phone) until it is unpaired here or on the phone.
 */
export function MobileCard() {
  const act = useAction();
  const res = useResource<{ mobile: MobileStatus }>('/api/mobile', ['integrations.changed', 'settings.changed']);
  const audit = useResource<{ audit: Array<{ ts: number; deviceId: string | null; type: string; outcome: string; detail: string }> }>('/api/mobile/audit?limit=30', ['integrations.changed']);
  const [pair, setPair] = useState<{ uri: string; expiresAt: number; shownAt: number } | null>(null);
  const [showAudit, setShowAudit] = useState(false);
  const m = res.data?.mobile;
  if (!m) return null;
  const devices = m.devices.filter((d) => d.revokedAt === null);
  // The phone that used the code on screen (the server closes the code once used).
  const paired = pair ? devices.find((d) => d.pairedAt >= pair.shownAt) : undefined;
  const tone = m.state === 'connected' ? 'success' : m.state === 'connecting' ? 'info' : m.enabled ? 'danger' : 'neutral';

  return (
    <Card title="Jarvis Mobile" icon={<Smartphone size={18} />} action={<Badge tone={tone}>{m.enabled ? m.state : 'off'}</Badge>}>
      <p className="muted small">
        Control Jarvis from your Android phone, from anywhere. This computer and the phone both connect <em>out</em> to a relay you host; messages are end-to-end encrypted, so the relay can’t read them, and nothing here is opened to the internet. Commands from the phone go through Jarvis’s normal approvals and safety checks.
      </p>
      <Field label="Relay URL" hint={m.relayProblem ?? 'Your relay’s address, e.g. wss://relay.example.com/v1 (see relay/README.md to host one).'}>
        <input defaultValue={m.relayUrl} placeholder="wss://relay.example.com/v1" spellCheck={false} aria-label="Relay URL" onBlur={(e) => e.target.value.trim() !== m.relayUrl && act(() => api.patch('/api/settings', { mobile: { relayUrl: e.target.value.trim() } }), 'Saved')} />
      </Field>
      <Field label="Connect to the relay" hint={m.detail}>
        <Toggle checked={m.enabled} onChange={(v) => act(() => api.patch('/api/settings', { mobile: { enabled: v } }), v ? 'Jarvis Mobile on' : 'Jarvis Mobile off')} ariaLabel="Jarvis Mobile" />
      </Field>

      {pair && !paired ? (
        <div className="mobile-pair">
          <Qr text={pair.uri} />
          <div className="stack">
            <strong>Scan with the Jarvis app</strong>
            <span className="muted small">Jarvis app → Devices → Scan QR code. Works once, for <Countdown until={pair.expiresAt} />. Only show it to your own phone.</span>
            <details className="small">
              <summary>Can’t scan? Copy the link</summary>
              <code className="mobile-link">{pair.uri}</code>
            </details>
            <div className="inline">
              <Button size="sm" variant="ghost" icon={<X size={14} />} onClick={() => act(async () => { await api.del('/api/mobile/pair'); setPair(null); }, 'Pairing cancelled')}>Cancel</Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="inline" style={{ margin: '8px 0' }}>
          <Button size="sm" icon={<QrCode size={14} />} disabled={m.state !== 'connected'} onClick={() => act(async () => { const shownAt = Date.now() - 2000; setPair({ ...(await api.post<{ uri: string; expiresAt: number }>('/api/mobile/pair')), shownAt }); }, 'Pairing code ready')}>
            Pair a phone
          </Button>
          {paired && <Badge tone="success">Paired with {paired.name}</Badge>}
          {m.state !== 'connected' && <span className="muted small">Connect to a relay first.</span>}
        </div>
      )}

      <div className="stack" style={{ marginTop: 8 }}>
        {devices.length === 0 && <span className="muted small">No phones paired.</span>}
        {devices.map((d) => (
          <div key={d.id} className="mobile-device">
            <div className="inline">
              <Badge tone={d.online ? 'success' : 'neutral'}>{d.online ? 'online' : 'offline'}</Badge>
              <strong>{d.name}</strong>
              <span className="muted small">
                {d.platform} · app {d.appVersion} · paired {dateTime(d.pairedAt)}
                {d.lastSeen ? ` · last seen ${dateTime(d.lastSeen)}` : ''}
              </span>
              <Button size="sm" variant="danger" icon={<Trash2 size={14} />} onClick={() => window.confirm(`Unpair ${d.name}? It will need a new QR code to pair again.`) && act(() => api.post(`/api/mobile/devices/${d.id}/revoke`), 'Phone unpaired')}>
                Unpair
              </Button>
            </div>
            <div className="inline small">
              {SCOPES.map((s) => (
                <label key={s.id} className="inline" title={s.hint}>
                  <input
                    type="checkbox"
                    checked={d.scopes.includes(s.id)}
                    onChange={(e) => act(() => api.put(`/api/mobile/devices/${d.id}/scopes`, { scopes: e.target.checked ? [...d.scopes, s.id] : d.scopes.filter((x) => x !== s.id) }), 'Saved')}
                  />
                  {s.label}
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>

      <details open={showAudit} onToggle={(e) => setShowAudit((e.target as HTMLDetailsElement).open)} className="small" style={{ marginTop: 10 }}>
        <summary>Phone activity log</summary>
        <div className="stack">
          {(audit.data?.audit ?? []).map((a, i) => (
            <span key={i} className="muted">
              {dateTime(a.ts)} — {a.type} → <strong>{a.outcome}</strong> {a.detail && `(${a.detail})`}
            </span>
          ))}
          {audit.data?.audit.length === 0 && <span className="muted">Nothing yet.</span>}
        </div>
      </details>
    </Card>
  );
}
