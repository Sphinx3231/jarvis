import { cpus, platform as osPlatform, totalmem } from 'node:os';

/**
 * Sizing Jarvis's local stack around the model YOU choose (DeepSeek, Qwen, Llama… — any Ollama model).
 *
 * Jarvis is the harness; the model is the product. So the harness takes as little as possible and the
 * rest of the RAM is the model's: weights + the context window's KV cache. This module measures what a
 * given model needs (from Ollama's own metadata), works out the budget on this machine, and picks the
 * largest context window that fits without swapping — on a 16 GB laptop, the GEEKOM A6 at 32 GB, or
 * the A6 upgraded to 64 GB alike.
 *
 * Nothing here picks a model. `fitModel` evaluates the one you give it.
 */

/** RAM the rest of the stack needs (GB), measured on this codebase — see docs/LOCAL_SETUP.md. */
export const STACK_GB = {
  /** Jarvis harness (Node): ~110 MB idle with the lean defaults; headroom for activity. */
  harness: 0.25,
  /** OpenJarvis server idle (Python/FastAPI), when the brain goes through it. */
  openjarvis: 0.6,
  /** Voice workers while talking (Kokoro ~1.4 GB + Whisper small ~0.4 GB). 0 when idle (they exit). */
  voicePeak: 1.8,
};

/** What the operating system and its background services keep for themselves. */
export function osReserveGb(platform: NodeJS.Platform = osPlatform()): number {
  return platform === 'win32' ? 5 : platform === 'darwin' ? 4 : 2.5;
}

export function ramGb(): number {
  return Math.round((totalmem() / 1024 ** 3) * 10) / 10;
}

export interface Budget {
  totalGb: number;
  osGb: number;
  stackGb: number;
  /** RAM left for model weights + KV cache. */
  modelGb: number;
  notes: string[];
}

export function budget(opts: { totalGb?: number; platform?: NodeJS.Platform; viaEngine?: boolean; voice?: boolean; browserGb?: number } = {}): Budget {
  const totalGb = opts.totalGb ?? ramGb();
  const osGb = osReserveGb(opts.platform);
  // The voice is only resident while talking, but the model must never be pushed into swap mid-sentence.
  const stackGb = STACK_GB.harness + (opts.viaEngine ? 0 : STACK_GB.openjarvis) + (opts.voice === false ? 0 : STACK_GB.voicePeak) + (opts.browserGb ?? 0);
  const modelGb = Math.max(0, Math.round((totalGb - osGb - stackGb) * 10) / 10);
  const notes: string[] = [];
  if (!opts.viaEngine) notes.push(`Route "direct to the engine" frees another ${STACK_GB.openjarvis} GB for the model.`);
  if (opts.browserGb === undefined) notes.push('If Jarvis drives a browser for Computer Access, budget ~1 GB for it (or let it close when not in use).');
  return { totalGb, osGb, stackGb: Math.round(stackGb * 100) / 100, modelGb, notes };
}

/** The bits of Ollama's /api/show model_info that decide KV-cache size. */
export interface ModelArch {
  family: string | null;
  parameterSize: string | null;
  quantization: string | null;
  /** Weights on disk ≈ in RAM (GB). */
  sizeGb: number;
  layers: number | null;
  headsKv: number | null;
  keyLength: number | null;
  valueLength: number | null;
  embedding: number | null;
  heads: number | null;
  /** DeepSeek V2/V3 Multi-head Latent Attention: the KV cache holds one compressed vector per layer. */
  kvLoraRank: number | null;
  ropeDim: number | null;
  maxContext: number | null;
  capabilities: string[];
}

