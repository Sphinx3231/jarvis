import type { ActivityLog } from '../core/activity.ts';
import type { SecretStore } from '../core/secrets.ts';
import type { ProviderConfig, SettingsStore } from '../core/settings.ts';
import { errorMessage, stableStringify } from '../core/util.ts';
import { AnthropicProvider } from './anthropic.ts';
import type { LocalModelManager } from './local-embeddings.ts';
import { OpenAiCompatibleEmbeddings, OpenAiCompatibleProvider } from './openai-compatible.ts';
import type { EmbeddingProvider, LlmProvider, LlmRequest, LlmResponse } from './types.ts';
import { ProviderError } from './types.ts';

export interface ProviderHealth {
  ok: boolean;
  detail: string;
  checkedAt: number;
}

export interface ProviderStatus {
  id: string;
  name: string;
  type: ProviderConfig['type'];
  model: string;
  baseUrl: string;
  enabled: boolean;
  requiresKey: boolean;
  keyConfigured: boolean;
  keySource: 'stored' | 'environment' | null;
  usable: boolean;
  role: 'primary' | 'fallback' | 'unused';
  health: ProviderHealth | null;
  lastError: string | null;
  lastUsedAt: number | null;
}

const ENV_KEYS: Record<string, string> = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' };

export const providerSecretName = (id: string): string => `llm:${id}:apiKey`;

/**
 * Chooses a model provider for each request: the configured primary first, then the
 * fallback order. Only retryable failures (network, rate limit, overload, auth) move on
 * to the next provider; a request the provider rejected as invalid is not retried elsewhere.
 */
export class LlmRouter {
  private settings: SettingsStore;
  private secrets: SecretStore;
  private activity: ActivityLog;
  private cache = new Map<string, { sig: string; provider: LlmProvider }>();
  private health = new Map<string, ProviderHealth>();
  private lastError = new Map<string, string>();
  private lastUsed = new Map<string, number>();

  readonly localModel: LocalModelManager | null;

  constructor(settings: SettingsStore, secrets: SecretStore, activity: ActivityLog, localModel: LocalModelManager | null = null) {
    this.settings = settings;
    this.secrets = secrets;
    this.activity = activity;
    this.localModel = localModel;
  }

  private resolveKey(cfg: ProviderConfig): { key?: string; source: 'stored' | 'environment' | null } {
    const stored = this.secrets.get(providerSecretName(cfg.id));
    if (stored) return { key: stored, source: 'stored' };
    const envName = ENV_KEYS[cfg.id] ?? `JARVIS_${cfg.id.toUpperCase().replace(/-/g, '_')}_API_KEY`;
    const env = process.env[envName];
    if (env) return { key: env, source: 'environment' };
    return { source: null };
  }

  private isUsable(cfg: ProviderConfig): boolean {
    if (!cfg.enabled) return false;
    if (cfg.type === 'openai-compatible' && !cfg.baseUrl) return false;
    return !cfg.requiresKey || Boolean(this.resolveKey(cfg).key);
  }

  private build(cfg: ProviderConfig): LlmProvider {
    const s = this.settings.get().llm;
    const { key } = this.resolveKey(cfg);
    const sig = stableStringify({ cfg, key: key ? key.slice(-6) : null, effort: s.effort, fb: s.serverSideFallback, t: s.requestTimeoutSec });
    const cached = this.cache.get(cfg.id);
    if (cached && cached.sig === sig) return cached.provider;
    const timeoutMs = s.requestTimeoutSec * 1000;
    const provider: LlmProvider =
      cfg.type === 'anthropic'
        ? new AnthropicProvider({ id: cfg.id, model: cfg.model, apiKey: key ?? '', baseUrl: cfg.baseUrl, effort: s.effort, serverSideFallback: s.serverSideFallback, timeoutMs })
        : new OpenAiCompatibleProvider({ id: cfg.id, model: cfg.model, baseUrl: cfg.baseUrl, apiKey: key, timeoutMs });
    this.cache.set(cfg.id, { sig, provider });
    return provider;
  }

  /** Providers in the order they will be tried. */
  private chain(): ProviderConfig[] {
    const s = this.settings.get().llm;
    const byId = new Map(s.providers.map((p) => [p.id, p]));
    const ordered = [s.primary, ...s.fallbackOrder.filter((id) => id !== s.primary)];
    return ordered.map((id) => byId.get(id)).filter((p): p is ProviderConfig => Boolean(p && this.isUsable(p)));
  }

  available(): boolean {
    return this.chain().length > 0;
  }

  activeProvider(): { id: string; model: string } | null {
    const first = this.chain()[0];
    return first ? { id: first.id, model: first.model } : null;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const chain = this.chain();
    if (!chain.length) throw new ProviderError('No language model is configured. Add an API key or enable a local model in Integrations.', { retryable: false });
    const failures: string[] = [];
    for (const cfg of chain) {
      try {
        const res = await this.build(cfg).complete(req);
        this.lastUsed.set(cfg.id, Date.now());
        this.lastError.delete(cfg.id);
        if (failures.length) this.activity.log('warning', 'llm', `Used fallback provider ${cfg.name} after: ${failures.join('; ')}`);
        return res;
      } catch (err) {
        const msg = errorMessage(err);
        this.lastError.set(cfg.id, msg);
        failures.push(`${cfg.name}: ${msg}`);
        if (req.signal?.aborted) throw err;
        if (!(err instanceof ProviderError) || !err.retryable) throw err;
      }
    }
    throw new ProviderError(`All model providers failed — ${failures.join('; ')}`, { retryable: false });
  }

