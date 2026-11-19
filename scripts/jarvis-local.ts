/**
 * jarvis-local — size and check Jarvis's fully local stack around the model YOU choose.
 *
 *   node scripts/jarvis-local.ts budget [--engine]          # RAM this machine leaves for the model
 *   node scripts/jarvis-local.ts fit <model> [--engine]     # will <model> run here, with how much context?
 *   node scripts/jarvis-local.ts use <model> [--engine]     # make it Jarvis's brain: OpenJarvis config +
 *                                                           #   the Ollama context window that fits
 *   node scripts/jarvis-local.ts env [--context N] [--format powershell|systemd|shell]
 *                                                           # Ollama settings for 24/7 use
 *   node scripts/jarvis-local.ts check [--url http://127.0.0.1:8000]
 *
 * <model> is any Ollama model you have pulled (`ollama pull deepseek-r1:14b`, a DeepSeek-V2-Lite GGUF
 * you imported, …). --engine = Jarvis talks to the engine directly (no OpenJarvis server, ~0.6 GB more
 * for the model). Nothing here contacts a cloud service; only localhost.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, freemem } from 'node:os';
import { join } from 'node:path';
import { OpenJarvisClient, isCloudModel } from '../server/llm/openjarvis.ts';
import { archFromShow, budget, fitModel, machineSummary, openJarvisConfig, whisperFor, type Fit } from '../server/llm/profiles.ts';

const args = process.argv.slice(2);
const cmd = args[0] ?? 'budget';
const positional = args.slice(1).filter((a, i, all) => !a.startsWith('--') && !(i > 0 && all[i - 1].startsWith('--') && ['--url', '--context', '--format', '--ollama'].includes(all[i - 1])));
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const OLLAMA = (opt('ollama') ?? process.env.OLLAMA_HOST_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');

async function fitFor(model: string): Promise<Fit> {
  const tags = (await (await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(5000) })).json()) as { models?: Array<{ name: string; size: number }> };
  const entry = tags.models?.find((m) => m.name === model || m.name === `${model}:latest`);
  if (!entry) throw new Error(`"${model}" isn't pulled in Ollama yet. Run: ollama pull ${model}`);
  const show = (await (await fetch(`${OLLAMA}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }), signal: AbortSignal.timeout(10000) })).json()) as Parameters<typeof archFromShow>[0];
  return fitModel(archFromShow(show, entry.size), budget({ viaEngine: flag('engine') }));
}

function printFit(model: string, f: Fit): void {
  const b = f.budget;
  console.log(`\n${model}`);
  console.log(`  ${f.verdict}`);
  console.log(`  RAM: ${b.totalGb} GB total − ${b.osGb} GB OS − ${b.stackGb} GB Jarvis stack = ${b.modelGb} GB for the model`);
  console.log(`  Context window: ${f.contextTokens.toLocaleString()} tokens (KV cache ${f.kvGb} GB at q8_0)`);
  for (const a of f.advice) console.log(`  · ${a}`);
  console.log('');
}

function ollamaEnv(contextTokens: number): Record<string, string> {
  return {
    // One model resident and never unloaded: answers start instantly, 24/7, and nothing swaps.
    OLLAMA_MAX_LOADED_MODELS: '1',
    OLLAMA_NUM_PARALLEL: '1',
    OLLAMA_KEEP_ALIVE: '-1',
    OLLAMA_CONTEXT_LENGTH: String(contextTokens),
    // Halves the KV-cache RAM for the context window (needs flash attention; fine on CPU).
    OLLAMA_FLASH_ATTENTION: '1',
    OLLAMA_KV_CACHE_TYPE: 'q8_0',
    OLLAMA_HOST: '127.0.0.1:11434',
  };
}

function printEnv(env: Record<string, string>, fmt: string): void {
  for (const [k, v] of Object.entries(env)) {
    if (fmt === 'powershell') console.log(`[Environment]::SetEnvironmentVariable('${k}', '${v}', 'User')`);
    else if (fmt === 'systemd') console.log(`Environment=${k}=${v}`);
    else console.log(`${k}=${v}`);
  }
}

async function main(): Promise<number> {
  switch (cmd) {
    case 'budget': {
      const m = machineSummary();
      const b = budget({ viaEngine: flag('engine') });
      console.log(`\nThis computer: ${m.cpu} — ${m.cores} threads, ${m.ramGb} GB RAM`);
      console.log(`For the model: ${b.modelGb} GB (after ${b.osGb} GB for the OS and ${b.stackGb} GB for Jarvis, ${flag('engine') ? 'direct to the engine' : 'OpenJarvis'} and the voice while talking)`);
      for (const n of b.notes) console.log(`  · ${n}`);
      console.log(`Listening: Whisper "${whisperFor(m.ramGb)}" suits this RAM.\n`);
      return 0;
    }
    case 'fit': {
      const model = positional[0];
      if (!model) return console.error('Usage: jarvis-local fit <model>'), 2;
      const f = await fitFor(model);
      printFit(model, f);
      return f.fits ? 0 : 1;
    }
    case 'use': {
      const model = positional[0];
      if (!model) return console.error('Usage: jarvis-local use <model>'), 2;
      const f = await fitFor(model);
      printFit(model, f);
      const dir = process.env.OPENJARVIS_HOME ?? join(homedir(), '.openjarvis');
      const file = process.env.OPENJARVIS_CONFIG ?? join(dir, 'config.toml');
      mkdirSync(dir, { recursive: true });
      if (existsSync(file) && !flag('force')) copyFileSync(file, `${file}.before-jarvis-${Date.now()}`);
      writeFileSync(file, openJarvisConfig({ model, whisper: whisperFor(machineSummary().ramGb) }));
      console.log(`Wrote ${file}: OpenJarvis now serves ${model} to Jarvis.`);
      console.log(`Set Ollama's context to ${f.contextTokens} (the setup does this; or: OLLAMA_CONTEXT_LENGTH=${f.contextTokens}) and restart Ollama.`);
      if (!f.fits) console.log('Warning: it does not fit comfortably — expect swapping and slow answers (see the advice above).');
      return 0;
    }
    case 'configure': {
      // Write the OpenJarvis config before a model is chosen (the setup without -Model); `use` fills it in.
      const dir = process.env.OPENJARVIS_HOME ?? join(homedir(), '.openjarvis');
      const file = process.env.OPENJARVIS_CONFIG ?? join(dir, 'config.toml');
      mkdirSync(dir, { recursive: true });
      if (existsSync(file) && !flag('force')) {
        console.log(`Kept the existing ${file} (use --force to replace it).`);
        return 0;
      }
      writeFileSync(file, openJarvisConfig({ model: positional[0] ?? '', whisper: whisperFor(machineSummary().ramGb) }));
      console.log(`Wrote ${file}.`);
      return 0;
    }
    case 'env': {
      let ctx = Number(opt('context') ?? 0);
      const model = positional[0];
      if (!ctx && model) ctx = (await fitFor(model)).contextTokens;
      printEnv(ollamaEnv(ctx || 16384), opt('format') ?? (process.platform === 'win32' ? 'powershell' : 'shell'));
      return 0;
    }
    case 'check': {
      const url = opt('url') ?? 'http://127.0.0.1:8000';
      const m = machineSummary();
      let bad = 0;
      const line = (ok: boolean | null, what: string, detail: string) => {
        if (ok === false) bad++;
        console.log(`  ${ok === null ? '·   ' : ok ? 'OK  ' : 'FAIL'}  ${what.padEnd(14)} ${detail}`);
      };
      console.log(`\nJarvis local check — ${m.cpu}, ${m.ramGb} GB RAM\n`);
      const tags = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(4000) })
        .then(async (r) => ((await r.json()) as { models?: Array<{ name: string }> }).models ?? [])
        .catch(() => null);
      const h = await new OpenJarvisClient(url).health();
      const local = h.models.filter((x) => !isCloudModel(x.id, x.ownedBy));
      line(tags !== null ? true : local.length ? null : false, 'Engine', tags === null ? (local.length ? 'Ollama not running (OpenJarvis uses another local engine)' : `Ollama not running at ${OLLAMA}`) : `Ollama: ${tags.length} model(s) ${tags.map((x) => x.name).join(', ') || '— pull one: ollama pull <model>'}`);
      line(h.reachable ? true : null, 'OpenJarvis', h.reachable ? h.detail : `${h.detail} (fine if Jarvis is set to go direct to the engine)`);
      if (h.reachable) line(local.length > 0, 'Brain model', local.length ? local.map((x) => x.id).join(', ') : 'none — pull a model, then: jarvis-local use <model>');
      const loaded = await fetch(`${OLLAMA}/api/ps`, { signal: AbortSignal.timeout(4000) })
        .then(async (r) => ((await r.json()) as { models?: Array<{ name: string; size: number; context_length?: number }> }).models ?? [])
        .catch(() => []);
      for (const x of loaded) line(null, 'In memory', `${x.name} — ${(x.size / 1024 ** 3).toFixed(1)} GB${x.context_length ? `, ${x.context_length} context` : ''}`);
      line(null, 'Free RAM', `${Math.round(freemem() / 1024 ** 3)} GB free now`);
      console.log(bad ? `\n${bad} problem(s). See docs/LOCAL_SETUP.md → Troubleshooting.\n` : '\nRunning locally. No API keys, no usage limits.\n');
      return bad ? 1 : 0;
    }
    default:
      console.log('Commands: budget | fit <model> | use <model> | configure | env [<model>] [--context N] | check');
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error((err as Error).message ?? err);
    process.exit(1);
  },
);
