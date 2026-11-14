import { z } from 'zod';
import type { ActivityLog } from '../core/activity.ts';
import { UserError } from '../core/util.ts';
import type { RoamiesEngine } from '../llm/engine.ts';
import { decodeToolName } from '../llm/types.ts';
import type { PermissionEngine } from '../permissions/engine.ts';
import { jsonSchemaOf, type SkillRegistry } from '../skills/registry.ts';
import { parseIntent, type Intent } from '../intelligence/intent.ts';
import { UNTRUSTED_POLICY } from '../intelligence/untrusted.ts';
import type { PlanStep } from '../tasks/store.ts';
import { assignAgent } from './agents.ts';

export const DraftStepSchema = z.object({
  skill: z.string().min(1).max(120),
  input: z.record(z.string(), z.unknown()).default({}),
  description: z.string().max(300).default(''),
});
export type DraftStep = z.infer<typeof DraftStepSchema>;

const TEMPLATE = /\{\{\s*steps\.\d+\.[\w.]+\s*\}\}/;

function containsTemplate(value: unknown): boolean {
  if (typeof value === 'string') return TEMPLATE.test(value);
  if (Array.isArray(value)) return value.some(containsTemplate);
  if (value && typeof value === 'object') return Object.values(value).some(containsTemplate);
  return false;
}

/** Rule-based plan for an explicit command (used when no model is configured). */
export function planFromIntent(intent: Intent, opts: { llmAvailable: boolean }): { title: string; steps: DraftStep[]; delayMs?: number } | null {
  switch (intent.type) {
    case 'run_command':
      return { title: `Run: ${intent.command.slice(0, 80)}`, steps: [{ skill: 'shell.run', input: { command: intent.command }, description: 'Run the command' }] };
    case 'fetch_url': {
      const steps: DraftStep[] = [{ skill: 'web.fetch', input: { url: intent.url }, description: `Fetch ${intent.url}` }];
      if (intent.summarize && opts.llmAvailable) {
        steps.push({
          skill: 'llm.generate',
          input: { instruction: 'Summarise this web page in a few concise bullet points.', context: '{{steps.0.output.text}}', contextSource: intent.url },
          description: 'Summarise the page',
        });
      }
      return { title: `${intent.summarize ? 'Summarise' : 'Fetch'} ${intent.url}`, steps };
    }
    case 'read_file':
      return { title: `Read ${intent.path}`, steps: [{ skill: 'files.read', input: { path: intent.path }, description: `Read ${intent.path}` }] };
    case 'list_files':
      return { title: 'List workspace files', steps: [{ skill: 'files.list', input: intent.path ? { path: intent.path } : {}, description: 'List files' }] };
    case 'calendar':
      return { title: `Calendar: next ${intent.days} day(s)`, steps: [{ skill: 'calendar.events', input: { days: intent.days }, description: 'List events' }] };
    case 'check_email':
      return { title: intent.unreadOnly ? 'Check unread email' : 'Check email', steps: [{ skill: 'email.search', input: { unreadOnly: intent.unreadOnly, limit: 10 }, description: 'Search mailbox' }] };
    case 'remind':
      return {
        title: `Reminder: ${intent.message.slice(0, 80)}`,
        steps: [{ skill: 'notify.user', input: { title: 'Reminder', body: intent.message, level: 'info' }, description: 'Show the reminder' }],
        delayMs: intent.delayMs,
      };
    default:
      return null;
  }
}

/**
 * Planning agent: turns a request into a validated sequence of skill steps. It never executes
 * anything; validation makes sure every step names a real, registered skill and well-formed input.
 */
export class Planner {
  private registry: SkillRegistry;
  private llm: RoamiesEngine;
  private permissions: PermissionEngine;
  private activity: ActivityLog;

  constructor(registry: SkillRegistry, llm: RoamiesEngine, permissions: PermissionEngine, activity: ActivityLog) {
    this.registry = registry;
    this.llm = llm;
    this.permissions = permissions;
    this.activity = activity;
  }

