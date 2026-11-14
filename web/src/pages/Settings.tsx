import { Bell, Brain, KeyRound, Mic, Palette, Shield, Sparkles, Timer, Trash2, User } from 'lucide-react';
import { Badge, Button, Card, Field, Loading, PageHeader, Toggle } from '../components/ui';
import { api, type Grant, type Scope, type Settings } from '../lib/api';
import { dateTime } from '../lib/format';
import { useAction, useLive, useResource } from '../lib/live';
import { useVoice, voiceSupport } from '../lib/voice';

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
  if (!settings) return <Loading />;
  const save = (patch: DeepPartial<Settings>) => act(() => api.patch('/api/settings', patch), 'Saved');
  const s = settings;
  const enabledProviders = s.llm.providers.filter((p) => p.enabled);

  return (
    <div className="page page--narrow">
      <PageHeader title="Settings" subtitle="Changes apply immediately." />

      <Card title="You" icon={<User size={18} />}>
        <Field label="Your name" hint="Used in greetings.">
          <input defaultValue={s.assistant.userName} maxLength={60} onBlur={(e) => e.target.value !== s.assistant.userName && save({ assistant: { userName: e.target.value.trim() } })} />
        </Field>
      </Card>

      <Card title="Model" icon={<Sparkles size={18} />}>
        <Field label="Primary provider" hint="API keys and endpoints are configured on the Integrations page.">
          <select value={s.llm.primary} onChange={(e) => save({ llm: { primary: e.target.value } })}>
            {s.llm.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — {p.model}
                {p.enabled ? '' : ' (disabled)'}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Fallback providers" hint="Tried in this order when the primary fails.">
          <div className="checks">
            {s.llm.providers
              .filter((p) => p.id !== s.llm.primary)
              .map((p) => (
                <label key={p.id} className="check">
                  <input
                    type="checkbox"
                    checked={s.llm.fallbackOrder.includes(p.id)}
                    onChange={(e) => save({ llm: { fallbackOrder: e.target.checked ? [...s.llm.fallbackOrder, p.id] : s.llm.fallbackOrder.filter((x) => x !== p.id) } })}
                  />
                  {p.name}
                  {!p.enabled && <span className="muted small"> (disabled)</span>}
                </label>
              ))}
          </div>
        </Field>
        <Field label="Effort" hint="How much reasoning Claude models apply. Higher is slower and costs more.">
          <select value={s.llm.effort} onChange={(e) => save({ llm: { effort: e.target.value as Settings['llm']['effort'] } })}>
            {['low', 'medium', 'high', 'xhigh', 'max'].map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Server-side refusal fallback" hint="On supported Claude models, a declined request is retried on a fallback model by Anthropic.">
          <Toggle checked={s.llm.serverSideFallback} onChange={(v) => save({ llm: { serverSideFallback: v } })} />
        </Field>
        <Field label="Max tool steps per message">
          <NumberInput value={s.llm.maxToolIterations} min={1} max={12} onCommit={(v) => save({ llm: { maxToolIterations: v } })} />
        </Field>
        {enabledProviders.length === 0 && <div className="note note--warning">No provider is enabled. Jarvis will handle direct commands only.</div>}
      </Card>

      <Card title="Voice" icon={<Mic size={18} />}>
        <Field label="Voice features" hint={voiceSupport.recognition ? 'Microphone button and spoken replies.' : 'Speech recognition is not supported in this browser; spoken replies may still work.'}>
          <Toggle checked={s.voice.enabled} onChange={(v) => save({ voice: { enabled: v } })} />
        </Field>
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
        <Field label="Wake word (“Jarvis, …”)" hint="Keeps the microphone listening while Jarvis is open. Voice can never approve actions.">
          <Toggle checked={s.voice.wakeWord} onChange={(v) => save({ voice: { wakeWord: v } })} disabled={!s.voice.enabled || !voiceSupport.recognition} />
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
        <p className="muted small">What Jarvis may do without asking. External actions ask first by default. Shell commands always ask.</p>
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
        <Field label="Reduce motion" hint="Keeps the dragon still; state is shown by colour only.">
          <Toggle checked={s.appearance.reduceMotion} onChange={(v) => save({ appearance: { reduceMotion: v } })} />
        </Field>
      </Card>
    </div>
  );
}
