import { accessSync, constants, existsSync } from 'node:fs';
import { z } from 'zod';
import type { JarvisApp } from '../app.ts';
import { AGENTS } from '../agents/agents.ts';
import { DraftStepSchema } from '../agents/planner.ts';
import { McpServerSchema } from '../core/settings.ts';
import { UserError } from '../core/util.ts';
import { providerSecretName } from '../llm/router.ts';
import { MEMORY_KINDS } from '../memory/store.ts';
import { TASK_STATUSES } from '../tasks/store.ts';
import { parse, type Router } from './http.ts';

const ChatBody = z.object({
  conversationId: z.string().max(64).nullable().optional(),
  message: z.string().min(1).max(20_000),
  via: z.enum(['text', 'voice']).optional(),
});

const RecurrenceSchema = z.object({ everyMinutes: z.number().int().min(1).max(525_600).optional(), dailyAt: z.string().regex(/^\d{2}:\d{2}$/).optional() });

const TaskBody = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  priority: z.number().int().min(1).max(4).optional(),
  steps: z.array(DraftStepSchema).max(20).optional(),
  scheduledFor: z.number().int().positive().nullable().optional(),
  delayMinutes: z.number().min(0).max(525_600).optional(),
  recurrence: RecurrenceSchema.nullable().optional(),
});

const MemoryBody = z.object({
  content: z.string().min(1).max(4000),
  kind: z.enum(MEMORY_KINDS),
  tags: z.array(z.string().max(30)).max(12).optional(),
});

const MemoryPatch = z.object({
  content: z.string().min(1).max(4000).optional(),
  kind: z.enum(MEMORY_KINDS).optional(),
  tags: z.array(z.string().max(30)).max(12).optional(),
  verified: z.boolean().optional(),
});

const DecisionBody = z.object({
  remember: z.boolean().optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
  note: z.string().max(500).optional(),
});

const SecretsBody = z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().max(4000));

