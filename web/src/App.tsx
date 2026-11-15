import { useEffect, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { Sidebar, Toasts, TopBar } from './components/Shell';
import type { StatusResponse } from './lib/api';
import { api } from './lib/api';
import { useLive, useResource } from './lib/live';
import { navigate, useRoute } from './lib/router';
import { ActivityPage } from './pages/Activity';
import { HomePage } from './pages/Home';
import { IntegrationsPage } from './pages/Integrations';
import { MemoryPage } from './pages/Memory';
import { PipelinePage } from './pages/Pipeline';
import { SettingsPage } from './pages/Settings';
import { SkillsPage } from './pages/Skills';
import { TasksPage } from './pages/Tasks';

const STATUS_EVENTS = ['task.updated', 'approval.updated', 'memory.changed', 'integrations.changed', 'settings.changed', 'job.ran'];

/** Immersive mode makes Jarvis the whole screen (just the core + voice). Toggle with the backslash key. */
function useImmersive(): [boolean, () => void] {
  const [immersive, setImmersive] = useState(() => {
    try {
      return localStorage.getItem('jarvis-immersive') === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    document.documentElement.dataset.immersive = String(immersive);
    try {
      localStorage.setItem('jarvis-immersive', immersive ? '1' : '0');
    } catch {
      /* private mode */
    }
  }, [immersive]);
  const toggle = () =>
    setImmersive((v) => {
      if (!v) navigate({ page: 'home' });
      return !v;
    });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '\\' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      setImmersive((v) => {
        if (!v) navigate({ page: 'home' });
        return !v;
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return [immersive, toggle];
}

export function App() {
  const route = useRoute();
  const { settings } = useLive();
  const { data: status } = useResource<StatusResponse>('/api/status', STATUS_EVENTS);
  const [immersive, toggleImmersive] = useImmersive();

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.accent = settings?.appearance.accent ?? 'violet';
    root.dataset.reduceMotion = String(settings?.appearance.reduceMotion ?? false);
  }, [settings?.appearance.accent, settings?.appearance.reduceMotion]);

  if (!api.hasToken()) {
    return (
      <div className="fatal">
        <img src="/icon-192.png" alt="" width={96} height={96} />
        <h1>Open Jarvis from its own address</h1>
        <p>This page has to be served by the Jarvis service. Start it with <code>npm run app</code> and use the address it prints.</p>
      </div>
    );
  }

  return (
    <div className="app">
      <button className="immersive-toggle" onClick={toggleImmersive} aria-label={immersive ? 'Exit immersive mode (backslash)' : 'Immersive mode (backslash)'} title={immersive ? 'Exit immersive (\\)' : 'Make Jarvis the whole screen (\\)'}>
        {immersive ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
      </button>
      <Sidebar page={route.page} status={status} />
      <div className="main">
        <TopBar />
        <main className="content" id="content">
          {route.page === 'home' && <HomePage status={status} />}
          {route.page === 'tasks' && <TasksPage selectedId={route.id} />}
          {route.page === 'pipeline' && <PipelinePage />}
          {route.page === 'memory' && <MemoryPage />}
          {route.page === 'skills' && <SkillsPage />}
          {route.page === 'integrations' && <IntegrationsPage />}
          {route.page === 'activity' && <ActivityPage />}
          {route.page === 'settings' && <SettingsPage />}
        </main>
      </div>
      {immersive && <div className="immersive-hint">Press \ to exit</div>}
      <Toasts />
    </div>
  );
}
