import type { ActivityLog } from '../core/activity.ts';
import type { SettingsStore } from '../core/settings.ts';
import { errorMessage, truncate } from '../core/util.ts';
import type { ConversationStore } from '../intelligence/conversations.ts';
import type { RoamiesEngine } from '../llm/engine.ts';
import type { MemoryStore } from '../memory/store.ts';
import type { ConversationDigester } from './digest.ts';
import type { SkillRegistry } from '../skills/registry.ts';
import type { Task } from '../tasks/store.ts';

/**
 * Memory agent: records task history and keeps memory organised. Runs inside the background
 * scheduler; model calls (conversation summaries) are bounded to a few per run and only when a
 * model is configured and summarisation is enabled.
 */
export class MemoryAgent {
  private memory: MemoryStore;
  private conversations: ConversationStore;
  private llm: RoamiesEngine;
  private settings: SettingsStore;
  private activity: ActivityLog;
  private registry: SkillRegistry;
  private digester: ConversationDigester | null;

  constructor(deps: { memory: MemoryStore; conversations: ConversationStore; llm: RoamiesEngine; settings: SettingsStore; activity: ActivityLog; registry: SkillRegistry; digester?: ConversationDigester }) {
    this.memory = deps.memory;
    this.conversations = deps.conversations;
    this.llm = deps.llm;
    this.settings = deps.settings;
    this.activity = deps.activity;
    this.registry = deps.registry;
    this.digester = deps.digester ?? null;
  }

  /** Record a factual summary of a finished task (it is a system record, so it is verified). */
  recordTask(task: Task): void {
    if (task.origin === 'system') return;
    if (task.plan?.every((s) => s.skill === 'notify.user')) return; // reminders aren't worth remembering
    const steps = (task.plan ?? []).map((s) => s.skill).join(', ');
    const outcome = task.status === 'completed' ? `completed: ${truncate(task.result?.summary ?? '', 300)}` : `${task.status}: ${truncate(task.error ?? '', 200)}`;
    this.memory.add({
      kind: 'task_history',
      content: `Task "${task.title}" (${new Date(task.finishedAt ?? Date.now()).toISOString().slice(0, 10)}) ${outcome}${steps ? ` [skills: ${steps}]` : ''}`,
      source: 'system',
      sourceRef: `task:${task.id}`,
      verified: true,
      confidence: 1,
      tags: ['task', task.status],
    });
  }

  private embedding: Promise<number> | null = null;

  /** Compute embeddings for memories that don't have one for the active model yet. */
  embedPending(signal?: AbortSignal, max = 512): Promise<number> {
    this.embedding ??= (async () => {
      const embedder = this.llm.embeddings();
      if (!embedder) return 0;
      let done = 0;
      while (done < max) {
        const pending = this.memory.missingEmbeddings(32, embedder.model);
        if (!pending.length) break;
        const vectors = await embedder.embed(pending.map((p) => p.content), signal);
        pending.forEach((p, i) => this.memory.setEmbedding(p.id, vectors[i], embedder.model));
        done += pending.length;
      }
      return done;
    })().finally(() => {
      this.embedding = null;
    });
    return this.embedding;
  }

  syncToolDocs(): void {
    this.memory.syncToolDocs(this.registry.docs());
  }

  async maintain(signal?: AbortSignal): Promise<string> {
    const notes: string[] = [];
    const merged = this.memory.dedupe();
    if (merged) notes.push(`merged ${merged} duplicate memories`);

    this.syncToolDocs();

    const s = this.settings.get();
    if (this.digester) {
      try {
        const digested = await this.digester.catchUp(signal);
        if (digested) notes.push(`digested ${digested} conversation part(s)`);
      } catch (err) {
        notes.push(`digest failed: ${errorMessage(err)}`);
      }
    }
    // Conversations are kept forever unless a retention period is set; even then each one is
    // digested (and its vault note kept) before it goes.
    if (s.memory.conversationRetentionDays > 0) {
      const cutoff = Date.now() - s.memory.conversationRetentionDays * 86_400_000;
      await this.digester?.digestBefore(cutoff);
      const pruned = this.conversations.pruneOlderThan(cutoff);
      if (pruned) notes.push(`removed ${pruned} expired conversation(s) (their digests and vault notes are kept)`);
    }

    try {
      const embedded = await this.embedPending(signal);
      if (embedded) notes.push(`embedded ${embedded} memories`);
    } catch (err) {
      notes.push(`embedding failed: ${errorMessage(err)}`);
    }

    if (s.memory.summarizeConversations && this.llm.available()) {
      const threshold = s.memory.contextMessages;
      for (const conv of this.conversations.needingSummary(threshold).slice(0, 2)) {
        const msgs = this.conversations.messages(conv.id, { limit: 400 });
        const older = msgs.slice(0, Math.max(0, msgs.length - threshold));
        if (older.length < 4) continue;
        try {
          const transcript = older.map((m) => `${m.role === 'user' ? 'User' : 'Jarvis'}: ${truncate(m.content, 1500)}`).join('\n');
          const res = await this.llm.generate({
            system: 'You summarise conversations between a user and their assistant Jarvis. Keep facts, decisions, open requests and preferences. Do not add anything that was not said. Be concise (under 200 words).',
            prompt: `${conv.summary ? `Previous summary:\n${conv.summary}\n\n` : ''}Conversation:\n${transcript}`,
            maxTokens: 1500,
            signal,
          });
          if (res.text.trim()) {
            this.conversations.setSummary(conv.id, res.text.trim(), older[older.length - 1].createdAt);
            notes.push(`summarised conversation "${conv.title}"`);
          }
        } catch (err) {
          notes.push(`summary failed: ${errorMessage(err)}`);
          break;
        }
      }
    }
    const message = notes.length ? notes.join('; ') : 'memory is organised; nothing to do';
    if (notes.length) this.activity.log('info', 'memory', `Maintenance: ${message}`);
    return message;
  }
}
