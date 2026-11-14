import { useEffect, useState } from 'react';

export type Route = { page: 'home' | 'tasks' | 'pipeline' | 'memory' | 'skills' | 'integrations' | 'activity' | 'settings'; id?: string };

const PAGES = new Set(['tasks', 'pipeline', 'memory', 'skills', 'integrations', 'activity', 'settings']);

export function parseHash(hash: string): Route {
  const [page, id] = hash.replace(/^#\/?/, '').split('/');
  if (PAGES.has(page)) return { page: page as Route['page'], id: id ? decodeURIComponent(id) : undefined };
  return { page: 'home' };
}

export function navigate(route: Route): void {
  const hash = route.page === 'home' ? '#/' : `#/${route.page}${route.id ? `/${encodeURIComponent(route.id)}` : ''}`;
  if (window.location.hash !== hash) window.location.hash = hash;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
