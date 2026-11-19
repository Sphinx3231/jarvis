import { cpus, totalmem } from 'node:os';

/**
 * Hardware profiles for running Jarvis fully locally, 24/7 — sized for the GEEKOM A6
 * (AMD Ryzen 7 6800H: 8 cores / 16 threads, Radeon 680M iGPU, dual-channel DDR5-4800).
 *
 * On a CPU-first mini PC, speed is bound by memory bandwidth, so the brain is chosen by how many
 * bytes it must read per token: Mixture-of-Experts models (only ~3B parameters active per token) are
 * the sweet spot — big-model quality at small-model speed — as long as they fit in RAM with room left
 * for Windows/Linux, the browser Jarvis drives, Whisper and Kokoro.
 *
 * Every model listed is in the Ollama library with tool calling (Jarvis acts through tools).
 * Sizes are the Ollama download sizes (Q4_K_M), verified against the registry.
 */

export interface ModelChoice {
  /** Ollama tag. */
  model: string;
  sizeGb: number;
  why: string;
}

export interface HardwareProfile {
  id: 'a6-32gb' | 'a6-64gb' | 'small';
  label: string;
  minRamGb: number;
  /** The always-on brain (loaded 24/7). */
  brain: ModelChoice;
  /** Optional bigger model for heavy jobs (only when nothing else big is running). */
  heavy: ModelChoice | null;
  /** faster-whisper size for listening (CPU int8). */
  whisper: 'base' | 'small' | 'medium';
  /** Kokoro voice. */
  voice: string;
  /** Context window given to the brain (tokens). Larger costs RAM (KV cache). */
  contextTokens: number;
  notes: string[];
}

export const PROFILES: HardwareProfile[] = [
  {
    id: 'small',
    label: 'Under 24 GB RAM',
    minRamGb: 0,
    brain: { model: 'qwen3:8b', sizeGb: 5.2, why: 'Small, tool-capable, runs on any 16 GB machine.' },
    heavy: null,
    whisper: 'base',
    voice: 'bm_george',
    contextTokens: 16_384,
    notes: ['Expect slower, simpler answers. Close other heavy apps while Jarvis thinks.'],
  },
  {
    id: 'a6-32gb',
    label: 'GEEKOM A6 — 32 GB (as shipped)',
    minRamGb: 24,
    brain: { model: 'qwen3.5:9b', sizeGb: 6.6, why: 'Tool calling + vision + thinking in 6.6 GB: always loaded, roughly 8–12 tokens/s on the 6800H (estimate — measure with `jarvis-local check`), leaves ~15 GB free for Windows, the browser, Whisper and Kokoro.' },
    heavy: { model: 'qwen3:30b-a3b', sizeGb: 18.6, why: 'Mixture-of-Experts (3B active): much smarter and still quick on CPU, but 18.6 GB — use it for big jobs with other apps closed.' },
    whisper: 'small',
    voice: 'bm_george',
    contextTokens: 16_384,
    notes: [
      'Set the iGPU memory (UMA frame buffer) to the minimum in the BIOS — RAM given to the 680M is RAM the brain cannot use.',
      'Ollama runs one model at a time here (OLLAMA_MAX_LOADED_MODELS=1) so the brain never gets swapped to disk.',
    ],
  },
  {
    id: 'a6-64gb',
    label: 'GEEKOM A6 — upgraded to 64 GB',
    minRamGb: 48,
    brain: { model: 'qwen3.6:35b-a3b', sizeGb: 22.6, why: 'Newest Qwen MoE (3B active): tools, vision and thinking at near-small-model speed — the full-potential brain, always loaded.' },
    heavy: { model: 'qwen3-next:80b', sizeGb: 50.4, why: '80B MoE (3B active) for the hardest reasoning; loads instead of the brain for big jobs.' },
    whisper: 'medium',
    voice: 'bm_george',
    contextTokens: 32_768,
    notes: ['With 64 GB the brain, a 32k context, Whisper medium, Kokoro and the browser all stay resident 24/7.'],
  },
];

export function ramGb(): number {
  return Math.round(totalmem() / 1024 ** 3);
}

/** The best profile this machine can run comfortably. */
export function recommendProfile(totalRamGb = ramGb()): HardwareProfile {
  return [...PROFILES].sort((a, b) => b.minRamGb - a.minRamGb).find((p) => totalRamGb >= p.minRamGb) ?? PROFILES[0];
}

export function machineSummary(): { ramGb: number; cpu: string; cores: number; profile: HardwareProfile } {
  const c = cpus();
  return { ramGb: ramGb(), cpu: c[0]?.model?.trim() ?? 'unknown', cores: c.length, profile: recommendProfile() };
}

/** OpenJarvis config.toml for a profile (written by the local setup scripts and `jarvis-local configure`). */
export function openJarvisConfig(p: HardwareProfile, opts: { ollamaHost?: string; port?: number } = {}): string {
  return [
    '# Written by Jarvis local setup — fully local: no API keys, no cloud engines are configured.',
    `# Profile: ${p.label}`,
    '',
    '[engine]',
    'default = "ollama"',
    '',
    '[engine.ollama]',
    `host = "${opts.ollamaHost ?? 'http://127.0.0.1:11434'}"`,
    '',
    '[intelligence]',
    `default_model = "${p.brain.model}"`,
    ...(p.heavy ? [`model_long = "${p.heavy.model}"`] : []),
    '',
    '[server]',
    'host = "127.0.0.1"',
    `port = ${opts.port ?? 8000}`,
    'agent = "simple"',
    '',
    '[speech]',
    'backend = "faster-whisper"',
    `model = "${p.whisper}"`,
    'device = "cpu"',
    'compute_type = "int8"',
    'tts_backend = "kokoro"',
    `voice_id = "${p.voice}"`,
    '',
  ].join('\n');
}
