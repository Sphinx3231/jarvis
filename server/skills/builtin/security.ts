import { spawn } from 'node:child_process';
import { z } from 'zod';
import { findCapabilities, knowledgeSummary, operatorBriefing } from '../../agents/knowledge/index.ts';
import { resolveInWorkspace } from './files.ts';
import type { Skill, SkillContext } from '../types.ts';

/**
 * The security operator's two skills.
 *
 *  - security.toolkit  — look up Kali capabilities/tools and the methodology (knowledge only).
 *  - security.operate  — orchestrate authorized bug-bounty testing with the LOCAL model: it reads the
 *    in-scope program, briefs the model with the ethical-hacking methodology + the Kali arsenal, and
 *    (when live testing is authorized) runs the model's low/medium-impact steps on this Kali host,
 *    feeding results back for the next step.
 *
 * Guardrails come from the connected model; this file adds none. What it enforces is AUTHORIZATION,
 * which the methodology itself requires and which is what makes the traffic legitimate:
 *   • the target must be a program Jarvis discovered in the HackerOne pipeline (an authorized program);
 *   • live traffic runs only with full PC access AND offensive mode on AND an explicit execute flag;
 *   • high-impact steps are planned but surfaced for the operator to run, never auto-fired (the
 *     methodology's "explicitly approved" boundary, and bug-bounty rules prohibit disruption/DoS).
 */

const MAX_OUTPUT = 60_000;

interface RunOut {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
}

function runCommand(command: string, cwd: string, timeoutSec: number, signal: AbortSignal): Promise<RunOut> {
  const started = Date.now();
  return new Promise<RunOut>((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, env: { ...process.env, JARVIS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    const add = (which: 'o' | 'e', c: Buffer) => {
      const t = c.toString('utf8');
      if (which === 'o') stdout += t;
      else stderr += t;
      if (stdout.length + stderr.length > MAX_OUTPUT) {
        truncated = true;
        stdout = stdout.slice(0, MAX_OUTPUT);
        stderr = stderr.slice(0, MAX_OUTPUT / 4);
      }
    };
    child.stdout.on('data', (c: Buffer) => add('o', c));
    child.stderr.on('data', (c: Buffer) => add('e', c));
    const kill = () => child.kill('SIGTERM');
    signal.addEventListener('abort', kill, { once: true });
    const timer = setTimeout(kill, timeoutSec * 1000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, truncated, durationMs: Date.now() - started });
    });
  });
}

