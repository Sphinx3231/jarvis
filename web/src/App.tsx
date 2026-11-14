import { useEffect } from 'react';
import { Sidebar, Toasts, TopBar } from './components/Shell';
import type { StatusResponse } from './lib/api';
import { api } from './lib/api';
import { useLive, useResource } from './lib/live';
import { useRoute } from './lib/router';
import { ActivityPage } from './pages/Activity';
import { HomePage } from './pages/Home';
import { IntegrationsPage } from './pages/Integrations';
import { MemoryPage } from './pages/Memory';
import { SettingsPage } from './pages/Settings';
import { SkillsPage } from './pages/Skills';
import { TasksPage } from './pages/Tasks';

const STATUS_EVENTS = ['task.updated', 'approval.updated', 'memory.changed', 'integrations.changed', 'settings.changed', 'job.ran'];

export function App() {
  const route = useRoute();
  const { settings } = useLive();
  const { data: status } = useResource<StatusResponse>('/api/status', STATUS_EVENTS);

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
      <Sidebar page={route.page} status={status} />
      <div className="main">
        <TopBar />
        <main className="content" id="content">
          {route.page === 'home' && <HomePage status={status} />}
          {route.page === 'tasks' && <TasksPage selectedId={route.id} />}
          {route.page === 'memory' && <MemoryPage />}
          {route.page === 'skills' && <SkillsPage />}
          {route.page === 'integrations' && <IntegrationsPage />}
          {route.page === 'activity' && <ActivityPage />}
          {route.page === 'settings' && <SettingsPage />}
        </main>
      </div>
      <Toasts />
    </div>
  );
}
