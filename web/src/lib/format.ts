export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 0) return `in ${duration(-diff)}`;
  if (diff < 45_000) return 'just now';
  return `${duration(diff)} ago`;
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function uptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function dateTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  paused: 'Paused',
  awaiting_approval: 'Needs approval',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const PRIORITY_LABEL: Record<number, string> = { 1: 'Low', 2: 'Normal', 3: 'High', 4: 'Urgent' };

export const KIND_LABEL: Record<string, string> = {
  rule: 'Rule',
  plan: 'Plan',
  schedule: 'Schedule',
  idea: 'Idea',
  preference: 'Preference',
  project: 'Project',
  decision: 'Decision',
  procedure: 'Procedure',
  fact: 'Fact',
  task_history: 'Task history',
  tool_doc: 'Tool doc',
};
