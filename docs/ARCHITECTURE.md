# Jarvis architecture

Jarvis is one local Node.js process (the **service**) plus a React UI it serves. All state lives in a single SQLite database (`~/.jarvis/jarvis.db`) using Node's built-in `node:sqlite` with FTS5.

```
                ┌──────────────────────────── UI (React, web/) ─────────────────────────────┐
                │ Home · Tasks · Memory · Skills · Integrations · Activity · Settings       │
                │ Dragon (state-driven CSS) · Voice (Web Speech API) · live updates (SSE)   │
                └───────────────▲──────────────────────────────┬─────────────────────────────┘
                     events     │ /api/events                   │ /api/*  (token + Host/Origin checks)
┌───────────────────────────────┴───────────────────────────────▼────────────────────────────┐
│ API (server/api)                                                                            │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ Central intelligence (intelligence/jarvis.ts)                                              │
│   intent.ts (rules) → context (memory retrieval, task state) → model tool loop             │
│   inline read-only skills │ plan_task → Task engine │ task_control                          │
├──────────────┬──────────────────────┬────────────────────────┬──────────────────────────────┤
│ LLM router   │ Task engine          │ Memory                 │ Scheduler (background)       │
│ anthropic.ts │ engine.ts / store.ts │ memory/store.ts        │ task-monitor                 │
│ openai-comp. │ approvals, retries,  │ FTS5 + optional        │ memory-maintenance           │
│ fallback     │ locks, recurrence,   │ embeddings, dedupe,    │ health-check                 │
│              │ crash recovery       │ provenance             │                              │
├──────────────┴──────────┬───────────┴────────────────────────┴──────────────────────────────┤
│ Agents (agents/)         │ Skill runner (skills/runner.ts) — the ONLY execution path        │
│ planner, researcher,     │  1 skill exists & available  2 agent role allows it              │
│ executor, memory,        │  3 input validates (zod)     4 permission engine decides         │
│ verifier                 │  5 execute w/ timeout+cancel 6 skill.verify()  7 audit log       │
├──────────────────────────┴──────────────────────────────────────────────────────────────────┤
│ Skills: memory.* · tasks.list · system.status · notify.user · llm.generate · files.* ·      │
│         web.fetch · shell.run · mcp.<server>.<tool> (integrations/mcp.ts)                   │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Request flow

1. The UI posts a message to `/api/chat`. `Jarvis.handleMessage` stores it and marks the assistant **thinking**.
2. `parseIntent` handles explicit commands locally (remember, reminders, task control, status, help). Without a model it also turns direct commands (`run`, `fetch`, `read file`, `list files`) into tasks.
3. Otherwise the model receives a stable, cacheable system prompt, recent conversation, and a `<context>` block with relevant memories and task state. It may call:
   - inline skills its role allows (read-only/internal, policy *allow*): results from files or the web come back wrapped in `<untrusted_content>`;
   - `plan_task`: the planning agent validates every step (real skill, valid input, no forward references) and the task engine queues it;
   - `task_control`: pause/resume/cancel. There is no tool that approves anything.
4. The reply is stored and returned with structured actions (task created, memory saved), which the UI shows as chips.

## Task engine

- States: `queued → running → (awaiting_approval | paused) → completed | failed | cancelled`, persisted with an event history.
- Each step names a skill, input (which can reference earlier output with `{{steps.N.output.field}}`), and the least-privileged agent role that may run it.
- Before acting, the step is persisted as `running`. If Jarvis stops mid-step, recovery re-queues steps that are **idempotent**; non-idempotent steps (commands, writes, external tools) become `uncertain` and the task pauses until you choose *Retry step* or *Skip step*.
- A step needing permission creates a single-use approval and pauses the task. Approving re-queues it; denying cancels it. “Always allow this exact action” creates a grant bound to the skill and a hash of the exact input.
- Retries apply only to idempotent steps, up to `tasks.maxAttempts`. Every success requires the skill's own verification (e.g. file SHA-256 matches, exit code 0, HTTP 2xx).
- Concurrency limit, per-resource locks (e.g. one writer per file), priority ordering, dedupe of identical active work, scheduling and recurrence (every N minutes / daily at HH:MM).

## Continuous operation

The scheduler runs internal jobs only:

| Job | Default | What it does |
|---|---|---|
| task-monitor | 30 s | Recover orphaned running tasks, flag slow steps, dispatch due work, one reminder per long-pending approval |
| memory-maintenance | 30 min | Merge duplicates, refresh tool docs, embed new memories (if enabled), summarise long conversations (≤2 model calls), prune expired conversations |
| health-check | 15 min | Provider reachability via model-list endpoints (no inference), reconnect dead MCP servers |

Task dispatch itself is event-driven (and a timer for the next scheduled task), so scheduled tasks run even with background monitoring paused. Jobs never take external actions; anything external is a task step and goes through permissions.

## Permissions

| Scope | Default | Can be “allow”? |
|---|---|---|
| internal, memory.read, memory.write, model, files.read | allow | yes |
| memory.delete, files.write, network.read | ask | yes |
| shell.exec | ask | **no** (only per-action approval or an exact-action grant) |
| mcp.&lt;server&gt; | ask | yes |

Agent roles add a second boundary: the *jarvis* role in chat may only use inline-safe skills; the *researcher* only internal/read skills; the *planner* and *verifier* cannot execute anything. Every decision is written to the audit log (inputs redacted).

## Memory

`memories` table + FTS5 index (porter stemming). Each memory has kind, source and all merged sources, confidence, verified flag, access stats and optional embedding. Rules:

- What you say with “remember that …” or add on the Memory page is **verified**.
- What the model saves is **unverified** (confidence 0.5–0.8) until you confirm it; editing counts as confirming.
- System records (task history, tool docs) are verified.
- Exact (normalised hash) and near-duplicates (trigram Jaccard ≥ 0.85, same kind) are merged, keeping provenance.
- Retrieval = BM25 keyword search (stop words dropped, word forms matched by stem prefix) + cosine similarity over embeddings, weighted by confidence and verification.
- Embeddings come from the built-in all-MiniLM-L6-v2 model (WebAssembly ONNX runtime, downloaded once from a pinned revision and SHA-256-checked, runs locally) or an OpenAI-compatible endpoint. New memories are embedded within seconds.

## Security

- Service binds to `127.0.0.1`; requests must carry a loopback `Host` (DNS-rebinding defence), a matching `Origin` if present (CSRF defence) and a per-start random token (embedded in the served page, required for every API call).
- Strict CSP; no third-party scripts or fonts.
- API keys and MCP secrets are AES-256-GCM encrypted at rest; never returned by the API; redacted from logs.
- Untrusted content is delimited, sanitised against delimiter spoofing and scanned for injection phrases; the model that summarises it (`llm.generate`) has no tools.
- Workspace sandbox: file skills resolve real paths and refuse anything outside the workspace (including via symlinks). `web.fetch` blocks private/loopback addresses (checked on every redirect hop) unless enabled.

- `web.fetch` checks the address the socket actually connects to (a lookup hook on the request), so DNS rebinding cannot slip a private address past a separate pre-check.
- One Jarvis per data folder (`jarvis.lock` with pid and URL); a second start points at the first instead of running two task engines on one database.
- MCP tool annotations are treated as hints: only read-only tools are retried automatically, never on a server's say-so.

Known limits: browser speech recognition in Chromium may send audio to the browser vendor's service (choose the transcription service in Settings → Voice to control where audio goes). Outlook.com/Microsoft 365 mail needs OAuth, which is not implemented. Desktop builds are unsigned.

## Desktop app

`desktop/main.cjs` (Electron) forks the compiled service (`dist-server/`, built with `tsc -p tsconfig.build.json`) using Electron's embedded Node.js and shows the UI in a sandboxed window. Microphone and notification permissions are granted only to the Jarvis origin; other links open in the default browser. Closing the window hides it to the tray; quitting asks the service over IPC to stop safely. `JARVIS_SMOKE_TEST=1` launches, checks the UI and API, and exits — used by `.github/workflows/desktop.yml` on Windows, macOS and Linux.

## Files

```
server/
  main.ts            entry point (startJarvis)        app.ts        composition root, status, insights
  api/               HTTP router, routes, SSE, static UI
  core/              settings (zod), secrets, events, activity/notifications, assistant state
  db/                SQLite wrapper + migrations
  llm/               provider interface, Anthropic SDK adapter, OpenAI-compatible adapter, router
  intelligence/      Jarvis core, intents, conversations, untrusted-content handling
  agents/            agent roles, planner, memory agent
  tasks/             task store + engine
  skills/            types, registry, runner, built-in skills
  permissions/       permission engine, approvals, grants
  scheduler/         background jobs
  integrations/      MCP client + manager, email (IMAP/SMTP), calendar (CalDAV/ICS)
web/src/             React UI (pages, components, live events, voice)
desktop/main.cjs     Electron desktop app
scripts/launch.ts    browser app-window launcher (run from source)
tests/               node:test suites + e2e/ui.e2e.ts (Playwright)
```
