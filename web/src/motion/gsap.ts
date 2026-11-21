/**
 * Jarvis's animation engine: GSAP, registered once. Every animated thing in the UI goes through here,
 * so plugins, easing and the reduced-motion rule are the same everywhere.
 *
 * Reduced motion = the OS setting OR Jarvis's own "Reduce motion" (Settings → Appearance), which the
 * app mirrors to <html data-reduce-motion>. Under it, animations jump straight to their end state.
 */
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import { CustomEase } from 'gsap/CustomEase';
import { DrawSVGPlugin } from 'gsap/DrawSVGPlugin';
import { ScrambleTextPlugin } from 'gsap/ScrambleTextPlugin';

gsap.registerPlugin(useGSAP, CustomEase, DrawSVGPlugin, ScrambleTextPlugin);

/** A quick, decisive deceleration — the house curve for UI entering and settling. */
CustomEase.create('jarvis.out', 'M0,0 C0.12,0.82 0.2,1 1,1');
/** A soft in-out for ambient, breathing motion. */
CustomEase.create('jarvis.breathe', 'M0,0 C0.45,0 0.55,1 1,1');
gsap.defaults({ ease: 'jarvis.out', duration: 0.6 });

export function reducedMotion(): boolean {
  if (typeof document === 'undefined') return false;
  if (document.documentElement.dataset.reduceMotion === 'true') return true;
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Duration helper: 0 under reduced motion, so tweens land instantly but still apply their end state. */
export const d = (seconds: number) => (reducedMotion() ? 0 : seconds);

export { gsap, useGSAP };
