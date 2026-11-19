import { accessSync, constants, existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { JarvisApp } from '../app.ts';
import { AGENTS } from '../agents/agents.ts';
import { DraftStepSchema } from '../agents/planner.ts';
import { McpServerSchema } from '../core/settings.ts';
import { errorMessage, UserError } from '../core/util.ts';
import { TRANSCRIPTION_SECRET } from '../llm/engine.ts';
import { HACKERONE_SECRET } from '../integrations/hackerone.ts';
import { FISH_SECRET } from '../integrations/fishaudio.ts';
import { ROAMIES_REPO_URL } from '../roamies/detect.ts';
import { EMAIL_SECRET } from '../integrations/email.ts';
import { CALDAV_SECRET } from '../integrations/calendar.ts';
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

const GG_FRAMEWORK_URL = 'https://github.com/KenKaiii/gg-framework';
export const JARVIS_SOURCE_URL = 'https://github.com/Sphinx3231/jarvis';

export function registerRoutes(router: Router, app: JarvisApp): void {
  // ------------------------------------------------------------------ Roamies (work while locked)
  router.get('/api/roamies', () => app.requirement());
  router.post('/api/roamies/check', () => app.recheckRoamies());
  // From the lock screen: run on OpenJarvis (local, no Roamies needed) instead.
  router.post('/api/roamies/use-openjarvis', () => app.useOpenJarvis());
  router.put('/api/roamies/location', async ({ body }) => {
    const b = parse(z.object({ path: z.string().min(1).max(1000) }), body);
    if (!isAbsolute(b.path.trim().replace(/^"|"$/g, ''))) throw new UserError('Give the full path to the Roamies app');
    app.gate.choose(b.path);
    return app.recheckRoamies();
  });
  // AGPL-3.0 §13: anyone using Jarvis can get its source.
  router.get('/api/about', () => ({
    name: 'Jarvis',
    license: 'AGPL-3.0-only',
    source: JARVIS_SOURCE_URL,
    builtOn: [
      { name: 'Roamies', by: 'KenKaiii', license: 'AGPL-3.0-only', url: ROAMIES_REPO_URL },
      { name: 'GG framework (gg-ai, gg-agent, gg-core)', by: 'KenKaiii', license: 'AGPL-3.0-only', url: GG_FRAMEWORK_URL },
    ],
  }));

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
  router.post('/api/voice/transcribe', async ({ req, body }) => {
    if (!Buffer.isBuffer(body) || body.length < 100) throw new UserError('Send the recording as an audio/* request body');
    const mime = String(req.headers['content-type']).split(';')[0];
    try {
      const result = await app.llm.transcribe(body, mime, { language: app.settings.get().voice.lang });
      return result;
    } catch (err) {
      throw new UserError(errorMessage(err), 502);
    }
  });
  // Jarvis's voice: local Kokoro through OpenJarvis (WAV), or Fish Audio (MP3, cloud). Audio bytes for the browser.
  router.post('/api/voice/speak', async ({ res, body }) => {
    const b = parse(z.object({ text: z.string().min(1).max(4000) }), body);
    try {
      const v = app.settings.get().voice;
      if (v.tts.provider === 'fish' && app.settings.get().brain.localOnly) throw new Error('Fish Audio is a cloud voice and Jarvis is set to local-only. Choose the local voice in Settings → Voice.');
      const out = v.tts.provider === 'local' ? await app.llm.openJarvis().synthesize(b.text, { voiceId: v.tts.voiceId.trim() || undefined }) : await app.tts.synthesize(b.text);
      res.writeHead(200, { 'content-type': out.mime, 'cache-control': 'no-store', 'content-length': String(out.audio.length) });
      res.end(out.audio);
    } catch (err) {
      throw new UserError(errorMessage(err), 502);
    }
  });
  router.put('/api/integrations/voice/tts/key', ({ body }) => {
    const b = parse(z.object({ key: z.string().min(8).max(500) }), body);
    app.secrets.set(FISH_SECRET, b.key.trim());
    app.activity.log('info', 'integrations', 'Fish Audio API key updated');
    app.bus.emit('integrations.changed', {});
    return { ok: true };
  });
  router.delete('/api/integrations/voice/tts/key', () => {
    app.secrets.delete(FISH_SECRET);
    app.bus.emit('integrations.changed', {});
    return { ok: true };
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
    // What the user typed is their request: steps that are part of it run without asking again.
    const request = { text: [b.title, b.description].filter(Boolean).join('\n\n'), via: 'user' as const };
    return app.engine.createTask({ title: b.title, description: b.description, priority: b.priority, origin: 'user', steps: b.steps ?? null, scheduledFor, recurrence: b.recurrence ?? null, request });
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
  router.get('/api/memory', async ({ query }) => {
    const q = query.get('q')?.trim();
    const kind = query.get('kind') as (typeof MEMORY_KINDS)[number] | null;
    if (kind && !MEMORY_KINDS.includes(kind)) throw new UserError('Unknown memory kind');
    const verifiedParam = query.get('verified');
    const verified = verifiedParam === null ? undefined : verifiedParam === 'true';
    // Tool documentation is generated from the skill registry; it has its own filter.
    const excludeKinds = kind ? [] : (['tool_doc'] as const).slice();
    let memories;
    if (q) {
      // Hybrid search: keywords plus meaning (when semantic search is available).
      const embedder = app.llm.embeddings();
      let vector: number[] | null = null;
      if (embedder) vector = (await embedder.embed([q], AbortSignal.timeout(5000)).catch(() => [null]))[0];
      memories = app.memory
        .retrieve(q, { limit: 100, queryVector: vector, embeddingModel: embedder?.model, markAccess: false, kind: kind ?? undefined })
        .filter((m) => verified === undefined || m.verified === verified);
    } else {
      memories = app.memory.list({ kind: kind ?? undefined, verified, excludeKinds, limit: Number(query.get('limit') ?? 200) });
    }
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
  router.get('/api/integrations', async () => {
    await app.llm.refresh().catch(() => {});
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
      model: { ...app.llm.status(), override: s.llm.model, thinking: s.llm.thinking },
      roamies: app.requirement().detection,
      embeddings: {
        enabled: s.embeddings.enabled,
        active: Boolean(embedder),
        memoriesEmbedded: app.memory.stats().embedded,
        builtin: { state: app.localModel.state, error: app.localModel.error, sizeBytes: 23_203_878 },
      },
      mcp: app.mcp.status(),
      workspace: { path: dir, exists: existsSync(dir), writable, readPolicy: app.permissions.policyFor('files.read'), writePolicy: app.permissions.policyFor('files.write') },
      web: { policy: app.permissions.policyFor('network.read'), allowPrivateNetwork: s.integrations.web.allowPrivateNetwork },
      shell: { enabled: s.integrations.shell.enabled, policy: app.permissions.policyFor('shell.exec') },
      email: { ...s.integrations.email, passwordSet: app.secrets.has(EMAIL_SECRET), missing: app.email.missing(), lastCheck: app.email.lastCheck },
      obsidian: {
        ...s.integrations.obsidian,
        problem: app.obsidian.problem(),
        location: app.obsidian.vaultPath(),
        isDefaultLocation: !s.integrations.obsidian.vaultPath.trim(),
        ready: app.obsidian.vaultReady(),
        openUri: app.obsidian.openUri(),
        lastReport: app.obsidian.lastReport,
        trackedNotes: app.obsidian.vaultReady() ? Number(app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM obsidian_files WHERE vault = ?', app.obsidian.vaultRoot())?.n ?? 0) : 0,
      },
      calendar: {
        caldav: { ...s.integrations.calendar.caldav, passwordSet: app.secrets.has(CALDAV_SECRET), missing: app.calendar.caldavMissing() },
        feeds: s.integrations.calendar.feeds,
        lastCheck: app.calendar.lastCheck,
      },
      transcription: { ...s.voice.transcription, keySet: app.secrets.has(TRANSCRIPTION_SECRET), available: Boolean(await app.llm.transcriptionTarget()) },
      hackerone: { ...s.integrations.hackerone, tokenSet: app.pipeline.hasToken(), missing: app.pipeline.missing(), lastCheck: app.pipeline.lastCheck },
      tts: await (async () => {
        const st = app.tts.status();
        if (st.provider !== 'local') return st;
        const h = app.llm.status().openjarvis ?? (await app.llm.openJarvis().health());
        return { ...st, available: Boolean(h.tts?.available), detail: h.tts?.detail ?? (h.reachable ? 'voice not configured in OpenJarvis' : 'OpenJarvis is not running') };
      })(),
    };
  });

  // ------------------------------------------------------------------ bug-bounty pipeline
  router.get('/api/pipeline', () => ({ pipeline: app.pipeline.summary() }));
  router.get('/api/pipeline/programs', ({ query }) => ({
    programs: app.pipeline.programs({
      query: query.get('query') ?? undefined,
      bountyOnly: query.get('bountyOnly') === 'true',
      newOnly: query.get('newOnly') === 'true',
      limit: Number(query.get('limit') ?? 100),
    }),
  }));
  router.post('/api/pipeline/sync', async () => {
    const r = await app.pipeline.sync();
    if (!r.ok && app.pipeline.missing()) throw new UserError(r.detail, 400);
    return { ...r, pipeline: app.pipeline.summary() };
  });
  router.get('/api/pipeline/scopes', async ({ query }) => {
    const handle = query.get('program');
    if (!handle) throw new UserError('program is required');
    return { program: handle, scopes: query.get('refresh') === 'true' ? (await app.pipeline.syncScopes(handle), app.pipeline.scopes(handle)) : await app.pipeline.ensureScopes(handle) };
  });
  router.get('/api/pipeline/submissions', ({ query }) => ({ submissions: app.pipeline.submissions(Number(query.get('limit') ?? 50)) }));
  // Autonomous orchestrator.
  router.get('/api/pipeline/orchestrator', () => ({ orchestrator: app.orchestrator.status() }));
  router.post('/api/pipeline/hunt', async () => ({ cycle: await app.orchestrator.runCycle() }));
  // ------------------------------------------------------------------ sub-agents
  router.get('/api/subagents', () => ({ agents: app.subAgents.list(), enabled: app.settings.get().agents.enabled, spendUsd: app.settings.get().agents.spendUsd }));
  router.post('/api/subagents/:id/run', async ({ params }) => {
    try {
      return { agent: await app.subAgents.runAgent(params.id) };
    } catch (err) {
      throw new UserError(errorMessage(err), 404);
    }
  });
  // ------------------------------------------------------------------ computer access
  router.get('/api/computer', async () => {
    const status = app.computer.status();
    // Only observe the machine when the toggle is on; the report itself is always safe to read.
    const telemetry = status.enabled ? await app.computer.telemetry().catch(() => null) : null;
    const browser = status.enabled ? await app.computer.browser().probe() : null;
    return { status, telemetry, browser, browserBinary: app.computer.browserBinary(), recent: app.computer.actions.recent(30), learning: app.watcher.sessions(8) };
  });
  router.get('/api/computer/actions', ({ query }) => ({ actions: app.computer.actions.recent(Number(query.get('limit') ?? 100)) }));
  // The user's decision on a critical action Jarvis paused for (send / pay / delete / install / admin …).
  router.post('/api/computer/confirmations/:id', ({ params, body }) => {
    const b = parse(z.object({ approve: z.boolean() }), body);
    return { confirmation: app.computer.decideConfirmation(params.id, b.approve), status: app.computer.status() };
  });
  const asUserError = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      const e = err as Error & { status?: number; confirmation?: unknown };
      const ue = new UserError(errorMessage(err), e.status ?? 400) as UserError & { confirmation?: unknown };
      throw ue;
    }
  };
  // Browser control (CDP on a loopback port, method-allowlisted; never cookies/storage/passwords).
  router.post('/api/computer/browser/start', ({ body }) => asUserError(async () => ({ browser: await app.computer.startBrowser(parse(z.object({ url: z.string().url().optional() }), body ?? {}).url) })));
  router.post('/api/computer/browser', ({ body }) =>
    asUserError(async () => {
      const Target = z.object({ name: z.string().max(200).optional(), role: z.string().max(40).optional(), index: z.number().int().min(0).optional(), nth: z.number().int().min(0).optional() });
      const Op = z.discriminatedUnion('op', [
        z.object({ op: z.literal('tabs') }),
        z.object({ op: z.literal('open'), url: z.string().max(2000) }),
        z.object({ op: z.literal('activate'), tabId: z.string().max(100) }),
        z.object({ op: z.literal('close_tab'), tabId: z.string().max(100) }),
        z.object({ op: z.literal('navigate'), url: z.string().max(2000), tabId: z.string().max(100).optional() }),
        z.object({ op: z.literal('back'), tabId: z.string().max(100).optional() }),
        z.object({ op: z.literal('read'), tabId: z.string().max(100).optional(), maxChars: z.number().int().min(200).max(200000).optional() }),
        z.object({ op: z.literal('click'), target: Target, expectText: z.string().max(200).optional(), expectUrl: z.string().max(500).optional(), tabId: z.string().max(100).optional() }),
        z.object({ op: z.literal('type'), target: Target.optional(), text: z.string().min(1).max(5000), clear: z.boolean().optional(), submit: z.boolean().optional(), tabId: z.string().max(100).optional() }),
        z.object({ op: z.literal('key'), key: z.string().max(20), tabId: z.string().max(100).optional() }),
        z.object({ op: z.literal('select'), target: Target, option: z.string().min(1).max(200), tabId: z.string().max(100).optional() }),
        z.object({ op: z.literal('scroll'), direction: z.enum(['up', 'down']), amount: z.number().int().min(50).max(5000).optional(), tabId: z.string().max(100).optional() }),
        z.object({ op: z.literal('wait_text'), text: z.string().min(1).max(200), timeoutMs: z.number().int().min(100).max(60000).optional(), tabId: z.string().max(100).optional() }),
        z.object({ op: z.literal('dismiss_dialog'), tabId: z.string().max(100).optional() }),
      ]);
      return { result: await app.computer.browserOp(parse(Op, body), undefined, { task: 'requested from the Jarvis UI' }) };
    }),
  );
  router.post('/api/computer/click-text', ({ body }) =>
    asUserError(async () => {
      const b = parse(z.object({ text: z.string().min(1).max(200), expectText: z.string().max(200).optional() }), body);
      return { result: await app.computer.clickText(b.text, { expectText: b.expectText, task: 'requested from the Jarvis UI' }) };
    }),
  );
  router.post('/api/computer/workflow', ({ body }) =>
    asUserError(async () => {
      const b = parse(z.object({ goal: z.string().min(1).max(300), steps: z.array(z.record(z.string(), z.unknown())).min(1).max(60), startAt: z.number().int().min(0).optional() }), body);
      const skill = app.registry.get('computer.workflow');
      const parsed = skill!.input.safeParse(b);
      if (!parsed.success) throw new UserError(`Invalid workflow: ${parsed.error.issues[0].path.join('.')} — ${parsed.error.issues[0].message}`);
      const w = parsed.data as { goal: string; steps: import('../computer/executor.ts').WorkflowStep[]; startAt?: number };
      return { result: await app.workflows.run(w.goal, w.steps, { startAt: w.startAt }) };
    }),
  );
  // Watch-and-learn sessions.
  router.get('/api/computer/watch', () => ({ active: app.watcher.active(), sessions: app.watcher.sessions(20) }));
  router.post('/api/computer/watch/start', ({ body }) =>
    asUserError(async () => {
      const b = parse(
        z.object({ course: z.string().max(200).optional(), source: z.enum(['browser', 'screen']).optional(), autoScroll: z.boolean().optional(), nextLabel: z.string().max(100).optional(), maxLessons: z.number().int().min(1).max(200).optional(), maxMinutes: z.number().int().min(1).max(600).optional(), intervalSec: z.number().min(0.5).max(120).optional() }),
        body ?? {},
      );
      return { session: await app.watcher.start({ ...b, task: 'Watch and learn (requested from the Jarvis UI)' }) };
    }),
  );
  router.post('/api/computer/watch/stop', ({ body }) => asUserError(async () => ({ sessions: await app.watcher.stop(parse(z.object({ id: z.string().max(100).optional() }), body ?? {}).id) })));
  router.post('/api/computer/stop', ({ body }) => {
    const b = parse(z.object({ reason: z.string().max(200).optional() }), body ?? {});
    return { status: app.computer.emergencyStop(b.reason ?? 'User pressed STOP') };
  });
  // Run real capability probes on this machine (capture/OCR/windows) and return the evidence.
  router.post('/api/computer/verify', async () => ({ probes: await app.computer.verify(), status: app.computer.status() }));
  // A one-shot observation (gated behind the toggle); text-first, never raw pixels.
  router.post('/api/computer/observe', async ({ body }) => {
    const b = parse(
      z.object({
        screenshot: z.boolean().optional(),
        ocr: z.boolean().optional(),
        ocrWords: z.boolean().optional(),
        activeWindow: z.boolean().optional(),
        windows: z.boolean().optional(),
        region: z.enum(['screen', 'active']).optional(),
        lang: z.string().max(40).optional(),
      }),
      body ?? {},
    );
    try {
      return { observation: await app.computer.observe(b) };
    } catch (err) {
      throw new UserError(errorMessage(err), 400);
    }
  });
  // One input action (mouse/keyboard/scroll/window switch). Gated by the toggle + the interact level.
  router.post('/api/computer/control', async ({ body }) => {
    const Action = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('move'), x: z.number(), y: z.number() }),
      z.object({ kind: z.literal('click'), button: z.enum(['left', 'right', 'middle']).optional(), count: z.number().int().min(1).max(5).optional(), x: z.number().optional(), y: z.number().optional(), label: z.string().max(200).optional() }),
      z.object({ kind: z.literal('type'), text: z.string().min(1).max(2000) }),
      z.object({ kind: z.literal('key'), keys: z.string().min(1).max(60) }),
      z.object({ kind: z.literal('scroll'), direction: z.enum(['up', 'down', 'left', 'right']), amount: z.number().int().min(1).max(50).optional() }),
      z.object({ kind: z.literal('activate_window'), title: z.string().min(1).max(200) }),
      z.object({ kind: z.literal('drag'), from: z.object({ x: z.number(), y: z.number() }), to: z.object({ x: z.number(), y: z.number() }), button: z.enum(['left', 'right']).optional() }),
      z.object({ kind: z.literal('mouse_down'), button: z.enum(['left', 'right', 'middle']).optional(), x: z.number().optional(), y: z.number().optional() }),
      z.object({ kind: z.literal('mouse_up'), button: z.enum(['left', 'right', 'middle']).optional(), x: z.number().optional(), y: z.number().optional() }),
      z.object({ kind: z.literal('window'), op: z.enum(['minimize', 'maximize', 'restore', 'resize', 'move', 'close']), title: z.string().min(1).max(200), width: z.number().int().optional(), height: z.number().int().optional(), x: z.number().int().optional(), y: z.number().int().optional() }),
    ]);
    const action = parse(Action, body);
    try {
      return { result: await app.computer.control(action) };
    } catch (err) {
      throw new UserError(errorMessage(err), 400);
    }
  });
  // Learning pipeline: ingest a lesson's text into persistent, attributed knowledge, and recall it.
  router.post('/api/computer/learn', ({ body }) => {
    const b = parse(
      z.object({
        course: z.string().min(1).max(200),
        lesson: z.string().min(1).max(200),
        lessonNumber: z.number().int().min(1).max(10000).optional(),
        text: z.string().min(1).max(40000),
        captions: z.string().max(40000).optional(),
        sourceUrl: z.string().max(1000).optional(),
      }),
      body,
    );
    return { result: app.learning.ingestLesson(b) };
  });
  router.get('/api/computer/learning', ({ query }) => {
    const q = query.get('q')?.trim();
    const course = query.get('course') ?? undefined;
    const lesson = query.get('lesson');
    if (q) return { recalled: app.learning.recall(q, { courseSlug: course }) };
    if (course) return { summary: app.learning.courseSummary(course), notes: app.learning.notesFor(course, { lesson: lesson ? (/^\d+$/.test(lesson) ? Number(lesson) : lesson) : undefined }), progress: app.watcher.lastProgress(course) };
    return { courses: app.learning.courses() };
  });

  router.put('/api/integrations/hackerone', ({ body }) => {
    const b = parse(
      z.object({
        enabled: z.boolean().optional(),
        username: z.string().max(100).optional(),
        autoRun: z.boolean().optional(),
        intervalMin: z.number().int().min(5).max(1440).optional(),
        bountyOnly: z.boolean().optional(),
      }),
      body,
    );
    const settings = app.settings.update({ integrations: { hackerone: b } });
    app.bus.emit('integrations.changed', {});
    return { hackerone: settings.integrations.hackerone };
  });
  router.put('/api/integrations/hackerone/token', ({ body }) => {
    const b = parse(z.object({ token: z.string().min(8).max(500) }), body);
    app.secrets.set(HACKERONE_SECRET, b.token.trim());
    app.activity.log('info', 'integrations', 'HackerOne API token updated');
    app.bus.emit('integrations.changed', {});
    return { ok: true };
  });
  router.delete('/api/integrations/hackerone/token', () => {
    app.secrets.delete(HACKERONE_SECRET);
    app.bus.emit('integrations.changed', {});
    return { ok: true };
  });
  router.post('/api/integrations/hackerone/test', async () => ({ result: await app.pipeline.test() }));
  // Local model servers (Ollama is found by itself; others are added here).
  router.post('/api/integrations/local/scan', async () => {
    await app.llm.discoverLocal(true);
    await app.llm.refresh(true);
    app.bus.emit('integrations.changed', {});
    return { local: app.llm.status().local };
  });
  router.post('/api/integrations/local/servers', async ({ body }) => {
    const b = parse(z.object({ url: z.string().url().regex(/^https?:\/\//, 'Use an http:// or https:// address') }), body);
    let url = b.url.trim().replace(/\/+$/, '');
    if (!/\/v\d+$/.test(url)) url = `${url}/v1`;
    const servers = app.settings.get().llm.localServers;
    if (!servers.includes(url)) app.settings.update({ llm: { localServers: [...servers, url] } });
    await app.llm.discoverLocal(true);
    await app.llm.refresh(true);
    app.activity.log('info', 'integrations', `Local model server added: ${url}`);
    return { local: app.llm.status().local };
  });
  router.delete('/api/integrations/local/servers', ({ query }) => {
    const url = query.get('url') ?? '';
    app.settings.update({ llm: { localServers: app.settings.get().llm.localServers.filter((x) => x !== url) } });
    return { ok: true };
  });
  router.post('/api/integrations/model/test', async () => {
    await app.llm.checkHealth();
    return { model: app.llm.status() };
  });
  router.put('/api/integrations/transcription/key', ({ body }) => {
    const b = parse(z.object({ apiKey: z.string().min(1).max(500) }), body);
    app.secrets.set(TRANSCRIPTION_SECRET, b.apiKey.trim());
    app.activity.log('info', 'integrations', 'Transcription server key updated');
    app.bus.emit('integrations.changed', {});
    return { ok: true };
  });
  router.delete('/api/integrations/transcription/key', () => {
    app.secrets.delete(TRANSCRIPTION_SECRET);
    app.bus.emit('integrations.changed', {});
    return { ok: true };
  });
  router.post('/api/integrations/embeddings/download', async () => {
    await app.localModel.ensure().catch((err: Error) => {
      throw new UserError(`Download failed: ${err.message}`, 502);
    });
    return { state: app.localModel.state };
  });
  router.delete('/api/integrations/embeddings/model', () => {
    app.localModel.remove();
    return { state: app.localModel.state };
  });
  const MailServer = z.object({ host: z.string().max(200), port: z.number().int().min(1).max(65535), security: z.enum(['tls', 'starttls', 'none']) });
  router.put('/api/integrations/email', ({ body }) => {
    const b = parse(
      z.object({
        enabled: z.boolean().optional(),
        address: z.string().max(200).optional(),
        displayName: z.string().max(100).optional(),
        username: z.string().max(200).optional(),
        imap: MailServer.optional(),
        smtp: MailServer.optional(),
        password: z.string().min(1).max(500).optional(),
      }),
      body,
    );
    const { password, ...config } = b;
    if (password) app.secrets.set(EMAIL_SECRET, password);
    app.settings.update({ integrations: { email: config } });
    app.activity.log('info', 'integrations', `Email account ${config.enabled === false ? 'turned off' : 'updated'}`);
    app.bus.emit('integrations.changed', {});
    return { ok: true };
  });
  router.post('/api/integrations/email/test', async () => app.email.test());
  router.put('/api/integrations/obsidian', ({ body }) => {
    const b = parse(
      z.object({
        enabled: z.boolean().optional(),
        vaultPath: z.string().max(1000).optional(),
        include: z.object({ manual: z.boolean(), memories: z.boolean(), tasks: z.boolean(), journal: z.boolean(), conversations: z.boolean() }).partial().optional(),
        intervalMin: z.number().int().min(1).max(1440).optional(),
      }),
      body,
    );
    const next = { ...app.settings.get().integrations.obsidian, ...b, include: { ...app.settings.get().integrations.obsidian.include, ...b.include } };
    if (b.vaultPath !== undefined) next.vaultPath = b.vaultPath.trim();
    if (next.vaultPath && !isAbsolute(next.vaultPath)) throw new UserError('Enter a full folder path for the vault (or leave it empty for the default location)');
    const previous = app.settings.get().integrations.obsidian;
    app.settings.update({ integrations: { obsidian: next } });
    const problem = app.obsidian.problem();
    if (next.enabled && problem) {
      app.settings.update({ integrations: { obsidian: previous } });
      throw new UserError(problem);
    }
    app.activity.log('info', 'obsidian', next.enabled ? `Jarvis vault: ${app.obsidian.vaultPath()}` : 'Jarvis vault updates turned off');
    if (next.enabled) app.obsidian.schedule(200);
    return { ok: true };
  });
  router.post('/api/integrations/obsidian/sync', async () => {
    const problem = app.obsidian.problem();
    if (problem) throw new UserError(problem);
    return app.obsidian.sync();
  });
  router.put('/api/integrations/calendar/caldav', ({ body }) => {
    const b = parse(
      z.object({
        enabled: z.boolean().optional(),
        serverUrl: z.string().url().or(z.literal('')).optional(),
        username: z.string().max(200).optional(),
        password: z.string().min(1).max(500).optional(),
      }),
      body,
    );
    const { password, ...config } = b;
    if (password) app.secrets.set(CALDAV_SECRET, password);
    app.settings.update({ integrations: { calendar: { caldav: config } } });
    app.bus.emit('integrations.changed', {});
    return { ok: true };
  });
  router.post('/api/integrations/calendar/test', async () => app.calendar.test());
  router.post('/api/integrations/calendar/feeds', ({ body }) => {
    const b = parse(z.object({ name: z.string().min(1).max(80), url: z.string().min(8).max(2000) }), body);
    const feed = app.calendar.addFeed(b.name, b.url.trim());
    app.bus.emit('integrations.changed', {});
    return { feed };
  });
  router.delete('/api/integrations/calendar/feeds/:id', ({ params }) => {
    app.calendar.removeFeed(params.id);
    app.bus.emit('integrations.changed', {});
    return { ok: true };
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
    if (patch.integrations && ['mcpServers', 'email', 'calendar', 'obsidian', 'hackerone'].some((k) => k in (patch.integrations as object))) throw new UserError('Manage accounts and servers on the Integrations page');
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
