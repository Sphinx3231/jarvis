import { createHash } from 'node:crypto';
import { detectInjection } from '../intelligence/untrusted.ts';

/**
 * Computer Access safety boundaries.
 *
 * 1. Critical-action classification. Some things a person does on a computer have consequences that
 *    must never happen without the user explicitly saying yes *for that action* — sending a message,
 *    paying, deleting, installing, changing security settings, running something as admin. These are
 *    recognised from the semantic target of an action (the button/link label, the text being typed,
 *    the page it happens on) and force an explicit confirmation even when Full Access is on and even
 *    when the user's request broadly "covers" the step.
 *
 * 2. Untrusted screen/page content. Everything Jarvis reads off the screen or a web page is data, not
 *    authority. `screenContentFindings` flags text that tries to instruct Jarvis (prompt injection) so
 *    the planner and the learning pipeline can quarantine it instead of acting on or storing it.
 *
 * The classifier is deliberately conservative (it prefers a false "needs confirmation" over a missed
 * one) and never decides *for* the user — it only decides when to ask.
 */

export type CriticalCategory =
  | 'send-message'
  | 'publish'
  | 'purchase'
  | 'money-transfer'
  | 'legal-agreement'
  | 'delete'
  | 'install'
  | 'security-settings'
  | 'admin-privileges'
  | 'share-private'
  | 'credentials';

export interface CriticalFinding {
  category: CriticalCategory;
  reason: string;
}

const LABEL_RULES: Array<{ category: CriticalCategory; re: RegExp; reason: string }> = [
  { category: 'send-message', re: /\b(send|send now|reply all|reply|forward|post comment|send message|submit message)\b/i, reason: 'sends a message on your behalf' },
  { category: 'publish', re: /\b(publish|post|tweet|share publicly|go live|make public|upload)\b/i, reason: 'publishes content' },
  { category: 'purchase', re: /\b(buy|buy now|purchase|place (your )?order|checkout|check out|pay( now)?|complete (purchase|payment|order)|subscribe (now|for \$?\d|to (premium|pro|plus|the plan))|start (my |your |a )?(paid )?subscription|upgrade (now|to|plan)|start (free )?trial|donate|add payment)\b/i, reason: 'spends money' },
  { category: 'money-transfer', re: /\b(transfer|send money|withdraw|wire|pay out|payout)\b/i, reason: 'moves money' },
  { category: 'legal-agreement', re: /\b(i agree|accept (the )?(terms|agreement|contract|offer)|sign( (contract|agreement|document))?|e-?sign)\b/i, reason: 'accepts a legally significant agreement' },
  { category: 'delete', re: /\b(delete|remove permanently|permanently delete|erase|empty (the )?trash|wipe|format (disk|drive)|deactivate account|close account)\b/i, reason: 'deletes data' },
  { category: 'install', re: /\b(install|uninstall|update now|run installer)\b/i, reason: 'installs or removes software' },
  { category: 'security-settings', re: /\b(change password|reset password|disable (2fa|two[- ]factor|mfa)|security settings|grant (access|permission)|add (admin|owner|member)|change (role|permissions?)|revoke)\b/i, reason: 'changes security or account permissions' },
  { category: 'share-private', re: /\b(share (with|file|folder|link)|invite|make (it )?public|anyone with the link)\b/i, reason: 'shares information externally' },
];

/** Text typed into a terminal/run box that escalates privileges or destroys data. */
const TYPED_RULES: Array<{ category: CriticalCategory; re: RegExp; reason: string }> = [
  { category: 'admin-privileges', re: /(^|[\s;&|])(sudo|su\s+-|doas|pkexec|runas)\b/i, reason: 'runs a command with administrator/root privileges' },
  { category: 'admin-privileges', re: /Start-Process\b[^\n]*-Verb\s+RunAs/i, reason: 'runs a command elevated' },
  { category: 'delete', re: /\b(rm\s+-[a-z]*r[a-z]*f|rm\s+-[a-z]*f[a-z]*r|del\s+\/[sq]|Remove-Item\b[^\n]*-Recurse|mkfs\.|dd\s+if=|format\s+[a-z]:)/i, reason: 'deletes files or disks' },
  { category: 'install', re: /\b(apt(-get)?\s+(install|remove|purge)|dnf\s+install|yum\s+install|pacman\s+-S|brew\s+install|winget\s+install|choco\s+install|pip\s+install|npm\s+i(nstall)?\s+-g|curl[^\n|]*\|\s*(ba)?sh)\b/i, reason: 'installs software' },
  { category: 'security-settings', re: /\b(chmod\s+777|ufw\s+disable|Set-MpPreference|netsh\s+advfirewall|setenforce\s+0|passwd\b)/i, reason: 'changes security settings' },
];

/** Card numbers / IBAN-ish strings being typed somewhere — sharing financial/private data. */
const SENSITIVE_DATA = /\b(?:\d[ -]?){13,19}\b|\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/;

