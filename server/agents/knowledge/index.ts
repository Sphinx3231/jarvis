import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The offensive-security knowledge base Jarvis's security operator (Trinity) reasons from:
 *
 *  - ethical-hacking-kb.md — methodology, bug-bounty reasoning, vulnerability taxonomy, the
 *    Observe→Model→Hypothesize→Test→Validate→Assess→Report→Learn loop, and the authorization rules.
 *  - kali-arsenal.md — a capability-indexed catalogue of 90 tool profiles across 21 families, with
 *    each tool's family, purpose, execution characteristics and operational impact.
 *
 * This module loads both and parses the arsenal into a structured capability → tool map so the
 * operator can look up "what performs DNS enumeration" and compare candidates by impact. It is a
 * KNOWLEDGE layer only: per the catalogue's own integration contract, retrieving a tool never grants
 * permission — scope authorization and approval are enforced separately (see the Trinity agent and
 * the security.operate skill). Nothing here runs a tool or sends traffic.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string): string => {
  try {
    return readFileSync(join(here, name), 'utf8');
  } catch {
    return '';
  }
};

export interface ToolProfile {
  num: number;
  name: string;
  pkg: string;
  familyId: string;
  familyName: string;
  description: string;
  execution: string;
  impact: string;
}
export interface CapabilityFamily {
  id: string;
  name: string;
  purpose: string;
}

let _methodology: string | null = null;
let _arsenal: string | null = null;
let _families: CapabilityFamily[] | null = null;
let _tools: ToolProfile[] | null = null;

export function methodologyText(): string {
  return (_methodology ??= read('ethical-hacking-kb.md'));
}
export function arsenalText(): string {
  return (_arsenal ??= read('kali-arsenal.md'));
}

function parseFamilies(text: string): CapabilityFamily[] {
  const out: CapabilityFamily[] = [];
  const section = text.split('## Capability family index')[1]?.split('## Canonical tool profile schema')[0] ?? '';
  for (const m of section.matchAll(/^\|\s*`(\d+)`\s*\|\s*\*\*(.+?)\*\*\s*\|\s*(.+?)\s*\|/gm)) {
    out.push({ id: m[1], name: m[2].trim(), purpose: m[3].trim() });
  }
  return out;
}

