import { useState } from 'react';
import { Bell, Database, Folder, Globe, KeyRound, Mic, Plug, Plus, RefreshCw, Server, Sparkles, Terminal, Trash2, X } from 'lucide-react';
import { Badge, Button, Card, ErrorNote, Field, Loading, PageHeader, PolicyBadge, Toggle } from '../components/ui';
import { api, type Integrations, type McpStatus, type ProviderStatus, type Settings } from '../lib/api';
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

function AddMcp({ onClose }: { onClose: () => void }) {
  const act = useAction();
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

function BrowserCapabilities() {
  const [perm, setPerm] = useState(() => ('Notification' in window ? Notification.permission : 'unsupported'));
  return (
    <Card title="This device" icon={<Mic size={18} />}>
      <Field label="Speech recognition" hint="Used for voice commands. In Chromium-based browsers audio may be processed by the browser vendor’s service.">
        {voiceSupport.recognition ? <Badge tone="success">Available</Badge> : <Badge tone="warning">Not supported by this browser</Badge>}
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

      <Card title="Semantic memory (embeddings)" icon={<Database size={18} />}>
        <Field label="Use embeddings for memory search" hint="Optional. Needs an OpenAI-compatible embeddings endpoint (e.g. Ollama with nomic-embed-text). Keyword search always works.">
          <Toggle checked={data.embeddings.enabled} onChange={(v) => patch({ embeddings: { enabled: v } })} />
        </Field>
        <Field label="Provider">
          <select value={data.embeddings.providerId} onChange={(e) => patch({ embeddings: { providerId: e.target.value } })}>
            {compatible.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Embedding model">
          <input defaultValue={data.embeddings.model} onBlur={(e) => e.target.value.trim() && e.target.value !== data.embeddings.model && patch({ embeddings: { model: e.target.value.trim() } })} />
        </Field>
        <Field label="Status">
          {data.embeddings.active ? <Badge tone="success">Active · {data.embeddings.memoriesEmbedded} memories embedded</Badge> : <Badge>{data.embeddings.enabled ? 'Provider not usable' : 'Off'}</Badge>}
        </Field>
      </Card>

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
      <BrowserCapabilities />
      <p className="muted small center">
        <Plug size={12} /> Email, calendar and other accounts connect through MCP servers — Jarvis doesn’t pretend to have integrations it can’t actually use.
      </p>
    </div>
  );
}
