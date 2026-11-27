import { EventEmitter } from 'node:events';

/** Every event broadcast inside Jarvis (and forwarded to the UI over SSE). */
export type JarvisEventType =
  | 'task.updated'
  | 'task.event'
  | 'approval.updated'
  | 'memory.changed'
  | 'activity'
  | 'notification'
  | 'assistant.state'
  | 'conversation.updated'
  | 'settings.changed'
  | 'roamies.changed'
  | 'integrations.changed'
  | 'pipeline.updated'
  | 'agents.changed'
  | 'computer.changed'
  | 'job.ran'
  /** What the agent harness (Hermes) is doing for a task right now: thinking, using a tool, waiting. */
  | 'harness.activity';

export interface JarvisEvent {
  type: JarvisEventType;
  ts: number;
  data: Record<string, unknown>;
}

export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit(type: JarvisEventType, data: Record<string, unknown> = {}): void {
    const event: JarvisEvent = { type, ts: Date.now(), data };
    this.emitter.emit(type, event);
    this.emitter.emit('*', event);
  }

  on(type: JarvisEventType | '*', listener: (event: JarvisEvent) => void): () => void {
    this.emitter.on(type, listener);
    return () => this.emitter.off(type, listener);
  }
}
