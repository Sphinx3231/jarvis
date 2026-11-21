import { useRef, type RefObject } from 'react';
import type { AgentInfo, CoreState } from '../lib/api';
import { d, gsap, reducedMotion, useGSAP } from './gsap';

/** What happened to an agent between two snapshots of the real agent list. */
export type AgentEvent = 'started' | 'completed' | 'failed';

/**
 * Compare two snapshots of the agents (from the live /api/agents resource) and say what changed.
 * Only real transitions count: a run that started, a run that finished (also one so quick that the
 * "working" state was never observed — its run count still went up), or a new error.
 */
export function agentEvents(prev: Map<string, Pick<AgentInfo, 'state' | 'runs' | 'error'>>, next: AgentInfo[]): Array<{ id: string; event: AgentEvent }> {
  const out: Array<{ id: string; event: AgentEvent }> = [];
  for (const a of next) {
    const p = prev.get(a.id);
    if (!p) continue;
    const wasWorking = p.state === 'working';
    const isWorking = a.state === 'working';
    if (!wasWorking && isWorking) out.push({ id: a.id, event: 'started' });
    else if ((wasWorking && !isWorking) || (!isWorking && a.runs > p.runs)) out.push({ id: a.id, event: a.error && a.error !== p.error ? 'failed' : 'completed' });
    else if (a.error && a.error !== p.error) out.push({ id: a.id, event: 'failed' });
  }
  return out;
}

const OK = '#4ade80';
const BAD = '#f87171';

/**
 * GSAP for the six-agent orbit: the power-on entrance (links draw out of the core, then each agent
 * arrives along its link) and the per-agent event animations. Elements are found by data attributes
 * inside the stage, so React keeps rendering the real state and GSAP only adds motion on top.
 */
export function useOrbitMotion(scope: RefObject<HTMLElement | null>, agents: AgentInfo[], ready: boolean) {
  const prev = useRef<Map<string, Pick<AgentInfo, 'state' | 'runs' | 'error'>> | null>(null);
  const entered = useRef(false);

  // Power-on entrance, once the stage has measured itself and the agents have loaded.
  const loaded = ready && agents.length > 0;
  useGSAP(
    () => {
      const root = scope.current;
      if (!root || !loaded || entered.current) return;
      entered.current = true;
      if (reducedMotion()) return;
      const q = gsap.utils.selector(root);
      const tl = gsap.timeline({ defaults: { ease: 'jarvis.out' } });
      tl.from(q('[data-core-body]'), { scale: 0.82, autoAlpha: 0, duration: 1.1, ease: 'expo.out', clearProps: 'transform,opacity,visibility' }, 0)
        .from(q('.orbit__wire, .orbit__beam'), {
          drawSVG: '0% 0%',
          duration: 0.9,
          stagger: 0.04,
          // DrawSVG leaves a dash pattern sized to today's length; drop it so a resize can't clip a link
          onComplete() {
            for (const el of this.targets() as SVGElement[]) el.style.removeProperty('stroke-dasharray'), el.style.removeProperty('stroke-dashoffset');
          },
        }, 0.25)
        .from(q('.gauge'), { autoAlpha: 0, duration: 0.6, stagger: 0.08, clearProps: 'opacity,visibility' }, 0.45)
        .from(
          q('[data-agent-body]'),
          {
            autoAlpha: 0,
            scale: 0.5,
            // each agent travels outwards along its own link
            x: (_: number, el: Element) => -Number((el as HTMLElement).dataset.dx ?? 0) * 0.45,
            y: (_: number, el: Element) => -Number((el as HTMLElement).dataset.dy ?? 0) * 0.45,
            duration: 0.85,
            stagger: 0.07,
            ease: 'back.out(1.4)',
            clearProps: 'transform,opacity,visibility',
          },
          0.55,
        )
        .from(q('.tele'), { autoAlpha: 0, y: 6, duration: 0.5, stagger: 0.06, clearProps: 'transform,opacity,visibility' }, 0.7);
      // The fixed labels decode into place (the live values next to them are left to React).
      q('.tele__k').forEach((el, i) => {
        tl.to(el, { scrambleText: { text: el.textContent ?? '', chars: '01#<>/', speed: 0.6, revealDelay: 0.2 }, duration: 0.7 }, 0.75 + i * 0.06);
      });
    },
    { scope, dependencies: [loaded] },
  );

  // Real agent events.
  useGSAP(
    () => {
      const root = scope.current;
      const before = prev.current;
      prev.current = new Map(agents.map((a) => [a.id, { state: a.state, runs: a.runs, error: a.error }]));
      if (!root || !before || !ready) return;
      for (const { id, event } of agentEvents(before, agents)) play(root, id, event);
    },
    { scope, dependencies: [agents, ready] },
  );
}

