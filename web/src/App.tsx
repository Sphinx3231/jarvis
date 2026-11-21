import { useCallback, useEffect, useRef, useState } from 'react';
import { Backdrop } from './components/Backdrop';
import { useLenis } from './motion/useLenis';
import { useReveal } from './motion/useReveal';
import { Sidebar, Toasts, TopBar } from './components/Shell';
import type { StatusResponse } from './lib/api';
import { api } from './lib/api';
import { useLive, useResource } from './lib/live';
import { useRoute } from './lib/router';
import { ActivityPage } from './pages/Activity';
import { HomePage } from './pages/Home';
import { IntegrationsPage } from './pages/Integrations';
import { MemoryPage } from './pages/Memory';
import { PipelinePage } from './pages/Pipeline';
import { SettingsPage } from './pages/Settings';
import { SkillsPage } from './pages/Skills';
import { TasksPage } from './pages/Tasks';
import { JarvisView } from './components/JarvisView';

const STATUS_EVENTS = ['task.updated', 'approval.updated', 'memory.changed', 'integrations.changed', 'settings.changed', 'job.ran'];

const VIEW_KEY = 'jarvis.view';

/**
 * Jarvis-only view (the default) or the full interface. Toggle with the backslash key, the button
 * in the Jarvis view's corner, or the top bar. The choice is remembered.
 */
function useJarvisView(): [boolean, () => void] {
  const [jarvisOnly, setJarvisOnly] = useState(() => {
    try {
      return localStorage.getItem(VIEW_KEY) !== 'full';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    document.documentElement.dataset.immersive = String(jarvisOnly);
    try {
      localStorage.setItem(VIEW_KEY, jarvisOnly ? 'jarvis' : 'full');
    } catch {
      /* private mode */
    }
  }, [jarvisOnly]);
  const toggle = useCallback(() => setJarvisOnly((v) => !v), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '\\' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      setJarvisOnly((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return [jarvisOnly, toggle];
}

export function App() {
  const route = useRoute();
  const { settings } = useLive();
  const { data: status } = useResource<StatusResponse>('/api/status', STATUS_EVENTS);
  const [immersive, toggleImmersive] = useJarvisView();
  const mainRef = useRef<HTMLElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  // Smooth wheel scrolling for the pages that scroll (Home is a fixed command center with its own panes).
  useLenis(mainRef, innerRef, route.page !== 'home' && !immersive, route.page);
  // Every page powers on: its panels slide out of their clips in order.
  useReveal(innerRef, `${route.page}:${immersive}`);

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
      <Backdrop />
      {immersive ? (
        <JarvisView onExit={toggleImmersive} />
      ) : (
        <>
          <TopBar immersive={false} onToggleImmersive={toggleImmersive} />
          <Sidebar page={route.page} status={status} />
          <main ref={mainRef} className={`content content--${route.page}`} id="content">
            <div ref={innerRef} className="content__inner">
              {route.page === 'home' && <HomePage status={status} onImmersive={toggleImmersive} />}
              {route.page === 'tasks' && <TasksPage selectedId={route.id} />}
              {route.page === 'pipeline' && <PipelinePage />}
              {route.page === 'memory' && <MemoryPage />}
              {route.page === 'skills' && <SkillsPage />}
              {route.page === 'integrations' && <IntegrationsPage />}
              {route.page === 'activity' && <ActivityPage />}
              {route.page === 'settings' && <SettingsPage />}
            </div>
          </main>
        </>
      )}
      <Toasts />
    </div>
  );
}
