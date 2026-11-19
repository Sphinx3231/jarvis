/**
 * jarvis-local — set up and check Jarvis's fully local brain (OpenJarvis + Ollama + Whisper + Kokoro).
 *
 *   node scripts/jarvis-local.ts profile                 # what this machine should run (GEEKOM A6 32/64 GB…)
 *   node scripts/jarvis-local.ts configure [--profile a6-32gb|a6-64gb|small] [--force]
 *                                                       # write ~/.openjarvis/config.toml (backs up an existing one)
 *   node scripts/jarvis-local.ts models [--heavy]        # the `ollama pull` commands for the profile
 *   node scripts/jarvis-local.ts env                     # Ollama environment for 24/7 use (one model, kept loaded)
 *   node scripts/jarvis-local.ts check [--url http://127.0.0.1:8000]
 *                                                       # is everything running? brain, listening, voice, RAM
 *
 * No command here contacts a cloud service. `check` only talks to localhost.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OpenJarvisClient, isCloudModel } from '../server/llm/openjarvis.ts';
import { PROFILES, machineSummary, openJarvisConfig, recommendProfile, type HardwareProfile } from '../server/llm/profiles.ts';

const args = process.argv.slice(2);
const cmd = args[0] ?? 'profile';
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);

function chosenProfile(): HardwareProfile {
  const id = opt('profile');
  if (!id) return recommendProfile();
  const p = PROFILES.find((x) => x.id === id);
  if (!p) {
    console.error(`Unknown profile "${id}". Choose one of: ${PROFILES.map((x) => x.id).join(', ')}`);
    process.exit(2);
  }
  return p;
}

function ollamaEnv(p: HardwareProfile): Record<string, string> {
  return {
    // One model resident and never unloaded: the brain answers instantly, 24/7, and nothing swaps.
    OLLAMA_MAX_LOADED_MODELS: '1',
    OLLAMA_NUM_PARALLEL: '1',
    OLLAMA_KEEP_ALIVE: '-1',
    OLLAMA_CONTEXT_LENGTH: String(p.contextTokens),
    // Halves the KV-cache RAM for the context window (needs flash attention, fine on CPU).
    OLLAMA_FLASH_ATTENTION: '1',
    OLLAMA_KV_CACHE_TYPE: 'q8_0',
    OLLAMA_HOST: '127.0.0.1:11434',
  };
}

async function main(): Promise<number> {
  switch (cmd) {
    case 'profile': {
      const m = machineSummary();
      const p = chosenProfile();
      console.log(`\nThis computer: ${m.cpu} — ${m.cores} threads, ${m.ramGb} GB RAM`);
      console.log(`Profile:       ${p.label} (${p.id})\n`);
      console.log(`  Brain (always on): ${p.brain.model}  ${p.brain.sizeGb} GB — ${p.brain.why}`);
      if (p.heavy) console.log(`  Heavy (optional):  ${p.heavy.model}  ${p.heavy.sizeGb} GB — ${p.heavy.why}`);
      console.log(`  Listening:         faster-whisper "${p.whisper}" (CPU, int8)`);
      console.log(`  Voice:             Kokoro "${p.voice}"`);
      console.log(`  Context:           ${p.contextTokens.toLocaleString()} tokens`);
      for (const n of p.notes) console.log(`  · ${n}`);
      console.log('\nOther profiles:');
      for (const x of PROFILES.filter((x) => x.id !== p.id)) console.log(`  ${x.id.padEnd(8)} ${x.label}: ${x.brain.model}${x.heavy ? ` (+ ${x.heavy.model})` : ''}`);
      console.log('');
      return 0;
    }
    case 'configure': {
      const p = chosenProfile();
      const dir = process.env.OPENJARVIS_HOME ?? join(homedir(), '.openjarvis');
      const file = process.env.OPENJARVIS_CONFIG ?? join(dir, 'config.toml');
      mkdirSync(dir, { recursive: true });
      if (existsSync(file)) {
        if (!flag('force')) {
          const backup = `${file}.before-jarvis-${Date.now()}`;
          copyFileSync(file, backup);
          console.log(`Backed up the existing config to ${backup}`);
        }
      }
      writeFileSync(file, openJarvisConfig(p));
      console.log(`Wrote ${file} for profile ${p.id}: brain ${p.brain.model}, Whisper ${p.whisper}, Kokoro ${p.voice}.`);
      return 0;
    }
    case 'models': {
      const p = chosenProfile();
      console.log(`ollama pull ${p.brain.model}`);
      if (flag('heavy') && p.heavy) console.log(`ollama pull ${p.heavy.model}`);
      return 0;
    }
    case 'env': {
      const p = chosenProfile();
      const env = ollamaEnv(p);
      const fmt = opt('format') ?? (process.platform === 'win32' ? 'powershell' : 'shell');
      for (const [k, v] of Object.entries(env)) {
        if (fmt === 'powershell') console.log(`[Environment]::SetEnvironmentVariable('${k}', '${v}', 'User')`);
        else if (fmt === 'systemd') console.log(`Environment=${k}=${v}`);
        else console.log(`${k}=${v}`);
      }
      return 0;
    }
    case 'check': {
      const url = opt('url') ?? 'http://127.0.0.1:8000';
      const m = machineSummary();
      const p = chosenProfile();
      let bad = 0;
      const line = (ok: boolean | null, what: string, detail: string) => {
        if (ok === false) bad++;
        console.log(`  ${ok === null ? '·   ' : ok ? 'OK  ' : 'FAIL'}  ${what.padEnd(18)} ${detail}`);
      };
      console.log(`\nJarvis local check — ${m.cpu}, ${m.ramGb} GB RAM (profile ${p.id})\n`);
      const h = await new OpenJarvisClient(url).health();
      const servesLocal = h.models.some((x) => !isCloudModel(x.id, x.ownedBy));
      const ollama = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(4000) })
        .then(async (r) => ((await r.json()) as { models?: Array<{ name: string; size: number }> }).models ?? [])
        .catch(() => null);
      // Ollama is the setup's engine; another local engine (llama.cpp, vLLM…) behind OpenJarvis is fine too.
      line(ollama !== null ? true : servesLocal ? null : false, 'Ollama', ollama === null ? (servesLocal ? 'not running (OpenJarvis is using another local engine)' : 'not running on 127.0.0.1:11434') : `${ollama.length} model(s): ${ollama.map((x) => x.name).join(', ') || 'none pulled yet'}`);
      if (ollama) line(ollama.some((x) => x.name === p.brain.model || x.name === `${p.brain.model}:latest`), 'Brain model', ollama.some((x) => x.name.startsWith(p.brain.model)) ? `${p.brain.model} is pulled` : `missing — run: ollama pull ${p.brain.model}`);
      line(h.reachable, 'OpenJarvis', h.detail);
      if (h.reachable) {
        const local = h.models.filter((x) => !isCloudModel(x.id, x.ownedBy));
        line(local.length > 0, 'Local models', local.length ? local.map((x) => x.id).join(', ') : 'none — OpenJarvis sees no local model');
        line(h.models.length > local.length ? null : true, 'Cloud models', h.models.length > local.length ? `${h.models.length - local.length} listed by OpenJarvis but unusable without API keys, and refused by Jarvis's local-only mode` : 'none');
        line(Boolean(h.speech?.available), 'Listening', h.speech?.detail ?? 'unknown');
        line(Boolean(h.tts?.available), 'Voice', h.tts?.detail ?? 'unknown');
      }
      const free = Math.round((await import('node:os')).freemem() / 1024 ** 3);
      line(free >= 3 ? true : null, 'Free RAM', `${free} GB free now`);
      console.log(bad ? `\n${bad} problem(s). See docs/LOCAL_SETUP.md → Troubleshooting.\n` : '\nEverything Jarvis needs is running locally. No API keys, no usage limits.\n');
      return bad ? 1 : 0;
    }
    default:
      console.log('Commands: profile | configure [--profile id] | models [--heavy] | env | check [--url]');
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
