import { existsSync, mkdirSync, statSync } from 'node:fs';
import { cpus, freemem, loadavg, platform, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { ActivityLog } from './core/activity.ts';
import { EventBus } from './core/events.ts';
import { SecretStore } from './core/secrets.ts';
import { SettingsStore } from './core/settings.ts';
import { StateTracker } from './core/state.ts';
import { Database } from './db/database.ts';
import { MemoryAgent } from './agents/memory-agent.ts';
import { AGENTS } from './agents/agents.ts';
import { Planner } from './agents/planner.ts';
import { McpManager } from './integrations/mcp.ts';
import { CalendarService, calendarSkills } from './integrations/calendar.ts';
import { EmailService, emailSkills } from './integrations/email.ts';
import { ConversationStore } from './intelligence/conversations.ts';
import { Jarvis } from './intelligence/jarvis.ts';
import { LocalModelManager } from './llm/local-embeddings.ts';
import { LlmRouter } from './llm/router.ts';
import { MemoryStore } from './memory/store.ts';
import { PermissionEngine } from './permissions/engine.ts';
import { Scheduler } from './scheduler/scheduler.ts';
import { registerBuiltinSkills } from './skills/builtin/index.ts';
import { SkillRegistry } from './skills/registry.ts';
import { SkillRunner } from './skills/runner.ts';
import type { SkillServices } from './skills/types.ts';
import { TaskEngine } from './tasks/engine.ts';
import { TaskStore, type TaskStatus } from './tasks/store.ts';

export const VERSION = '1.0.0';

export interface AppOptions {
  dataDir: string;
  quiet?: boolean;
}

export interface Insight {
  id: string;
  level: 'info' | 'warning' | 'error';
  text: string;
  page: 'tasks' | 'memory' | 'integrations' | 'settings' | 'activity';
}

/** Composition root: builds every Jarvis service and connects them. */
export class JarvisApp {
  readonly dataDir: string;
  readonly startedAt = Date.now();
  readonly db: Database;
  readonly bus = new EventBus();
  readonly activity: ActivityLog;
  readonly settings: SettingsStore;
  readonly secrets: SecretStore;
  readonly llm: LlmRouter;
  readonly localModel: LocalModelManager;
  readonly memory: MemoryStore;
  readonly conversations: ConversationStore;
  readonly tasks: TaskStore;
  readonly registry: SkillRegistry;
  readonly permissions: PermissionEngine;
  readonly runner: SkillRunner;
  readonly planner: Planner;
  readonly engine: TaskEngine;
  readonly memoryAgent: MemoryAgent;
  readonly state: StateTracker;
  readonly mcp: McpManager;
  readonly email: EmailService;
  readonly calendar: CalendarService;
  readonly scheduler: Scheduler;
  readonly jarvis: Jarvis;
  private running = false;

  constructor(opts: AppOptions) {
    this.dataDir = resolve(opts.dataDir);
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.db = new Database(join(this.dataDir, 'jarvis.db'));
    this.activity = new ActivityLog(this.db, this.bus, { quiet: opts.quiet });
    this.settings = new SettingsStore(this.db, this.bus);
    this.secrets = new SecretStore(this.db, join(this.dataDir, 'master.key'));
    this.localModel = new LocalModelManager(process.env.JARVIS_MODEL_DIR ?? join(this.dataDir, 'models', 'all-MiniLM-L6-v2'));
    this.llm = new LlmRouter(this.settings, this.secrets, this.activity, this.localModel);
    this.memory = new MemoryStore(this.db, this.bus);
    this.conversations = new ConversationStore(this.db, this.bus);
    this.tasks = new TaskStore(this.db, this.bus);
    this.permissions = new PermissionEngine(this.db, this.settings, this.bus, this.activity);

    const services: SkillServices = {
      memory: this.memory,
      settings: this.settings,
      activity: this.activity,
      llm: this.llm,
      workspaceDir: () => this.workspaceDir(),
      listTasks: (status) =>
        this.tasks.list({ status: status as TaskStatus | 'active' | undefined, limit: 50 }).map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, progress: t.progress })),
      statusSnapshot: () => this.statusSnapshot(),
    };
    this.registry = new SkillRegistry(services);
    registerBuiltinSkills(this.registry);
    this.email = new EmailService(this.settings, this.secrets);
    this.calendar = new CalendarService(this.settings, this.secrets);
    for (const skill of [...emailSkills(this.email), ...calendarSkills(this.calendar)]) this.registry.register(skill);
    this.runner = new SkillRunner({
      db: this.db,
      registry: this.registry,
      permissions: this.permissions,
      services,
      activity: this.activity,
      defaultTimeoutMs: () => this.settings.get().tasks.stepTimeoutSec * 1000,
    });
    this.planner = new Planner(this.registry, this.llm, this.permissions, this.activity);
    this.memoryAgent = new MemoryAgent({ memory: this.memory, conversations: this.conversations, llm: this.llm, settings: this.settings, activity: this.activity, registry: this.registry });
    this.engine = new TaskEngine({
      store: this.tasks,
      runner: this.runner,
      registry: this.registry,
      permissions: this.permissions,
      planner: this.planner,
      activity: this.activity,
      bus: this.bus,
      settings: this.settings,
      onCompleted: (task) => this.memoryAgent.recordTask(task),
    });
    this.state = new StateTracker(this.bus, () => this.engine.runningCount);
    this.mcp = new McpManager({ settings: this.settings, secrets: this.secrets, registry: this.registry, activity: this.activity, bus: this.bus, permissions: this.permissions });
    this.jarvis = new Jarvis({
      conversations: this.conversations,
      memory: this.memory,
      llm: this.llm,
      registry: this.registry,
      runner: this.runner,
      permissions: this.permissions,
      engine: this.engine,
      tasks: this.tasks,
      planner: this.planner,
      settings: this.settings,
      activity: this.activity,
      state: this.state,
      statusSnapshot: () => this.statusSnapshot(),
    });

    this.scheduler = new Scheduler(this.db, this.settings, this.activity, this.bus);
    this.scheduler.register({
      name: 'task-monitor',
      title: 'Task monitor',
      description: 'Checks task progress, recovers stalled tasks, dispatches due work and reminds you about pending approvals.',
      intervalMs: () => this.settings.get().background.monitorIntervalSec * 1000,
      run: () => this.engine.monitor().message,
    });
    this.scheduler.register({
      name: 'memory-maintenance',
      title: 'Memory maintenance',
      description: 'Merges duplicate memories, refreshes tool documentation, computes embeddings (if enabled), summarises long conversations and prunes expired ones.',
      intervalMs: () => this.settings.get().background.maintenanceIntervalMin * 60_000,
      run: (signal) => this.memoryAgent.maintain(signal),
    });
    this.scheduler.register({
      name: 'health-check',
      title: 'Health check',
      description: 'Checks model providers are reachable (no model inference) and reconnects MCP servers that stopped.',
      intervalMs: () => this.settings.get().background.healthIntervalMin * 60_000,
      run: async () => {
        await this.llm.checkHealth();
        const mcp = await this.mcp.health();
        const accounts: string[] = [];
        if (!this.email.missing()) accounts.push(`email ${(await this.email.test()).ok ? 'ok' : 'failing'}`);
        if (!this.calendar.readMissing()) accounts.push(`calendar ${(await this.calendar.test()).ok ? 'ok' : 'failing'}`);
        const providers = this.llm.status().filter((p) => p.usable);
        return `${providers.filter((p) => p.health?.ok).length}/${providers.length} model provider(s) reachable; ${mcp}${accounts.length ? `; ${accounts.join(', ')}` : ''}`;
      },
    });

    this.registry.onChange(() => this.bus.emit('integrations.changed', {}));
    this.bus.on('settings.changed', () => {
      this.ensureWorkspace();
      if (this.running) {
        void this.mcp.sync();
        this.prepareSemanticSearch();
      }
    });

    this.localModel.onChange = (state) => {
      if (state === 'downloading') this.activity.log('info', 'memory', 'Downloading the built-in semantic search model (23 MB, one time)…');
      if (state === 'ready') {
        this.activity.log('success', 'memory', 'Semantic memory search is ready (runs on this computer)');
        void this.memoryAgent.embedPending().catch(() => {});
      }
      if (state === 'error') this.activity.log('error', 'memory', `Could not set up semantic search: ${this.localModel.error}. Keyword search still works.`);
      this.bus.emit('integrations.changed', {});
    };
    // New or edited memories get their embedding within seconds rather than at the next maintenance run.
    let embedTimer: NodeJS.Timeout | null = null;
    this.bus.on('memory.changed', () => {
      if (!this.running || !this.llm.embeddings()) return;
      if (embedTimer) clearTimeout(embedTimer);
      embedTimer = setTimeout(() => void this.memoryAgent.embedPending().catch(() => {}), 1500);
      embedTimer.unref?.();
    });
  }

  /** Download the built-in model when it is the selected embedding provider. */
  private prepareSemanticSearch(): void {
    const e = this.settings.get().embeddings;
    if (e.enabled && e.providerId === 'builtin' && this.localModel.state === 'not_downloaded') void this.localModel.ensure().catch(() => {});
  }

  workspaceDir(): string {
    const configured = this.settings.get().integrations.workspaceDir.trim();
    return configured ? resolve(configured) : join(this.dataDir, 'workspace');
  }

  private ensureWorkspace(): void {
    const dir = this.workspaceDir();
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch (err) {
        this.activity.log('error', 'files', `Cannot create workspace ${dir}: ${(err as Error).message}`);
      }
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.ensureWorkspace();
    this.memoryAgent.syncToolDocs();
    this.engine.start();
    this.scheduler.start();
    this.activity.log('info', 'system', `Jarvis ${VERSION} started`);
    void this.mcp.sync();
    void this.llm.checkHealth();
    this.prepareSemanticSearch();
    void this.memoryAgent.embedPending().catch(() => {});
  }

  async stop(): Promise<void> {
    if (!this.running) {
      this.db.close();
      return;
    }
    this.running = false;
    this.scheduler.stop();
    await this.engine.stop();
    this.mcp.stopAll();
    this.activity.log('info', 'system', 'Jarvis stopped');
    this.db.close();
  }

  statusSnapshot(): Record<string, unknown> & {
    uptimeSec: number;
    tasks: Record<TaskStatus, number>;
    approvalsPending: number;
    memory: ReturnType<MemoryStore['stats']>;
    model: { provider: string; model: string; healthy: boolean | null } | null;
    background: { enabled: boolean };
  } {
    const active = this.llm.activeProvider();
    const providerStatus = active ? this.llm.status().find((p) => p.id === active.id) : undefined;
    const skills = this.registry.info();
    let dbSizeBytes = 0;
    try {
      dbSizeBytes = statSync(this.db.path).size;
    } catch {
      /* in-memory */
    }
    const mem = process.memoryUsage();
    return {
      version: VERSION,
      startedAt: this.startedAt,
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      process: { pid: process.pid, rssBytes: mem.rss, heapUsedBytes: mem.heapUsed },
      host: { platform: platform(), cpus: cpus().length, totalMemBytes: totalmem(), freeMemBytes: freemem(), loadAvg: loadavg()[0] },
      tasks: this.tasks.counts(),
      runningNow: this.engine.runningCount,
      approvalsPending: this.permissions.listApprovals('pending', 500).length,
      memory: this.memory.stats(),
      model: active ? { provider: providerStatus?.name ?? active.id, model: active.model, healthy: providerStatus?.health ? providerStatus.health.ok : null } : null,
      skills: { total: skills.length, available: skills.filter((s) => s.available).length },
      background: { enabled: this.settings.get().background.enabled },
      dbSizeBytes,
      agents: Object.values(AGENTS).map((a) => ({ name: a.name, title: a.title })),
    };
  }

  /** Internal recommendations — computed from real state, no model calls. */
  insights(): Insight[] {
    const out: Insight[] = [];
    if (!this.llm.available()) out.push({ id: 'no-model', level: 'warning', text: 'No language model is configured — Jarvis can only handle direct commands.', page: 'integrations' });
    const approvals = this.permissions.listApprovals('pending', 500).length;
    if (approvals) out.push({ id: 'approvals', level: 'warning', text: `${approvals} action${approvals === 1 ? ' is' : 's are'} waiting for your approval.`, page: 'tasks' });
    const attention = this.tasks.list({ status: 'paused', limit: 200 }).filter((t) => t.attention).length;
    if (attention) out.push({ id: 'attention', level: 'warning', text: `${attention} paused task${attention === 1 ? ' needs' : 's need'} your review.`, page: 'tasks' });
    const dayAgo = Date.now() - 86_400_000;
    const failed = this.tasks.list({ status: 'failed', limit: 200 }).filter((t) => (t.finishedAt ?? 0) > dayAgo).length;
    if (failed) out.push({ id: 'failed', level: 'error', text: `${failed} task${failed === 1 ? '' : 's'} failed in the last 24 hours.`, page: 'tasks' });
    const unverified = this.memory.stats().unverified;
    if (unverified) out.push({ id: 'unverified', level: 'info', text: `${unverified} memor${unverified === 1 ? 'y is' : 'ies are'} unverified — confirm or correct ${unverified === 1 ? 'it' : 'them'}.`, page: 'memory' });
    for (const p of this.llm.status()) {
      if (p.usable && p.health && !p.health.ok) out.push({ id: `provider-${p.id}`, level: 'error', text: `${p.name} is unreachable: ${p.health.detail}`, page: 'integrations' });
    }
    if (this.email.lastCheck && !this.email.lastCheck.ok && !this.email.missing()) out.push({ id: 'email', level: 'error', text: `Email is not working: ${this.email.lastCheck.detail}`, page: 'integrations' });
    if (this.calendar.lastCheck && !this.calendar.lastCheck.ok && !this.calendar.readMissing()) out.push({ id: 'calendar', level: 'error', text: `Calendar is not working: ${this.calendar.lastCheck.detail}`, page: 'integrations' });
    for (const s of this.mcp.status()) {
      if (s.state === 'error') out.push({ id: `mcp-${s.id}`, level: 'error', text: `MCP server "${s.name}" is not connected: ${s.error ?? 'error'}`, page: 'integrations' });
    }
    if (!this.settings.get().background.enabled) out.push({ id: 'background-off', level: 'info', text: 'Background monitoring is paused.', page: 'settings' });
    return out;
  }
}
