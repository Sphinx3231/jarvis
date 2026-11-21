import type { RefObject } from 'react';
import { gsap, reducedMotion, useGSAP } from './gsap';

/**
 * The command bar's motion, all tied to what the user is doing or what Jarvis is doing:
 * a light sweep when the box takes focus, a pulse when a message is sent, a halo on the
 * microphone while it is really listening, and an indeterminate scan while Jarvis is answering
 * (indeterminate on purpose: the chat call reports no progress, so none is invented).
 */
export function useCommandMotion(scope: RefObject<HTMLElement | null>, { sending, listening }: { sending: boolean; listening: boolean }) {
  const { contextSafe } = useGSAP({ scope });

  const focusSweep = contextSafe(() => {
    if (reducedMotion()) return;
    const sweep = scope.current?.querySelector('.command__sweep');
    if (sweep) gsap.fromTo(sweep, { xPercent: -120, autoAlpha: 1 }, { xPercent: 220, duration: 0.9, ease: 'power2.inOut', onComplete: () => void gsap.set(sweep, { autoAlpha: 0 }) });
  });

  const submitPulse = contextSafe(() => {
    if (reducedMotion()) return;
    const bar = scope.current?.querySelector('.command__bar, .command__voice');
    const send = scope.current?.querySelector('.command__send svg');
    if (bar) gsap.fromTo(bar, { boxShadow: '0 0 0 0 rgba(167,139,250,0.55), 0 0 46px -4px rgba(124,58,237,0.8)' }, { boxShadow: '0 0 0 14px rgba(167,139,250,0), 0 0 46px -4px rgba(124,58,237,0.8)', duration: 0.7, ease: 'expo.out', clearProps: 'boxShadow' });
    if (send) gsap.timeline().to(send, { x: 14, autoAlpha: 0, duration: 0.18, ease: 'power2.in' }).fromTo(send, { x: -12, autoAlpha: 0 }, { x: 0, autoAlpha: 1, duration: 0.32, ease: 'jarvis.out', clearProps: 'transform,opacity,visibility' });
  });

  // Processing: an indeterminate scan along the bar while the reply is on its way.
  useGSAP(
    () => {
      const proc = scope.current?.querySelector('.command__proc');
      if (!proc) return;
      if (!sending || reducedMotion()) return void gsap.set(proc, { autoAlpha: sending ? 0.8 : 0, xPercent: 0, scaleX: 1 });
      gsap.set(proc, { autoAlpha: 1 });
      gsap.fromTo(proc, { xPercent: -100 }, { xPercent: 400, duration: 1.4, ease: 'sine.inOut', repeat: -1 });
    },
    { scope, dependencies: [sending], revertOnUpdate: true },
  );

  // Listening: the microphone breathes with two expanding halos for as long as it listens.
  useGSAP(
    () => {
      const halos = scope.current?.querySelectorAll('.command__halo');
      if (!halos?.length || !listening || reducedMotion()) return;
      gsap.fromTo(halos, { scale: 1, autoAlpha: 0.7 }, { scale: 1.9, autoAlpha: 0, duration: 1.5, stagger: 0.75, repeat: -1, ease: 'sine.out' });
    },
    { scope, dependencies: [listening], revertOnUpdate: true },
  );

  return { focusSweep, submitPulse };
}
