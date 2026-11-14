/**
 * Deterministic intent recognition for explicit commands. It works with no model configured
 * and keeps simple, unambiguous requests fast and free. Anything it doesn't recognise goes to
 * the language model (or gets an honest "I need a model for that" reply).
 */

export type Intent =
  | { type: 'remember'; content: string }
  | { type: 'recall'; query: string }
  | { type: 'list_tasks' }
  | { type: 'status' }
  | { type: 'help' }
  | { type: 'greeting' }
  | { type: 'remind'; message: string; delayMs: number }
  | { type: 'task_control'; action: 'cancel' | 'pause' | 'resume'; ref: string }
  | { type: 'run_command'; command: string }
  | { type: 'fetch_url'; url: string; summarize: boolean }
  | { type: 'read_file'; path: string }
  | { type: 'list_files'; path?: string }
  | { type: 'unknown' };

/** Intents that are always handled locally, even when a model is available. */
export const LOCAL_INTENTS = new Set<Intent['type']>(['remember', 'list_tasks', 'status', 'help', 'remind', 'task_control']);

const UNIT_MS: Record<string, number> = { s: 1000, sec: 1000, second: 1000, m: 60_000, min: 60_000, minute: 60_000, h: 3_600_000, hr: 3_600_000, hour: 3_600_000, d: 86_400_000, day: 86_400_000 };

function unitMs(unit: string): number {
  const u = unit.toLowerCase().replace(/s$/, '');
  return UNIT_MS[u] ?? UNIT_MS[unit.toLowerCase()] ?? 60_000;
}

export function parseIntent(raw: string): Intent {
  const text = raw.trim().replace(/\s+/g, ' ');
  const t = text.replace(/[.!]+$/, '');
  let m: RegExpMatchArray | null;

  if (/^(hi|hello|hey|good (morning|afternoon|evening))( jarvis)?[!.,]?$/i.test(t)) return { type: 'greeting' };
  if (/^(help|what can you do\??|commands)$/i.test(t)) return { type: 'help' };
  if (/^((system )?status|how are you( doing)?\??|are you (there|online)\??)$/i.test(t)) return { type: 'status' };

  if ((m = t.match(/^(?:jarvis,? )?(?:please )?remember(?: that)?[:,]? (.{3,})$/i))) return { type: 'remember', content: m[1].trim() };

  if ((m = t.match(/^what do you (?:know|remember) about (.+?)\??$/i))) return { type: 'recall', query: m[1] };

  if (/^(show|list|what are|what's|whats)( me)?( all)?( my| the)?( (active|current|open|pending))? tasks\??$/i.test(t) || /^tasks$/i.test(t)) return { type: 'list_tasks' };

  if ((m = t.match(/^(cancel|stop|pause|resume) task (tsk_[a-z0-9]+)$/i))) {
    const verb = m[1].toLowerCase();
    return { type: 'task_control', action: verb === 'stop' ? 'cancel' : (verb as 'cancel' | 'pause' | 'resume'), ref: m[2] };
  }

  // "remind me in 10 minutes to stretch" / "remind me to stretch in 10 minutes"
  if ((m = t.match(/^remind me in (\d+) ?(seconds?|secs?|minutes?|mins?|m|hours?|hrs?|h|days?|d) (?:to |that |about )?(.+)$/i))) {
    return { type: 'remind', delayMs: Number(m[1]) * unitMs(m[2]), message: m[3] };
  }
  if ((m = t.match(/^remind me (?:to |that |about )?(.+?) in (\d+) ?(seconds?|secs?|minutes?|mins?|m|hours?|hrs?|h|days?|d)$/i))) {
    return { type: 'remind', delayMs: Number(m[2]) * unitMs(m[3]), message: m[1] };
  }

  if ((m = text.match(/^(?:run|execute)(?: the)?(?: command)?[: ]+`([^`]+)`$/i)) || (m = text.match(/^(?:run|execute) command[: ]+(.+)$/i))) {
    return { type: 'run_command', command: m[1].trim() };
  }

  if ((m = t.match(/^(fetch|get|open|read|summari[sz]e)(?: the)?(?: page| url| website| site)?[: ]+(https?:\/\/\S+)$/i))) {
    return { type: 'fetch_url', url: m[2], summarize: /^summari/i.test(m[1]) };
  }

  if ((m = t.match(/^(?:read|show|open|cat)(?: the)? file[: ]+(.+)$/i))) return { type: 'read_file', path: m[1].replace(/^["'`]|["'`]$/g, '') };
  if ((m = t.match(/^(?:list|show)(?: the| my)?(?: workspace)? files(?: in (.+))?$/i))) return { type: 'list_files', path: m[1]?.trim() };

  return { type: 'unknown' };
}
