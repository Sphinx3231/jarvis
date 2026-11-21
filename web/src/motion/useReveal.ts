import { type RefObject } from 'react';
import { gsap, reducedMotion, useGSAP } from './gsap';

/**
 * Coordinated entrance for a screen: every `[data-reveal]` element inside [scope] slides up out of a
 * clip, in document order, with a short stagger — the HUD "powering on". Runs again whenever
 * [key] changes (e.g. the page). Transforms and clips are cleared afterwards, so nothing is left
 * that could affect layout, fixed children or text rendering.
 */
export function useReveal(scope: RefObject<HTMLElement | null>, key: unknown, opts: { selector?: string; stagger?: number; y?: number } = {}) {
  useGSAP(
    () => {
      const root = scope.current;
      if (!root) return;
      const items = gsap.utils.toArray<HTMLElement>(opts.selector ?? '[data-reveal]', root);
      if (!items.length || reducedMotion()) return;
      gsap.fromTo(
        items,
        { autoAlpha: 0, y: opts.y ?? 14, clipPath: 'inset(0% 0% 100% 0%)' },
        {
          autoAlpha: 1,
          y: 0,
          clipPath: 'inset(0% 0% 0% 0%)',
          duration: 0.7,
          // long screens finish within ~0.8 s however many panels they have
          stagger: { each: Math.min(opts.stagger ?? 0.055, 0.8 / items.length), from: 'start' },
          ease: 'jarvis.out',
          clearProps: 'transform,clipPath,opacity,visibility',
        },
      );
    },
    { scope, dependencies: [key], revertOnUpdate: true },
  );
}