function play(root: HTMLElement, id: string, event: AgentEvent) {
  const body = root.querySelector<HTMLElement>(`[data-agent-body="${id}"]`);
  const burst = root.querySelector<HTMLElement>(`[data-agent-burst="${id}"]`);
  const surge = root.querySelector<SVGLineElement>(`[data-agent-surge="${id}"]`);
  if (!body) return;
  const color = event === 'failed' ? BAD : event === 'completed' ? OK : getComputedStyle(body).getPropertyValue('--c').trim() || '#a78bfa';
  const tl = gsap.timeline({ defaults: { ease: 'jarvis.out' } });
  if (surge) {
    gsap.set(surge, { stroke: color, autoAlpha: 1 });
    if (event === 'started')
      // energy leaves the core and reaches the agent
      tl.fromTo(surge, { drawSVG: '0% 0%' }, { drawSVG: '0% 100%', duration: d(0.45) }, 0).to(surge, { drawSVG: '100% 100%', duration: d(0.35) }, '>');
    else
      // the result travels back to the core
      tl.fromTo(surge, { drawSVG: '100% 100%' }, { drawSVG: '0% 100%', duration: d(0.45) }, 0).to(surge, { drawSVG: '0% 0%', duration: d(0.35) }, '>');
    tl.set(surge, { autoAlpha: 0 });
  }
  if (burst) {
    tl.fromTo(burst, { scale: 0.85, autoAlpha: 0.95, borderColor: color }, { scale: 1.75, autoAlpha: 0, duration: d(0.9), ease: 'expo.out' }, event === 'started' ? 0.4 : 0);
  }
  if (event === 'failed') tl.fromTo(body, { x: -4 }, { x: 0, duration: d(0.5), ease: 'elastic.out(1, 0.25)', clearProps: 'transform' }, 0);
  else tl.fromTo(body, { scale: 1 }, { scale: event === 'started' ? 1.08 : 1.05, duration: d(0.18), yoyo: true, repeat: 1, ease: 'power2.out', clearProps: 'transform' }, event === 'started' ? 0.4 : 0.05);
}

/** Ring colour and motion for each change of Jarvis's real state. */
const CORE_FX: Partial<Record<CoreState, { color: string; kind: 'ripple' | 'converge' | 'wave' | 'burst' | 'alarm' }>> = {
  listening: { color: '#67e8f9', kind: 'ripple' },
  thinking: { color: '#c4b5fd', kind: 'converge' },
  working: { color: '#a78bfa', kind: 'wave' },
  speaking: { color: '#d8b4fe', kind: 'wave' },
  success: { color: '#4ade80', kind: 'burst' },
  error: { color: '#f87171', kind: 'alarm' },
};

/**
 * One short ring effect around the core each time Jarvis's state changes (never on a timer). The
 * core's own rig keeps its continuous per-state motion; this marks the moment of the transition.
 */
