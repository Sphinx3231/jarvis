import type { EventBus } from './events.ts';

/**
 * Server-side assistant state, derived only from real activity:
 *   thinking — a request is being processed by the intelligence layer
 *   working  — at least one task is executing
 *   success  — a task just completed (brief)
 *   error    — a task or request just failed (brief)
 *   idle     — nothing is happening
 * The UI overlays "listening" and "speaking", which happen in the browser.
 */
export type AssistantState = 'idle' | 'thinking' | 'working' | 'success' | 'error';

export interface StateSnapshot {
  state: AssistantState;
  detail: string;
  since: number;
}

const FLASH_MS = { success: 4000, error: 6000 };

export class StateTracker {
  private bus: EventBus;
  private runningTasks: () => number;
  private thinking = 0;
  private flash: { state: 'success' | 'error'; detail: string; until: number } | null = null;
  private current: StateSnapshot = { state: 'idle', detail: 'Ready', since: Date.now() };
  private timer: NodeJS.Timeout | null = null;

  constructor(bus: EventBus, runningTasks: () => number) {
    this.bus = bus;
    this.runningTasks = runningTasks;
    bus.on('task.updated', (e) => {
      const status = e.data.status;
      if (status === 'completed') this.setFlash('success', 'Task completed');
      else if (status === 'failed') this.setFlash('error', 'A task failed');
      else this.recompute();
    });
  }

  beginThinking(): () => void {
    this.thinking++;
    this.recompute();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.thinking--;
      this.recompute();
    };
  }

  setFlash(state: 'success' | 'error', detail: string): void {
    this.flash = { state, detail, until: Date.now() + FLASH_MS[state] };
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.recompute(), FLASH_MS[state] + 10);
    this.timer.unref?.();
    this.recompute();
  }

  recompute(): void {
    const running = this.runningTasks();
    let next: Omit<StateSnapshot, 'since'>;
    if (this.thinking > 0) next = { state: 'thinking', detail: 'Thinking about your request' };
    else if (this.flash && this.flash.until > Date.now()) next = { state: this.flash.state, detail: this.flash.detail };
    else if (running > 0) next = { state: 'working', detail: `Working on ${running} task${running === 1 ? '' : 's'}` };
    else next = { state: 'idle', detail: 'Ready' };
    if (next.state !== this.current.state || next.detail !== this.current.detail) {
      this.current = { ...next, since: Date.now() };
      this.bus.emit('assistant.state', { ...this.current });
    }
  }

  get(): StateSnapshot {
    this.recompute();
    return this.current;
  }
}
