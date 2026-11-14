import { useState } from 'react';
import { Bell, BookOpen, CalendarDays, Database, Folder, Globe, KeyRound, Mail, Mic, Plug, Plus, RefreshCw, Server, Sparkles, Terminal, Trash2, X } from 'lucide-react';
import { Badge, Button, Card, ErrorNote, Field, Loading, PageHeader, PolicyBadge, Toggle } from '../components/ui';
import { api, type Integrations, type MailServer, type McpStatus, type ProviderStatus, type Settings } from '../lib/api';
import { timeAgo } from '../lib/format';
import { useAction, useLive, useResource } from '../lib/live';
import { voiceSupport } from '../lib/voice';

function ProviderCard({ p, settings }: { p: ProviderStatus; settings: Settings }) {
  const act = useAction();
  const [editing, setEditing] = useState(false);
  const [model, setModel] = useState(p.model);
  const [baseUrl, setBaseUrl] = useState(p.baseUrl);
  const [key, setKey] = useState('');
  const [testing, setTesting] = useState(false);

  const updateProvider = (patch: Partial<Settings['llm']['providers'][number]>) =>
    act(() => api.patch('/api/settings', { llm: { providers: settings.llm.providers.map((x) => (x.id === p.id ? { ...x, ...patch } : x)) } }), 'Saved');

  const health = !p.enabled ? (
    <Badge>Disabled</Badge>
  ) : !p.usable ? (
    <Badge tone="warning">{p.requiresKey && !p.keyConfigured ? 'API key missing' : 'Not configured'}</Badge>
  ) : p.health === null ? (
    <Badge tone="info">Not checked yet</Badge>
  ) : p.health.ok ? (
    <Badge tone="success">Connected</Badge>
  ) : (
    <Badge tone="danger">Unreachable</Badge>
  );

  return (
    <li className="integration">
      <div className="integration__head">
        <div>
          <div className="integration__title">
            {p.name} {p.role === 'primary' && <Badge tone="accent">Primary</Badge>} {p.role === 'fallback' && <Badge>Fallback</Badge>}
          </div>
          <div className="muted small">
            {p.type === 'anthropic' ? 'Anthropic API' : 'OpenAI-compatible API'} · <code>{p.model}</code>
            {p.baseUrl && (
              <>
                {' '}
                · <code>{p.baseUrl}</code>
              </>
            )}
          </div>
        </div>
        {health}
        <Toggle checked={p.enabled} onChange={(v) => updateProvider({ enabled: v })} ariaLabel={`Use ${p.name}`} />
      </div>
      {p.health && <div className={`small ${p.health.ok ? 'muted' : 'bad'}`}>{p.health.detail} · checked {timeAgo(p.health.checkedAt)}</div>}
      {p.lastError && p.lastError !== p.health?.detail && <div className="small bad">Last error: {p.lastError}</div>}
      <div className="integration__row">
        {p.requiresKey && (
          <span className="small">
            <KeyRound size={13} /> API key: {p.keyConfigured ? <Badge tone="success">{p.keySource === 'environment' ? 'from environment' : 'stored (encrypted)'}</Badge> : <Badge tone="warning">not set</Badge>}
          </span>
        )}
        <span className="spacer" />
        <Button size="sm" icon={<RefreshCw size={14} />} busy={testing} onClick={async () => (setTesting(true), await act(() => api.post(`/api/integrations/providers/${p.id}/test`)), setTesting(false))}>
          Test connection
        </Button>
        {p.role !== 'primary' && p.enabled && (
          <Button size="sm" onClick={() => act(() => api.patch('/api/settings', { llm: { primary: p.id, fallbackOrder: [settings.llm.primary, ...settings.llm.fallbackOrder.filter((x) => x !== p.id && x !== settings.llm.primary)] } }), `${p.name} is now primary`)}>
            Make primary
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => setEditing((e) => !e)}>
          {editing ? 'Close' : 'Configure'}
        </Button>
      </div>
      {editing && (
        <div className="form form--inline">
          <label className="form__row">
            <span>Model</span>
            <input value={model} onChange={(e) => setModel(e.target.value)} />
          </label>
          {p.type === 'openai-compatible' && (
            <label className="form__row">
              <span>Base URL</span>
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://127.0.0.1:11434/v1" />
            </label>
          )}
          <div className="form__actions">
            <Button size="sm" variant="primary" onClick={() => updateProvider({ model: model.trim(), baseUrl: baseUrl.trim() })}>
              Save
            </Button>
          </div>
          {p.requiresKey && (
            <>
              <label className="form__row">
                <span>API key</span>
                <input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={p.keyConfigured ? 'Enter a new key to replace the stored one' : 'Paste your API key'} />
              </label>
              <div className="form__actions">
                {p.keySource === 'stored' && (
                  <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => act(() => api.del(`/api/integrations/providers/${p.id}/key`), 'Key removed')}>
                    Remove stored key
                  </Button>
                )}
                <Button size="sm" variant="primary" disabled={key.trim().length < 8} onClick={async () => (await act(() => api.put(`/api/integrations/providers/${p.id}/key`, { apiKey: key }), 'Key saved securely')) && setKey('')}>
                  Save key
                </Button>
              </div>
              <p className="muted small">Keys are encrypted on this computer and never shown again or sent to the browser.</p>
            </>
          )}
        </div>
      )}
    </li>
  );
}

