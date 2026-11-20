import { Bell, Brain, Info, KeyRound, Mic, Monitor, Palette, Shield, Sparkles, Square, Timer, Trash2, User } from 'lucide-react';
import { useState } from 'react';
import { MobileCard } from '../components/MobileCard';
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

      <Card title="Brain" icon={<Sparkles size={18} />}>
        <Field label="Jarvis thinks with" hint="OpenJarvis runs everything on this computer: local models, local listening (Whisper) and a local voice (Kokoro) — no API keys, no token bills, no usage limits. Roamies uses the sign-ins in the Roamies app (cloud models).">
          <select value={s.brain.backend} onChange={(e) => save({ brain: { backend: e.target.value as Settings['brain']['backend'] } })} aria-label="Brain">
            <option value="openjarvis">OpenJarvis — fully local (recommended)</option>
            <option value="roamies">Roamies engine — cloud sign-ins</option>
          </select>
        </Field>
        <Field label="Local only" hint="Refuse every cloud model, cloud voice and cloud transcription — and use local listening instead of the browser's (Chrome's speech recognition sends audio to Google). Nothing is ever billed.">
          <Toggle checked={s.brain.localOnly} onChange={(v) => save({ brain: { localOnly: v } })} ariaLabel="Local only" />
        </Field>
        {s.brain.backend === 'openjarvis' && (
          <>
            <Field label="Route" hint="Through OpenJarvis (default), or straight to the local engine (Ollama) — skipping the OpenJarvis server leaves about 500 MB more RAM for the model. Listening and the voice stay local either way.">
              <select value={s.brain.via} onChange={(e) => save({ brain: { via: e.target.value as Settings['brain']['via'] } })} aria-label="Brain route">
                <option value="openjarvis">Through OpenJarvis</option>
                <option value="engine">Direct to the engine (leanest)</option>
              </select>
            </Field>
            <Field label="OpenJarvis address" hint="Where `jarvis serve` runs — this computer or your local network only.">
              <input defaultValue={s.brain.openjarvisUrl} spellCheck={false} aria-label="OpenJarvis address" onBlur={(e) => e.target.value.trim() !== s.brain.openjarvisUrl && save({ brain: { openjarvisUrl: e.target.value.trim() } })} />
            </Field>
            <Field label="Local model" hint="The model OpenJarvis serves to Jarvis. Empty = OpenJarvis's default.">
              <select value={s.brain.model} onChange={(e) => save({ brain: { model: e.target.value } })} aria-label="Local model">
                <option value="">OpenJarvis default{engine?.backend === 'openjarvis' && engine.model && !s.brain.model ? ` (${engine.model.name})` : ''}</option>
                {s.brain.model && !engine?.models.some((m) => m.id === s.brain.model) && <option value={s.brain.model}>{s.brain.model}</option>}
                {engine?.backend === 'openjarvis' &&
                  engine.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Tools for this model" hint="Auto uses the model's own tool calling when the engine says it has it, and otherwise describes Jarvis's tools in the prompt (works with models that have no tool support, at some cost in reliability).">
              <select value={s.brain.toolMode} onChange={(e) => save({ brain: { toolMode: e.target.value as Settings['brain']['toolMode'] } })} aria-label="Tool mode">
                <option value="auto">Auto{engine?.toolMode ? ` (${engine.toolMode === 'native' ? 'native tool calling' : 'tools in the prompt'})` : ''}</option>
                <option value="native">Native tool calling</option>
                <option value="prompted">Tools described in the prompt</option>
              </select>
            </Field>
            {engine?.backend === 'openjarvis' && (
              <div className="stack small">
                {engine.capabilities && (
                  <span>
                    <Badge tone="info">model</Badge> {engine.model?.name}: {[engine.capabilities.parameterSize, engine.capabilities.family].filter(Boolean).join(' ')}
                    {' — '}
                    {[engine.capabilities.tools ? 'tools' : 'no native tools', engine.capabilities.thinking ? 'reasons before answering' : null, engine.capabilities.vision ? 'vision' : null, engine.capabilities.contextLength ? `${Math.round(engine.capabilities.contextLength / 1024)}k context max` : null].filter(Boolean).join(' · ')}
                  </span>
                )}
                <span>
                  <Badge tone={engine.openjarvis?.reachable ? 'success' : 'danger'}>{engine.openjarvis?.reachable ? 'running' : 'not running'}</Badge> OpenJarvis — {engine.openjarvis?.detail ?? 'not checked yet'}
                </span>
                <span>
                  <Badge tone={engine.openjarvis?.speech?.available ? 'success' : 'warning'}>{engine.openjarvis?.speech?.available ? 'ready' : 'not ready'}</Badge> Listening (local Whisper) — {engine.openjarvis?.speech?.detail ?? '—'}
                </span>
                <span>
                  <Badge tone={engine.openjarvis?.tts?.available ? 'success' : 'warning'}>{engine.openjarvis?.tts?.available ? 'ready' : 'not ready'}</Badge> Voice (local Kokoro) — {engine.openjarvis?.tts?.detail ?? '—'}
                </span>
              </div>
            )}
          </>
        )}
        {engine && !engine.ready && <div className="note note--warning">{engine.problem} Until then Jarvis handles direct commands only.</div>}
        {engine?.ready && engine.warning && <div className="note note--warning">{engine.warning}</div>}
      </Card>

      {s.brain.backend === 'roamies' && (
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
      </Card>
      )}

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
        <Field label="Transcription service" hint="OpenJarvis transcribes on this computer with Whisper (offline, free). OpenAI uses the OpenAI API key saved in Roamies (cloud; blocked in local-only mode). Or use your own Whisper-compatible server. Audio is only processed after you speak.">
          <div className="inline">
            <select value={s.voice.transcription.service} onChange={(e) => save({ voice: { transcription: { service: e.target.value as Settings['voice']['transcription']['service'] } } })} aria-label="Transcription service">
              <option value="openjarvis">OpenJarvis — local Whisper</option>
              <option value="openai" disabled={s.brain.localOnly}>OpenAI (key from Roamies){s.brain.localOnly ? ' — off in local-only mode' : ''}</option>
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
        <Field label="Jarvis's voice" hint="Local runs Kokoro on this computer through OpenJarvis (natural, offline, free). Browser uses the computer's built-in speech. Fish Audio is a cloud voice (needs a key; blocked in local-only mode).">
          <select value={s.voice.tts.provider} onChange={(e) => save({ voice: { tts: { provider: e.target.value as 'local' | 'browser' | 'fish', ...(e.target.value === 'local' && !s.voice.tts.voiceId ? { voiceId: 'bm_george' } : {}) } } })} aria-label="Voice output">
            <option value="local">Local — Kokoro via OpenJarvis</option>
            <option value="browser">Browser (built-in)</option>
            <option value="fish" disabled={s.brain.localOnly}>Fish Audio (cloud){s.brain.localOnly ? ' — off in local-only mode' : ''}</option>
          </select>
        </Field>
        {(s.voice.tts.provider === 'local' || s.voice.transcription.service === 'openjarvis') && (
          <Field label="Load voice on demand" hint="Whisper and Kokoro start when you talk and exit after a quiet spell, giving their memory (about 1.5 GB) back to the brain model. The first reply after a pause takes a few seconds longer while the voice loads (it starts loading as soon as you speak).">
            <div className="inline">
              <Toggle checked={s.voice.local.onDemand} onChange={(v) => save({ voice: { local: { onDemand: v } } })} ariaLabel="Load voice on demand" />
              <NumberInput value={s.voice.local.idleSec} min={15} max={3600} onCommit={(v) => save({ voice: { local: { idleSec: v } } })} suffix="s idle, then free" />
              <select value={s.voice.local.whisperModel} onChange={(e) => save({ voice: { local: { whisperModel: e.target.value as Settings['voice']['local']['whisperModel'] } } })} aria-label="Whisper size">
                {(['tiny', 'base', 'small', 'medium', 'large-v3'] as const).map((m) => (
                  <option key={m} value={m}>
                    Whisper {m}
                  </option>
                ))}
              </select>
            </div>
          </Field>
        )}
        {s.voice.tts.provider === 'local' && (
          <Field label="Local voice" hint="Kokoro voices: British (bm_/bf_) or American (am_/af_), male (m) or female (f).">
            <select value={s.voice.tts.voiceId || 'bm_george'} onChange={(e) => save({ voice: { tts: { voiceId: e.target.value } } })} aria-label="Local voice">
              {['bm_george', 'bm_lewis', 'bm_daniel', 'bm_fable', 'bf_emma', 'bf_isabella', 'am_michael', 'am_adam', 'am_onyx', 'af_heart', 'af_bella', 'af_sarah'].map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
        )}
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
        <Field label="Digest conversations after" hint="Once a conversation is quiet this long, Jarvis summarises it to itself (what was new, what was repeated), files everything by category (rules, plans, schedules, ideas…) and writes it to the vault. Rules you give are kept instantly. 0 = only in the background job.">
          <NumberInput value={s.memory.digestAfterSec} min={0} max={3600} onCommit={(v) => save({ memory: { digestAfterSec: v } })} suffix="seconds quiet" />
        </Field>
        <Field label="Always in context" hint="Your standing rules, preferences, schedules and plans go into every request, whatever the topic, up to this size.">
          <NumberInput value={s.memory.standingChars} min={0} max={20000} onCommit={(v) => save({ memory: { standingChars: v } })} suffix="characters" />
        </Field>
        <Field label="Keep conversations for" hint="0 = forever (the default). Digests and the vault's copy of every conversation are kept either way.">
          <NumberInput value={s.memory.conversationRetentionDays} min={0} max={3650} onCommit={(v) => save({ memory: { conversationRetentionDays: v } })} suffix={s.memory.conversationRetentionDays ? 'days' : 'days (forever)'} />
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
          Let Jarvis see — and, at higher levels, use — this computer like a person would: what’s on screen (read as text with OCR), windows, your browser (tabs, pages, forms — through its own signed-in profile, never your passwords or cookies), the mouse and keyboard, and “watch this and learn” sessions. Off by default; when off, nothing is observed or controlled. Mouse/keyboard actions need your approval, and anything that sends, pays, deletes, installs or changes security always asks you first — even with Full access.{' '}
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
        <Field label="Level" hint="Observe = see only (screen, windows, browser pages; no input). Interact = also click, type, scroll, switch windows and use the browser. Extended = also open/close apps and open files.">
          <select value={s.computerAccess.level} onChange={(e) => save({ computerAccess: { level: e.target.value as Settings['computerAccess']['level'] } })} disabled={!s.computerAccess.enabled} aria-label="Computer Access level">
            <option value="observe">Observe (see only)</option>
            <option value="interact">Interact (mouse &amp; keyboard)</option>
            <option value="extended">Extended (apps &amp; files)</option>
          </select>
        </Field>
        <Field label="Keep screenshots for" hint="How long temporary screenshots are kept on disk. 0 = delete as soon as they are read.">
          <NumberInput value={s.computerAccess.screenshotRetentionMin} min={0} max={1440} onCommit={(v) => save({ computerAccess: { screenshotRetentionMin: v } })} suffix="minutes" />
        </Field>
        <Field label="Browser connection" hint="The loopback DevTools address of the browser Jarvis uses (Jarvis starts it with its own profile from the Computer Access panel). Only this computer (127.0.0.1) is allowed.">
          <input
            defaultValue={s.computerAccess.browserEndpoint}
            onBlur={(e) => e.target.value !== s.computerAccess.browserEndpoint && save({ computerAccess: { browserEndpoint: e.target.value.trim() } })}
            aria-label="Browser DevTools endpoint"
            spellCheck={false}
          />
        </Field>
        <Field label="Look again every" hint="While watching and learning, how often Jarvis samples the screen/page. Unchanged content is skipped, so shorter is cheap.">
          <NumberInput value={s.computerAccess.watchIntervalSec} min={1} max={120} onCommit={(v) => save({ computerAccess: { watchIntervalSec: v } })} suffix="seconds" />
        </Field>
        <Field label="Ask me before critical actions" hint="Sending, paying, deleting, installing, entering a password… Jarvis asks you first. This is your approval, not a content rule — what the model will or won't do is up to the model. Off: Jarvis just does them (every action is still logged).">
          <Toggle checked={s.computerAccess.confirmCritical} onChange={(v) => save({ computerAccess: { confirmCritical: v } })} />
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

      <MobileCard />

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
        <div className={`fullaccess ${s.agents.autoSubmit ? 'is-on' : ''}`}>
          <div className="fullaccess__row">
            <div>
              <div className="fullaccess__title">Autonomous report submission</div>
              <div className="muted small">
                When on — and only with <strong>Full access</strong> and <strong>Offensive mode</strong> also on — Jarvis may submit bug-bounty reports to in-scope programs <strong>on its own, without asking each time</strong>. Every submission is still checked against the program’s eligible scope (an out-of-scope report is never sent) and recorded in the audit trail. This is the “ship it without telling me” switch.
              </div>
            </div>
            <Toggle
              checked={s.agents.autoSubmit}
              onChange={(v) => {
                if (v && !window.confirm('Let Jarvis submit bug-bounty reports autonomously, without asking each time? It will still refuse out-of-scope assets and log everything, but reports will be sent to programs without your per-report approval.')) return;
                save({ agents: { autoSubmit: v } });
              }}
              ariaLabel="Autonomous report submission"
            />
          </div>
          {s.agents.autoSubmit && (!s.permissions.fullAccess || !s.agents.offensive) && (
            <div className="fullaccess__banner">⚠ Auto-submit is on but inactive — it also needs {[!s.permissions.fullAccess ? 'Full access' : null, !s.agents.offensive ? 'Offensive mode' : null].filter(Boolean).join(' and ')}. Until then every autonomous report is held.</div>
          )}
          {s.agents.autoSubmit && s.permissions.fullAccess && s.agents.offensive && <div className="fullaccess__banner">● Autonomous submission is LIVE — in-scope reports will be sent without asking. Scope is still enforced; see the audit trail on the Pipeline page.</div>}
        </div>
        <div className={`fullaccess ${s.agents.autoHunt ? 'is-on' : ''}`}>
          <div className="fullaccess__row">
            <div>
              <div className="fullaccess__title">Autonomous hunting (“go”)</div>
              <div className="muted small">
                The master switch. When on — with <strong>Full access</strong> and <strong>Offensive mode</strong> — Jarvis runs the bug-bounty loop on its own: it picks an in-scope program, tests it, drafts a report from a verified finding, and (with Auto-submit on) ships it in scope, then moves to the next program. One program per run.
              </div>
            </div>
            <Toggle
              checked={s.agents.autoHunt}
              onChange={(v) => {
                if (v && !window.confirm('Start autonomous bug-bounty hunting? Jarvis will test in-scope programs and run the loop on its own on a schedule. It submits only if Auto-submit is also on, and never out of scope.')) return;
                save({ agents: { autoHunt: v } });
              }}
              ariaLabel="Autonomous hunting"
            />
          </div>
          {s.agents.autoHunt && (!s.permissions.fullAccess || !s.agents.offensive) && (
            <div className="fullaccess__banner">⚠ Autonomous hunting is on but paused — it also needs {[!s.permissions.fullAccess ? 'Full access' : null, !s.agents.offensive ? 'Offensive mode' : null].filter(Boolean).join(' and ')}.</div>
          )}
          {s.agents.autoHunt && s.permissions.fullAccess && s.agents.offensive && (
            <div className="fullaccess__banner">● Autonomous hunting is LIVE{s.agents.autoSubmit ? ' and will submit in-scope reports' : ' (reports are drafted and held until Auto-submit is on)'}.</div>
          )}
        </div>
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
