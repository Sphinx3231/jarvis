# JARVIS — MASTER HANDOFF

Written: 2026-11-26 (UTC), by the Claude Code session that built the work described here, at the moment
development was **frozen** on the owner's instruction. Its purpose: a brand-new session (Hermes or any
other) can take over Jarvis without the owner repeating its history.

**Read this first.**
- **Where the code is.** This file was written in a **cloud container** (Claude Code on the web), *not* on
  the owner's PC. That container has no access to the owner's computer (no machine was attached, and
  no folder was shared through Remote Control). So the "transfer to the PC" step could only be prepared
  as a **downloadable transfer archive**. See §6 and §48.
- **Unique, uncommitted work.** The newest work (the Hermes harness integration) is **uncommitted**. A
  commit + push from the freezing session was **refused by the environment's permission policy**,
  consistent with the owner's instruction "do not automatically commit/push". That work exists only in:
  1. the transfer archive; and
  2. the cloud container, until it is reclaimed.

  Restore it from the archive before anything else.

**Labels used.**
- Status: IMPLEMENTED · TESTED · PARTIALLY IMPLEMENTED · UNVERIFIED · BROKEN · PLANNED · BLOCKED
- Source of a claim: VERIFIED FACT (checked now) · HISTORICAL FACT (true when done earlier in this
  project, not re-checked now) · CURRENT OBSERVATION · ASSUMPTION · IDEA · DECISION · UNKNOWN

---

## 1. Jarvis project overview

VERIFIED FACT. Jarvis is a persistent AI personal operating system. Its identity is a living
purple energy core, and its brand mark is a purple dragon. It:
- remembers context;
- organises and runs tasks in the background;
- coordinates skills and agents;
- never acts beyond what the user authorises.

Licence: AGPL-3.0-only (LICENSE, NOTICE.md). It is built on Roamies (KenKaiii, AGPL-3.0).

Main parts:

| Part | Where | Status |
|---|---|---|
| Service (Node 22, TypeScript run directly via type-stripping) | `server/` | IMPLEMENTED, TESTED (HISTORICAL) |
| Web UI (React 19, Vite 8) | `web/` | IMPLEMENTED, TESTED (HISTORICAL) |
| Desktop app (Electron 45) | `desktop/main.cjs` | IMPLEMENTED, smoke-tested on Linux in this project (HISTORICAL) |
| Android companion (Kotlin, Compose) | `mobile/android/` | IMPLEMENTED, JVM/Robolectric-tested; **never run on a real phone** (HISTORICAL) |
| Relay for phone ⇄ PC | `relay/` | IMPLEMENTED (HISTORICAL) |
| Shared phone/PC protocol | `shared/protocol/` | IMPLEMENTED (HISTORICAL) |
| Hermes Agent harness | `server/harness/` | PARTIALLY IMPLEMENTED, **uncommitted** (see §18, §36) |

## 2. Vision and long-term objectives

- **HISTORICAL FACT.** Jarvis is the owner's single assistant, running **fully locally by default**
  (OpenJarvis: local model, Whisper, Kokoro), with no API spending ("local-only" mode is on by default).
- **HISTORICAL FACT.** The owner is the user and final authority. The owner's explicit standing rule:
  **Jarvis adds no content guardrails of its own**; guardrails come only from the connected model. What
  Jarvis enforces is the owner's *authorization*: approvals, critical-action confirmation, scopes,
  and protection against third parties (prompt injection, origin/token checks). See §32 and §46.
- **HISTORICAL FACT.** Android-first mobile, in two modes:
  - Remote PC: the phone drives the PC's Jarvis.
  - Independent Mobile: Jarvis runs on the phone with its own on-device model, memory and tools.
- **DECISION (owner, latest).** Jarvis becomes the executive assistant of an autonomous AI technical
  organization:
  - Hermes as CTO;
  - OpenJarvis as technical collaborator;
  - a Hermes Auditor;
  - one shared Obsidian vault;
  - one shared local inference runtime.

  This mission was **received but NOT started** (frozen). Its requirements are summarised in §43.

## 3. Current PC environment and hardware

CURRENT OBSERVATION. The machine this handoff was written on is **not the owner's PC**:

| | Value |
|---|---|
| Machine | Cloud container "vm" (Claude Code on the web), ephemeral |
| OS | Ubuntu 24.04.5 LTS, Linux 6.18 x86_64 |
| CPU | 4 vCPU |
| RAM | 15 GiB |
| GPU | none (`nvidia-smi` absent) |
| Disk | 252 GB volume, about 4.7 GB free in the session allowance |
| Tools | git 2.43, Node v22.23.5, Python 3.13.18 (system), uv, Python 3.14 (via uv), Chromium + Playwright |

**The owner's PC:**
- UNKNOWN (not reachable from this session).
- HISTORICAL FACT: the repo's setup profiles target a **GEEKOM A6 with 32 GB or 64 GB RAM**
  (`scripts/local-setup/`, README).
- HISTORICAL FACT: the Windows paths in `docs/LOCAL_SETUP.md` (`%LOCALAPPDATA%\Jarvis\…`) suggest the
  PC runs Windows. ASSUMPTION; verify on the PC.

## 4. Exact project path

- **In the cloud container:** `/home/user/jarvis` (VERIFIED FACT).
- **On the owner's PC:** UNKNOWN (not created by this session; see §6 for how to restore it).

## 5. Authoritative project source

VERIFIED FACT (checked with `git fetch` / `git ls-remote` at freeze time):

