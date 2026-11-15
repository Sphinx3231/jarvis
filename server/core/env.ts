import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * API keys live in a .env file. On start Jarvis loads it into the environment, and the secret store
 * falls back to it, so a key set in .env is used everywhere without pasting it into the UI. Keys set
 * inside the app (encrypted on disk) still take precedence over .env.
 *
 * .env is looked for at $JARVIS_ENV, then <data dir>/.env, then ./.env. Existing environment values
 * are never overwritten. The file is yours — Jarvis never writes to it and never logs its values.
 */

/** Secret name (as used by the app) → the environment variable names that can supply it. */
export const ENV_SECRET_FALLBACK: Record<string, string[]> = {
  'hackerone:token': ['HACKERONE_TOKEN', 'HACKERONE_API_TOKEN', 'HACKERONE_API_KEY'],
  'voice:tts:fishKey': ['FISH_AUDIO_KEY', 'FISHAUDIO_API_KEY', 'FISH_API_KEY'],
  'voice:transcription:apiKey': ['TRANSCRIPTION_API_KEY', 'WHISPER_API_KEY', 'OPENAI_API_KEY'],
  'email:password': ['EMAIL_PASSWORD', 'JARVIS_EMAIL_PASSWORD'],
  'calendar:caldav:password': ['CALDAV_PASSWORD', 'JARVIS_CALDAV_PASSWORD'],
};

/** The value a secret name can take from the environment (.env or the real environment), or undefined. */
export function resolveEnvSecret(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const key of ENV_SECRET_FALLBACK[name] ?? []) {
    const v = env[key];
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

/** Parse KEY=VALUE lines (ignoring comments, blanks and a leading `export`), with optional quotes. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

/**
 * Load .env files into process.env (first file to set a key wins; the real environment always wins).
 * Returns the files that were read and the names (never the values) of the keys they set.
 */
export function loadEnvFiles(dataDir: string, env: NodeJS.ProcessEnv = process.env): { files: string[]; keys: string[] } {
  const candidates = [env.JARVIS_ENV, join(dataDir, '.env'), join(process.cwd(), '.env')].filter((p): p is string => Boolean(p));
  const files: string[] = [];
  const keys = new Set<string>();
  const seen = new Set<string>();
  for (const path of candidates) {
    if (seen.has(path)) continue;
    seen.add(path);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    files.push(path);
    for (const [k, v] of Object.entries(parseDotenv(text))) {
      if (env[k] === undefined) {
        env[k] = v;
        keys.add(k);
      }
    }
  }
  return { files, keys: [...keys] };
}
