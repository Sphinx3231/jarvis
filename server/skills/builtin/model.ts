import { z } from 'zod';
import { UNTRUSTED_POLICY, wrapUntrusted } from '../../intelligence/untrusted.ts';
import type { Skill } from '../types.ts';

const Input = z.object({
  instruction: z.string().min(1).max(8000).describe('What to produce, e.g. "Summarise the page in 5 bullet points"'),
  context: z.string().max(200_000).optional().describe('Material to work from (may reference earlier step output with {{steps.N.output.text}})'),
  contextSource: z.string().max(200).optional().describe('Where the context came from, e.g. a URL or file path'),
  maxTokens: z.number().int().min(64).max(16000).optional(),
});
type Out = { text: string; model: string; provider: string };

/**
 * A model call with no tools attached. Because it cannot call anything, untrusted context
 * passed here can at worst produce misleading text — never an action.
 */
export const llmGenerate: Skill<z.infer<typeof Input>, Out> = {
  name: 'llm.generate',
  title: 'Generate with model',
  description: 'Use the language model to write, summarise, analyse or transform text. Has no tools; cannot take actions.',
  category: 'model',
  scope: 'model',
  risk: 'internal',
  idempotent: true,
  inlineSafe: false,
  untrustedOutput: false,
  input: Input,
  outputDescription: 'Generated text plus the model/provider that produced it.',
  timeoutMs: 300_000,
  dependsOn: 'Roamies model sign-in',
  availability: (s) => (s.llm.available() ? { available: true } : { available: false, reason: 'No model from Roamies (sign in on its Model page)' }),
  summarize: (i) => `Ask the model: ${i.instruction.slice(0, 100)}`,
  async execute(input, ctx) {
    const content = input.context
      ? `${input.instruction}\n\n${wrapUntrusted(input.contextSource ?? 'previous step output', input.context)}`
      : input.instruction;
    const res = await ctx.services.llm.generate({
      system: `You are Jarvis's text-processing component. Produce exactly what the instruction asks for, concisely. ${UNTRUSTED_POLICY}`,
      prompt: content,
      maxTokens: input.maxTokens ?? 4000,
      signal: ctx.signal,
    });
    if (res.stopReason === 'refusal') throw new Error('The model declined this request');
    return { text: res.text.trim(), model: res.model, provider: res.provider };
  },
  async verify(_i, out) {
    return out.text.length > 0 ? { ok: true, detail: `${out.text.length} characters from ${out.model}` } : { ok: false, detail: 'Model returned empty output' };
  },
  describe: (o) => o.text,
};