export function registerRoutes(router: Router, app: JarvisApp): void {
  // ------------------------------------------------------------------ status
  router.get('/api/status', () => ({
    status: app.statusSnapshot(),
    state: app.state.get(),
    insights: app.insights(),
    unreadNotifications: app.activity.unreadCount(),
  }));
  router.get('/api/agents', () => ({
    agents: Object.values(AGENTS).map((a) => ({ name: a.name, title: a.title, responsibility: a.responsibility })),
    active: app.tasks.list({ status: 'running', limit: 50 }).map((t) => ({ taskId: t.id, title: t.title, agent: t.agent })),
  }));

  // ------------------------------------------------------------------ chat
  router.post('/api/chat', async ({ body }) => {
    const b = parse(ChatBody, body);
    return app.jarvis.handleMessage({ conversationId: b.conversationId, text: b.message, via: b.via });
  });
  router.get('/api/conversations', () => ({ conversations: app.conversations.list(50) }));
  router.get('/api/conversations/:id/messages', ({ params }) => {
    if (!app.conversations.get(params.id)) throw new UserError('Conversation not found', 404);
    return { messages: app.conversations.messages(params.id, { limit: 200 }) };
  });
  router.delete('/api/conversations/:id', ({ params }) => {
    app.conversations.delete(params.id);
    return { ok: true };
  });

  // ------------------------------------------------------------------ tasks
  router.get('/api/tasks', ({ query }) => {
    const status = query.get('status') ?? undefined;
    if (status && status !== 'active' && !TASK_STATUSES.includes(status as never)) throw new UserError('Unknown status');
    return { tasks: app.tasks.list({ status: status as never, limit: Number(query.get('limit') ?? 200) }), counts: app.tasks.counts() };
  });
  router.post('/api/tasks', ({ body }) => {
    const b = parse(TaskBody, body);
    const scheduledFor = b.scheduledFor ?? (b.delayMinutes ? Date.now() + b.delayMinutes * 60_000 : null);
    return app.engine.createTask({ title: b.title, description: b.description, priority: b.priority, origin: 'user', steps: b.steps ?? null, scheduledFor, recurrence: b.recurrence ?? null });
  });
  router.get('/api/tasks/:id', ({ params }) => {
    const task = app.tasks.require(params.id);
    return { task, events: app.tasks.events(task.id), approvals: app.permissions.listApprovals(undefined, 500).filter((a) => a.taskId === task.id) };
  });
  router.post('/api/tasks/:id/pause', ({ params }) => ({ task: app.engine.pause(params.id) }));
  router.post('/api/tasks/:id/resume', ({ params, body }) => {
    const b = parse(z.object({ uncertain: z.enum(['retry', 'skip']).optional() }), body);
    return { task: app.engine.resume(params.id, b) };
  });
  router.post('/api/tasks/:id/cancel', ({ params }) => ({ task: app.engine.cancel(params.id) }));
  router.post('/api/tasks/:id/retry', ({ params }) => ({ task: app.engine.retry(params.id) }));
  router.delete('/api/tasks/:id', ({ params }) => {
    const t = app.tasks.require(params.id);
    if (['running', 'queued', 'awaiting_approval'].includes(t.status)) throw new UserError('Cancel the task before deleting it', 409);
    app.tasks.delete(t.id);
    return { ok: true };
  });

  // ------------------------------------------------------------------ approvals & permissions
  router.get('/api/approvals', ({ query }) => {
    const status = (query.get('status') ?? 'pending') as never;
    const approvals = app.permissions.listApprovals(status, 200).map((a) => ({ ...a, taskTitle: app.tasks.get(a.taskId)?.title ?? '(deleted task)' }));
    return { approvals };
  });
  router.post('/api/approvals/:id/approve', ({ params, body }) => ({ approval: app.permissions.decideApproval(params.id, 'approve', parse(DecisionBody, body)) }));
  router.post('/api/approvals/:id/deny', ({ params, body }) => ({ approval: app.permissions.decideApproval(params.id, 'deny', parse(DecisionBody, body)) }));
  router.get('/api/permissions', () => ({ scopes: app.permissions.scopes(), grants: app.permissions.listGrants() }));
  router.delete('/api/grants/:id', ({ params }) => {
    app.permissions.revokeGrant(params.id);
    return { ok: true };
  });

  // ------------------------------------------------------------------ memory
  router.get('/api/memory', ({ query }) => {
    const q = query.get('q')?.trim();
    const kind = query.get('kind') as (typeof MEMORY_KINDS)[number] | null;
    if (kind && !MEMORY_KINDS.includes(kind)) throw new UserError('Unknown memory kind');
    const verifiedParam = query.get('verified');
    const verified = verifiedParam === null ? undefined : verifiedParam === 'true';
    // Tool documentation is generated from the skill registry; it has its own filter.
    const excludeKinds = kind ? [] : (['tool_doc'] as const).slice();
    const memories = q
      ? app.memory.keywordSearch(q, { kind: kind ?? undefined, limit: 100, excludeKinds }).filter((m) => verified === undefined || m.verified === verified)
      : app.memory.list({ kind: kind ?? undefined, verified, excludeKinds, limit: Number(query.get('limit') ?? 200) });
    return { memories, stats: app.memory.stats() };
  });
  router.post('/api/memory', ({ body }) => {
    const b = parse(MemoryBody, body);
    return app.memory.add({ ...b, source: 'user', verified: true, confidence: 1 });
  });
  router.patch('/api/memory/:id', ({ params, body }) => ({ memory: app.memory.update(params.id, parse(MemoryPatch, body)) }));
  router.delete('/api/memory/:id', ({ params }) => {
    if (!app.memory.delete(params.id)) throw new UserError('Memory not found', 404);
    return { ok: true };
  });

  // ------------------------------------------------------------------ skills
  router.get('/api/skills', () => ({
    skills: app.registry.info().map((s) => ({ ...s, policy: app.permissions.policyFor(s.scope), scopeLabel: app.permissions.scopeDefinition(s.scope).label })),
  }));

  // ------------------------------------------------------------------ integrations
  router.get('/api/integrations', () => {
    const dir = app.workspaceDir();
    let writable = false;
    try {
      accessSync(dir, constants.W_OK);
      writable = true;
    } catch {
      writable = false;
    }
    const s = app.settings.get();
    const embedder = app.llm.embeddings();
    return {
      providers: app.llm.status(),
      embeddings: { ...s.embeddings, active: Boolean(embedder), memoriesEmbedded: app.memory.stats().embedded },
      mcp: app.mcp.status(),
      workspace: { path: dir, exists: existsSync(dir), writable, readPolicy: app.permissions.policyFor('files.read'), writePolicy: app.permissions.policyFor('files.write') },
      web: { policy: app.permissions.policyFor('network.read'), allowPrivateNetwork: s.integrations.web.allowPrivateNetwork },
      shell: { enabled: s.integrations.shell.enabled, policy: app.permissions.policyFor('shell.exec') },
    };
  });
  router.put('/api/integrations/providers/:id/key', ({ params, body }) => {
    const b = parse(z.object({ apiKey: z.string().min(8).max(500) }), body);
    if (!app.settings.get().llm.providers.some((p) => p.id === params.id)) throw new UserError('Provider not found', 404);
    app.secrets.set(providerSecretName(params.id), b.apiKey.trim());
    app.activity.log('info', 'integrations', `API key updated for provider ${params.id}`);
    app.bus.emit('integrations.changed', {});
    return { ok: true };
  });
  router.delete('/api/integrations/providers/:id/key', ({ params }) => {
    app.secrets.delete(providerSecretName(params.id));
    app.activity.log('info', 'integrations', `API key removed for provider ${params.id}`);
    app.bus.emit('integrations.changed', {});
    return { ok: true };
  });
  router.post('/api/integrations/providers/:id/test', async ({ params }) => {
    if (!app.settings.get().llm.providers.some((p) => p.id === params.id)) throw new UserError('Provider not found', 404);
    await app.llm.checkHealth(params.id);
    return { provider: app.llm.status().find((p) => p.id === params.id) };
  });
  router.post('/api/integrations/mcp', async ({ body }) => {
    const b = parse(McpServerSchema.extend({ secrets: SecretsBody.optional() }), body);
    const { secrets, ...cfg } = b;
    const servers = app.settings.get().integrations.mcpServers;
    if (servers.some((s) => s.id === cfg.id)) throw new UserError(`An MCP server with id "${cfg.id}" already exists`, 409);
    for (const [name, value] of Object.entries(secrets ?? {})) {
      if (!cfg.secretEnv.includes(name)) cfg.secretEnv.push(name);
      app.secrets.set(app.mcp.secretName(cfg.id, name), value);
    }
    app.settings.update({ integrations: { mcpServers: [...servers, cfg] } });
    await app.mcp.sync();
    return { servers: app.mcp.status() };
  });
  router.put('/api/integrations/mcp/:id', async ({ params, body }) => {
    const servers = app.settings.get().integrations.mcpServers;
    const existing = servers.find((s) => s.id === params.id);
    if (!existing) throw new UserError('MCP server not found', 404);
    const b = parse(McpServerSchema.partial().omit({ id: true }), body);
    app.settings.update({ integrations: { mcpServers: servers.map((s) => (s.id === params.id ? { ...s, ...b } : s)) } });
    await app.mcp.sync();
    return { servers: app.mcp.status() };
  });
  router.put('/api/integrations/mcp/:id/secrets', async ({ params, body }) => {
    const servers = app.settings.get().integrations.mcpServers;
    const existing = servers.find((s) => s.id === params.id);
    if (!existing) throw new UserError('MCP server not found', 404);
    const secrets = parse(SecretsBody, body);
    for (const [name, value] of Object.entries(secrets)) app.secrets.set(app.mcp.secretName(params.id, name), value);
    const secretEnv = [...new Set([...existing.secretEnv, ...Object.keys(secrets)])];
    app.settings.update({ integrations: { mcpServers: servers.map((s) => (s.id === params.id ? { ...s, secretEnv } : s)) } });
    await app.mcp.reconnect(params.id);
    return { servers: app.mcp.status() };
  });
  router.delete('/api/integrations/mcp/:id', async ({ params }) => {
    const servers = app.settings.get().integrations.mcpServers;
    if (!servers.some((s) => s.id === params.id)) throw new UserError('MCP server not found', 404);
    app.settings.update({ integrations: { mcpServers: servers.filter((s) => s.id !== params.id) } });
    app.secrets.deletePrefix(`mcp:${params.id}:`);
    await app.mcp.sync();
    return { servers: app.mcp.status() };
  });
  router.post('/api/integrations/mcp/:id/reconnect', async ({ params }) => {
    await app.mcp.reconnect(params.id);
    return { servers: app.mcp.status() };
  });

  // ------------------------------------------------------------------ settings
  router.get('/api/settings', () => ({ settings: app.settings.get() }));
  router.patch('/api/settings', ({ body }) => {
    const patch = (body ?? {}) as { permissions?: { policies?: Record<string, unknown> }; integrations?: { mcpServers?: unknown } };
    if (patch.permissions?.policies) app.permissions.validatePolicyPatch(patch.permissions.policies);
    if (patch.integrations && 'mcpServers' in patch.integrations) throw new UserError('Manage MCP servers on the Integrations page');
    const settings = app.settings.update(patch);
    app.activity.log('info', 'settings', 'Settings updated');
    return { settings };
  });

  // ------------------------------------------------------------------ activity, audit, notifications, jobs
  router.get('/api/activity', ({ query }) => ({ activity: app.activity.recent(Math.min(500, Number(query.get('limit') ?? 100)), query.get('category') ?? undefined) }));
  router.get('/api/audit', ({ query }) => ({
    audit: app.db.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', Math.min(500, Number(query.get('limit') ?? 100))),
  }));
  router.get('/api/notifications', ({ query }) => ({ notifications: app.activity.notifications(50, query.get('unread') === 'true'), unread: app.activity.unreadCount() }));
  router.post('/api/notifications/:id/read', ({ params }) => {
    app.activity.markRead(params.id);
    return { ok: true };
  });
  router.post('/api/notifications/read-all', () => {
    app.activity.markRead();
    return { ok: true };
  });
  router.get('/api/jobs', () => ({ jobs: app.scheduler.status() }));
  router.post('/api/jobs/:name/run', async ({ params }) => ({ message: await app.scheduler.runJob(params.name, { manual: true }) }));
}
