import { cpus, freemem, totalmem } from 'node:os';

/**
 * Live host metrics for the dashboard. CPU use is measured from the per-core time counters between
 * two samples (os.loadavg is always 0 on Windows, so it can't be used). The first reading after
 * start covers the time since this module loaded.
 */
type Sample = { idle: number; total: number };

function sample(): Sample {
  let idle = 0;
  let total = 0;
  for (const c of cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

let last = sample();
let lastCpu = 0;

export interface HostMetrics {
  ts: number;
  cpuPercent: number;
  cores: number;
  memUsedPercent: number;
  memUsedBytes: number;
  memTotalBytes: number;
  /** The Jarvis process itself (resident memory). */
  rssBytes: number;
}

export function hostMetrics(): HostMetrics {
  const now = sample();
  const dTotal = now.total - last.total;
  const dIdle = now.idle - last.idle;
  // Two calls very close together carry no information: keep the previous reading.
  if (dTotal > 0) {
    lastCpu = Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
    last = now;
  }
  const total = totalmem();
  const used = total - freemem();
  return {
    ts: Date.now(),
    cpuPercent: Math.round(lastCpu * 10) / 10,
    cores: cpus().length,
    memUsedPercent: Math.round((used / total) * 1000) / 10,
    memUsedBytes: used,
    memTotalBytes: total,
    rssBytes: process.memoryUsage().rss,
  };
}
