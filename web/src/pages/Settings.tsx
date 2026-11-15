import { Bell, Brain, Info, KeyRound, Mic, Monitor, Palette, Shield, Sparkles, Square, Timer, Trash2, User } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, Field, Loading, PageHeader, Toggle } from '../components/ui';
import { api, type ComputerResponse, type Grant, type Integrations, type Scope, type Settings } from '../lib/api';
import { dateTime } from '../lib/format';
import { useAction, useLive, useResource } from '../lib/live';
import { useVoice, voiceSupport } from '../lib/voice';

interface About {
  license: string;
  source: string;
  builtOn: Array<{ name: string; by: string; license: string; url: string }>;
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function NumberInput({ value, min, max, step = 1, onCommit, suffix }: { value: number; min: number; max: number; step?: number; onCommit: (v: number) => void; suffix?: string }) {
  return (
    <span className="inline">
      <input
        type="number"
        className="num"
        defaultValue={value}
        min={min}
        max={max}
        step={step}
        onBlur={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v) && v !== value) onCommit(Math.min(max, Math.max(min, v)));
        }}
      />
      {suffix && <span className="muted small">{suffix}</span>}
    </span>
  );
}

export function SettingsPage() {
  const act = useAction();
  const { settings } = useLive();
  const voice = useVoice();
  const perms = useResource<{ scopes: Scope[]; grants: Grant[] }>('/api/permissions', ['settings.changed', 'approval.updated', 'integrations.changed']);
  const integrations = useResource<Integrations>('/api/integrations', ['integrations.changed', 'settings.changed']);
  const about = useResource<About>('/api/about', []);
  const computer = useResource<ComputerResponse>('/api/computer', ['settings.changed', 'computer.changed']);
  const [transcriptionKey, setTranscriptionKey] = useState('');
  const [fishKey, setFishKey] = useState('');
  if (!settings) return <Loading />;
  const save = (patch: DeepPartial<Settings>) => act(() => api.patch('/api/settings', patch), 'Saved');
  const s = settings;
  const engine = integrations.data?.model;
  const providers = [...new Set((engine?.models ?? []).map((m) => m.provider))];
  const providerName = (id: string) => engine?.signedIn.find((p) => p.id === id)?.name ?? id;

  return (
    <div className="page page--narrow">
      <PageHeader title="Settings" subtitle="Changes apply immediately." />

      <Card title="You" icon={<User size={18} />}>
        <Field label="Your name" hint="Used in greetings.">
          <input defaultValue={s.assistant.userName} maxLength={60} onBlur={(e) => e.target.value !== s.assistant.userName && save({ assistant: { userName: e.target.value.trim() } })} />
        </Field>
      </Card>

      <Card title="Model" icon={<Sparkles size={18} />}>
        <Field label="Model" hint="Jarvis thinks with the Roamies engine. By default it uses the model you picked in Roamies; you can choose another model from the same Roamies sign-ins, or a local model (Ollama, LM Studio…), here. What the model will or won't do is up to the model.">
          <select value={s.llm.model} onChange={(e) => save({ llm: { model: e.target.value } })} aria-label="Model">
            <option value="">The model picked in Roamies{engine?.source === 'roamies' && engine.model ? ` (${engine.model.name})` : ''}</option>
            {s.llm.model && !engine?.models.some((m) => m.id === s.llm.model) && <option value={s.llm.model}>{s.llm.model}</option>}
            {providers.map((p) => (
              <optgroup key={p} label={providerName(p)}>
                {engine!.models
                  .filter((m) => m.provider === p)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                      {m.tools ? '' : ' (chat only — no tools)'}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </Field>
        <Field label="Thinking" hint="How much the model reasons before answering, where the model supports it. Higher is slower.">
          <select value={s.llm.thinking} onChange={(e) => save({ llm: { thinking: e.target.value as Settings['llm']['thinking'] } })} aria-label="Thinking">
            {(['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const).map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Max tool steps per message">
          <NumberInput value={s.llm.maxToolIterations} min={1} max={12} onCommit={(v) => save({ llm: { maxToolIterations: v } })} />
        </Field>
        {engine && !engine.ready && <div className="note note--warning">{engine.problem} Until then Jarvis handles direct commands only.</div>}
        {engine?.ready && engine.warning && <div className="note note--warning">{engine.warning}</div>}
      </Card>

      <Card title="Voice" icon={<Mic size={18} />}>
        <Field label="Voice features" hint="Microphone button and spoken replies.">
          <Toggle checked={s.voice.enabled} onChange={(v) => save({ voice: { enabled: v } })} />
        </Field>
        <Field
          label="Voice input"
          hint={
            <>
              Automatic uses the browser’s speech recognition where it exists, otherwise records your voice and sends it to the transcription service below. In use now:{' '}
              <strong>{voice.inputMethod === 'browser' ? 'browser recognition' : voice.inputMethod === 'transcription' ? 'transcription service' : 'none available'}</strong>.
            </>
          }
        >
          <select value={s.voice.inputMode} onChange={(e) => save({ voice: { inputMode: e.target.value as Settings['voice']['inputMode'] } })} aria-label="Voice input">
            <option value="auto">Automatic</option>
            <option value="browser" disabled={!voiceSupport.recognition}>
              Browser speech recognition{voiceSupport.recognition ? '' : ' (not available here)'}
            </option>
            <option value="transcription" disabled={!voiceSupport.recording}>
              Transcription service
            </option>
          </select>
        </Field>
        <Field label="Transcription service" hint="OpenAI uses the OpenAI API key you saved in Roamies (whisper-1 / gpt-4o-mini-transcribe). Or use your own Whisper-compatible server, e.g. a local one for fully offline voice. Audio is only sent after you speak.">
          <div className="inline">
            <select value={s.voice.transcription.service} onChange={(e) => save({ voice: { transcription: { service: e.target.value as Settings['voice']['transcription']['service'] } } })} aria-label="Transcription service">
              <option value="openai">OpenAI (key from Roamies)</option>
              <option value="custom">My own server</option>
              <option value="none">None</option>
            </select>
            <input
              defaultValue={s.voice.transcription.model}
              aria-label="Transcription model"
              className="num-wide"
              onBlur={(e) => e.target.value.trim() && e.target.value !== s.voice.transcription.model && save({ voice: { transcription: { model: e.target.value.trim() } } })}
            />
          </div>
        </Field>
        {s.voice.transcription.service === 'custom' && (
          <Field label="Server address" hint="The OpenAI-compatible base URL, e.g. http://127.0.0.1:8000/v1. A key is optional and stored encrypted.">
            <div className="stack">
              <input
                defaultValue={s.voice.transcription.baseUrl}
                placeholder="http://127.0.0.1:8000/v1"
                aria-label="Transcription server address"
                onBlur={(e) => e.target.value.trim() !== s.voice.transcription.baseUrl && save({ voice: { transcription: { baseUrl: e.target.value.trim() } } })}
              />
              <div className="inline">
                <input type="password" autoComplete="off" value={transcriptionKey} onChange={(e) => setTranscriptionKey(e.target.value)} placeholder={integrations.data?.transcription.keySet ? 'Key saved — enter a new one to replace it' : 'Key (optional)'} aria-label="Transcription server key" />
                <Button size="sm" disabled={!transcriptionKey.trim()} onClick={async () => (await act(() => api.put('/api/integrations/transcription/key', { apiKey: transcriptionKey }), 'Key saved securely')) && setTranscriptionKey('')}>
                  Save key
                </Button>
                {integrations.data?.transcription.keySet && (
                  <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => act(() => api.del('/api/integrations/transcription/key'), 'Key removed')}>
                    Remove
                  </Button>
                )}
              </div>
            </div>
          </Field>
        )}
        <Field label="Jarvis's voice" hint="Browser uses the computer's built-in speech. Fish Audio gives Jarvis a natural cloud voice (needs a key — put FISH_AUDIO_KEY in your .env, or paste it below).">
          <select value={s.voice.tts.provider} onChange={(e) => save({ voice: { tts: { provider: e.target.value as 'browser' | 'fish' } } })} aria-label="Voice output">
            <option value="browser">Browser (built-in)</option>
            <option value="fish">Fish Audio</option>
          </select>
        </Field>
        {s.voice.tts.provider === 'fish' && (
          <Field label="Fish Audio voice" hint={`Voice/reference id from fish.audio (empty = account default).${integrations.data?.tts.keyFromEnv ? ' Key loaded from .env.' : ''}`}>
            <div className="stack">
              <input
                defaultValue={s.voice.tts.voiceId}
                placeholder="e.g. a reference id from fish.audio"
                aria-label="Fish Audio voice id"
                onBlur={(e) => e.target.value.trim() !== s.voice.tts.voiceId && save({ voice: { tts: { voiceId: e.target.value.trim() } } })}
              />
              {!integrations.data?.tts.keyFromEnv && (
                <div className="inline">
                  <input type="password" autoComplete="off" value={fishKey} onChange={(e) => setFishKey(e.target.value)} placeholder={integrations.data?.tts.keySet ? 'Key saved — enter a new one to replace it' : 'Fish Audio API key'} aria-label="Fish Audio API key" />
                  <Button size="sm" disabled={fishKey.trim().length < 8} onClick={async () => (await act(() => api.put('/api/integrations/voice/tts/key', { key: fishKey.trim() }), 'Key saved securely')) && setFishKey('')}>
                    Save key
                  </Button>
                  {integrations.data?.tts.keySet && (
                    <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => act(() => api.del('/api/integrations/voice/tts/key'), 'Key removed')}>
                      Remove
                    </Button>
                  )}
                </div>
              )}
            </div>
          </Field>
        )}
        <Field label="Speak every reply" hint="Replies to voice commands are always spoken.">
          <Toggle checked={s.voice.autoSpeak} onChange={(v) => save({ voice: { autoSpeak: v } })} disabled={!s.voice.enabled} />
        </Field>
        <Field label="Voice">
          <select value={s.voice.voiceName} onChange={(e) => save({ voice: { voiceName: e.target.value } })}>
            <option value="">System default</option>
            {voice.voices.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name} ({v.lang})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Speed">
          <NumberInput value={s.voice.rate} min={0.5} max={2} step={0.1} onCommit={(v) => save({ voice: { rate: v } })} />
        </Field>
        <Field label="Pitch">
          <NumberInput value={s.voice.pitch} min={0} max={2} step={0.1} onCommit={(v) => save({ voice: { pitch: v } })} />
        </Field>
        <Field label="Recognition language">
          <input defaultValue={s.voice.lang} maxLength={20} onBlur={(e) => e.target.value !== s.voice.lang && save({ voice: { lang: e.target.value.trim() || 'en-US' } })} />
        </Field>
        <Field label="Wake word (“Hey Jarvis…”)" hint="Keeps the microphone listening while Jarvis is open; say “Hey Jarvis”. Needs browser speech recognition (available in the browser app window; the packaged desktop app needs a local recognition service) — it never streams audio to a transcription service. Voice can never approve actions.">
          <Toggle checked={s.voice.wakeWord} onChange={(v) => save({ voice: { wakeWord: v } })} disabled={!s.voice.enabled || voice.inputMethod !== 'browser'} />
        </Field>
        {voiceSupport.synthesis && (
          <Button size="sm" onClick={() => voice.speak('Hello. I am Jarvis, and I am ready when you are.')} disabled={!s.voice.enabled}>
            Test voice
          </Button>
        )}
      </Card>

      <Card title="Memory" icon={<Brain size={18} />}>
        <Field label="Save memories from conversations" hint="Jarvis may store useful facts you mention. They stay unverified until you confirm them.">
          <Toggle checked={s.memory.autoExtract} onChange={(v) => save({ memory: { autoExtract: v } })} />
        </Field>
        <Field label="Conversation context" hint="Recent messages sent with each request.">
          <NumberInput value={s.memory.contextMessages} min={2} max={100} onCommit={(v) => save({ memory: { contextMessages: v } })} suffix="messages" />
        </Field>
        <Field label="Memories retrieved per request">
          <NumberInput value={s.memory.retrievalLimit} min={0} max={30} onCommit={(v) => save({ memory: { retrievalLimit: v } })} />
        </Field>
        <Field label="Summarise long conversations" hint="Background job; uses the model a few times at most per run.">
          <Toggle checked={s.memory.summarizeConversations} onChange={(v) => save({ memory: { summarizeConversations: v } })} />
        </Field>
        <Field label="Keep conversations for">
          <NumberInput value={s.memory.conversationRetentionDays} min={1} max={3650} onCommit={(v) => save({ memory: { conversationRetentionDays: v } })} suffix="days" />
        </Field>
      </Card>

      <Card title="Background operation" icon={<Timer size={18} />}>
        <Field label="Background monitoring" hint="Task monitoring, memory maintenance and health checks. Scheduled tasks still run when this is off.">
          <Toggle checked={s.background.enabled} onChange={(v) => save({ background: { enabled: v } })} />
        </Field>
        <Field label="Check tasks every">
          <NumberInput value={s.background.monitorIntervalSec} min={5} max={3600} onCommit={(v) => save({ background: { monitorIntervalSec: v } })} suffix="seconds" />
        </Field>
        <Field label="Memory maintenance every">
          <NumberInput value={s.background.maintenanceIntervalMin} min={1} max={1440} onCommit={(v) => save({ background: { maintenanceIntervalMin: v } })} suffix="minutes" />
        </Field>
        <Field label="Health check every">
          <NumberInput value={s.background.healthIntervalMin} min={1} max={1440} onCommit={(v) => save({ background: { healthIntervalMin: v } })} suffix="minutes" />
        </Field>
        <Field label="Tasks at the same time">
          <NumberInput value={s.background.maxConcurrentTasks} min={1} max={8} onCommit={(v) => save({ background: { maxConcurrentTasks: v } })} />
        </Field>
        <Field label="Flag a step as slow after">
          <NumberInput value={s.background.stalledAfterSec} min={30} max={86400} onCommit={(v) => save({ background: { stalledAfterSec: v } })} suffix="seconds" />
        </Field>
        <Field label="Remind me about approvals after">
          <NumberInput value={s.background.approvalReminderMin} min={1} max={10080} onCommit={(v) => save({ background: { approvalReminderMin: v } })} suffix="minutes" />
        </Field>
        <Field label="Step timeout">
          <NumberInput value={s.tasks.stepTimeoutSec} min={5} max={3600} onCommit={(v) => save({ tasks: { stepTimeoutSec: v } })} suffix="seconds" />
        </Field>
        <Field label="Attempts for repeatable steps" hint="Steps that aren’t safe to repeat (commands, writes) are never retried automatically.">
          <NumberInput value={s.tasks.maxAttempts} min={1} max={5} onCommit={(v) => save({ tasks: { maxAttempts: v } })} />
        </Field>
      </Card>

      <Card title="Permissions" icon={<Shield size={18} />}>
        <div className={`fullaccess ${s.permissions.fullAccess ? 'is-on' : ''}`}>
          <div className="fullaccess__row">
            <div>
              <div className="fullaccess__title">Full access to this computer</div>
              <div className="muted small">
                When on, Jarvis may use <strong>every</strong> capability — read and write files anywhere on the disk, reach any website (including your local network), and run shell commands — with <strong>no sandbox and no approval prompts</strong>. Turn this on only on a machine you trust Jarvis with. (It does not let Jarvis control other apps, your screen, or input — that is a separate capability.)
              </div>
            </div>
            <Toggle
              checked={s.permissions.fullAccess}
              onChange={(v) => {
                if (v && !window.confirm('Give Jarvis FULL access to this computer? It will read/write any file, reach any site, and run shell commands with no approval prompts. Only do this on a machine you trust it with.')) return;
                save({ permissions: { fullAccess: v } });
              }}
              ariaLabel="Full access to this computer"
            />
          </div>
          {s.permissions.fullAccess && <div className="fullaccess__banner">⚠ Full access is ON — Jarvis acts without asking. Turn it off when you're done.</div>}
        </div>
        <Field
          label="Do what I ask without asking again"
          hint="Your request is your approval: steps that are clearly part of what you asked — the command you typed, the email you asked for — just run. Anything beyond what you asked, anything Jarvis starts on its own, and anything containing instructions from a web page or file still waits for your explicit approval. A permission set to Deny stays denied."
        >
          <Toggle checked={s.permissions.followRequests} onChange={(v) => save({ permissions: { followRequests: v } })} ariaLabel="Do what I ask without asking again" />
        </Field>
        <p className="muted small">
          What Jarvis may do without asking{s.permissions.followRequests ? ' when it is not something you asked for' : ''}. External actions ask first by default. Shell commands and sending email can't be set to “allow” for everything.
        </p>
        {!perms.data ? (
          <Loading />
        ) : (
          perms.data.scopes.map((scope) => (
            <Field key={scope.id} label={scope.label} hint={scope.description}>
              <select
                value={scope.policy}
                onChange={(e) => save({ permissions: { policies: { [scope.id]: e.target.value as 'allow' } } })}
                aria-label={`Policy for ${scope.label}`}
              >
                <option value="allow" disabled={!scope.allowPermitted}>
                  Allow{!scope.allowPermitted ? ' (not available)' : ''}
                </option>
                <option value="ask">Ask first</option>
                <option value="deny">Never</option>
              </select>
            </Field>
          ))
        )}
        <h3 className="section-title">
          <KeyRound size={15} /> Remembered authorizations
        </h3>
        {perms.data && perms.data.grants.length === 0 && <p className="muted small">None. When approving, tick “Always allow this exact action” to let one identical action repeat (useful for recurring tasks).</p>}
        <ul className="grants">
          {(perms.data?.grants ?? []).map((g) => (
            <li key={g.id}>
              <div>
                <div>{g.description}</div>
                <div className="muted small">
                  <code>{g.skill}</code> · since {dateTime(g.createdAt)} · used {g.uses}× {g.expiresAt ? `· expires ${dateTime(g.expiresAt)}` : ''}
                </div>
              </div>
              <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => act(() => api.del(`/api/grants/${g.id}`), 'Revoked')}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Computer Access" icon={<Monitor size={18} />}>
        <p className="muted small">
          Let Jarvis see — and, at higher levels, use — this computer: what’s on screen (read as text with OCR), the active window, and the mouse and keyboard. Off by default. When off, nothing is observed or controlled. Every mouse/keyboard action still needs your approval.{' '}
          {computer.data && (
            <>
              This machine: <strong>{computer.data.status.os}</strong>, display <strong>{computer.data.status.display.server}</strong>
              {computer.data.status.display.headless ? ' (no screen detected)' : ''}.
            </>
          )}
        </p>
        <div className={`fullaccess ${s.computerAccess.enabled ? 'is-on' : ''}`}>
          <div className="fullaccess__row">
            <div>
              <div className="fullaccess__title">Computer Access</div>
              <div className="muted small">When on, Jarvis can observe this computer (and, at the Interact level, control the mouse and keyboard). You can stop it instantly below.</div>
            </div>
            <Toggle
              checked={s.computerAccess.enabled}
              onChange={(v) => {
                if (v && !window.confirm('Turn on Computer Access? Jarvis will be able to see this computer’s screen and windows. At the Interact level it can also move the mouse and type — each action still needs your approval.')) return;
                save({ computerAccess: { enabled: v } });
              }}
              ariaLabel="Computer Access"
            />
          </div>
          {s.computerAccess.enabled && (
            <div className="fullaccess__banner">
              ● Computer Access is ON ({s.computerAccess.level}) — Jarvis can see this computer{s.computerAccess.level !== 'observe' ? ' and use the mouse/keyboard' : ''}.
            </div>
          )}
        </div>
        <Field label="Level" hint="Observe = see only (screen, windows; no input). Interact = also move the mouse, type, scroll and switch windows. Extended = open/manage apps and files (not wired yet).">
          <select value={s.computerAccess.level} onChange={(e) => save({ computerAccess: { level: e.target.value as Settings['computerAccess']['level'] } })} disabled={!s.computerAccess.enabled} aria-label="Computer Access level">
            <option value="observe">Observe (see only)</option>
            <option value="interact">Interact (mouse &amp; keyboard)</option>
            <option value="extended">Extended (apps &amp; files)</option>
          </select>
        </Field>
        <Field label="Keep screenshots for" hint="How long temporary screenshots are kept on disk. 0 = delete as soon as they are read.">
          <NumberInput value={s.computerAccess.screenshotRetentionMin} min={0} max={1440} onCommit={(v) => save({ computerAccess: { screenshotRetentionMin: v } })} suffix="minutes" />
        </Field>
        <div className="inline">
          <Button size="sm" variant="danger" icon={<Square size={14} />} disabled={!s.computerAccess.enabled} onClick={() => act(() => api.post('/api/computer/stop', { reason: 'Stopped from Settings' }), 'Computer Access stopped')}>
            STOP now
          </Button>
          <Button size="sm" variant="ghost" onClick={() => act(() => api.post('/api/computer/verify'), 'Checked this machine')}>
            Run capability check
          </Button>
        </div>
        {computer.data && (
          <div className="stack" style={{ marginTop: 12 }}>
            {computer.data.status.capabilities.map((c) => (
              <div key={c.id} className="inline">
                <Badge tone={c.status === 'available' ? 'success' : c.status === 'unavailable' ? 'danger' : c.status === 'limited' ? 'info' : 'warning'} title={c.requires ?? ''}>
                  {c.status}
                </Badge>
                <span>
                  <strong>{c.label}</strong> <span className="muted small">— {c.detail}</span>
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="muted small">The “Observe this computer” and “Control this computer” permissions above govern how often Jarvis asks before each use. Control is consequential and always asks (or runs under Full access).</p>
      </Card>

      <Card title="Notifications" icon={<Bell size={18} />}>
        <Field label="Desktop notifications" hint="When the Jarvis window is in the background. Your browser must allow notifications (see Integrations).">
          <Toggle checked={s.notifications.desktop} onChange={(v) => save({ notifications: { desktop: v } })} />
        </Field>
        <Field label="Notify when tasks complete">
          <Toggle checked={s.notifications.taskCompletion} onChange={(v) => save({ notifications: { taskCompletion: v } })} />
        </Field>
      </Card>

      <Card title="Appearance" icon={<Palette size={18} />}>
        <Field label="Accent colour">
          <div className="swatches">
            {(['violet', 'indigo', 'fuchsia'] as const).map((a) => (
              <button key={a} className={`swatch swatch--${a} ${s.appearance.accent === a ? 'is-active' : ''}`} onClick={() => save({ appearance: { accent: a } })} aria-label={a} title={a} />
            ))}
          </div>
        </Field>
        <Field label="Reduce motion" hint="Holds the core still; state is shown by colour only.">
          <Toggle checked={s.appearance.reduceMotion} onChange={(v) => save({ appearance: { reduceMotion: v } })} />
        </Field>
      </Card>
      <Card title="Sub-agents" icon={<Sparkles size={18} />}>
        <p className="muted small">Named specialists that run in the background with their own memory, shown as colored satellites around Jarvis: Friday (profit), Tom (new small programs), Neo (pipeline watch &amp; keys), Sentinel (scope), Echo (digest), Trinity (security operator — knows the Kali arsenal &amp; the ethical-hacking methodology).</p>
        <Field label="Run the sub-agents" hint="When on, they work on a schedule (and only while background monitoring is on).">
          <Toggle checked={s.agents.enabled} onChange={(v) => save({ agents: { enabled: v } })} ariaLabel="Run the sub-agents" />
        </Field>
        <Field label="Running cost so far (USD)" hint="What you've spent on models/tools, so Friday can tell whether the pipeline is in profit.">
          <NumberInput value={s.agents.spendUsd} min={0} max={1000000} step={10} onCommit={(v) => save({ agents: { spendUsd: v } })} suffix="USD" />
        </Field>
        <Field
          label="Live offensive testing (Trinity)"
          hint="When on — and only with full PC access on, against HackerOne programs in your pipeline — Trinity may send live traffic with the Kali tools. Guardrails come from your connected model; this is the authorization switch. Leave off to plan/passive only."
        >
          <Toggle checked={s.agents.offensive} onChange={(v) => save({ agents: { offensive: v } })} ariaLabel="Allow live offensive testing" />
        </Field>
        {s.agents.offensive && !s.permissions.fullAccess && <p className="muted small fullaccess-hint">Offensive mode is on, but live testing also needs <strong>full PC access</strong> (Permissions, above). Until then Trinity plans only.</p>}
      </Card>

      <Card title="About" icon={<Info size={18} />}>
        <div className="credits">
          <p>
            Jarvis is free software under the <strong>GNU Affero General Public License v3</strong>. You can use, study, change and share it; if you share a changed version or let others use it over a network, share its source the same way.
          </p>
          <p>
            Built on{' '}
            {(about.data?.builtOn ?? []).map((b, i) => (
              <span key={b.name}>
                {i > 0 && ' and '}
                <a href={b.url} target="_blank" rel="noreferrer">
                  {b.name}
                </a>{' '}
                by {b.by}
              </span>
            ))}
            {about.data ? ', both AGPL-3.0.' : '…'}
          </p>
          <p>
            <a href={about.data?.source ?? 'https://github.com/Sphinx3231/jarvis'} target="_blank" rel="noreferrer">
              Jarvis source code
            </a>
          </p>
        </div>
      </Card>
    </div>
  );
}