function McpCard({ s }: { s: McpStatus }) {
  const act = useAction();
  const [secretName, setSecretName] = useState('');
  const [secretValue, setSecretValue] = useState('');
  const tone = s.state === 'connected' ? 'success' : s.state === 'error' ? 'danger' : s.state === 'connecting' ? 'info' : 'neutral';
  return (
    <li className="integration">
      <div className="integration__head">
        <div>
          <div className="integration__title">{s.name}</div>
          <div className="muted small">
            <code>
              {s.command} {s.args.join(' ')}
            </code>
            {s.serverInfo.name && ` · ${s.serverInfo.name} ${s.serverInfo.version ?? ''}`}
          </div>
        </div>
        <Badge tone={tone}>{s.state === 'connected' ? `Connected · ${s.tools.length} tools` : s.state[0].toUpperCase() + s.state.slice(1)}</Badge>
        <Toggle checked={s.enabled} onChange={(v) => act(() => api.put(`/api/integrations/mcp/${s.id}`, { enabled: v }))} ariaLabel={`Use ${s.name}`} />
      </div>
      {s.error && <div className="small bad">{s.error}</div>}
      {s.tools.length > 0 && (
        <details>
          <summary className="small">Tools</summary>
          <ul className="tool-list">
            {s.tools.map((t) => (
              <li key={t.name}>
                <code>{t.skill}</code> {t.readOnly && <Badge tone="info">read-only</Badge>} <span className="muted small">{t.description}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="integration__row">
        {s.secretEnv.map((e) => (
          <span key={e.name} className="small">
            <KeyRound size={13} /> {e.name} {e.configured ? <Badge tone="success">set</Badge> : <Badge tone="warning">missing</Badge>}
          </span>
        ))}
        <span className="spacer" />
        <Button size="sm" icon={<RefreshCw size={14} />} onClick={() => act(() => api.post(`/api/integrations/mcp/${s.id}/reconnect`), 'Reconnected')}>
          Reconnect
        </Button>
        <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => confirm(`Remove ${s.name}?`) && act(() => api.del(`/api/integrations/mcp/${s.id}`), 'Removed')}>
          Remove
        </Button>
      </div>
      <div className="form form--inline">
        <div className="form__grid">
          <input placeholder="SECRET_ENV_NAME" value={secretName} onChange={(e) => setSecretName(e.target.value.toUpperCase())} aria-label="Secret variable name" />
          <input type="password" placeholder="Secret value" value={secretValue} onChange={(e) => setSecretValue(e.target.value)} aria-label="Secret value" autoComplete="off" />
          <Button
            size="sm"
            disabled={!/^[A-Z_][A-Z0-9_]*$/.test(secretName) || !secretValue}
            onClick={async () => (await act(() => api.put(`/api/integrations/mcp/${s.id}/secrets`, { [secretName]: secretValue }), 'Secret saved')) && (setSecretName(''), setSecretValue(''))}
          >
            Set secret
          </Button>
        </div>
      </div>
    </li>
  );
}

/** Servers verified with Jarvis's MCP client (see tests/mcp-real.test.ts). They run with npx, so Node.js must be installed. */
const MCP_PRESETS = [
  { id: 'custom', label: 'Custom server', name: '', command: 'npx', args: '' },
  { id: 'filesystem', label: 'Filesystem (official) — give Jarvis a folder', name: 'Filesystem', command: 'npx', args: '-y\n@modelcontextprotocol/server-filesystem\n/path/to/folder' },
  { id: 'everything', label: 'Everything (official test server)', name: 'MCP test server', command: 'npx', args: '-y\n@modelcontextprotocol/server-everything\nstdio' },
];

function AddMcp({ onClose }: { onClose: () => void }) {
  const act = useAction();
  const [preset, setPreset] = useState('custom');
  const [name, setName] = useState('');
  const [command, setCommand] = useState('npx');
  const [args, setArgs] = useState('');
  const [secrets, setSecrets] = useState('');
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
  const submit = async () => {
    const secretMap: Record<string, string> = {};
    for (const line of secrets.split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+)\s*$/);
      if (m) secretMap[m[1]] = m[2];
    }
    const ok = await act(
      () => api.post('/api/integrations/mcp', { id, name, command, args: args.split('\n').map((a) => a.trim()).filter(Boolean), env: {}, secretEnv: Object.keys(secretMap), enabled: true, secrets: secretMap }),
      'MCP server added',
    );
    if (ok) onClose();
  };
  return (
    <div className="form form--inline">
      <label className="form__row">
        <span>Start from</span>
        <select
          value={preset}
          onChange={(e) => {
            const p = MCP_PRESETS.find((x) => x.id === e.target.value)!;
            setPreset(p.id);
            setName(p.name);
            setCommand(p.command);
            setArgs(p.args);
          }}
        >
          {MCP_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      {preset === 'filesystem' && <p className="muted small">Replace the last argument with the folder Jarvis may use. The server refuses paths outside it.</p>}
      <div className="form__grid">
        <label className="form__row">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. GitHub" />
        </label>
        <label className="form__row">
          <span>Command</span>
          <input value={command} onChange={(e) => setCommand(e.target.value)} />
        </label>
      </div>
      <label className="form__row">
        <span>Arguments (one per line)</span>
        <textarea rows={3} className="mono" value={args} onChange={(e) => setArgs(e.target.value)} placeholder={'-y\n@modelcontextprotocol/server-everything'} />
      </label>
      <label className="form__row">
        <span>Secret environment variables (NAME=value, one per line — stored encrypted)</span>
        <textarea rows={2} className="mono" value={secrets} onChange={(e) => setSecrets(e.target.value)} placeholder="API_TOKEN=…" />
      </label>
      <p className="muted small">Jarvis starts the server as a local process and lists its tools as skills. Each tool asks for your approval unless you change its permission in Settings.</p>
      <div className="form__actions">
        <Button variant="ghost" icon={<X size={14} />} onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!id || !command.trim()} onClick={submit}>
          Add server
        </Button>
      </div>
    </div>
  );
}

function SemanticMemoryCard({ data, compatible, patch }: { data: Integrations; compatible: ProviderStatus[]; patch: (p: unknown, msg?: string) => Promise<unknown> }) {
  const act = useAction();
  const e = data.embeddings;
  const builtin = e.providerId === 'builtin';
  const [busy, setBusy] = useState(false);
  const modelState = e.builtin.state;
  return (
    <Card title="Semantic memory" icon={<Database size={18} />}>
      <Field label="Search memories by meaning" hint="Finds memories even when you use different words. Keyword search always works too.">
        <Toggle checked={e.enabled} onChange={(v) => patch({ embeddings: { enabled: v } })} ariaLabel="Semantic memory search" />
      </Field>
      <Field label="Runs on" hint={builtin ? 'A small model (all-MiniLM-L6-v2, 23 MB) that runs on this computer. Your memories never leave it.' : 'An OpenAI-compatible embeddings endpoint, e.g. Ollama with nomic-embed-text.'}>
        <select value={e.providerId} onChange={(ev) => patch({ embeddings: { providerId: ev.target.value } })} aria-label="Embedding provider">
          <option value="builtin">This computer (built-in)</option>
          {compatible.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      {!builtin && (
        <Field label="Embedding model">
          <input defaultValue={e.model} onBlur={(ev) => ev.target.value.trim() && ev.target.value !== e.model && patch({ embeddings: { model: ev.target.value.trim() } })} />
        </Field>
      )}
      {builtin && (
        <Field label="Built-in model" hint={e.builtin.error ?? undefined}>
          <div className="inline">
            {modelState === 'ready' && <Badge tone="success">Installed</Badge>}
            {modelState === 'downloading' && <Badge tone="info">Downloading…</Badge>}
            {modelState === 'not_downloaded' && <Badge>Not downloaded</Badge>}
            {modelState === 'error' && <Badge tone="danger">Download failed</Badge>}
            {(modelState === 'not_downloaded' || modelState === 'error') && (
              <Button size="sm" busy={busy} onClick={async () => (setBusy(true), await act(() => api.post('/api/integrations/embeddings/download'), 'Model installed'), setBusy(false))}>
                {modelState === 'error' ? 'Retry' : 'Download (23 MB)'}
              </Button>
            )}
            {modelState === 'ready' && (
              <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => confirm('Remove the built-in model? Semantic search will stop until it is downloaded again.') && act(() => api.del('/api/integrations/embeddings/model'), 'Model removed')}>
                Remove
              </Button>
            )}
          </div>
        </Field>
      )}
      <Field label="Status">
        {e.active ? <Badge tone="success">Active · {e.memoriesEmbedded} memories indexed</Badge> : <Badge>{e.enabled ? (builtin ? 'Waiting for the model' : 'Provider not usable') : 'Off — keyword search only'}</Badge>}
      </Field>
    </Card>
  );
}

const EMAIL_PRESETS: Record<string, { label: string; imap: MailServer; smtp: MailServer; help: string }> = {
  gmail: { label: 'Gmail', imap: { host: 'imap.gmail.com', port: 993, security: 'tls' }, smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' }, help: 'Create an app password: Google Account → Security → 2-Step Verification → App passwords.' },
  icloud: { label: 'iCloud Mail', imap: { host: 'imap.mail.me.com', port: 993, security: 'tls' }, smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' }, help: 'Create an app-specific password at account.apple.com → Sign-In and Security. Your username is the part before @icloud.com.' },
  fastmail: { label: 'Fastmail', imap: { host: 'imap.fastmail.com', port: 993, security: 'tls' }, smtp: { host: 'smtp.fastmail.com', port: 465, security: 'tls' }, help: 'Create an app password under Settings → Privacy & Security → Integrations.' },
  yahoo: { label: 'Yahoo Mail', imap: { host: 'imap.mail.yahoo.com', port: 993, security: 'tls' }, smtp: { host: 'smtp.mail.yahoo.com', port: 465, security: 'tls' }, help: 'Generate an app password under Account Security.' },
  custom: { label: 'Other (IMAP/SMTP)', imap: { host: '', port: 993, security: 'tls' }, smtp: { host: '', port: 465, security: 'tls' }, help: 'Use the IMAP and SMTP settings from your provider.' },
};

function ServerFields({ label, value, onChange }: { label: string; value: MailServer; onChange: (v: MailServer) => void }) {
  return (
    <div className="form__grid">
      <label className="form__row">
        <span>{label} server</span>
        <input value={value.host} onChange={(e) => onChange({ ...value, host: e.target.value.trim() })} placeholder="mail.example.com" />
      </label>
      <label className="form__row">
        <span>Port</span>
        <input type="number" value={value.port} onChange={(e) => onChange({ ...value, port: Number(e.target.value) })} />
      </label>
      <label className="form__row">
        <span>Security</span>
        <select value={value.security} onChange={(e) => onChange({ ...value, security: e.target.value as MailServer['security'] })}>
          <option value="tls">SSL/TLS</option>
          <option value="starttls">STARTTLS</option>
          <option value="none">None (local servers only)</option>
        </select>
      </label>
    </div>
  );
}

function CheckBadge({ check, missing }: { check: { ok: boolean; detail: string } | null; missing: string | null }) {
  if (missing) return <Badge>{missing.includes('turned off') ? 'Off' : 'Not set up'}</Badge>;
  if (!check) return <Badge tone="info">Not checked yet</Badge>;
  return check.ok ? <Badge tone="success">Connected</Badge> : <Badge tone="danger">Not working</Badge>;
}

function EmailCard({ data }: { data: Integrations['email'] }) {
  const act = useAction();
  const [editing, setEditing] = useState(!data.address);
  const [form, setForm] = useState({ address: data.address, displayName: data.displayName, username: data.username, imap: data.imap, smtp: data.smtp, password: '' });
  const [preset, setPreset] = useState('custom');
  const [testing, setTesting] = useState(false);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const save = async (enable: boolean) => {
    const { password, ...rest } = form;
    const ok = await act(() => api.put('/api/integrations/email', { ...rest, enabled: enable, ...(password ? { password } : {}) }), 'Email settings saved');
    if (ok) {
      set({ password: '' });
      setEditing(false);
      setTesting(true);
      await act(() => api.post('/api/integrations/email/test'));
      setTesting(false);
    }
  };
  return (
    <Card title="Email" icon={<Mail size={18} />} action={<CheckBadge check={data.lastCheck} missing={data.missing} />}>
      <p className="muted small">Jarvis searches and reads mail over IMAP and sends over SMTP. Reading asks first by default; every message sent needs your approval.</p>
      {data.address && !editing && (
        <div className="integration__row">
          <span>
            <strong>{data.address}</strong> <span className="muted small">· IMAP {data.imap.host} · SMTP {data.smtp.host}</span>
          </span>
          <span className="spacer" />
          <Toggle checked={data.enabled} onChange={(v) => act(() => api.put('/api/integrations/email', { enabled: v }))} ariaLabel="Use email" />
          <Button size="sm" icon={<RefreshCw size={14} />} busy={testing} onClick={async () => (setTesting(true), await act(() => api.post('/api/integrations/email/test')), setTesting(false))}>
            Test
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            Change
          </Button>
        </div>
      )}
      {data.lastCheck && !editing && <div className={`small ${data.lastCheck.ok ? 'muted' : 'bad'}`}>{data.lastCheck.detail}</div>}
      {editing && (
        <div className="form form--inline">
          <label className="form__row">
            <span>Provider</span>
            <select
              value={preset}
              onChange={(e) => {
                setPreset(e.target.value);
                const p = EMAIL_PRESETS[e.target.value];
                set({ imap: p.imap, smtp: p.smtp });
              }}
            >
              {Object.entries(EMAIL_PRESETS).map(([id, p]) => (
                <option key={id} value={id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <p className="muted small">
            {EMAIL_PRESETS[preset].help} Outlook.com and Microsoft 365 only allow Microsoft sign-in (OAuth), which Jarvis doesn’t support yet.
          </p>
          <div className="form__grid">
            <label className="form__row">
              <span>Email address</span>
              <input value={form.address} onChange={(e) => set({ address: e.target.value.trim() })} placeholder="you@example.com" />
            </label>
            <label className="form__row">
              <span>Your name (sender)</span>
              <input value={form.displayName} onChange={(e) => set({ displayName: e.target.value })} />
            </label>
            <label className="form__row">
              <span>Username (if different)</span>
              <input value={form.username} onChange={(e) => set({ username: e.target.value.trim() })} placeholder="usually your address" />
            </label>
            <label className="form__row">
              <span>App password</span>
              <input type="password" autoComplete="off" value={form.password} onChange={(e) => set({ password: e.target.value })} placeholder={data.passwordSet ? 'Stored — enter to replace' : 'App password'} />
            </label>
          </div>
          <ServerFields label="IMAP (incoming)" value={form.imap} onChange={(imap) => set({ imap })} />
          <ServerFields label="SMTP (outgoing)" value={form.smtp} onChange={(smtp) => set({ smtp })} />
          <div className="form__actions">
            {data.address && (
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
            <Button variant="primary" disabled={!form.address || !form.imap.host || !form.smtp.host || (!form.password && !data.passwordSet)} onClick={() => save(true)}>
              Save and connect
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

const CALDAV_PRESETS: Record<string, { label: string; url: string; help: string }> = {
  icloud: { label: 'iCloud', url: 'https://caldav.icloud.com/', help: 'Use your Apple ID email and an app-specific password.' },
  fastmail: { label: 'Fastmail', url: 'https://caldav.fastmail.com/', help: 'Use your Fastmail address and an app password.' },
  nextcloud: { label: 'Nextcloud', url: 'https://your-server/remote.php/dav/', help: 'Replace your-server with your Nextcloud address.' },
  custom: { label: 'Other CalDAV server', url: '', help: 'The CalDAV address from your provider.' },
};

function CalendarCard({ data }: { data: Integrations['calendar'] }) {
  const act = useAction();
  const c = data.caldav;
  const [editing, setEditing] = useState(false);
  const [preset, setPreset] = useState('custom');
  const [form, setForm] = useState({ serverUrl: c.serverUrl, username: c.username, password: '' });
  const [feedName, setFeedName] = useState('');
  const [feedUrl, setFeedUrl] = useState('');
  const [testing, setTesting] = useState(false);
  const test = async () => (setTesting(true), await act(() => api.post('/api/integrations/calendar/test')), setTesting(false));
  return (
    <Card title="Calendar" icon={<CalendarDays size={18} />} action={<CheckBadge check={data.lastCheck} missing={c.missing && !data.feeds.length ? c.missing : null} />}>
      <p className="muted small">Read events from CalDAV accounts and calendar feeds; add events to a CalDAV calendar (asks first by default).</p>
      <h3 className="section-title">CalDAV account (read and add events)</h3>
      {c.serverUrl && !editing ? (
        <div className="integration__row">
          <span>
            <strong>{c.username}</strong> <span className="muted small">· {c.serverUrl}</span>
          </span>
          <span className="spacer" />
          <Toggle checked={c.enabled} onChange={(v) => act(() => api.put('/api/integrations/calendar/caldav', { enabled: v }))} ariaLabel="Use CalDAV calendar" />
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            Change
          </Button>
        </div>
      ) : !editing ? (
        <Button size="sm" icon={<Plus size={14} />} onClick={() => setEditing(true)}>
          Connect a CalDAV calendar
        </Button>
      ) : null}
      {editing && (
        <div className="form form--inline">
          <label className="form__row">
            <span>Provider</span>
            <select value={preset} onChange={(e) => (setPreset(e.target.value), setForm((f) => ({ ...f, serverUrl: CALDAV_PRESETS[e.target.value].url || f.serverUrl })))}>
              {Object.entries(CALDAV_PRESETS).map(([id, p]) => (
                <option key={id} value={id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <p className="muted small">{CALDAV_PRESETS[preset].help} Google and Outlook calendars: add their private iCal/ICS link below instead.</p>
          <div className="form__grid">
            <label className="form__row">
              <span>Server address</span>
              <input value={form.serverUrl} onChange={(e) => setForm((f) => ({ ...f, serverUrl: e.target.value.trim() }))} placeholder="https://…" />
            </label>
            <label className="form__row">
              <span>Username</span>
              <input value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value.trim() }))} />
            </label>
            <label className="form__row">
              <span>App password</span>
              <input type="password" autoComplete="off" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} placeholder={c.passwordSet ? 'Stored — enter to replace' : ''} />
            </label>
          </div>
          <div className="form__actions">
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!form.serverUrl || !form.username || (!form.password && !c.passwordSet)}
              onClick={async () => {
                const ok = await act(
                  () => api.put('/api/integrations/calendar/caldav', { enabled: true, serverUrl: form.serverUrl, username: form.username, ...(form.password ? { password: form.password } : {}) }),
                  'Calendar saved',
                );
                if (ok) {
                  setEditing(false);
                  await test();
                }
              }}
            >
              Save and connect
            </Button>
          </div>
        </div>
      )}
      <h3 className="section-title">Subscribed feeds (read-only)</h3>
      {data.feeds.length === 0 && <p className="muted small">None. In Google Calendar use “Secret address in iCal format”; in Outlook use “Publish calendar → ICS”.</p>}
      <ul className="tool-list">
        {data.feeds.map((f) => (
          <li key={f.id} className="inline">
            {f.name}
            <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} aria-label={`Remove ${f.name}`} onClick={() => act(() => api.del(`/api/integrations/calendar/feeds/${f.id}`), 'Feed removed')} />
          </li>
        ))}
      </ul>
      <div className="form__grid">
        <input placeholder="Name, e.g. Work" value={feedName} onChange={(e) => setFeedName(e.target.value)} aria-label="Feed name" />
        <input placeholder="https://… or webcal://… (.ics link)" value={feedUrl} onChange={(e) => setFeedUrl(e.target.value)} aria-label="Feed URL" />
        <Button size="sm" icon={<Plus size={14} />} disabled={!feedName.trim() || feedUrl.trim().length < 8} onClick={async () => (await act(() => api.post('/api/integrations/calendar/feeds', { name: feedName.trim(), url: feedUrl.trim() }), 'Feed added')) && (setFeedName(''), setFeedUrl(''), await test())}>
          Add feed
        </Button>
      </div>
      {data.lastCheck && <div className={`small ${data.lastCheck.ok ? 'muted' : 'bad'}`}>{data.lastCheck.detail}</div>}
      {(c.serverUrl || data.feeds.length > 0) && (
        <div className="form__actions">
          <Button size="sm" icon={<RefreshCw size={14} />} busy={testing} onClick={test}>
            Test calendars
          </Button>
        </div>
      )}
    </Card>
  );
}

const OBSIDIAN_PARTS: Array<{ key: keyof Integrations['obsidian']['include']; label: string; hint: string }> = [
  { key: 'memories', label: 'Memories', hint: 'One note per memory; edit a note to correct it' },
  { key: 'tasks', label: 'Tasks', hint: 'Each task with its steps, results and history, plus a task log' },
  { key: 'conversations', label: 'Conversations', hint: 'Your chats with Jarvis' },
  { key: 'journal', label: 'Daily journal', hint: 'What Jarvis did each day (last 30 days)' },
  { key: 'manual', label: 'Manual', hint: 'Skills, agents, permissions, integrations, background jobs and the architecture docs' },
];

function VaultCard({ data }: { data: Integrations['obsidian'] }) {
  const act = useAction();
  const [editing, setEditing] = useState(false);
  const [path, setPath] = useState(data.vaultPath);
  const [syncing, setSyncing] = useState(false);
  const save = (patch: Record<string, unknown>, msg = 'Saved') => act(() => api.put('/api/integrations/obsidian', patch), msg);
  const r = data.lastReport;
  const status = !data.enabled ? (
    <Badge>Off</Badge>
  ) : data.problem ? (
    <Badge tone="warning">Needs attention</Badge>
  ) : r && !r.ok ? (
    <Badge tone="danger">Update failed</Badge>
  ) : data.ready ? (
    <Badge tone="success">Up to date</Badge>
  ) : (
    <Badge tone="info">Creating…</Badge>
  );
  return (
    <Card title="Jarvis vault (Obsidian)" icon={<BookOpen size={18} />} action={status}>
      <p className="muted small">
        Jarvis keeps everything it learns in its own Obsidian vault — memories, tasks, conversations, a daily journal and its own manual, as linked Markdown notes that update within seconds. Notes you edit are never overwritten; edits to memory notes flow back into Jarvis; notes you add are left alone.
      </p>
      <Field label="Location" hint={data.isDefaultLocation ? 'Default location' : 'Custom location'}>
        {editing ? (
          <div className="inline">
            <input className="mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder={data.location} aria-label="Vault location" />
            <Button size="sm" variant="ghost" onClick={() => (setEditing(false), setPath(data.vaultPath))}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={async () => (await save({ vaultPath: path.trim() }, path.trim() ? 'Vault moved to a new location' : 'Using the default location')) && setEditing(false)}>
              Save
            </Button>
          </div>
        ) : (
          <div className="inline">
            <code>{data.location}</code>
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              Change
            </Button>
          </div>
        )}
      </Field>
      {editing && <p className="muted small">Jarvis creates a new vault at the new location (an empty or new folder). Your current vault stays where it is, untouched.</p>}
      {data.enabled && data.problem && <div className="note note--warning">{data.problem}</div>}
      {data.enabled && data.ready && (
        <Field label="Open it in Obsidian" hint="First time only: in Obsidian choose “Open folder as vault” and pick the location above. After that, this button opens it directly.">
          <a className="btn btn--sm btn--secondary" href={data.openUri}>
            <BookOpen size={14} /> <span>Open in Obsidian</span>
          </a>
        </Field>
      )}
      <Field label="Keep the vault updated">
        <Toggle checked={data.enabled} onChange={(v) => save({ enabled: v }, v ? 'Vault updates on' : 'Vault updates off')} ariaLabel="Keep the vault updated" />
      </Field>
      <Field label="What goes in the vault">
        <div className="checks">
          {OBSIDIAN_PARTS.map((p) => (
            <label key={p.key} className="check" title={p.hint}>
              <input type="checkbox" checked={data.include[p.key]} onChange={(e) => save({ include: { [p.key]: e.target.checked } })} />
              {p.label}
            </label>
          ))}
        </div>
      </Field>
      <div className="integration__row">
        <span className="small muted">
          {r
            ? r.ok
              ? `Updated ${timeAgo(r.at)} · ${data.trackedNotes} notes${r.imported ? ` · ${r.imported} of your edits imported` : ''}`
              : `Last update ${timeAgo(r.at)} failed: ${r.error}`
            : 'Not updated yet.'}
        </span>
        <span className="spacer" />
        <Button size="sm" icon={<RefreshCw size={14} />} busy={syncing} disabled={!data.enabled || Boolean(data.problem)} onClick={async () => (setSyncing(true), await act(() => api.post('/api/integrations/obsidian/sync'), 'Vault updated'), setSyncing(false))}>
          Update now
        </Button>
      </div>
      {r && r.keptUserEdits.length > 0 && (
        <details className="small">
          <summary>{r.keptUserEdits.length} note(s) you edited were left as you wrote them</summary>
          <ul className="tool-list">
            {r.keptUserEdits.map((p) => (
              <li key={p}>
                <code>{p}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

function BrowserCapabilities({ transcription }: { transcription: Integrations['transcription'] }) {
  const [perm, setPerm] = useState(() => ('Notification' in window ? Notification.permission : 'unsupported'));
  return (
    <Card title="This device" icon={<Mic size={18} />}>
      <Field label="Browser speech recognition" hint="In Chromium-based browsers audio may be processed by the browser vendor’s service.">
        {voiceSupport.recognition ? <Badge tone="success">Available</Badge> : <Badge>Not available here</Badge>}
      </Field>
      <Field label="Voice transcription service" hint={`Used when browser recognition is unavailable or chosen in Settings → Voice (${transcription.model}).`}>
        {transcription.available ? <Badge tone="success">Configured</Badge> : <Badge tone="warning">Not configured — add an OpenAI key or a local Whisper server</Badge>}
      </Field>
      <Field label="Spoken replies" hint="Uses voices installed on this computer.">
        {voiceSupport.synthesis ? <Badge tone="success">Available</Badge> : <Badge tone="warning">Not supported</Badge>}
      </Field>
      <Field label="Desktop notifications" hint="Shown when Jarvis needs you while the window is in the background.">
        {perm === 'granted' ? (
          <Badge tone="success">Allowed</Badge>
        ) : perm === 'unsupported' ? (
          <Badge tone="warning">Not supported</Badge>
        ) : perm === 'denied' ? (
          <Badge tone="danger">Blocked in browser settings</Badge>
        ) : (
          <Button size="sm" icon={<Bell size={14} />} onClick={async () => setPerm(await Notification.requestPermission())}>
            Allow notifications
          </Button>
        )}
      </Field>
    </Card>
  );
}

export function IntegrationsPage() {
  const act = useAction();
  const { settings } = useLive();
  const { data, error } = useResource<Integrations>('/api/integrations', ['integrations.changed', 'settings.changed', 'job.ran']);
  const [addingMcp, setAddingMcp] = useState(false);
  const [workspace, setWorkspace] = useState<string | null>(null);

  if (error) return <ErrorNote message={error} />;
  if (!data || !settings) return <Loading />;
  const patch = (p: unknown, msg = 'Saved') => act(() => api.patch('/api/settings', p), msg);
  const compatible = data.providers.filter((p) => p.type === 'openai-compatible');

  return (
    <div className="page">
      <PageHeader title="Integrations" subtitle="Everything Jarvis can connect to. Statuses come from real checks — nothing is shown as connected unless it is." />
      <Card title="Model providers" icon={<Sparkles size={18} />}>
        <p className="muted small">Jarvis tries the primary provider first, then falls back in order. Anthropic requests use server-side refusal fallbacks on supported Claude models.</p>
        <ul className="integrations">
          {data.providers.map((p) => (
            <ProviderCard key={`${p.id}-${p.model}-${p.baseUrl}`} p={p} settings={settings} />
          ))}
        </ul>
      </Card>

      <VaultCard key={data.obsidian.location} data={data.obsidian} />

      <SemanticMemoryCard data={data} compatible={compatible} patch={patch} />

      <Card
        title="MCP servers"
        icon={<Server size={18} />}
        action={
          !addingMcp && (
            <Button size="sm" icon={<Plus size={14} />} onClick={() => setAddingMcp(true)}>
              Add server
            </Button>
          )
        }
      >
        <p className="muted small">Model Context Protocol servers add tools — calendars, email, notes, developer tools and more — without changing Jarvis.</p>
        {addingMcp && <AddMcp onClose={() => setAddingMcp(false)} />}
        {data.mcp.length === 0 && !addingMcp && <p className="muted">No MCP servers configured.</p>}
        <ul className="integrations">
          {data.mcp.map((s) => (
            <McpCard key={s.id} s={s} />
          ))}
        </ul>
      </Card>

      <div className="grid-2">
        <EmailCard key={`${data.email.address}-${data.email.imap.host}`} data={data.email} />
        <CalendarCard data={data.calendar} />
      </div>

      <div className="grid-2">
        <Card title="Local files" icon={<Folder size={18} />}>
          <Field label="Workspace folder" hint="Jarvis can only read and write inside this folder.">
            <div className="inline">
              <input value={workspace ?? data.workspace.path} onChange={(e) => setWorkspace(e.target.value)} className="mono" />
              {workspace !== null && workspace !== data.workspace.path && (
                <Button size="sm" variant="primary" onClick={async () => (await patch({ integrations: { workspaceDir: workspace } })) && setWorkspace(null)}>
                  Save
                </Button>
              )}
            </div>
          </Field>
          <Field label="Status">{data.workspace.exists ? data.workspace.writable ? <Badge tone="success">Ready</Badge> : <Badge tone="warning">Read-only</Badge> : <Badge tone="danger">Folder missing</Badge>}</Field>
          <Field label="Reading">
            <PolicyBadge policy={data.workspace.readPolicy} />
          </Field>
          <Field label="Writing">
            <PolicyBadge policy={data.workspace.writePolicy} />
          </Field>
        </Card>
        <Card title="Web & shell" icon={<Globe size={18} />}>
          <Field label="Fetch web pages">
            <PolicyBadge policy={data.web.policy} />
          </Field>
          <Field label="Allow private network addresses" hint="Lets Jarvis fetch localhost and LAN addresses. Off by default to protect your local services.">
            <Toggle checked={data.web.allowPrivateNetwork} onChange={(v) => patch({ integrations: { web: { allowPrivateNetwork: v } } })} />
          </Field>
          <Field label={`Shell commands`} hint="Always requires your approval for each command (or one remembered exact command).">
            <div className="inline">
              <Terminal size={15} />
              <Toggle checked={data.shell.enabled} onChange={(v) => patch({ integrations: { shell: { enabled: v } } })} label={data.shell.enabled ? 'Enabled' : 'Disabled'} />
            </div>
          </Field>
        </Card>
      </div>
      <BrowserCapabilities transcription={data.transcription} />
      <p className="muted small center">
        <Plug size={12} /> Other services connect through MCP servers. Jarvis only lists integrations it can actually use.
      </p>
    </div>
  );
}
