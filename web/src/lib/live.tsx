import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, type NotificationEntry, type Settings, type StateSnapshot } from './api';

/**
 * Live connection to the Jarvis backend (server-sent events). Pages subscribe to event types
 * and refetch only when something relevant changed — no polling.
 */

interface Toast {
  id: string;
  level: NotificationEntry['level'];
  title: string;
  body?: string;
}

interface LiveContextValue {
  /** Listen to one event type with its data (for animations of real events; doesn't re-render). */
  subscribe: (type: string, fn: (data: Record<string, unknown>) => void) => () => void;
  connected: boolean;
  state: StateSnapshot;
  versions: Record<string, number>;
  settings: Settings | null;
  reloadSettings: () => Promise<void>;
  toasts: Toast[];
  toast: (t: Omit<Toast, 'id'>) => void;
  dismissToast: (id: string) => void;
}

const LiveContext = createContext<LiveContextValue | null>(null);

export function LiveProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<StateSnapshot>({ state: 'idle', detail: 'Connecting…', since: Date.now() });
  const [versions, setVersions] = useState<Record<string, number>>({});
  const [settings, setSettings] = useState<Settings | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const settingsRef = useRef<Settings | null>(null);
  settingsRef.current = settings;
  const listeners = useRef(new Map<string, Set<(data: Record<string, unknown>) => void>>());
  const subscribe = useCallback((type: string, fn: (data: Record<string, unknown>) => void) => {
    const set = listeners.current.get(type) ?? new Set();
    set.add(fn);
    listeners.current.set(type, set);
    return () => {
      set.delete(fn);
    };
  }, []);

  const reloadSettings = useCallback(async () => {
    const res = await api.get<{ settings: Settings }>('/api/settings');
    setSettings(res.settings);
  }, []);

  const dismissToast = useCallback((id: string) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (t: Omit<Toast, 'id'>) => {
      const id = Math.random().toString(36).slice(2);
      setToasts((list) => [...list.filter((x) => x.title !== t.title || x.body !== t.body).slice(-2), { ...t, id }]);
      setTimeout(() => dismissToast(id), t.level === 'error' ? 9000 : t.level === 'success' ? 3500 : 6000);
    },
    [dismissToast],
  );

  useEffect(() => {
    if (!api.hasToken()) return;
    void reloadSettings().catch(() => {});
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      source = new EventSource(api.eventsUrl());
      source.onopen = () => {
        setConnected(true);
        // Anything may have changed while we were disconnected.
        setVersions((v) => Object.fromEntries(Object.entries(v).map(([k, n]) => [k, n + 1])));
      };
      source.onerror = () => {
        setConnected(false);
        source?.close();
        retry = setTimeout(connect, 3000);
      };
      source.onmessage = (msg) => {
        const event = JSON.parse(msg.data) as { type: string; data: Record<string, unknown> };
        if (event.type === 'hello') {
          setState(event.data.state as StateSnapshot);
          return;
        }
        if (event.type === 'assistant.state') setState(event.data as unknown as StateSnapshot);
        if (event.type === 'settings.changed') void reloadSettings();
        if (event.type === 'notification' && typeof event.data.title === 'string') {
          const n = event.data as unknown as NotificationEntry;
          toast({ level: n.level, title: n.title, body: n.body });
          const s = settingsRef.current;
          if (s?.notifications.desktop && 'Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
            try {
              new Notification(`Jarvis — ${n.title}`, { body: n.body, icon: '/icon-192.png', tag: n.id });
            } catch {
              /* some platforms disallow constructing notifications */
            }
          }
        }
        setVersions((v) => ({ ...v, [event.type]: (v[event.type] ?? 0) + 1 }));
        listeners.current.get(event.type)?.forEach((fn) => {
          try {
            fn(event.data ?? {});
          } catch {
            /* an animation must never break the live connection */
          }
        });
      };
    };
    connect();
    return () => {
      source?.close();
      if (retry) clearTimeout(retry);
    };
  }, [reloadSettings, toast]);

  return <LiveContext.Provider value={{ connected, state, versions, settings, reloadSettings, toasts, toast, dismissToast, subscribe }}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveContextValue {
  const ctx = useContext(LiveContext);
  if (!ctx) throw new Error('useLive outside LiveProvider');
  return ctx;
}

/**
 * Fetch a resource and refetch whenever one of the given event types arrives.
 */
export function useResource<T>(path: string | null, events: string[] = []): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const { versions } = useLive();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const version = events.reduce((sum, e) => sum + (versions[e] ?? 0), 0);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .get<T>(path)
        .then((d) => {
          if (cancelled) return;
          setData(d);
          setError(null);
        })
        .catch((e: Error) => !cancelled && setError(e.message))
        .finally(() => !cancelled && setLoading(false));
    }, 60); // coalesce bursts of events
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [path, version, nonce]);

  return { data, error, loading, reload: () => setNonce((n) => n + 1) };
}

/** Run an API action, surfacing failures as toasts. */
export function useAction() {
  const { toast } = useLive();
  return useCallback(
    async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      try {
        const r = await fn();
        if (success) toast({ level: 'success', title: success });
        return r;
      } catch (e) {
        toast({ level: 'error', title: 'That didn’t work', body: (e as Error).message });
        return undefined;
      }
    },
    [toast],
  );
}

/** Run [handler] for every live event of [type] (with its data). The handler may change between renders. */
export function useLiveEvent(type: string, handler: (data: Record<string, unknown>) => void) {
  const { subscribe } = useLive();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribe(type, (data) => ref.current(data)), [subscribe, type]);
}