| Item | Value |
|---|---|
| Remote | `origin https://github.com/Sphinx3231/jarvis` |
| Default branch on GitHub | `claude/compassionate-euler-5rmclz` @ `24bcd8ee6b00d74639fa5fe05ea45110014268ef` ("Autonomous bug-bounty orchestrator…") |
| Development branch | `ccr-3670aed0-joz4xe` @ `93aa3328a51149e4f87552789bf2f77c8d1a8000` |

- The development branch is identical on GitHub and locally, and contains the default branch (the default
  branch is its ancestor).
- **Authoritative state = `ccr-3670aed0-joz4xe` on GitHub + the uncommitted working-tree changes
  listed in §48.** Nothing on GitHub is newer than this container's tree.
- No other copy of the project was found on this machine.

## 6. Transfer / consolidation details

- **BLOCKED: direct transfer to the PC.** This session has no access to the owner's computer:
  `list_computer_folders` returned no folders, so no machine is attached and nothing is shared through
  Remote Control.
- **BLOCKED: preserving to GitHub.** A WIP commit + push was refused by the environment's permission
  policy, and the freezing session did not work around that.
- **IMPLEMENTED (by this session): a transfer archive,** delivered to the owner as a download. It contains:
  - the complete repository: `.git` with full history, both local branches and remote refs;
  - all modified and untracked files;
  - this handoff;
  - `docs/research/hermes-integration/` (research reports and the real-model demo log).

  It excludes only regenerable or machine-specific items:
  - `node_modules/`, `web/dist/`, `dist-server/`, `test-results/`;
  - the Android `build/` and `.gradle/` folders, and `mobile/android/local.properties` (the local SDK
    path);
  - `dist/`, which holds the 86 MB mobile APK (see §12).

**Restoring on the PC:**
1. Unpack the archive into the folder you want as the project root, e.g. `C:\Users\<you>\jarvis` or
   `~/jarvis`. Keep the folder name `jarvis`.
2. `git status` must list exactly the files in §48 as modified or untracked.
3. Optionally, `git remote -v` to confirm the GitHub remote.
4. If a copy already exists on the PC:
   - do **not** unpack over it;
   - unpack next to it;
   - compare with `git log` and `git status` in both;
   - keep whichever has newer commits, and copy over any uncommitted work from the other.

**Consolidation:** no conflicting copies were found here, so none were needed.

## 7. Git branch, commit, remote and status (frozen baseline)

VERIFIED FACT at 2026-11-26T03:15:32Z:

| Item | Value |
|---|---|
| Branch | `ccr-3670aed0-joz4xe` (tracking `origin/ccr-3670aed0-joz4xe`; ahead 0, behind 0) |
| HEAD | `93aa3328a51149e4f87552789bf2f77c8d1a8000`, "Sub-agents drawn like Jarvis: each agent is a mini intelligence core" |
| Other local branch | `claude/compassionate-euler-5rmclz` |
| History | 60 commits |

`git status --short` at freeze:

```
 M HANDOFF.md
 M README.md
 M docs/ARCHITECTURE.md
 M server/api/routes.ts
 M server/api/server.ts
 M server/app.ts
 M server/core/events.ts
 M server/core/settings.ts
 M server/db/database.ts
 M server/db/migrations.ts
 M server/intelligence/jarvis.ts
 M server/llm/engine.ts
 M server/main.ts
 M server/tasks/engine.ts
 M server/tasks/store.ts
 M web/src/components/JarvisView.tsx
 M web/src/components/Orbit.tsx
 M web/src/lib/api.ts
 M web/src/motion/jarvis-view.css
 M web/src/pages/Home.tsx
 M web/src/pages/Settings.tsx
 M web/src/pages/Tasks.tsx
?? docs/HERMES.md
?? docs/research/            (added at freeze: Hermes/OpenJarvis research reports, demo log and script)
?? scripts/install-hermes.sh
?? server/harness/           (hermes_bridge.py, hermes.ts, model-endpoint.ts, profiles.ts, capabilities.ts)
?? tests/harness.test.ts
?? JARVIS_MASTER_HANDOFF.md  (this file)
```

All of these are the Hermes harness integration (§18), plus this handoff.

## 8. Existing architecture

HISTORICAL FACT; full detail in `docs/ARCHITECTURE.md` and `HANDOFF.md`.

```
 Electron (desktop/main.cjs) ── forks ──▶ dist-server/server/main.js (compiled service)
 Browser / Electron window ◀── HTTP + SSE (127.0.0.1, token + Host/Origin checks) ──▶ server/api
 server/app.ts (JarvisApp) wires:
   RoamiesEngine (llm/engine.ts) — the model: OpenJarvis (default) | Roamies sign-ins | local servers
   Jarvis (intelligence/jarvis.ts) — chat turns, context, inline read-only tools, plan_task
   TaskEngine (tasks/engine.ts) + TaskStore — the one task lifecycle
   Planner (agents/planner.ts) — LLM or rule-based plans of skill steps
   SkillRegistry + SkillRunner (skills/) — the ONLY path that executes anything
   PermissionEngine (permissions/engine.ts) — scopes, policies, approvals, grants, critical actions
   MemoryStore (memory/store.ts) — SQLite + FTS5 + local embeddings
   SubAgentManager (agents/subagents.ts) — Friday, Tom, Neo, Sentinel, Echo, Trinity
   Scheduler, McpManager, ObsidianSync, VoiceWorkers, ComputerAccessManager,
   HackerOneService + BountyOrchestrator, MobileGateway
   [uncommitted] HermesHarness + HarnessModelEndpoint (server/harness/)
```

## 9. Frontend

HISTORICAL FACT (TESTED by e2e at commit `93aa332`):
- **Stack:** React 19, Vite 8, TypeScript, lucide-react; hand-written CSS in `web/src/styles.css`.
- **Motion layer:** GSAP 3.15 + @gsap/react, Lenis 1.3 and vendored React Bits components (`web/src/motion/`,
  `web/src/components/bits/`).
