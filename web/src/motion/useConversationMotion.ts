import { useRef, type RefObject } from 'react';
import { gsap, reducedMotion, useGSAP } from './gsap';
import { useLenis } from './useLenis';

/**
 * The chat feed: Lenis smooths wheel scrolling inside the feed only, and each message that
 * arrives after the feed opened rises into place (the history that loads with the page does not
 * replay). Returns the feed's Lenis instance (null under reduced motion) for scrolling to the end.
 */
export function useConversationMotion(box: RefObject<HTMLElement | null>, inner: RefObject<HTMLElement | null>, ids: string[], sending: boolean) {
  const lenis = useLenis(box, inner, true);
  const seen = useRef<Set<string> | null>(null);
  useGSAP(
    () => {
      const root = inner.current;
      if (!root) return;
      const all = Array.from(root.querySelectorAll<HTMLElement>('[data-msg]'));
      if (seen.current === null) {
        // First render: what's there is history.
        seen.current = new Set(all.map((el) => el.dataset.msg ?? ''));
        return;
      }
      const fresh = all.filter((el) => !seen.current!.has(el.dataset.msg ?? ''));
      for (const el of fresh) seen.current.add(el.dataset.msg ?? '');
      if (!fresh.length || reducedMotion()) return;
      gsap.from(fresh, {
        autoAlpha: 0,
        y: 16,
        x: (_: number, el: HTMLElement) => (el.classList.contains('msg--user') ? 18 : -18),
        duration: 0.55,
        stagger: 0.08,
        ease: 'jarvis.out',
        clearProps: 'transform,opacity,visibility',
      });
    },
    { scope: inner, dependencies: [ids.join(','), sending] },
  );
  return lenis;
}