  validate(draft: DraftStep[]): { steps: PlanStep[]; requiredPermissions: string[] } {
    if (!Array.isArray(draft) || !draft.length) throw new UserError('A plan needs at least one step');
    if (draft.length > 20) throw new UserError('Plans are limited to 20 steps');
    const steps: PlanStep[] = draft.map((raw, i) => {
      const d = DraftStepSchema.parse(raw);
      const name = d.skill.includes('__') ? decodeToolName(d.skill) : d.skill;
      const skill = this.registry.get(name);
      if (!skill) throw new UserError(`Step ${i + 1} uses unknown skill "${d.skill}"`);
      const availability = this.registry.availability(skill);
      if (!availability.available) throw new UserError(`Step ${i + 1}: ${skill.name} is unavailable (${availability.reason})`);
      // Inputs that reference earlier steps are validated at run time, once resolved.
      if (!containsTemplate(d.input)) {
        const parsed = skill.input.safeParse(d.input);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          throw new UserError(`Step ${i + 1} (${skill.name}) has invalid input: ${issue.path.join('.') || 'input'} — ${issue.message}`);
        }
      }
      for (const m of JSON.stringify(d.input).matchAll(/steps\.(\d+)\./g)) {
        if (Number(m[1]) >= i) throw new UserError(`Step ${i + 1} references output of step ${Number(m[1]) + 1}, which has not run yet`);
      }
      return { skill: skill.name, input: d.input, description: d.description || skill.title, agent: assignAgent(skill), status: 'pending', attempts: 0 };
    });
    const requiredPermissions = [...new Set(steps.map((s) => this.registry.get(s.skill)!.scope).filter((scope) => this.permissions.policyFor(scope) !== 'allow'))];
    return { steps, requiredPermissions };
  }

  /** Produce a plan for a task that was created from a plain description. */
  async plan(title: string, description: string, signal?: AbortSignal): Promise<{ steps: DraftStep[] } | { error: string }> {
    const request = `${title}${description ? `\n\n${description}` : ''}`;
    await this.llm.refresh().catch(() => {});
    if (!this.llm.available()) {
      const rule = planFromIntent(parseIntent(title), { llmAvailable: false }) ?? planFromIntent(parseIntent(description), { llmAvailable: false });
      if (rule) return { steps: rule.steps };
      return { error: 'Jarvis could not plan this without a language model. Sign in to a model in Roamies, or phrase it as a direct command (e.g. "fetch https://…", "run `…`").' };
    }

    const skills = this.registry.all().filter((s) => this.registry.availability(s).available);
    const catalogue = skills
      .map((s) => `- ${s.name} — ${s.description} [permission: ${s.scope}]\n  input schema: ${JSON.stringify(jsonSchemaOf(s))}`)
      .join('\n');
    const system = `You are the planning agent of Jarvis, a personal assistant. Convert the user's task into the shortest reliable sequence of steps using ONLY the skills listed below. Never invent skills.
To pass a previous step's result into a later step, use a template string such as "{{steps.0.output.text}}" (zero-based step index) or "{{steps.0.text}}" for the step's text rendering.
Steps that need permission will be shown to the user for approval before they run; plan them normally — do not try to avoid or work around permissions.
If the task cannot be done with these skills, call submit_plan with an empty steps array and explain why in "reason".
Always respond by calling submit_plan exactly once.
${UNTRUSTED_POLICY}

Available skills:
${catalogue}`;

    let submitted: { steps?: DraftStep[]; reason?: string } | null = null;
    const res = await this.llm.run({
      system,
      messages: [{ role: 'user', content: `Task to plan:\n${request}` }],
      tools: [
        {
          spec: {
          name: 'submit_plan',
          description: 'Submit the plan for this task.',
          inputSchema: {
            type: 'object',
            properties: {
              steps: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    skill: { type: 'string', description: 'Skill name, e.g. web.fetch' },
                    input: { type: 'object', description: 'Input matching the skill input schema' },
                    description: { type: 'string', description: 'Short description of the step' },
                  },
                  required: ['skill', 'input', 'description'],
                },
              },
              reason: { type: 'string', description: 'Why the task cannot be planned (only when steps is empty)' },
            },
            required: ['steps'],
          },
          },
          execute: async (input) => {
            submitted = input as { steps?: DraftStep[]; reason?: string };
            return { content: 'Plan received.' };
          },
        },
      ],
      stopAfter: 'submit_plan',
      maxTurns: 2,
      maxTokens: 8000,
      signal,
    });
    const input = submitted as { steps?: DraftStep[]; reason?: string } | null;
    if (!input) return { error: res.stopReason === 'refusal' ? 'The model declined to plan this task.' : 'The planning model did not return a plan.' };
    if (!input.steps?.length) return { error: input.reason ? `Not possible with the available skills: ${input.reason}` : 'The planner returned an empty plan.' };
    this.activity.log('info', 'planner', `Planned "${title}" in ${input.steps.length} step(s)`);
    return { steps: input.steps };
  }
}