/** Parse Ollama /api/show into the architecture numbers (works for llama/qwen/gemma/deepseek2/…). */
export function archFromShow(show: { model_info?: Record<string, unknown>; details?: { family?: string; parameter_size?: string; quantization_level?: string }; capabilities?: string[] }, sizeBytes: number): ModelArch {
  const info = show.model_info ?? {};
  const arch = String(info['general.architecture'] ?? show.details?.family ?? '');
  const num = (key: string): number | null => {
    const v = info[`${arch}.${key}`];
    const n = Array.isArray(v) ? Math.max(...v.map(Number)) : Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return {
    family: arch || show.details?.family || null,
    parameterSize: show.details?.parameter_size ?? null,
    quantization: show.details?.quantization_level ?? null,
    sizeGb: Math.round((sizeBytes / 1024 ** 3) * 100) / 100,
    layers: num('block_count'),
    headsKv: num('attention.head_count_kv') ?? num('attention.head_count'),
    keyLength: num('attention.key_length'),
    valueLength: num('attention.value_length'),
    embedding: num('embedding_length'),
    heads: num('attention.head_count'),
    kvLoraRank: num('attention.kv_lora_rank'),
    ropeDim: num('rope.dimension_count'),
    maxContext: num('context_length'),
    capabilities: show.capabilities ?? [],
  };
}

/**
 * KV-cache size for 1,024 tokens of context, in GB, at Ollama's q8_0 cache (≈1.06 bytes/element) —
 * the setting the local setup uses. MLA models (DeepSeek V2/V3/R1-full) cache a compressed latent per
 * layer, which is why they fit far longer contexts than their size suggests.
 */
export function kvGbPer1k(a: ModelArch, bytesPerElem = 1.0625): number | null {
  if (!a.layers) return null;
  let perTokenElems: number;
  if (a.kvLoraRank) perTokenElems = a.layers * (a.kvLoraRank + (a.ropeDim ?? 64));
  else {
    const headDim = a.keyLength ?? (a.embedding && a.heads ? a.embedding / a.heads : null);
    const vDim = a.valueLength ?? headDim;
    if (!a.headsKv || !headDim || !vDim) return null;
    perTokenElems = a.layers * a.headsKv * (headDim + vDim);
  }
  return (perTokenElems * bytesPerElem * 1024) / 1024 ** 3;
}

export interface Fit {
  fits: boolean;
  /** Largest power-of-two context (≥ 4k) that fits, capped at the model's own maximum and 128k. */
  contextTokens: number;
  weightsGb: number;
  kvGb: number;
  totalModelGb: number;
  headroomGb: number;
  budget: Budget;
  verdict: string;
  advice: string[];
}

const CONTEXTS = [4096, 8192, 16384, 24576, 32768, 49152, 65536, 98304, 131072];

/** Will this model run here, and with how much context? (minContext = what Jarvis's tools need) */
export function fitModel(a: ModelArch, b: Budget, opts: { minContext?: number; overheadGb?: number } = {}): Fit {
  const minContext = opts.minContext ?? 8192;
  // Compute graph / scratch buffers on top of weights + KV (llama.cpp): a few hundred MB, more for big models.
  const overhead = opts.overheadGb ?? Math.max(0.4, a.sizeGb * 0.04);
  const per1k = kvGbPer1k(a) ?? 0.15; // unknown architecture: assume a typical 7–8B model
  const cap = Math.min(a.maxContext ?? 131072, 131072);
  let ctx = 0;
  for (const c of CONTEXTS) if (c <= cap && a.sizeGb + overhead + (per1k * c) / 1024 <= b.modelGb) ctx = c;
  const contextTokens = Math.max(ctx, 0);
  const kvGb = Math.round(((per1k * Math.max(contextTokens, minContext)) / 1024) * 100) / 100;
  const totalModelGb = Math.round((a.sizeGb + overhead + kvGb) * 100) / 100;
  const fits = contextTokens >= minContext;
  const advice: string[] = [];
  if (!fits) {
    advice.push(a.sizeGb + overhead > b.modelGb ? `The weights alone (${a.sizeGb} GB) don't fit the ${b.modelGb} GB available: use a smaller quantization (e.g. a q4_K_M or q3 tag) or a smaller model.` : `Only ${contextTokens || 'under 4k'} tokens of context would fit; Jarvis needs at least ${minContext}. Use a smaller quantization or free RAM (route direct to the engine, close the browser).`);
  }
  if (a.capabilities.length && !a.capabilities.includes('tools')) advice.push('This model has no native tool calling — Jarvis will describe its tools in the prompt (works, but tool use is less reliable than with a tool-capable model).');
  if (a.capabilities.includes('thinking')) advice.push('This is a reasoning model: it thinks before answering, so replies take longer; Jarvis gives it room to think and shows only the answer.');
  if (a.kvLoraRank) advice.push('Multi-head Latent Attention (DeepSeek): its context costs very little RAM, so long contexts are cheap.');
  const verdict = fits
    ? `Fits: ${a.sizeGb} GB weights + ${kvGb} GB context cache (${(contextTokens / 1024).toFixed(0)}k tokens) of ${b.modelGb} GB available; ${Math.round((b.modelGb - totalModelGb) * 10) / 10} GB spare.`
    : `Does not fit well: ${a.sizeGb} GB weights, ${b.modelGb} GB available for the model.`;
  return { fits, contextTokens: fits ? contextTokens : Math.max(contextTokens, 4096), weightsGb: a.sizeGb, kvGb, totalModelGb, headroomGb: Math.round((b.modelGb - totalModelGb) * 10) / 10, budget: b, verdict, advice };
}

/** Whisper size for this RAM (listening accuracy vs memory while talking). */
export function whisperFor(totalGb: number): 'base' | 'small' | 'medium' {
  return totalGb >= 48 ? 'medium' : totalGb >= 24 ? 'small' : 'base';
}

export function machineSummary(): { ramGb: number; cpu: string; cores: number } {
  const c = cpus();
  return { ramGb: ramGb(), cpu: c[0]?.model?.trim() ?? 'unknown', cores: c.length };
}

/** OpenJarvis config.toml for the model you chose (written by the local setup / `jarvis-local use`). */
export function openJarvisConfig(opts: { model: string; whisper: 'base' | 'small' | 'medium'; voice?: string; ollamaHost?: string; port?: number }): string {
  return [
    '# Written by Jarvis local setup — fully local: no API keys, no cloud engines are configured.',
    '',
    '[engine]',
    'default = "ollama"',
    '',
    '[engine.ollama]',
    `host = "${opts.ollamaHost ?? 'http://127.0.0.1:11434'}"`,
    '',
    '[intelligence]',
    `default_model = "${opts.model}"`,
    '',
    '[server]',
    'host = "127.0.0.1"',
    `port = ${opts.port ?? 8000}`,
    'agent = "simple"',
    '',
    '# Jarvis runs listening/voice in on-demand workers (they free their RAM when idle); these settings',
    '# only apply if Jarvis is set to use OpenJarvis\'s own speech instead.',
    '[speech]',
    'backend = "faster-whisper"',
    `model = "${opts.whisper}"`,
    'device = "cpu"',
    'compute_type = "int8"',
    'tts_backend = "kokoro"',
    `voice_id = "${opts.voice ?? 'bm_george'}"`,
    '',
  ].join('\n');
}