/** Pull the first JSON object out of a model reply (which may wrap it in prose or fences). */
function extractJson(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- security.toolkit

const ToolkitInput = z.object({
  query: z.string().min(1).max(200).describe('Capability, family id, or need — e.g. "DNS enumeration", "08", "subdomains", "TLS"'),
  limit: z.number().int().min(1).max(30).optional(),
});
type ToolkitOut = {
  query: string;
  families: Array<{ id: string; name: string; purpose: string }>;
  tools: Array<{ name: string; pkg: string; family: string; impact: string; execution: string; description: string }>;
  totals: { families: number; tools: number };
};

export const securityToolkit: Skill<z.infer<typeof ToolkitInput>, ToolkitOut> = {
  name: 'security.toolkit',
  title: 'Look up security tools',
  description: "Search Jarvis's Kali arsenal (90 tool profiles across 21 capability families) and methodology: find which tools perform a capability, with their operational impact, lowest-impact first. Knowledge only — runs nothing.",
  category: 'pipeline',
  scope: 'internal',
  risk: 'internal',
  idempotent: true,
  inlineSafe: true,
  untrustedOutput: false,
  input: ToolkitInput,
  outputDescription: 'Matching capability families and candidate tools (name, package, impact), lowest-impact first.',
  availability: () => ({ available: true }),
  summarize: (i) => `Look up security tools for "${i.query}"`,
  async execute(input) {
    const { families, tools } = findCapabilities(input.query, input.limit ?? 12);
    return {
      query: input.query,
      families: families.map((f) => ({ id: f.id, name: f.name, purpose: f.purpose })),
      tools: tools.map((t) => ({ name: t.name, pkg: t.pkg, family: t.familyName, impact: t.impact, execution: t.execution, description: t.description })),
      totals: knowledgeSummary(),
    };
  },
  async verify(_i, o) {
    return { ok: Array.isArray(o.tools), detail: `${o.tools.length} candidate tool(s)` };
  },
  describe: (o) =>
    o.tools.length
      ? [
          ...o.families.map((f) => `Capability [${f.id}] ${f.name} — ${f.purpose}`),
          ...o.tools.map((t) => `• ${t.name} (${t.pkg || '?'}) — ${t.family}, ${t.impact || '?'} impact, ${t.execution || '?'}: ${t.description}`),
        ].join('\n')
      : `No matching tools for "${o.query}". The arsenal holds ${o.totals.tools} tools across ${o.totals.families} families.`,
};

// ---------------------------------------------------------------- security.operate

const OperateInput = z.object({
  program: z.string().min(1).max(120).describe('HackerOne program handle or name (must be a program in the pipeline — i.e. authorized)'),
  objective: z.string().max(2000).optional().describe('What to focus on, e.g. "map the auth surface and look for IDOR"'),
  maxSteps: z.number().int().min(1).max(6).optional().describe('How many operate iterations (default 3 when live, 1 when planning)'),
  execute: z.boolean().optional().describe('Send live traffic (requires full access + offensive mode). Default false = plan only.'),
});
interface OperateStep {
  n: number;
  capability: string;
  tool: string;
  impact: string;
  purpose: string;
  command: string;
  ran: boolean;
  exitCode?: number | null;
  output?: string;
  note?: string;
}
type OperateOut = {
  program: string;
  url: string;
  active: boolean;
  reason: string;
  model: string;
  steps: OperateStep[];
};

export const securityOperate: Skill<z.infer<typeof OperateInput>, OperateOut> = {
  name: 'security.operate',
  title: 'Run authorized security testing',
  description:
    'Orchestrate authorized bug-bounty testing of an in-scope HackerOne program with the local model and the Kali arsenal. Briefs the model with the ethical-hacking methodology and the authorized scope, then plans — and, when live testing is enabled (full access + offensive mode), runs — low/medium-impact steps on this machine, feeding results back. High-impact steps are surfaced for you to run.',
  category: 'shell',
  scope: 'shell.exec',
  risk: 'consequential',
  idempotent: false,
  inlineSafe: false,
  untrustedOutput: true,
  input: OperateInput,
  outputDescription: 'The operator plan/run: each step with its capability, tool, impact, command, and (if run) output.',
  timeoutMs: 1_800_000,
  dependsOn: 'Roamies model sign-in',
  availability: (s) => (s.llm.available() ? { available: true } : { available: false, reason: 'No model from Roamies (sign in on its Model page)' }),
  summarize: (i) => `${i.execute ? 'Run' : 'Plan'} authorized security testing of "${i.program}"${i.objective ? ` — ${i.objective}` : ''}`,
  lockKey: (i) => `security.operate:${i.program.toLowerCase()}`,
  async execute(input, ctx): Promise<OperateOut> {
    const s = ctx.services;
    const q = input.program.trim().toLowerCase();
    // AUTHORIZATION: the target must be a program Jarvis discovered in the pipeline (an authorized program).
    const programs = s.pipeline.programs({ limit: 500 });
    const prog = programs.find((p) => p.handle.toLowerCase() === q) ?? programs.find((p) => p.name.toLowerCase() === q) ?? programs.find((p) => p.handle.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
    if (!prog) {
      throw new Error(`"${input.program}" is not a known in-scope program. Only HackerOne programs in the pipeline are authorized for testing — sync the pipeline or let Tom surface it first.`);
    }

    const cfg = s.settings.get();
    const shellEnabled = cfg.integrations.shell.enabled;
    const wantLive = Boolean(input.execute);
    const active = wantLive && cfg.permissions.fullAccess && cfg.agents.offensive && shellEnabled;
    const reason = active
      ? 'Live testing on: full access + offensive mode are enabled and this program is authorized.'
      : !wantLive
        ? 'Planning only (execute flag not set).'
        : [!cfg.permissions.fullAccess ? 'full access is off' : null, !cfg.agents.offensive ? 'offensive mode is off' : null, !shellEnabled ? 'shell is disabled' : null].filter(Boolean).join(', ') + ' — planning only until that is on.';

    const briefing = operatorBriefing({ program: prog.handle, url: prog.url, objective: input.objective, activeAllowed: active });
    const cwd = resolveInWorkspace(s.workspaceDir(), '.');
    const steps: OperateStep[] = [];
    const transcript: string[] = [`Target program: ${prog.name} (${prog.handle}) ${prog.url}`, input.objective ? `Objective: ${input.objective}` : ''];
    const maxSteps = input.maxSteps ?? (active ? 3 : 1);
    let modelId = '';

    for (let n = 1; n <= maxSteps; n++) {
      const prompt = [
        transcript.filter(Boolean).join('\n'),
        '',
        'Decide the single next step. Reply with ONLY a JSON object:',
        '{"capability": "<family or capability>", "tool": "<tool name>", "impact": "low|medium|high", "purpose": "<what this establishes>", "command": "<exact shell command to run on this Kali host, or empty string if no command>", "finding": "<a validated finding so far, or empty>", "done": <true|false>}',
        active ? 'If a command is appropriate, give a real, runnable, lowest-impact command bound to the authorized target only.' : 'Active testing is OFF: set command to "" and describe the passive/offline step instead.',
      ].join('\n');
      let res;
      try {
        res = await s.llm.generate({ system: briefing, prompt, maxTokens: 1200, signal: ctx.signal });
      } catch (err) {
        transcript.push(`(model error: ${(err as Error).message})`);
        break;
      }
      modelId = res.model;
      if (res.stopReason === 'refusal') {
        steps.push({ n, capability: '', tool: '', impact: '', purpose: 'Model declined this step', command: '', ran: false, note: `The model (${res.model}) declined.` });
        break;
      }
      const j = extractJson(res.text) ?? {};
      const step: OperateStep = {
        n,
        capability: String(j.capability ?? '').slice(0, 120),
        tool: String(j.tool ?? '').slice(0, 80),
        impact: String(j.impact ?? '').toLowerCase().slice(0, 20),
        purpose: String(j.purpose ?? res.text.trim().slice(0, 300)).slice(0, 500),
        command: String(j.command ?? '').slice(0, 2000),
        ran: false,
      };
      const finding = String(j.finding ?? '').trim();
      if (finding) {
        transcript.push(`Finding: ${finding}`);
        s.memory.add({ kind: 'fact', content: `[${prog.handle}] Finding (needs verification): ${finding}`, source: 'agent:trinity', tags: ['agent:trinity', prog.handle, 'finding'], verified: false });
      }

      // Decide whether to actually run it.
      if (step.command && active) {
        if (step.impact === 'high') {
          step.note = 'High-impact step — surfaced for you to run manually (not auto-fired).';
          transcript.push(`Planned (high-impact, not run): ${step.command}`);
          steps.push(step);
          break;
        }
        s.activity.log('info', 'agents', `Trinity running on ${prog.handle}: ${step.command.slice(0, 120)}`);
        try {
          const out = await runCommand(step.command, cwd, 300, ctx.signal);
          step.ran = true;
          step.exitCode = out.exitCode;
          step.output = `${out.stdout}${out.stderr ? `\n[stderr]\n${out.stderr}` : ''}`.slice(0, 8000);
          transcript.push(`$ ${step.command}\n(exit ${out.exitCode})\n${step.output}${out.truncated ? '\n…[truncated]' : ''}`);
        } catch (err) {
          step.note = `Command failed to start: ${(err as Error).message}`;
          transcript.push(`$ ${step.command}\n(error: ${(err as Error).message})`);
        }
      } else if (step.command) {
        step.note = 'Planned (live testing off) — run it yourself or enable offensive mode.';
        transcript.push(`Planned (not run): ${step.command}`);
      }
      steps.push(step);
      if (j.done === true || (!step.command && !active)) break;
    }

    // Record the operator run as a research-notebook memory in Trinity's mind (and the vault).
    s.memory.add({
      kind: 'fact',
      content: `[${prog.handle}] Operator ${active ? 'run' : 'plan'} — ${steps.length} step(s): ${steps.map((st) => `${st.tool || st.capability || 'step'} (${st.impact || '?'}${st.ran ? ', ran' : ''})`).join('; ')}. ${input.objective ? `Objective: ${input.objective}.` : ''}`.slice(0, 4000),
      source: 'agent:trinity',
      tags: ['agent:trinity', prog.handle, active ? 'operate' : 'plan'],
      verified: false,
    });

    return { program: prog.handle, url: prog.url, active, reason, model: modelId, steps };
  },
  async verify(_i, o) {
    return { ok: Array.isArray(o.steps), detail: `${o.steps.length} step(s), ${o.steps.filter((s) => s.ran).length} run${o.active ? ' (live)' : ' (planned)'}` };
  },
  describe: (o) =>
    [
      `Operator ${o.active ? 'run' : 'plan'} for ${o.program} — ${o.reason}`,
      ...o.steps.map((s) => `#${s.n} [${s.impact || '?'}] ${s.tool || s.capability}: ${s.purpose}${s.command ? `\n    $ ${s.command}${s.ran ? ` → exit ${s.exitCode}` : s.note ? ` — ${s.note}` : ''}` : ''}${s.ran && s.output ? `\n    ${s.output.split('\n').slice(0, 8).join('\n    ')}` : ''}`),
    ].join('\n'),
};
