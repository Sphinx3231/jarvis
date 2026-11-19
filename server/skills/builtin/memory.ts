import { z } from 'zod';
import { MEMORY_KINDS } from '../../memory/store.ts';
import type { Skill } from '../types.ts';

const always = () => ({ available: true });
const userKinds = MEMORY_KINDS.filter((k) => k !== 'tool_doc' && k !== 'task_history') as unknown as [string, ...string[]];

const SearchInput = z.object({
  query: z.string().min(1).max(500).describe('What to look for'),
  kind: z.enum(MEMORY_KINDS).optional().describe('Restrict to one kind of memory'),
  limit: z.number().int().min(1).max(20).optional(),
});
type SearchOut = { results: Array<{ id: string; kind: string; content: string; verified: boolean; confidence: number; source: string }> };

export const memorySearch: Skill<z.infer<typeof SearchInput>, SearchOut> = {
  name: 'memory.search',
  title: 'Search memory',
  description: 'Search Jarvis long-term memory (rules, preferences, plans, schedules, ideas, project knowledge, decisions, procedures, facts, task history, tool docs). Unverified memories are assumptions, not facts.',
  category: 'memory',
  scope: 'memory.read',
  risk: 'internal',
  idempotent: true,
  inlineSafe: true,
  untrustedOutput: false,
  input: SearchInput,
  outputDescription: 'Matching memories with kind, verification status, confidence and source.',
  availability: always,
  summarize: (i) => `Search memory for "${i.query}"`,
  async execute(input, ctx) {
    const found = input.kind
      ? ctx.services.memory.keywordSearch(input.query, { kind: input.kind, limit: input.limit ?? 8 })
      : ctx.services.memory.retrieve(input.query, { limit: input.limit ?? 8, includeToolDocs: true });
    return { results: found.map((m) => ({ id: m.id, kind: m.kind, content: m.content, verified: m.verified, confidence: Number(m.confidence.toFixed(2)), source: m.source })) };
  },
  async verify(_i, out) {
    return { ok: Array.isArray(out.results), detail: `${out.results.length} result(s)` };
  },
  describe: (out) =>
    out.results.length
      ? out.results.map((r) => `- [${r.kind}${r.verified ? '' : ', unverified'}] ${r.content}`).join('\n')
      : 'No matching memories.',
};

const RememberInput = z.object({
  content: z.string().min(3).max(1000).describe('A single self-contained statement to remember'),
  kind: z.enum(userKinds).describe('rule (a standing instruction for how Jarvis works) | preference | plan | schedule | idea | project | decision | procedure | fact'),
  tags: z.array(z.string().max(30)).max(6).optional(),
  userStated: z.boolean().describe('true only if the user explicitly stated this; false if you inferred it'),
});
type RememberOut = { id: string; merged: boolean; verified: boolean };

export const memoryRemember: Skill<z.infer<typeof RememberInput>, RememberOut> = {
  name: 'memory.remember',
  title: 'Remember',
  description: 'Save something worth remembering across sessions. Memories saved this way are marked unverified until the user confirms them on the Memory page.',
  category: 'memory',
  scope: 'memory.write',
  risk: 'internal',
  idempotent: true,
  inlineSafe: true,
  untrustedOutput: false,
  input: RememberInput,
  outputDescription: 'The memory id and whether it was merged into an existing memory.',
  availability: always,
  summarize: (i) => `Remember (${i.kind}): "${i.content}"`,
  async execute(input, ctx) {
    const origin = ctx.conversationId ? `conversation:${ctx.conversationId}` : ctx.taskId ? `task:${ctx.taskId}` : null;
    const { memory, merged } = ctx.services.memory.add({
      kind: input.kind as (typeof MEMORY_KINDS)[number],
      content: input.content,
      tags: input.tags,
      source: input.userStated ? 'user (via conversation)' : 'jarvis (inferred)',
      sourceRef: origin,
      confidence: input.userStated ? 0.8 : 0.5,
      // A model's account of what the user said is not the user's confirmation.
      verified: false,
    });
    return { id: memory.id, merged, verified: memory.verified };
  },
  async verify(_i, out, ctx) {
    const m = ctx.services.memory.get(out.id);
    return { ok: Boolean(m), detail: m ? 'Memory stored' : 'Memory not found after saving' };
  },
  describe: (out) => (out.merged ? `Merged into existing memory ${out.id}` : `Saved memory ${out.id} (unverified)`),
};

const ForgetInput = z.object({ id: z.string().min(3).max(64).describe('Memory id from memory.search') });

export const memoryForget: Skill<z.infer<typeof ForgetInput>, { id: string; deleted: boolean }> = {
  name: 'memory.forget',
  title: 'Forget memory',
  description: 'Delete a memory by id. Requires approval by default.',
  category: 'memory',
  scope: 'memory.delete',
  risk: 'write',
  idempotent: true,
  inlineSafe: false,
  untrustedOutput: false,
  input: ForgetInput,
  outputDescription: 'Whether the memory was deleted.',
  availability: always,
  summarize: (i) => `Delete memory ${i.id}`,
  lockKey: (i) => `memory:${i.id}`,
  async execute(input, ctx) {
    const existed = ctx.services.memory.get(input.id);
    if (!existed) throw new Error(`Memory ${input.id} does not exist`);
    return { id: input.id, deleted: ctx.services.memory.delete(input.id) };
  },
  async verify(i, _o, ctx) {
    const still = ctx.services.memory.get(i.id);
    return { ok: !still, detail: still ? 'Memory still exists' : 'Memory removed' };
  },
  describe: (o) => `Deleted memory ${o.id}`,
};