export function useCoreTransitions(scope: RefObject<HTMLElement | null>, state: CoreState, ready: boolean) {
  const last = useRef<CoreState | null>(null);
  useGSAP(
    () => {
      const root = scope.current;
      const prevState = last.current;
      last.current = state;
      if (!root || !ready || prevState === null || prevState === state || reducedMotion()) return;
      const fx = CORE_FX[state];
      const rings = gsap.utils.toArray<SVGCircleElement>(root.querySelectorAll('[data-core-ring]'));
      if (!fx || !rings.length) return;
      gsap.killTweensOf(rings);
      gsap.set(rings, { stroke: fx.color, transformOrigin: '50% 50%', autoAlpha: 0 });
      const tl = gsap.timeline();
      switch (fx.kind) {
        case 'ripple': // sound coming in: rings spread gently from the core
          tl.fromTo(rings, { scale: 0.62, autoAlpha: 0.75, strokeWidth: 2 }, { scale: 1.2, autoAlpha: 0, strokeWidth: 0.5, duration: 1.3, stagger: 0.22, ease: 'sine.out' });
          break;
        case 'converge': // gathering in to think
          tl.fromTo(rings, { scale: 1.3, autoAlpha: 0 }, { keyframes: { autoAlpha: [0, 0.6, 0], scale: [1.3, 0.95, 0.66] }, duration: 1.1, stagger: 0.14, ease: 'power2.in' });
          break;
        case 'wave': // output going out
          tl.fromTo(rings, { scale: 0.7, autoAlpha: 0.6, strokeWidth: 1.6 }, { scale: 1.28, autoAlpha: 0, strokeWidth: 0.4, duration: 1, stagger: 0.16, ease: 'jarvis.out' });
          break;
        case 'burst':
          tl.fromTo(rings[0], { scale: 0.75, autoAlpha: 0.9, strokeWidth: 3 }, { scale: 1.35, autoAlpha: 0, strokeWidth: 0.5, duration: 0.9, ease: 'expo.out' })
            .fromTo(rings.slice(1), { scale: 0.8, autoAlpha: 0.5 }, { scale: 1.15, autoAlpha: 0, duration: 0.8, stagger: 0.1, ease: 'expo.out' }, 0.08);
          break;
        case 'alarm':
          tl.fromTo(rings[0], { scale: 0.92, autoAlpha: 0 }, { scale: 1, autoAlpha: 0.85, strokeWidth: 2.4, duration: 0.16, yoyo: true, repeat: 3, ease: 'power1.inOut' })
            .set(rings[0], { autoAlpha: 0 });
          break;
      }
    },
    { scope, dependencies: [state, ready] },
  );
}

/**
 * Tween the number inside an SVG <text> (gauge readouts) from its last value to the new one, keeping
 * any suffix. React writes the real value; GSAP only animates the digits in between.
 */
export function useNumberTween(scope: RefObject<HTMLElement | null>, selector: string, deps: unknown[]) {
  const values = useRef(new Map<Element, number>());
  const tweens = useRef(new Map<Element, gsap.core.Tween>());
  useGSAP(
    () => {
      const root = scope.current;
      if (!root) return;
      root.querySelectorAll<SVGTextElement | HTMLElement>(selector).forEach((el) => {
        // Write to React's own text node so later renders still land.
        const node = el.firstChild;
        if (!node || node.nodeType !== Node.TEXT_NODE) return;
        const text = node.nodeValue ?? '';
        const m = /^(\d+)(.*)$/.exec(text);
        tweens.current.get(el)?.kill();
        if (!m) return void values.current.delete(el);
        const to = Number(m[1]);
        const from = values.current.get(el);
        values.current.set(el, to);
        if (from === undefined || from === to || reducedMotion()) return;
        const o = { v: from };
        tweens.current.set(el, gsap.to(o, { v: to, duration: 0.6, ease: 'power2.out', onUpdate: () => void (node.nodeValue = `${Math.round(o.v)}${m[2]}`), onComplete: () => void (node.nodeValue = text) }));
      });
    },
    { scope, dependencies: deps },
  );
}
