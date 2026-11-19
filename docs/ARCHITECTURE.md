# Jarvis architecture

Jarvis is one local Node.js process (the **service**) plus a React UI it serves. All state lives in a single SQLite database (`~/.jarvis/jarvis.db`) using Node's built-in `node:sqlite` with FTS5. It is built on [Roamies](https://github.com/KenKaiii/Roamies): the model layer is the Roamies engine, and Jarvis only runs where Roamies is installed.

```
                ┌──────────────────────────── UI (React, web/) ─────────────────────────────┐
                │ Home · Tasks · Memory · Skills · Integrations · Activity · Settings       │
                │ Core (vector SVG rig; \\ = immersive full-screen) · Voice · live via SSE   │
                └───────────────▲──────────────────────────────┬─────────────────────────────┘
                     events     │ /api/events                   │ /api/*  (token + Host/Origin checks)
┌───────────────────────────────┴───────────────────────────────▼────────────────────────────┐
│ API (server/api)                                                                            │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ Central intelligence (intelligence/jarvis.ts)                                              │
│   intent.ts (rules) → context (memory retrieval, task state) → model tool loop             │
│   inline read-only skills │ plan_task → Task engine │ task_control                          │
├──────────────┬──────────────────────┬────────────────────────┬──────────────────────────────┤
│ Roamies      │ Task engine          │ Memory                 │ Scheduler (background)       │
│ engine       │ engine.ts / store.ts │ memory/store.ts        │ task-monitor                 │
│ (GG frame-   │ approvals, retries,  │ FTS5 + optional        │ memory-maintenance           │
│ work)        │ locks, recurrence,   │ embeddings, dedupe,    │ health-check                 │
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

## Roamies: requirement and engine

**Requirement.** `roamies/detect.ts` looks for an installed Roamies (macOS `Roamies.app` in `/Applications` or `~/Applications`; Windows the installer's folder under `%LOCALAPPDATA%`/Program Files or its uninstall registry entry; Linux the `roamies` command or a `Roamies*.AppImage` in the usual folders; or a path the user chose). `roamies/gate.ts` keeps the result and re-checks every 4 s while missing (every minute otherwise). While Roamies is missing the app is **locked**: the task engine, scheduler, integrations and model never start, and the API answers every request except `/api/roamies*` and `/api/about` with `423 Locked`. The UI then shows only the Roamies-required screen (download link, Check again, choose a location). When Roamies appears, the services start in place — no restart.

**Engine.** `llm/engine.ts` (`RoamiesEngine`) replaces Jarvis's own model adapters with the GG framework Roamies runs on:

- **Which model:** the `provider`/`model` picked in Roamies (`~/.gg/sidekick.json`, or `$ROAMIES_DATA_DIR/sidekick.json`), unless Settings → Model names another model from the same sign-ins. If Roamies has none picked yet, the first signed-in provider's default model.
- **Credentials:** `gg-core`'s `AuthStorage` over Roamies' `~/.gg/auth.json`, resolved per request (`resolveCredentials`, refreshing expiring sign-ins) — never copied, stored, logged or sent to the UI.
- **Calls:** `gg-ai`'s `stream()` for every provider (Anthropic, OpenAI/ChatGPT, Gemini, xAI, Kimi, GLM, MiniMax, DeepSeek, OpenRouter, local models…). Jarvis runs its own tool loop so every tool call goes through its skill runner and permission engine.
- **Signed in with Claude:** like Roamies, replies run through Claude Code using Roamies' bridge (`llm/claudecode.mjs`, copied from Roamies): Claude Code's own tools are disabled (`tools: []`, no settings sources, every non-Jarvis tool denied) and Jarvis's tools are served to it over an in-process MCP server.
- **Local models:** gg-core's local discovery probes Ollama (`OLLAMA_HOST` honoured) and any servers added in Settings (`llm.localServers`) at most every 30 s, registers their models (`local/<server>/<model>`) and reads each one's tool, thinking and context support. Local models need no sign-in; a key Roamies saved for the server is used if present. With nothing signed in, a running local model is used automatically (preferring one with tools). Models without tool support get a talk-only system prompt and no tools; the planner then falls back to rule-based plans and says plainly that it can't plan otherwise. Small context windows are flagged.
- **Guardrails:** Jarvis adds no content filtering, topic rules or refusals of its own. Messages go to the model as written, answers come back as written, and a refusal is reported as the model's. Jarvis's own rules are about actions and safety of the user's data: the permission engine (approvals), untrusted-content delimiting against prompt injection, the workspace sandbox and private-network blocking for `web.fetch`.
- Settings and sign-in changes are noticed by file stamps (two `stat` calls per request).

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
| health-check | 15 min | Roamies sign-in check (refreshes the credential, no inference), reconnect dead MCP servers |

Task dispatch itself is event-driven (and a timer for the next scheduled task), so scheduled tasks run even with background monitoring paused. Jobs never take external actions; anything external is a task step and goes through permissions.

## Permissions

| Scope | Default | Can be “allow”? |
|---|---|---|
| internal, memory.read, memory.write, model, files.read | allow | yes |
| memory.delete, files.write, network.read | ask | yes |
| shell.exec | ask | **no** (only per-action approval or an exact-action grant) |
| mcp.&lt;server&gt; | ask | yes |

**Your request is the approval** (`permissions/request-scope.ts`, setting `permissions.followRequests`, on by default). Tasks keep the user's own words that created them (`tasks.request`: the chat or voice message plus Jarvis's previous reply, or what was typed on the Tasks page; repeats of a recurring task inherit it). When a step would need approval, the task engine first checks it against those words: (1) for commands, URLs and paths, the user's words containing the exact value; otherwise (2) a separate model call with no tools that sees only the request, the previous reply and the exact action (input wrapped as untrusted data) and must answer `{"partOfRequest": true}`. A covered step gets a single-use approval recorded as `decided_by = 'request'` with the reason, and runs. Everything else — not covered, no request (system/schedule tasks), input that trips the injection scanner, no model to check with, any unparseable answer — gets a normal pending approval whose `reason` says why. *Deny* policies are never overridden.

**Full access** (`permissions.fullAccess`, off by default) is a single trusted-machine override: `PermissionEngine.decide()` returns allow for every scope (no approvals), the file skills resolve paths against the whole disk instead of the workspace (`resolvePath`), and `web.fetch` is allowed onto private/LAN addresses. It is loud (a warning insight and a red banner) and grants data/file/web/shell reach only — not control of other apps, the screen or input.

Agent roles add a second boundary: the *jarvis* role in chat may only use inline-safe skills; the *researcher* only internal/read skills; the *planner* and *verifier* cannot execute anything. Every decision is written to the audit log (inputs redacted).

## Memory

`memories` table + FTS5 index (porter stemming). Each memory has kind, source and all merged sources, confidence, verified flag, access stats and optional embedding. Rules:

- What you say with “remember that …” or add on the Memory page is **verified**.
- What the model saves is **unverified** (confidence 0.5–0.8) until you confirm it; editing counts as confirming.
- System records (task history, tool docs) are verified.
- Exact (normalised hash) and near-duplicates (trigram Jaccard ≥ 0.85, same kind) are merged, keeping provenance.
- Retrieval = BM25 keyword search (stop words dropped, word forms matched by stem prefix) + cosine similarity over embeddings, weighted by confidence and verification.
- Embeddings come from the built-in all-MiniLM-L6-v2 model (WebAssembly ONNX runtime, downloaded once from a pinned revision and SHA-256-checked, runs locally) or an OpenAI-compatible endpoint. New memories are embedded within seconds.

## Voice and API keys

Voice is first-class: a **“Hey Jarvis”** wake word (browser `SpeechRecognition` where available), Whisper transcription for input, and spoken replies through the computer's built-in speech **or Fish Audio** (`integrations/fishaudio.ts`, key from the secret store or `.env`, served as MP3 by `/api/voice/speak`). The Home screen is voice-first — a large animated core and a microphone — with a collapsible type-instead fallback.

API keys for Jarvis's own integrations load from a **`.env` file** (`core/env.ts`): `$JARVIS_ENV`, then `<data dir>/.env`, then `./.env`, merged into the environment without overwriting it. The secret store falls back to `.env` for known names (Fish Audio, HackerOne, transcription, email/CalDAV), so a key in `.env` is used everywhere; a key set inside the app (AES-256-GCM encrypted) takes precedence. Model sign-ins stay in Roamies (`~/.gg`), never in Jarvis's `.env`.

## Security

- Service binds to `127.0.0.1`; requests must carry a loopback `Host` (DNS-rebinding defence), a matching `Origin` if present (CSRF defence) and a per-start random token (embedded in the served page, required for every API call).
- Strict CSP; no third-party scripts or fonts.
- Model sign-ins stay in Roamies (`~/.gg/auth.json`, managed by the GG framework). Secrets Jarvis keeps (email/CalDAV passwords, MCP secrets, a transcription-server key) are AES-256-GCM encrypted at rest; never returned by the API; redacted from logs.
- Untrusted content is delimited, sanitised against delimiter spoofing and scanned for injection phrases; the model that summarises it (`llm.generate`) has no tools.
- Workspace sandbox: file skills resolve real paths and refuse anything outside the workspace (including via symlinks). `web.fetch` blocks private/loopback addresses (checked on every redirect hop) unless enabled.

- `web.fetch` checks the address the socket actually connects to (a lookup hook on the request), so DNS rebinding cannot slip a private address past a separate pre-check.
- One Jarvis per data folder (`jarvis.lock` with pid and URL); a second start points at the first instead of running two task engines on one database.
- MCP tool annotations are treated as hints: only read-only tools are retried automatically, never on a server's say-so.

Known limits: Jarvis reads Roamies' model choice but never writes it (change it in Roamies). Browser speech recognition in Chromium may send audio to the browser vendor's service (choose the transcription service in Settings → Voice to control where audio goes). Outlook.com/Microsoft 365 mail needs OAuth, which is not implemented. Desktop builds are unsigned.

## Jarvis vault (Obsidian)

`integrations/obsidian.ts` gives Jarvis its own Obsidian vault — the place everything it learns is kept in readable form. On first start it creates the vault (default `~/Documents/Jarvis Vault`, or `~/Jarvis Vault`; configurable; `JARVIS_VAULT_DIR` overrides) with `.obsidian/` settings (dark theme in the Jarvis purple, daily notes in `Journal/`, graph colour groups per note type) and a `.jarvis-vault.json` marker. It refuses any folder that already contains other files and isn't marked as a Jarvis vault, so it can never write into a personal vault. `.obsidian/` settings are only written at creation.

Contents: `Jarvis.md` (live status and index), `Manual/` (one note per skill generated from the registry, agents, permissions and grants, integrations, background jobs, `docs/*.md` + README), `Memory/<kind>/` (one note per memory: `jarvis_id`, `verified`, `confidence`, sources), `Tasks/` (steps as a checklist, result, history, task log), `Conversations/`, `Journal/<date>.md` (last 30 days) and `Notes/` (notes written on request).

It updates within ~5 s of meaningful changes and on the `obsidian-sync` schedule. The `obsidian_files` table stores, per vault, the hash of every file Jarvis wrote: a file whose hash no longer matches was edited by the user and is never overwritten or deleted; for memory notes the edited text, `verified` and `kind` are imported back as a correction. Notes the user adds are never touched. Writes are atomic (temp file + rename) and confined to the vault (real paths checked). Moving the vault creates a fresh one and leaves the old untouched. Secrets and feed URLs are never written. Skills: `obsidian.search`/`obsidian.read` (ask first) and `obsidian.write_note` (new notes only).

## Bug-bounty pipeline (HackerOne)

`integrations/hackerone.ts` reads the HackerOne Hacker API (HTTPS Basic auth with your username and an API token, stored encrypted; base URL overridable with `JARVIS_HACKERONE_API`). It is **read-only and observational**: it tracks earnings and reports and discovers programs, and never tests, scans or attacks anything — working a target is a normal task that goes through the permission engine. It pulls three JSON:API collections with pagination (`/payments/earnings`, `/me/reports`, `/programs`) and stores them in `h1_earnings`, `h1_reports` and `h1_programs` (migration 5), so the pipeline can be analysed over time. A program is "newly discovered" when its `first_seen` is later than the earliest import cohort (so the first bulk sync is the baseline, not a flood of "new") and within 14 days. `summary()` computes total / last-30-day / average / monthly earnings, reports by state, and new programs. The `hackerone-pipeline` scheduler job refreshes everything on its interval **for as long as `integrations.hackerone.autoRun` is on** (it reports `paused` otherwise); it is separate from the connection, so pausing the autonomous run never disconnects. Read-only, permission-gated skills (`hackerone.programs`, `hackerone.earnings`, `hackerone.reports`, scope `hackerone.read`) let the model and tasks reason about the pipeline. The UI is the **Pipeline** page plus a HackerOne card on Integrations. Nothing about the pipeline is sent to the model unless you ask.

## Sub-agents

`agents/subagents.ts` is a small team of named background specialists, each with a colour, an interval and its own memory (findings are stored tagged `agent:<id>`, so they persist and can be recalled). `SubAgentManager` runs them on its own 60-second tick (gated by `agents.enabled` and `background.enabled`), tracks per-agent status, and exposes `/api/subagents` (and `/api/subagents/:id/run`). They are drawn as colored mini-cores orbiting the main core (the `Core` takes an `agents` prop; the orbs twinkle and orbit, brightening while an agent is working). The roster: **Friday** (profit = pipeline earnings − a user-set spend), **Tom** (newly discovered paying programs — the "small, likely-unfound-bugs" heuristic), **Neo** (task/pipeline watch, key presence, run documentation), **Sentinel** (authorized in-scope program list), **Echo** (a digest of the others). They observe only what Jarvis can — its pipeline, tasks, memory, secrets — never other apps, processes or the screen.

## Computer Access Mode

Jarvis can see and use the computer it runs on: screen capture and OCR, windows, the mouse, keyboard and scroll, the user's browser (over a loopback DevTools port with a method allowlist, so cookies and storage are never read), multi-step workflows that verify every step, and "watch this and learn" sessions that turn what it watches into attributed, persistent knowledge. Everything goes through `ComputerAccessManager` (toggle, level, STOP) and the existing permission engine. Critical actions (send, pay, delete, install, admin and so on) always wait for the user's own confirmation, even with Full access. See [COMPUTER_ACCESS.md](COMPUTER_ACCESS.md) for details and [COMPUTER_ACCESS_REPORT.md](COMPUTER_ACCESS_REPORT.md) for test evidence.

## Desktop app

`desktop/main.cjs` (Electron) forks the compiled service (`dist-server/`, built with `tsc -p tsconfig.build.json`) using Electron's embedded Node.js and shows the UI in a sandboxed window. Microphone and notification permissions are granted only to the Jarvis origin; other links open in the default browser. Closing the window hides it to the tray; quitting asks the service over IPC to stop safely. `JARVIS_SMOKE_TEST=1` launches, checks the UI and API, and exits — used by `.github/workflows/desktop.yml` on Windows, macOS and Linux.

## Files

```
server/
  main.ts            entry point (startJarvis)        app.ts        composition root, status, insights
  api/               HTTP router, routes, SSE, static UI
  core/              settings (zod), secrets, events, activity/notifications, assistant state
  db/                SQLite wrapper + migrations
  llm/               Roamies engine (GG framework), Roamies' Claude Code bridge, local embeddings
  roamies/           Roamies detection and the requirement gate
  intelligence/      Jarvis core, intents, conversations, untrusted-content handling
  agents/            agent roles, planner, memory agent
  tasks/             task store + engine
  skills/            types, registry, runner, built-in skills
  permissions/       permission engine, approvals, grants
  scheduler/         background jobs
  integrations/      MCP client + manager, email (IMAP/SMTP), calendar (CalDAV/ICS), HackerOne pipeline
web/src/             React UI (pages, components, live events, voice)
desktop/main.cjs     Electron desktop app
scripts/launch.ts    browser app-window launcher (run from source)
tests/               node:test suites + e2e/ui.e2e.ts (Playwright)
```
