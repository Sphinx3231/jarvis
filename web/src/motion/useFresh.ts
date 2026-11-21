import { useRef, type RefObject } from 'react';
import { gsap, reducedMotion, useGSAP } from './gsap';

/**
 * Animates list items that appear after the list first rendered — a new task, a new activity
 * entry, a new toast — and nothing else. Items are identified by `data-<attr>`; what was on screen
 * at first render is never replayed.
 */
export function useFresh(scope: RefObject<HTMLElement | null>, attr: string, ids: readonly string[], vars: gsap.TweenVars = {}) {
  const seen = useRef<Set<string> | null>(null);
  useGSAP(
    () => {
      const root = scope.current;
      if (!root) return;
      const els = Array.from(root.querySelectorAll<HTMLElement>(`[data-${attr}]`));
      const key = (el: HTMLElement) => el.getAttribute(`data-${attr}`) ?? '';
      if (seen.current === null) {
        seen.current = new Set(els.map(key));
        return;
      }
      const fresh = els.filter((el) => !seen.current!.has(key(el)));
      for (const el of fresh) seen.current.add(key(el));
      if (!fresh.length || reducedMotion()) return;
      gsap.from(fresh, { autoAlpha: 0, y: -8, duration: 0.5, stagger: Math.min(0.06, 0.4 / fresh.length), ease: 'jarvis.out', clearProps: 'transform,opacity,visibility', ...vars });
    },
    { scope, dependencies: [ids.join('|')] },
  );
}

const TASK_TONE: Record<string, string> = {
  running: '167, 139, 250',
  completed: '74, 222, 128',
  failed: '248, 113, 113',
  awaiting_approval: '251, 191, 36',
  paused: '148, 163, 184',
  cancelled: '148, 163, 184',
};

/** A brief light on the row of a task whose status really changed (from the live task.updated event). */
export function flashTask(root: HTMLElement | null, data: Record<string, unknown>) {
  if (!root || reducedMotion()) return;
  const id = typeof data.id === 'string' ? data.id : null;
  const tone = typeof data.status === 'string' ? TASK_TONE[data.status] : undefined;
  if (!id || !tone) return;
  const row = root.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"]`);
  if (!row) return;
  gsap.fromTo(
    row,
    { boxShadow: `inset 3px 0 0 rgba(${tone}, 0.95), inset 0 0 0 1px rgba(${tone}, 0.45), 0 0 22px -6px rgba(${tone}, 0.6)` },
    { boxShadow: `inset 3px 0 0 rgba(${tone}, 0), inset 0 0 0 1px rgba(${tone}, 0), 0 0 22px -6px rgba(${tone}, 0)`, duration: 1.4, ease: 'power2.out', clearProps: 'boxShadow' },
  );
  if (data.status === 'completed' || data.status === 'failed') {
    const badge = row.querySelector('.badge');
    if (badge) gsap.fromTo(badge, { scale: 1.18 }, { scale: 1, duration: 0.5, ease: 'back.out(2)', clearProps: 'transform' });
  }
}
