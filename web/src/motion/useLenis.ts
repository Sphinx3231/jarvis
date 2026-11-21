import Lenis from 'lenis';
import { useEffect, useRef, type RefObject } from 'react';
import { gsap, reducedMotion } from './gsap';

/**
 * Smooth wheel scrolling for one scroll container (never the whole window): Jarvis is a desktop app
 * with many panels, so only the areas with real reading — pages, feeds, the conversation — get it.
 *
 * - One Lenis per container, driven by GSAP's ticker (a single animation loop for the whole UI).
 * - Wheel only: touch, keyboard (PageDown/arrows/space), the scrollbar and find-in-page stay native.
 * - Nested scrollables (code blocks, lists, textareas, selects, anything with data-lenis-prevent)
 *   scroll natively; Ctrl+wheel zoom is never touched.
 * - Off under reduced motion.
 */
export function useLenis(wrapper: RefObject<HTMLElement | null>, content: RefObject<HTMLElement | null>, enabled = true, key?: unknown): RefObject<Lenis | null> {
  const lenisRef = useRef<Lenis | null>(null);
  useEffect(() => {
    const w = wrapper.current;
    const c = content.current;
    if (!enabled || !w || !c || reducedMotion()) return;
    const lenis = new Lenis({
      wrapper: w,
      content: c,
      autoRaf: false,
      smoothWheel: true,
      syncTouch: false,
      lerp: 0.14,
      wheelMultiplier: 1,
      allowNestedScroll: true,
      overscroll: true,
      prevent: (node) => Boolean(node.closest?.('[data-lenis-prevent], textarea, select, pre, .notif__panel, [role="dialog"]')),
    });
    lenisRef.current = lenis;
    const tick = (time: number) => lenis.raf(time * 1000);
    gsap.ticker.add(tick);
    return () => {
      gsap.ticker.remove(tick);
      lenis.destroy();
      lenisRef.current = null;
    };
  }, [wrapper, content, enabled, key]);
  return lenisRef;
}
