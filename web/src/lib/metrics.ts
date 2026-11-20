import { useEffect, useState } from 'react';
import { api } from './api';

export interface HostMetrics {
  ts: number;
  cpuPercent: number;
  cores: number;
  memUsedPercent: number;
  memUsedBytes: number;
  memTotalBytes: number;
  rssBytes: number;
}

export interface MetricsHistory {
  latest: HostMetrics | null;
  cpu: number[];
  mem: number[];
  rss: number[];
}

/**
 * Real host metrics from the Jarvis service, sampled every few seconds while the page is visible,
 * with a short history for sparklines. Nothing is simulated: no data → nothing is drawn.
 */
export function useMetrics(intervalMs = 3000, keep = 40): MetricsHistory {
  const [hist, setHist] = useState<MetricsHistory>({ latest: null, cpu: [], mem: [], rss: [] });
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (!document.hidden) {
        try {
          const m = await api.get<HostMetrics>('/api/metrics');
          if (!alive) return;
          setHist((h) => ({
            latest: m,
            cpu: [...h.cpu, m.cpuPercent].slice(-keep),
            mem: [...h.mem, m.memUsedPercent].slice(-keep),
            rss: [...h.rss, m.rssBytes].slice(-keep),
          }));
        } catch {
          /* service briefly unreachable: keep the last values */
        }
      }
      if (alive) timer = setTimeout(tick, intervalMs);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [intervalMs, keep]);
  return hist;
}
