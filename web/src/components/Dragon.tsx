import { Check, X } from 'lucide-react';
import type { DragonState } from '../lib/api';

export const DRAGON_LABEL: Record<DragonState, string> = {
  idle: 'Idle',
  thinking: 'Thinking',
  listening: 'Listening',
  speaking: 'Speaking',
  working: 'Working',
  success: 'Done',
  error: 'Needs attention',
};

/**
 * Jarvis's 2D identity: the official dragon artwork with lightweight CSS animations.
 * Every state is driven by real application state — nothing animates for show.
 */
export function Dragon({ state, size = 220, reduceMotion = false }: { state: DragonState; size?: number; reduceMotion?: boolean }) {
  return (
    <div className={`dragon dragon--${state} ${reduceMotion ? 'dragon--still' : ''}`} style={{ ['--size' as string]: `${size}px` }} role="img" aria-label={`Jarvis is ${DRAGON_LABEL[state].toLowerCase()}`}>
      <svg className="dragon__ring" viewBox="0 0 100 100" aria-hidden>
        <circle className="dragon__ring-track" cx="50" cy="50" r="48" />
        <circle className="dragon__ring-arc" cx="50" cy="50" r="48" pathLength="100" />
      </svg>
      <div className="dragon__ripples" aria-hidden>
        <span />
        <span />
        <span />
      </div>
      <div className="dragon__frame">
        <img src="/dragon-1024.webp" alt="" draggable={false} />
        <div className="dragon__eye" aria-hidden />
      </div>
      <div className="dragon__bars" aria-hidden>
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>
      <div className="dragon__badge" aria-hidden>
        {state === 'success' ? <Check size={16} strokeWidth={3} /> : state === 'error' ? <X size={16} strokeWidth={3} /> : null}
      </div>
    </div>
  );
}