export interface ActionContext {
  /** What is being clicked/activated: a button/link/menu label (semantic target). */
  label?: string | null;
  /** Text being typed. */
  typed?: string | null;
  /** Typing into a password/secret field (the text itself is never logged or classified). */
  secretField?: boolean;
  /** Key chord being pressed (e.g. "Return", "ctrl+Return"). */
  keys?: string | null;
  /** Where it happens: page title / URL / window title, used to disambiguate (e.g. Enter in a mail composer). */
  where?: string | null;
}

const SUBMIT_KEYS = /^(ctrl\+|cmd\+|super\+)?(Return|KP_Enter|Enter)$/i;
const COMPOSE_CONTEXT = /\b(compose|new message|reply|inbox|mail|chat|message|checkout|payment|cart|order)\b/i;

/** Decide whether an action is critical. Returns null when it is ordinary. */
export function classifyAction(ctx: ActionContext): CriticalFinding | null {
  const label = (ctx.label ?? '').trim();
  if (label) {
    for (const r of LABEL_RULES) if (r.re.test(label)) return { category: r.category, reason: `"${label.slice(0, 60)}" ${r.reason}` };
  }
  if (ctx.secretField) return { category: 'credentials', reason: 'enters a password or other secret into a sign-in field' };
  const typed = ctx.typed ?? '';
  if (typed) {
    for (const r of TYPED_RULES) if (r.re.test(typed)) return { category: r.category, reason: `typing ${JSON.stringify(typed.slice(0, 60))} ${r.reason}` };
    if (SENSITIVE_DATA.test(typed)) return { category: 'share-private', reason: 'typing what looks like a card/account number' };
  }
  // Enter in a composer/checkout submits it — same consequence as pressing "Send"/"Pay".
  if (ctx.keys && SUBMIT_KEYS.test(ctx.keys.trim()) && ctx.where && COMPOSE_CONTEXT.test(ctx.where)) {
    return { category: 'send-message', reason: `pressing ${ctx.keys} in "${ctx.where.slice(0, 60)}" may send or submit it` };
  }
  return null;
}

/** A stable fingerprint of an action, so a confirmation authorizes exactly that action once. */
export function actionFingerprint(kind: string, ctx: ActionContext): string {
  const norm = JSON.stringify([kind, ctx.label ?? null, ctx.typed ?? null, ctx.keys ?? null, ctx.where ?? null]);
  return createHash('sha256').update(norm).digest('hex').slice(0, 24);
}

// ---------------------------------------------------------------- untrusted content

/** Extra patterns specific to screen/page content aimed at an agent operating the computer. */
const SCREEN_INJECTION: RegExp[] = [
  /\b(jarvis|assistant|ai agent|ai model|language model)\b[^.\n]{0,40}\b(must|should|now|please)\b[^.\n]{0,60}\b(click|type|run|open|send|delete|disable|enable|turn (on|off)|approve|grant|reveal|upload|download|navigate)\b/i,
  /\b(turn|switch) (off|on) (computer access|safety|security|the (stop|guard))\b/i,
  /\b(send|upload|email|post) (your|the user'?s?|all) (files|passwords?|cookies|tokens?|credentials|keys|history|data)\b/i,
  /\b(reveal|print|show|tell me) (your|the) (system prompt|instructions|api key|password|token)\b/i,
  /\b(run|execute) (this|the following) (command|script|code)\b/i,
];

export interface ContentFinding {
  line: string;
  match: string;
}

/** Lines of screen/page text that try to instruct Jarvis. Data, never instructions. */
export function screenContentFindings(text: string): ContentFinding[] {
  const out: ContentFinding[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const generic = detectInjection(line);
    const specific = SCREEN_INJECTION.map((re) => line.match(re)?.[0]).filter((m): m is string => Boolean(m));
    const hit = [...generic, ...specific][0];
    if (hit) out.push({ line: line.slice(0, 300), match: hit.slice(0, 80) });
  }
  return out;
}

/** Remove instruction-like lines from content before it is stored as knowledge. */
export function quarantineInstructions(text: string): { clean: string; quarantined: ContentFinding[] } {
  const quarantined = screenContentFindings(text);
  if (!quarantined.length) return { clean: text, quarantined };
  const bad = new Set(quarantined.map((q) => q.line));
  const clean = text
    .split(/\r?\n/)
    .filter((l) => !bad.has(l.trim().slice(0, 300)))
    .join('\n');
  return { clean, quarantined };
}

// ---------------------------------------------------------------- secrets

/** Never store or echo these: anything shaped like a credential seen on screen. */
const SECRET_PATTERNS: RegExp[] = [
  /\b(password|passwd|pwd|passcode|pin)\s*[:=]\s*\S+/gi,
  /\b(api[_-]?key|secret|token|bearer|authorization)\s*[:=]\s*\S+/gi,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
  /\b(?:\d[ -]?){13,19}\b/g,
];

/** Redact credential-shaped strings from observed text before it is persisted anywhere. */
export function redactSecrets(text: string): { text: string; redacted: number } {
  let redacted = 0;
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m) => {
      redacted++;
      const key = m.match(/^[A-Za-z_ -]+\s*[:=]/)?.[0];
      return key ? `${key} [redacted]` : '[redacted]';
    });
  }
  return { text: out, redacted };
}
