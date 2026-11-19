import type { SecretStore } from '../core/secrets.ts';
import type { SettingsStore } from '../core/settings.ts';
import { errorMessage } from '../core/util.ts';

/**
 * Fish Audio text-to-speech: Jarvis replies out loud in a chosen voice. The API key lives in the
 * secret store or .env (FISH_AUDIO_KEY) and is sent only to Fish Audio over HTTPS. When no Fish key
 * is set, the browser's built-in speech is used instead, so nothing here is required to talk.
 */

export const FISH_SECRET = 'voice:tts:fishKey';
const DEFAULT_API = 'https://api.fish.audio';

export class FishAudioService {
  private settings: SettingsStore;
  private secrets: SecretStore;
  fetchImpl: typeof fetch;

  constructor(deps: { settings: SettingsStore; secrets: SecretStore; fetchImpl?: typeof fetch }) {
    this.settings = deps.settings;
    this.secrets = deps.secrets;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  private baseUrl(): string {
    return (process.env.JARVIS_FISH_API || DEFAULT_API).replace(/\/+$/, '');
  }

  hasKey(): boolean {
    return this.secrets.has(FISH_SECRET);
  }

  /** Why Fish Audio voice can't be used, or null when it is ready. */
  missing(): string | null {
    const tts = this.settings.get().voice.tts;
    if (tts.provider !== 'fish') return tts.provider === 'local' ? 'Fish Audio is off (replies use the local voice).' : 'Fish Audio voice is off (replies use the browser voice).';
    if (!this.hasKey()) return 'No Fish Audio API key (set FISH_AUDIO_KEY in .env, or add it in Settings → Voice).';
    return null;
  }

  status(): { provider: string; voiceId: string; keySet: boolean; keyFromEnv: boolean; available: boolean } {
    const tts = this.settings.get().voice.tts;
    return { provider: tts.provider, voiceId: tts.voiceId, keySet: this.hasKey(), keyFromEnv: this.secrets.fromEnv(FISH_SECRET), available: this.missing() === null };
  }

  /** Synthesize speech. Returns MP3 bytes, or throws with a plain message. */
  async synthesize(text: string, signal?: AbortSignal): Promise<{ audio: Buffer; mime: string }> {
    const key = this.secrets.get(FISH_SECRET);
    if (!key) throw new Error('No Fish Audio API key configured.');
    const voiceId = this.settings.get().voice.tts.voiceId.trim();
    const body: Record<string, unknown> = { text: text.slice(0, 4000), format: 'mp3', normalize: true, latency: 'normal' };
    if (voiceId) body.reference_id = voiceId;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl()}/v1/tts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new Error(`Cannot reach Fish Audio: ${errorMessage(err)}`);
    }
    if (res.status === 401 || res.status === 403) throw new Error('Fish Audio rejected the API key.');
    if (!res.ok) throw new Error(`Fish Audio error (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
    const audio = Buffer.from(await res.arrayBuffer());
    if (!audio.length) throw new Error('Fish Audio returned no audio.');
    return { audio, mime: res.headers.get('content-type')?.split(';')[0] || 'audio/mpeg' };
  }
}