- **Default view:** the **Jarvis-only view** (`web/src/components/JarvisView.tsx`). It shows the core
  in a targeting HUD, the six agents as mini cores, the state, the latest answer and the voice/command
  bar. `\` or the "Interface" button toggles the full interface (Home, Tasks, Pipeline, Memory, Skills,
  Integrations, Activity, Settings).
- **[uncommitted] UI wiring for the harness:**
  - harness status and live Hermes activity in the Jarvis view and the core panel;
  - Hermes/Native and owner badges on tasks;
  - a Settings → Agent harness card.
- **Licensing note (DECISION pending, owner):** React Bits is "MIT + Commons Clause" and GSAP uses its
  own no-charge licence. Possible tension with AGPL; both are recorded in NOTICE.md.

## 10. Backend

HISTORICAL FACT:
- **Runtime:** Node ≥22.18 with type-stripping (no enums, namespaces or parameter properties;
  `import type`; `.ts` extensions in imports).
- **Database:** SQLite via `node:sqlite`, with migrations in `server/db/migrations.ts`, currently up to
  v9 committed and **v10 uncommitted**.
- **[uncommitted] Migration v10:**
  - adds `tasks.harness`, `tasks.owner` and `tasks.harness_state`;
  - before any pending migration runs, `server/db/database.ts` now copies the existing database file to
    `<db>.before-v<N>.bak`.

## 11. Desktop

HISTORICAL FACT:
- `npm run desktop` builds web + server, then runs Electron. `desktop/main.cjs` forks
  `dist-server/server/main.js`.
- The server build output layout was changed to `dist-server/server` + `dist-server/shared` in commit
  `8e0a21a`, to fix `build:server`.
- Smoke test: `JARVIS_SMOKE_TEST=1` launches, checks, and exits. It PASSED on Linux under Xvfb in this
  project.
- **Known stale expectation (BROKEN in CI, not caused by this work):** the CI "locked" smoke test
  expects Jarvis to lock when Roamies is missing. Since the brain defaults to OpenJarvis (commit
  `6b04c74`), Roamies isn't required, so that expectation no longer holds.

## 12. Mobile / Android

HISTORICAL FACT; full detail in `docs/MOBILE.md`, `docs/adr/`, `relay/README.md`.

- **Remote PC mode:**
  - end-to-end encryption (AES-256-GCM) through a relay you host;
  - the PC only connects outward;
  - permanent pairing that survives restarts, until the user taps Unpair.
- **Independent Mobile mode:**
  - its own Room memory, tools, permissions, router, WorkManager and voice;
  - an on-device model: abliterated Gemma 4 E2B/E4B (v0.4.0, LiteRT-LM, native tool calling), with
    Qwen2.5 earlier;
  - on-device speech recognition;
  - phone control via an AccessibilityService. It **never controls games** and **never reads or types
    passwords**.
- **Latest APK built:** 0.4.0.
  - HISTORICAL FACT: it was delivered to the owner in chat when built.
  - It exists in the container at `dist/jarvis-mobile-0.4.0.apk` (86 MB, git-ignored).
  - It is **not** in the transfer archive; rebuild it with the Gradle steps in `docs/MOBILE.md`.
- **Limits:**
  - never run on a physical phone by the builder;
  - no background push of approvals;
  - cross-network use needs a TLS relay.
- **The new harness work does not touch mobile.** Independent Mobile mode does not depend on desktop
  Hermes (VERIFIED FACT: no mobile files changed).

## 13. APIs and entry points

HISTORICAL FACT unless marked.

**Commands:**
- `npm run app`: dev launcher (`scripts/launch.ts`).
- `npm start`: service only (`server/main.ts`).
- `npm run desktop`: Electron.

**HTTP API:**
- `/api/*`, with the per-start token embedded in the page, plus Host/Origin checks.
- Live events: `GET /api/events` (SSE).
- Key routes: `/api/chat`, `/api/tasks`, `/api/approvals`, `/api/subagents`, `/api/skills`,
  `/api/settings`, `/api/status`, `/api/computer`, `/api/integrations`, `/api/roamies*`, `/api/about`.
- **[uncommitted]:**
  - `GET /api/harness`;
  - `GET /api/capabilities[?agent=]`;
  - `POST /api/tasks` accepts `agent` and `harness`;
  - `POST /harness/v1/chat/completions`: a loopback model endpoint for Hermes, requiring a per-run
    bearer token.

**Mobile:** through `server/mobile/gateway.ts` ⇄ relay.

## 14. Existing task engine

HISTORICAL FACT (TESTED):
- **States:** `queued → running → (awaiting_approval | paused) → completed | failed | cancelled`, with an
  event history.
- **Steps:** each step is a skill call, run by `SkillRunner`, which checks in order:
  1. role allow-list;
  2. input validation;
  3. permission decision;
  4. approval;
  5. timeout/cancel;
  6. verification;
  7. audit log.
- **Recovery:** after a crash, steps that are safe to repeat are re-queued; anything else becomes
  "uncertain" and the user chooses retry or skip.
- **Other features:** per-resource locks, deduplication, scheduling and recurrence. "Part of what you
  asked" (RequestScope) lets steps that are part of the user's own request run without a second approval.

**[uncommitted, PARTIALLY IMPLEMENTED] `TaskEngine.executeHarness`:**
- Open-ended tasks (no explicit steps) run Hermes's loop.
- Every Hermes tool call becomes a step of the same task, under the same runner, permissions, approvals
  and audit log.
- Live approval waits; deny tells Hermes no; pause, cancel and resume work.
- Conversation state is stored on the task.
- Falls back to the native planner when Hermes is unavailable.

## 15. Agent registry and lifecycle

HISTORICAL FACT:
- **Internal roles** (`server/agents/agents.ts`): jarvis (coordinator), planner, researcher, executor,
  memory, verifier. These are least-privilege roles for skill steps.
- **The six named agents** (`server/agents/subagents.ts`):
  - background specialists on timers (`SubAgentManager`), gated by `agents.enabled` and
    `background.enabled`;
  - each stores findings as memories tagged `agent:<id>`;
  - each has a vault page `Agents/<Name>.md`;
  - API: `GET /api/subagents` and `POST /api/subagents/:id/run`.
- **[uncommitted]** `server/harness/profiles.ts`: each agent can own a Hermes task with only its own
  skill allow-list.

## 16. The seven permanent agents

VERIFIED FACT from code. Jarvis is the coordinator; the other six are in `server/agents/subagents.ts`.

| # | Agent | Colour | Role (from code) | Background interval | Status |
|---|---|---|---|---|---|
| 1 | **Jarvis** | purple core | Coordinator: understands requests, retrieves context, delegates, answers. Inline: read-only/internal skills only; everything else becomes a task. | n/a | IMPLEMENTED |
| 2 | **Friday** | `#ef4444` | "Scout — tracks what we earn, what we spend and whether we are in profit." | 10 min | IMPLEMENTED |
| 3 | **Tom** | `#22d3ee` | "Hunter — finds newly launched, small bug-bounty programs." | 15 min | IMPLEMENTED |
| 4 | **Neo** | `#15803d` | Monitor: tasks/pipeline watch, key presence, documents runs. | 5 min | IMPLEMENTED |
| 5 | **Sentinel** | `#f59e0b` | "Guard — keeps the list of authorized, in-scope programs so Jarvis never tests out of scope." | 30 min | IMPLEMENTED |
| 6 | **Echo** | `#a855f7` | "Reporter — compiles the team's findings into one running digest." | 20 min | IMPLEMENTED |
| 7 | **Trinity** | `#f43f5e` | "Operator — the security specialist. Knows all 90 Kali tools and the ethical-hacking methodology; plans and (when authorized) runs live testing against in-scope bug-bounty programs." | 30 min | IMPLEMENTED |

## 17. Roles, prompts, responsibilities and unknowns

- **Jarvis:** VERIFIED FACT. The prompt is `SYSTEM_PROMPT` in `server/intelligence/jarvis.ts`.
- **The six agents (VERIFIED FACT):**
  - Their background jobs are mostly **deterministic code, not LLM prompts**: they summarise pipeline,
    tasks, memory and keys.
  - **Trinity** uses the local model with its knowledge base (`server/agents/knowledge/ethical-hacking-kb.md`,
    `kali-arsenal.md`).
  - Trinity's live testing requires all of: the `agents.offensive` switch, full PC access, Sentinel's
    in-scope list, and approvals.
- **[uncommitted] Harness briefs** (`server/harness/profiles.ts`):
  - each is the agent's role text;
  - `security.operate` and `hackerone.submit_report` are allowed **only for Trinity**;
  - no profile may call `llm.generate`.
- **UNKNOWN:** whether the owner intended richer persona prompts for the six agents beyond these roles.
  None exist in the repo.

## 18. Existing AI / model integrations

HISTORICAL FACT unless marked.

- **OpenJarvis** (`open-jarvis/OpenJarvis`, Apache-2.0): the **default brain**.
  - Jarvis calls its OpenAI-compatible `/v1/chat/completions` and **runs every tool itself**.
  - It also uses `/v1/models`, `/health`, `/v1/speech/transcribe` (Whisper) and `/v1/speech/synthesize`
    (Kokoro).
  - Code: `server/llm/openjarvis.ts`. Setup: `scripts/local-setup/`, `docs/LOCAL_SETUP.md`.
- **Roamies engine** (optional): gg-ai providers via Roamies sign-ins, including the **Claude Code
  bridge** route, and local OpenAI-compatible servers (Ollama, LM Studio, llama.cpp) added under
  Integrations → Model.
- **Hermes Agent** (NousResearch, MIT) as the **agent harness**: uncommitted, PARTIALLY IMPLEMENTED.
  - **What it does.** Jarvis embeds Hermes's `AIAgent` through its own bridge
    (`server/harness/hermes_bridge.py`). It does not use `hermes acp`, `hermes chat` or the API server,
    because those start Hermes's gateway daemon with its own sessions, approvals and cron.
  - **Locked down:**
    - Hermes's only tools are Jarvis skills; the bridge asserts the exact tool list.
    - Hermes thinks through Jarvis's model endpoint.
    - Hermes memory, background review, context files, rules, delegation and tool search are off.
  - **Install:** `scripts/install-hermes.sh`, pinned commit `38fde82474b5d370590e314358cc05076dc9ae70`.
    It uses Python 3.14 and `uv sync --frozen`. Tested on Linux in this container.
  - Full design: `docs/HERMES.md`. Research: `docs/research/hermes-integration/`.
- **OpenJarvis's own agents, schedulers, tools, approvals, memory and skills:** rejected as duplicates
  (DECISION; reasons in `docs/HERMES.md` and `docs/research/hermes-integration/B-openjarvis.md`).
- **Mobile on-device models:** see §12.

## 19. Ollama / local models

- **HISTORICAL FACT:**
  - OpenJarvis drives Ollama by default.
  - Jarvis warns when a local model is served with too little context (`MIN_LOCAL_CONTEXT`).
  - The setup profiles pick models by RAM.
- **VERIFIED FACT (this container):** a real run used **Qwen3 1.7B Q8 on llama.cpp `llama-server` b12608**,
  64K context with YaRN, with Hermes through Jarvis. Jarvis read the 64K window from the server itself.
- **Not part of the project:** those model files and binaries were in the container's scratch space only.
- **UNKNOWN:** which models are installed on the owner's PC.

## 20. Claude integration and authentication status (no secrets)

- **HISTORICAL FACT:** Claude is reachable only through **Roamies** sign-ins (gg-ai: "Sign in with
  Claude" / API key, stored by Roamies under its own `~/.gg`). Jarvis stores no Claude credential itself.
- **HISTORICAL FACT:** the Claude Code bridge route is a whole agent, so it **cannot** be Hermes's model.
  `completeOnce` refuses it.
- **UNKNOWN:** whether the owner's PC has an active Roamies/Claude sign-in.

## 21. Model-routing goals

- **DECISION (HISTORICAL):** local-only by default. Cloud models, cloud voice and cloud transcription
  are refused unless the owner turns local-only off.
- **Owner's newest requirements (§43, PLANNED):**
  - one shared local inference runtime for Hermes and OpenJarvis;
  - no silent cloud fallback;
  - concurrency-aware queueing.
- **CURRENT OBSERVATION:** Hermes needs ≥64K served context and a tool-calling model.
- **CURRENT OBSERVATION:** small local models (1.7B) plan poorly (§37).

## 22. Agent collaboration

- **IMPLEMENTED:**
  - The six agents share one memory ("shared knowledge mind").
  - Echo digests the others.
  - Sentinel's scope list gates Trinity.
- **PARTIALLY IMPLEMENTED (uncommitted):**
  - Hermes runs tasks "as" an agent.
  - `/api/subagents` reports an agent's live Hermes work.
- **PLANNED, not started:** the multi-agent organization (Hermes CTO ⇄ OpenJarvis ⇄ Auditor) with
  pre-execution plan review, workstreams, messaging, audits and file locks (§43).

## 23. Living Mind and memory

- **HISTORICAL FACT: memory.** `server/memory/store.ts` holds SQLite memories by kind:
  rule, preference, plan, schedule, idea, project, decision, procedure, fact, task_history, tool_doc.
  - Search is hybrid FTS5 + local embeddings (all-MiniLM-L6-v2 via onnxruntime).
  - Unverified vs verified flags.
  - Standing rules are always in context.
  - Every conversation is digested (`server/agents/digest.ts`).
  - Conversations are kept forever by default.
- **HISTORICAL FACT: the Obsidian vault "Jarvis Vault".**
  - Jarvis writes it automatically (`server/integrations/obsidian.ts`).
  - Location: configured path, or `JARVIS_VAULT_DIR`, or `~/Documents/Jarvis Vault`.
  - Folders: `Conversations/`, `Digests/`, `Agents/<Name>.md`, and docs.
  - Edits to memory notes are imported back.
- **HISTORICAL FACT: mobile.** It has its own "live brain" notes vault (§12).
- **UNKNOWN:** whether "Living Mind" is the owner's name for this memory + vault system, or a separate
  concept. The term appears nowhere in the repository. ASSUMPTION: it refers to the above.

## 24. Existing tools and MCP

**Skills: VERIFIED FACT** (from the registry at runtime in this project):

| Group | Skills |
|---|---|
| Calendar | `calendar.events`, `calendar.create_event` |
| Email | `email.read`, `email.search`, `email.send` |
| Files | `files.list`, `files.read`, `files.search`, `files.write` |
| Obsidian | `obsidian.read`, `obsidian.search`, `obsidian.write_note` |
| Memory | `memory.remember`, `memory.search`, `memory.forget` |
| Model | `llm.generate` |
| Tasks | `tasks.list` |
| HackerOne | `hackerone.earnings`, `hackerone.programs`, `hackerone.reports`, `hackerone.scopes`, `hackerone.submit_report` |
| Security | `security.toolkit`, `security.operate` |
| Shell | `shell.run` |
| Computer | `computer.recall`, `computer.app`, `computer.click_text`, `computer.control`, `computer.workflow`, `computer.capabilities`, `computer.watch`, `computer.find_on_screen`, `computer.learn`, `computer.observe`, `computer.telemetry`, `computer.browser`, `computer.browser_read` |
| System | `notify.user`, `system.status` |
| Web | `web.fetch` |

- **MCP:** an MCP client (`server/integrations/mcp.ts`) registers server tools as `mcp.<server>.<tool>`
  skills, under the same runner and permissions (HISTORICAL FACT, TESTED by `tests/mcp.test.ts`).
- **[uncommitted]** `server/harness/capabilities.ts` + `GET /api/capabilities`: a unified capability view
  over that one registry.

## 25. Skills / repositories previously discussed

**Integrated or evaluated in this project (HISTORICAL FACT):**

| Repository | Use |
|---|---|
| `open-jarvis/OpenJarvis` | brain/voice |
| `KenKaiii/Roamies` | engine |
| `NousResearch/hermes-agent` | harness |
| GSAP, Lenis, React Bits (`DavidHDev/react-bits`) | UI |
| llama.cpp | demo runtime only |

**UNKNOWN:** any other list of skills or repositories the owner discussed in conversations not
available to this session.

## 26. The original 12-repository skills list

**UNKNOWN / NOT RECOVERABLE by this session.** No such list exists in the repository, its docs or its
history. It is not in the context available to the freezing session (earlier parts of the conversation
were summarised). The owner needs to provide it again.

## 27. Honorable mentions

**UNKNOWN.** Same situation as §26.

## 28. Discord history and requirements

**UNKNOWN.** The word "Discord" appears nowhere in the repository, and no Discord requirement is in the
context available to this session. Nothing Discord-related is implemented.

## 29. Existing UI / design direction

HISTORICAL FACT (owner's direction, implemented):
- **Look:** near-black, deep purple, violet and electric purple. Cinematic, "high-tech" HUD, restrained
  motion.
- **Honesty:** every animation reflects real state; no fake progress or activity. Reduced motion is
  respected.
- **Default view:** Jarvis-only, with the interface toggleable.
- **Agents:** sub-agents drawn as mini Jarvis cores in their own colours.
- **Rejected looks:** generic SaaS look, excessive glow or glassmorphism, constant meaningless animation.
- **Owner's newest requirement (§43, PLANNED):** organization visibility in the same design language,
  not a separate dashboard.

## 30. Voice

HISTORICAL FACT:
- **Engines:**
  - local Whisper (speech-to-text) and Kokoro (text-to-speech) via OpenJarvis;
  - optional **Fish Audio** text-to-speech (`server/integrations/fishaudio.ts`; key via `.env`);
  - browser speech as a fallback.
- **Features:** wake word ("Hey Jarvis"), voice-first command bar, pause detection.
- **Workers:** `server/voice/workers.ts` + `voice_worker.py`.
- **Tests:** a voice e2e exists.

## 31. Scheduler and autonomous capabilities

HISTORICAL FACT:
- `server/scheduler/scheduler.ts` runs these background jobs:
  - task monitor;
  - memory maintenance;
  - health checks;
  - sub-agent ticks;
  - vault sync;
  - conversation digester.
- **Autonomous bug-bounty orchestrator** (`server/agents/orchestrator.ts`): the self-driving hunt loop,
  gated by `agents.autoHunt` and `agents.autoSubmit`.
- **Recurring tasks:** "every N minutes" or "daily at HH:MM".
- **[uncommitted]** A recurring Hermes task repeats as open-ended work, not as a replay of the previous
  run's steps.

## 32. Security and permissions

HISTORICAL FACT; enforced in code:
- **Permission engine:** scopes and policies (allow/ask/deny), approvals, grants bound to the exact input
  hash, and critical-action confirmation (send/pay/delete/install/admin). Full Access mode does **not**
  bypass critical confirmations unless the owner turns that off.
- **Third-party protection:**
  - untrusted-content wrapping (prompt injection);
  - API token plus Host/Origin checks;
  - loopback-only DevTools with a cookie/storage block;
  - a Computer Access emergency STOP.
- **Mobile:** end-to-end encryption, scopes, idempotency, replay window, rate limits and an audit trail.
- **[uncommitted] Hermes boundary:**
  - Hermes gets only Jarvis skills.
  - It runs with a minimal environment (no secrets), its own `HERMES_HOME`, and an empty non-git working
    directory.
  - Project rules are off, and its config is locked down on every run.
  - `/` and `@` text expansion is neutralised.
  - The model endpoint takes only a per-run token.

## 33. Approval gates

HISTORICAL FACT:
- A step that needs approval creates a single-use approval bound to the task, the step and the exact
  input hash.
- Approve → the step runs once. Deny → the native task is cancelled.
- "Always allow this exact action" → a grant.
- "Part of what you asked" coverage auto-approves steps inside the user's own request, except critical
  actions.
- Approvals happen only through Jarvis's approval controls; never through chat, voice or tool output.

[uncommitted] For Hermes tasks:
- approval is the same, with the run waiting live;
- deny → Hermes is told no and the task continues;
- a restart during the wait → the task pauses.

## 34. Testing

**Commands:**
- `npm run typecheck`
- `npm test` (unit/integration, `tests/**/*.test.ts`)
- `npm run test:e2e` (UI, voice, computer, mobile; Playwright)
- `npm run build`, `npm run build:server`
- Mobile: Gradle tests under `mobile/android` (see `docs/MOBILE.md`)

**Last results:**

| When | Result | Label |
|---|---|---|
| At commit `93aa332` (before the Hermes work) | `npm test`: **190 tests, 187 pass, 0 fail, 3 skipped**; all 4 e2e suites **passed**; build passed; Electron smoke passed (Linux) | HISTORICAL FACT |
| During the Hermes work | `tests/harness.test.ts` **7/7 passed** against real Hermes with the scripted test model | HISTORICAL FACT |
| At freeze | `tsc` server + web **pass** on the frozen tree | VERIFIED FACT |

**NOT re-run after the last harness edits (UNVERIFIED):**
- the full `npm test`, `test:e2e` and `tests/harness.test.ts`;
- the build.

The last edits were:
- the model-endpoint "patience" retry;
- the clearer model-error text;
- the recurrence fix;
- the UI harness wiring.

## 35. Existing working features

IMPLEMENTED + TESTED, HISTORICAL FACT as of `93aa332`:
- chat with memory and context;
- background tasks with approvals, verification and recovery;
- the six agents;
- the memory, digest and vault pipeline;
- OpenJarvis local brain and voice;
- MCP client;
- Computer Access:
  - observe/interact on Linux/X11;
  - browser control;
  - a watch-and-learn pipeline;
  - the critical-action gate;
- HackerOne pipeline and orchestrator;
- the desktop app;
- the mobile app (JVM-tested);
- the Jarvis-only HUD UI with motion.

## 36. Partially implemented features

- **Hermes agent harness:** PARTIALLY IMPLEMENTED, uncommitted. Done:
  - bridge, endpoint, profiles, capability view, task-engine path;
  - migration with backup;
  - UI wiring and installer;
  - docs and tests.

  Missing:
  - re-running all suites after the last edits;
  - Windows installer (`scripts/install-hermes.ps1` does not exist);
  - a successful real-model demo that performs the intended steps (§37);
  - OpenJarvis telemetry adapter (deferred).
- **Computer Access:** Windows/macOS adapters are written but UNVERIFIED on real hardware. No native
  accessibility trees, no Wayland input.
- **Mobile:** never run on a physical phone. Streaming replies are defined but not used.
- **Gmail and PayPal connectors:** PLANNED (HANDOFF.md §8).

## 37. Bugs and known issues

- **BROKEN: CI desktop locked-mode smoke test.** The expectation is stale since OpenJarvis became the
  default brain.
- **Real-model Hermes run (VERIFIED FACT, this container).** Setup: Qwen3 1.7B, llama-server, Hermes via
  Jarvis.
  - The task completed in 759 s, but the model searched memory with `kind: "fact"` while the note was a
    `preference`. It found nothing, did not write the file, and reported "nothing found".
  - The plumbing worked; the small model's judgment did not.
  - Log: `docs/research/hermes-integration/real-model-demo.log`.
- **Busy local servers look unavailable.** Jarvis's health probe can mark a busy single-threaded local
  server as unavailable. Mitigated for Hermes by a 2-minute retry in `model-endpoint.ts`; that mitigation
  is UNVERIFIED.
- **Model request timeout too short for slow CPU models (OPEN).** `llm.requestTimeoutSec` (default 180 s)
  can cut off long CPU prompt processing of Hermes's ~3.8K-token prompt. A planned fix (a higher minimum
  timeout for harness calls) was **not implemented** at freeze.
- **Bundle size.** The JS bundle grew to about 218 kB gzip after the UI motion work.

## 38. Failed experiments

All HISTORICAL FACT.

- **Hermes install paths that don't work:**
  - Hermes on Python 3.13: its dependencies are pinned only for 3.14, so it installs incompletely.
  - `pip install` of Hermes: wheel builds are refused and the pins conflict (pillow). Use
    `uv sync --frozen`.
  - Hermes `acp`/CLI/API server as the embedding: rejected because they spawn Hermes's gateway and cron.
- **Demo model servers that didn't work:**
  - llama-cpp-python as the demo server: it can't stream automatic tool calls, and `logits_all` tried to
    allocate 37 GB.
  - The Ollama Linux package is now a 1.5 GB `.tar.zst`; the old `.tgz` URL returns 404.
- **Earlier mobile work:**
  - The OpenCL failure on the phone, fixed in 0.3.1.
  - The Fortnite/game-playing automation the owner asked for was **declined**: game rules and anti-cheat,
    and real-time play is infeasible. Phone control blocks games.

## 39. Decisions and rationale

All DECISION / HISTORICAL FACT.
- **Jarvis keeps authority** over tasks, permissions, approvals, memory and the model. Hermes is
  embedded as the loop only. *Why:* one orchestrator; no bypass of the owner's approvals.
- **Hermes thinks through Jarvis's engine, not straight to OpenJarvis.** *Why:* OpenJarvis's chat route
  redacts email addresses inside messages (including tool arguments), injects memory, and can drop tools
  on engine errors.
- **The six agents keep their native background jobs.** They own Hermes tasks only through profiles.
  *Why:* their jobs are deterministic and cheap; converting them to LLM sessions would add cost and risk.
- **Trinity's security authority is preserved;** security actions are offered only to Trinity's profile.
- **Never guess a 64K context window.** If it's unknown, use the native planner.
- **No content guardrails added by Jarvis** (owner's rule); authorization controls stay.

## 40. Outstanding tasks

In order:
1. Restore the frozen tree on the PC (§6), then decide whether to commit it.
2. Re-run `npm run typecheck`, `npm test`, `npm run test:e2e`, `npm run build` and `npm run build:server`.
   Then run `JARVIS_HERMES_PYTHON=<hermes>/.venv/bin/python node --test tests/harness.test.ts`. Fix what
   fails.
3. Raise the model timeout for harness calls on slow local servers (§37).
4. Install Hermes on the PC (Linux/macOS script exists; Windows: write and test `install-hermes.ps1`).
5. Run a real end-to-end Hermes task on the PC's real model. Ensure ≥64K served context; set
   `OLLAMA_CONTEXT_LENGTH`, or Settings → Agent harness → Context for OpenJarvis.
6. Then the queued **AI organization mission** (§43).
7. Earlier backlog (HANDOFF.md §8): Gmail and PayPal connectors, Computer Access on Windows/macOS,
   Neo surfacing observations, MCP presets.

## 41. Blockers

- **BLOCKED (this session):**
  - no access to the owner's PC;
  - no permission to commit/push.
- **For Hermes:**
  - Python 3.14 + `uv` + git are needed on the PC;
  - Windows support of Hermes's runtime is UNVERIFIED.

## 42. Risks

- **Uncommitted work lost** if the archive isn't restored and the container is reclaimed.
- **Hermes upstream churn.** Its embedding API is a ~70-argument constructor; keep the pinned commit and
  re-run `tests/harness.test.ts` on every bump.
- **Licensing questions:** React Bits / GSAP vs AGPL (§9).
- **Small local models are unreliable planners** for agentic work.

## 43. Future roadmap (the queued mission — NOT STARTED)

The owner's next mission (received, frozen, **no work done**): "Autonomous AI organization".
- **Hierarchy:**
  - Owner (CEO) → Jarvis (executive assistant, UI, task intake, reporting).
  - Jarvis → **Hermes CTO**, provisioned as a real Hermes agent with its own identity, config, memory,
    skills and learning.
  - Hermes → **OpenJarvis** (technical collaborator with a separate identity, reviewing and executing
    workstreams).
  - Hermes → **Hermes Auditor** (independent reviewer with its own context: plan, decision,
    implementation, evidence and final audits; verdicts APPROVED / APPROVED_WITH_WARNINGS /
    REQUIRES_CORRECTIONS / REJECTED; severities; bounded correction loop).
- **Workflow:**
  1. One parent task in Jarvis's task system.
  2. Mandatory pre-execution coordination: Hermes plans → OpenJarvis reviews → discussion → audit if
     significant → agreed plan persisted.
  3. Workstreams with owners and statuses (PLANNING … CANCELLED).
  4. Parallel execution, with persistent bidirectional messaging tied to task IDs.
  5. Dynamic replanning.
  6. File ownership and locks.
  7. Cancellation propagation.
- **Shared resources:**
  - **one Obsidian vault** used by both, the same physical path;
  - **one local inference runtime**, with concurrency and queueing, separate contexts, **no silent cloud
    fallback**.
- **Constraints:**
  - preserve the six agents and Trinity's authority;
  - preserve all permissions;
  - mobile Independent mode must not depend on desktop agents.
- **Visibility and validation:**
  - organization visibility in the Jarvis UI;
  - a real end-to-end demonstration;
  - failure testing;
  - an honest final report.

Starting point: the uncommitted harness already provides the Jarvis ⇄ Hermes task path, profiles,
capability view and model endpoint. The organization layer (messaging, workstreams, Auditor,
OpenJarvis as an agent, shared vault for Hermes) is **not** built.

## 44. Run / setup / test commands

From `package.json`, HISTORICAL FACT; not re-run at freeze:

| Command | What it does |
|---|---|
| `npm ci` | install |
| `npm run app` | run, dev launcher |
| `npm start` | service only |
| `npm run desktop` | Electron |
| `npm run build` / `npm run build:server` | builds |
| `npm run typecheck` | typecheck |
| `npm test` / `npm run test:e2e` | tests |
| `npm run dist` | desktop installer (electron-builder) |
| `scripts/local-setup/` | one-command local OpenJarvis setup (see `docs/LOCAL_SETUP.md`) |
| `scripts/install-hermes.sh` | [uncommitted] Hermes install, Linux/macOS |

## 45. Important file paths

**Documentation:**
- `README.md`
- `HANDOFF.md` (the long-running engineering handoff, with the full history of commits and phases)
- `docs/ARCHITECTURE.md`, `docs/HERMES.md`, `docs/MOBILE.md`, `docs/LOCAL_SETUP.md`
- `docs/COMPUTER_ACCESS*.md`, `docs/adr/`, `docs/research/hermes-integration/`

**Service:**
- `server/app.ts`, `server/main.ts`
- `server/tasks/`, `server/skills/`, `server/permissions/`
- `server/agents/`, `server/memory/`, `server/llm/`
- `server/harness/`, `server/integrations/`, `server/computer/`, `server/mobile/`

**Other code:**
- `web/src/` (`App.tsx`, `components/JarvisView.tsx`, `components/Orbit.tsx`, `components/AgentCore.tsx`,
  `motion/`)
- `desktop/main.cjs`, `relay/`, `shared/protocol/`, `mobile/android/`
- `tests/`, `tests/e2e/`

## 46. Must not be changed, deleted or discarded

- The uncommitted harness work until it is restored and evaluated, and this file.
- The seven agent identities, roles and colours.
- Trinity's security authority and Sentinel's scope gate.
- The permission engine, approvals, critical-action confirmation, grants and the audit log.
- Local-only default; no silent cloud fallback.
- **The owner's rule: no added content guardrails;** authorization controls stay.
- "Memory never forgets": the digester, standing rules, conversation retention, vault `Conversations/`
  and `Digests/`.
- Mobile: Independent mode independent of the PC; never control games; never read or type passwords.
- Git history (no rewrites or force pushes); the GitHub remote.
- Database files and backups (`*.before-v*.bak`).

## 47. Recommended immediate next steps for the next session (Hermes)

1. Restore the archive on the PC (§6); verify `git status` matches §48.
2. `npm ci`, then all checks in §40, step 2. Record real results.
3. Read `docs/HERMES.md` and `docs/research/hermes-integration/*.md` before touching the harness.
4. Finish the Hermes phase:
   - timeout fix;
   - Windows installer;
   - real end-to-end task on the PC's model;
   - commit (with the owner's consent).
5. Only then start the organization mission (§43), building on the existing task engine and harness
   rather than adding a second task system.

## 48. Transfer status and frozen baseline

**Freeze:**
- 2026-11-26T03:15:32Z, machine `vm` (cloud container), `/home/user/jarvis`.
- Branch `ccr-3670aed0-joz4xe` @ `93aa332`, in sync with GitHub.

**State of activity at freeze:**
- **Development:** stopped. No subagents, loops or Claude-started processes were running. The session
  had just restarted. The earlier research agents had completed; the demo model server and runs were no
  longer running.
- **Interrupted work:** Hermes harness phase (§36). Not resumed.
- **Not started:** the organization mission (§43).
- **Uncommitted:** all files in §7. Typecheck passes. **Not committed or pushed**: refused by the
  environment's permission policy, and the session did not work around that.

**Transfer:**
- A transfer archive was produced: the full repo with `.git` and all uncommitted/untracked files, minus
  `node_modules/` and build outputs.
- It was delivered to the owner as a download.
- **Not placed on the PC directly:** BLOCKED, no machine access.

**Not done (by instruction):** no dependency installs, no setup scripts, no new features, no Hermes start.