  async checkHealth(id?: string): Promise<void> {
    const providers = this.settings.get().llm.providers.filter((p) => (id ? p.id === id : this.isUsable(p)));
    await Promise.all(
      providers.map(async (cfg) => {
        if (!this.isUsable(cfg)) {
          this.health.set(cfg.id, { ok: false, detail: cfg.enabled ? 'Missing API key or base URL' : 'Disabled', checkedAt: Date.now() });
          return;
        }
        const result = await this.build(cfg).healthCheck(AbortSignal.timeout(15_000));
        const prev = this.health.get(cfg.id);
        this.health.set(cfg.id, { ...result, checkedAt: Date.now() });
        if (prev && prev.ok !== result.ok) {
          this.activity.log(result.ok ? 'success' : 'warning', 'llm', `${cfg.name} is ${result.ok ? 'reachable again' : `unreachable: ${result.detail}`}`);
        }
      }),
    );
  }

  status(): ProviderStatus[] {
    const s = this.settings.get().llm;
    const chainIds = this.chain().map((p) => p.id);
    return s.providers.map((cfg) => {
      const { source } = this.resolveKey(cfg);
      return {
        id: cfg.id,
        name: cfg.name,
        type: cfg.type,
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        enabled: cfg.enabled,
        requiresKey: cfg.requiresKey,
        keyConfigured: Boolean(source),
        keySource: source,
        usable: this.isUsable(cfg),
        role: chainIds[0] === cfg.id ? 'primary' : chainIds.includes(cfg.id) ? 'fallback' : 'unused',
        health: this.health.get(cfg.id) ?? null,
        lastError: this.lastError.get(cfg.id) ?? null,
        lastUsedAt: this.lastUsed.get(cfg.id) ?? null,
      };
    });
  }

  /** Which transcription endpoint voice recordings would use, if any. */
  transcriptionTarget(): { cfg: ProviderConfig; key?: string } | null {
    const t = this.settings.get().voice.transcription;
    const cfg = this.settings.get().llm.providers.find((p) => p.id === t.providerId);
    if (!cfg || cfg.type !== 'openai-compatible' || !cfg.baseUrl) return null;
    const { key } = this.resolveKey(cfg);
    if (cfg.requiresKey && !key) return null;
    return { cfg, key };
  }

  /** Speech to text through an OpenAI-compatible /audio/transcriptions endpoint (OpenAI, local Whisper servers). */
  async transcribe(audio: Buffer, mimeType: string, opts: { language?: string; signal?: AbortSignal } = {}): Promise<{ text: string; provider: string }> {
    const target = this.transcriptionTarget();
    if (!target) throw new ProviderError('No transcription service is configured. Choose one under Settings → Voice.', { retryable: false });
    const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('wav') ? 'wav' : mimeType.includes('mp4') || mimeType.includes('m4a') ? 'm4a' : mimeType.includes('mpeg') ? 'mp3' : 'webm';
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), `speech.${ext}`);
    form.append('model', this.settings.get().voice.transcription.model);
    if (opts.language) form.append('language', opts.language.split('-')[0]);
    form.append('response_format', 'json');
    let res: Response;
    try {
      res = await fetch(`${target.cfg.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
        method: 'POST',
        headers: target.key ? { authorization: `Bearer ${target.key}` } : {},
        body: form,
        signal: opts.signal ?? AbortSignal.timeout(120_000),
      });
    } catch (err) {
      throw new ProviderError(`Cannot reach ${target.cfg.name}: ${errorMessage(err)}`, { retryable: true });
    }
    const text = await res.text();
    if (!res.ok) throw new ProviderError(`${target.cfg.name} transcription failed (HTTP ${res.status}): ${text.slice(0, 200)}`, { retryable: false, status: res.status });
    let parsed: { text?: string };
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { text };
    }
    return { text: (parsed.text ?? '').trim(), provider: target.cfg.name };
  }

  /** Built-in local model, or an OpenAI-compatible endpoint (Anthropic has no embeddings API). */
  embeddings(): EmbeddingProvider | null {
    const e = this.settings.get().embeddings;
    if (!e.enabled) return null;
    if (e.providerId === 'builtin') return this.localModel?.get() ?? null;
    const cfg = this.settings.get().llm.providers.find((p) => p.id === e.providerId);
    if (!cfg || cfg.type !== 'openai-compatible' || !cfg.baseUrl) return null;
    const { key } = this.resolveKey(cfg);
    if (cfg.requiresKey && !key) return null;
    return new OpenAiCompatibleEmbeddings({ baseUrl: cfg.baseUrl, apiKey: key, model: e.model });
  }
}