function parseTools(text: string): ToolProfile[] {
  const out: ToolProfile[] = [];
  const section = text.split('## Tool profiles')[1]?.split('## Research methodology')[0] ?? '';
  // Split on each "### NN. Name" heading.
  const blocks = section.split(/^###\s+(\d+)\.\s+(.+)$/gm);
  // blocks: [pre, num, name, body, num, name, body, ...]
  for (let i = 1; i + 2 < blocks.length; i += 3) {
    const num = Number(blocks[i]);
    const name = blocks[i + 1].trim();
    const body = blocks[i + 2];
    const field = (label: string): string => {
      const m = body.match(new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`));
      return m ? m[1].trim() : '';
    };
    const pkg = (field('Likely Kali package').match(/`([^`]+)`/) ?? [, ''])[1] ?? '';
    const fam = field('Primary family').match(/`?(\d+)\s*[—-]\s*([^`]+)`?/);
    out.push({
      num,
      name,
      pkg: pkg.trim(),
      familyId: fam?.[1] ?? '',
      familyName: (fam?.[2] ?? '').trim(),
      description: field('Description').replace(/\.$/, ''),
      execution: field('Execution characteristics'),
      impact: field('Operational impact').replace(/\*\*/g, '').trim(),
    });
  }
  return out;
}

export function families(): CapabilityFamily[] {
  return (_families ??= parseFamilies(arsenalText()));
}
export function tools(): ToolProfile[] {
  return (_tools ??= parseTools(arsenalText()));
}

/** Look up candidate tools for a capability: matches a family id/name/purpose or tool name/description. */
export function findCapabilities(query: string, limit = 12): { families: CapabilityFamily[]; tools: ToolProfile[] } {
  const q = query.toLowerCase().trim();
  const fams = families().filter((f) => f.id === q || f.name.toLowerCase().includes(q) || f.purpose.toLowerCase().includes(q));
  const famIds = new Set(fams.map((f) => f.id));
  const matched = tools().filter(
    (t) => famIds.has(t.familyId) || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || t.familyName.toLowerCase().includes(q),
  );
  // Lowest operational impact first (the methodology prefers the least-impact method that answers the question).
  const rank = (s: string) => (/low/i.test(s) ? 0 : /high/i.test(s) ? 2 : 1);
  matched.sort((a, b) => rank(a.impact) - rank(b.impact));
  return { families: fams, tools: matched.slice(0, limit) };
}

/** A compact one-line-per-tool arsenal index, grouped by family, for prompts and reports. */
export function arsenalIndex(): string {
  const byFam = new Map<string, ToolProfile[]>();
  for (const t of tools()) byFam.set(t.familyId, [...(byFam.get(t.familyId) ?? []), t]);
  return families()
    .map((f) => {
      const list = (byFam.get(f.id) ?? []).map((t) => `${t.name} (${t.pkg || '?'}, impact ${t.impact || '?'})`).join('; ');
      return `- [${f.id}] ${f.name}: ${list || '—'}`;
    })
    .join('\n');
}

/**
 * The operator briefing handed to the LOCAL model as its system prompt. It supplies the methodology,
 * the lowest-impact-first validation hierarchy, the authorization facts for exactly one target, and
 * the capability index — the information the model needs to plan authorized testing. It does not add
 * behavioural guardrails to the model; it gives it the scope and the discipline the catalogue requires.
 */
export function operatorBriefing(scope: { program: string; url?: string; objective?: string; activeAllowed: boolean }): string {
  return [
    'You are Trinity, Jarvis\'s offensive-security operator for AUTHORIZED bug-bounty testing on this machine (Kali Linux).',
    'You work strictly inside one bug-bounty program\'s scope and follow this discipline:',
    '',
    'Methodology (run this loop): Observe → Model → Hypothesize → Test → Validate → Assess Impact → Report → Learn.',
    'Before any active step confirm: the program policy and exact in-scope assets, the exclusions/prohibited techniques/rate limits, whether automation and authenticated testing are permitted, and the lowest-impact test that answers the question.',
    'Validation hierarchy, prefer in order: (1) static inspection, (2) offline analysis, (3) passive public-source research the program permits, (4) read-only service/config checks, (5) minimal active verification with a test account and harmless data, (6) state-changing/high-volume testing only when explicitly permitted and approved.',
    'Never promote a hypothesis to a finding because a tool reported a match — reproduce and verify. Keep evidence: raw output, UTC timestamp, tool version, exact target, config.',
    'Do not test anything outside the authorized scope below. A discovered subdomain/IP/asset is NOT automatically in scope. Stop if a test risks disruption, data modification, or access to another user\'s data.',
    '',
    `AUTHORIZED TARGET: program "${scope.program}"${scope.url ? ` (${scope.url})` : ''}.`,
    scope.objective ? `OBJECTIVE: ${scope.objective}` : 'OBJECTIVE: map the attack surface and surface the highest-value, lowest-impact next test.',
    `ACTIVE TESTING (sending live traffic): ${scope.activeAllowed ? 'ENABLED — you may run low-impact active steps on the authorized target.' : 'DISABLED — plan and do passive/offline work only; do not send active traffic.'}`,
    '',
    'Available tool capabilities on this Kali host (by family; pick the lowest-impact tool that answers the question, and verify it is installed before use):',
    arsenalIndex(),
    '',
    'When asked to plan, respond with concrete, bounded next steps: for each, give the capability, the specific tool and why, the exact target it runs against, its impact level, and the evidence it should capture. Prefer one well-chosen step over a broad sweep.',
  ].join('\n');
}

export function knowledgeSummary(): { families: number; tools: number; methodologyBytes: number } {
  return { families: families().length, tools: tools().length, methodologyBytes: methodologyText().length };
}
