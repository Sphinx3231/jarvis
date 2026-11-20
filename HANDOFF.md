# Jarvis — Handoff

_Last updated: 2026-11-15 · Branch: `claude/compassionate-euler-5rmclz` (this is the working/default branch) · Repo: `Sphinx3231/jarvis`_

Jarvis is a persistent, local-first AI "personal operating system" (purple/dark theme) built on the
**Roamies** engine (the `gg-framework`). It runs as a desktop app (Electron) on the user's own
machines (Kali Linux + Windows 11) and thinks with whatever model Roamies is signed into — including
**local models** (Ollama/LM Studio). Guardrails come from the connected model; Jarvis adds none.

> **The app is deliberately useless without Roamies.** On launch it shows only a "Jarvis runs on
> Roamies" lock screen with an install link until Roamies is detected. Licensed **AGPL-3.0**.

---

## 1. Quick start (dev, in this repo)

Requires **Node ≥ 22.18** (uses native TypeScript type-stripping — `.ts` is run directly, no bundler
for the server — plus `node:sqlite`). Zod v4.

```bash
npm install
npm run app          # launches server + opens the UI (scripts/launch.ts)
npm test             # 121 unit + integration tests (node --test, concurrency 1)
npm run build        # builds the web UI (vite → web/dist)
npm run typecheck    # tsc for server + web
npm run test:e2e     # Playwright e2e (ui.e2e.ts + voice.e2e.ts); Chromium is pre-installed
```

E2E screenshots: set `E2E_SCREENSHOTS=<dir>` (and `E2E_SCALE=2` for retina shots). The e2e boots a
real Jarvis on a temp dir, drives the built UI in Chromium, and asserts real behavior.

**Current status:** typecheck clean · 121/121 tests pass (incl. real X11 integration) · both e2e flows pass.

---

## 2. Architecture (where things live)

```
server/
  main.ts                 startJarvis(): HTTP server + SSE event bus; loads .env
  app.ts                  JarvisApp: wires every subsystem together
  core/
    settings.ts           zod-validated settings + defaults (single source of truth)
    env.ts                .env loading + ENV_SECRET_FALLBACK (API keys → secret store)
    secrets.ts            encrypted-on-disk secrets, with .env fallback
    events.ts, activity.ts
  permissions/engine.ts   scopes + policies; decide(); full-access short-circuit
  tasks/                  task engine (plan → steps → verify), scheduler
  memory/store.ts         SQLite FTS5 + embeddings; list / keywordSearch / semanticSearch / retrieve
  skills/
    types.ts              Skill interface (scope, risk, availability, execute, verify, describe)
    builtin/              files, shell, web, model, memory, system, security  ← skills
    registry.ts, builtin/index.ts   registration
  agents/
    agents.ts             internal task-step agents (planner/executor/…); AGENTS roster
    subagents.ts          the 6 named background sub-agents (SUB_AGENTS + SubAgentManager)
    knowledge/            Trinity's knowledge base (see §5)
  integrations/           email, calendar, hackerone (bug-bounty pipeline), fishaudio (TTS),
                          mcp, obsidian (vault sync)
  computer/               Computer Access Mode (see §12): types.ts, exec.ts (run/hasBinary/pngSize),
                          adapters.ts (Linux/Win/macOS telemetry+windows), capture.ts (screenshots),
                          ocr.ts (tesseract), input.ts (xdotool/osascript/PowerShell),
                          probe-image.ts (OCR self-test), learning.ts (watch-and-learn pipeline),
                          manager.ts (ComputerAccessManager: gating, telemetry, observe, verify,
                          control, STOP), skills.ts
  llm/engine.ts           RoamiesEngine: generate()/stream(), model discovery, health
  api/routes.ts           all HTTP routes
web/src/
  App.tsx                 shell, routing, immersive mode (backslash key)
  pages/Home.tsx          the stage: core + 6 agent nodes + portal + voice command bar + aside cards
  components/Core.tsx     the inline-SVG "JARVIS planet" rig (one rAF loop; wordmark/Saturn ring)
  pages/Settings.tsx, Integrations.tsx, Pipeline.tsx, Memory.tsx, Tasks.tsx, Skills.tsx, Activity.tsx
  styles.css              all CSS (stage/anode/core/immersive/command bar live here)
  lib/{api.ts,live.ts,voice.ts,router.ts}
desktop/main.cjs          Electron main (forks dist-server/main.js); no-sandbox on Linux-as-root
.github/workflows/desktop.yml   builds 3-OS installers; smoke tests (locked + unlocked, checks `.core`)
```

**Runtime shape:** the desktop app forks the compiled server (`dist-server/main.js`), which serves the
built web UI and a JSON+SSE API on localhost. The UI is token-gated to that local server.

---

## 3. The UI (command center)

- **Shell** (`components/Shell.tsx`):
  - The top bar spans the window: identity (orb + JARVIS / AI Operating System), the connection status
    (the only "Online" text in the app; the e2e tests wait on it), Computer Access, clock,
    notifications, Settings and the immersive toggle.
  - A slim icon rail (`.sidebar`, labelled links) replaces the old sidebar.
  - The window keeps its native frame, so there are no fake window controls.
- **Home** (`pages/Home.tsx`), a 3-column dashboard:
  - **Left:** System overview, with real CPU, RAM and Jarvis RSS from `/api/metrics`
    (`server/core/metrics.ts`) and sparklines of the samples; active tasks; recent activity.
  - **Centre:** the orbit stage (`components/Orbit.tsx`): the hero core and the six agents in
    holographic containers on an ellipse, with double orbit lines, an anchor ring and beam links.
    Geometry comes from the stage's measured size, so everything always lines up. A link carries
    packets, and an agent's ring spins, only while that agent is actually working. The voice-first
    command bar sits below.
  - **Hero core** (`<Core hero />`): a rotating neural network on a canvas (`drawPlexus`: a
    Fibonacci point sphere plus precomputed neighbour links, drawn in depth batches). Its pulse count,
    spin and tint follow the live state. Tick ring, segmented arcs and HUD frame in SVG. No
    wordmark; the e2e test checks the canvas keeps drawing (`data-frame`).
  - **Live HUD around the core:**
    - four gauges (CPU, memory, tasks running vs. the concurrency limit, agents ready);
    - a radar sweep, shown only while background monitoring is on;
    - telemetry corners (local clock, uptime, host and threads, monitor state and version);
    - a data plate under each agent (runs, last run).
  - **Dials** (`components/Hud.tsx`, inspired by a JARVIS phone launcher):
    - the arc-reactor emblem (header and launcher centre);
    - the clock dial, with real power status from the Battery Status API, hidden when unavailable;
    - segmented ring gauges for CPU and memory;
    - the radial **Quick launch** ring of real actions, with the hovered name shown in the centre.

    The stage's top-left corner shows the brain (model and provider) instead of a second clock.
  - **Type:** Rajdhani (`@fontsource/rajdhani`, bundled latin subsets) for labels, numbers and
    names; monospace for micro-readouts; Inter for body text.
- **Environment** (`components/Backdrop.tsx`): fixed behind the app. Light sources, a masked
  holographic grid, a perspective floor, concentric HUD rings, orbital arcs and particles. The big
  SVG is static (painted once); only 16 twinkles and one slow ring animate, on their own compositor
  layers.
  - **Right:** Jarvis core status, approvals, quick actions, the agents list (`.agents__row`, pinned
    by e2e) and insights.
  - Clicking an agent (disc or row) opens `AgentDetail`: role, latest result, last run, runs,
    errors and **Run now**.
  - Quick actions are real: they prefill commands, run every agent, start a new chat or go immersive.
- **Agent discs:** the `<button class="anode">` stays still and only its inner `.anode__disc`
  floats, so clicks (and Playwright) see a stable target. Agent status labels are
  Ready/Working/Paused/Error; never "Online" (see above).
- **Chat mode:** in a conversation the centre becomes a compact core (agent orbs) plus the
  transcript.
- **Immersive mode:** press **`\`**; the rail, top bar and side columns hide.
- **Motion:** reduced motion (OS setting or Settings → Appearance) stops every animation.
- **Core:** a real inline-SVG vector rig (`Core.tsx`): one `requestAnimationFrame` loop with eased
  per-state parameters, and a static pose under reduced motion.

**Voice:** wake word ("Hey Jarvis"), browser STT + optional Whisper transcription, and **Fish Audio**
TTS replies (`integrations/fishaudio.ts`). Keys load from `.env` (see §6).

**Full access mode** (Settings → Permissions, off by default, confirm to enable): a trusted-machine
override — `permissions.fullAccess` makes `decide()` allow everything with no sandbox/approvals
(whole-disk files via `resolvePath`, any website, shell). Loud red banner + warning insight. It grants
data/file/web/shell reach only — NOT control of other apps/screen/input.

---

## 4. The sub-agents (`server/agents/subagents.ts`)

Named background specialists, each with its own memory (findings stored as memories tagged
`agent:<id>`), shown as the colored satellite nodes. `SubAgentManager` runs them on its own tick
(gated by `agents.enabled` + `background.enabled`). Endpoints: `GET /api/subagents`,
`POST /api/subagents/:id/run`.

| Agent | Color | Role |
|---|---|---|
| **Friday** | red `#ef4444` | Profit scout — pipeline earnings vs. `agents.spendUsd`; flags a loss |
| **Tom** | cyan `#22d3ee` | Hunter — newly discovered paying programs (small, likely-unfound-bugs) |
| **Neo** | green `#15803d` | Monitor — tasks/pipeline watch, key presence, documents runs |
| **Sentinel** | amber `#f59e0b` | Guard — keeps the authorized in-scope program list |
| **Echo** | violet `#a855f7` | Reporter — digests the team's findings |
| **Trinity** | rose `#f43f5e` | Security operator (see §5) |

**Shared knowledge mind (Obsidian):** agent findings are plain memories Jarvis searches, and the vault
surfaces them per-agent at `Agents/<Name>.md` + an index `Agents/Agents.md` (generated in
`integrations/obsidian.ts → agentNotes()`), linked from the vault home note.

---

## 5. Trinity — the security operator (authorized bug-bounty testing)

Trinity carries an offensive-security knowledge base and orchestrates **authorized** testing using the
**local model**. **No guardrails were added** — those come from the connected model. What is enforced
is **authorization**, which the Kali arsenal doc itself mandates ("retrieving a tool never grants
permission; scope + approval are a separate layer").

**Knowledge base** — `server/agents/knowledge/`:
- `ethical-hacking-kb.md` — methodology, bug-bounty reasoning, vuln taxonomy, the
  Observe→Model→Hypothesize→Test→Validate→Assess→Report→Learn loop, authorization rules.
- `kali-arsenal.md` — **90 tool profiles across 21 capability families** (impact, execution).
- `index.ts` — parses both; `findCapabilities(query)` (lowest-impact first), `operatorBriefing(scope)`
  (the local model's system prompt), `knowledgeSummary()`.

**Skills** — `server/skills/builtin/security.ts`:
- `security.toolkit` — look up capabilities/tools (knowledge only; runs nothing). Scope `internal`.
- `security.operate` — orchestrate testing of **one authorized program**: briefs the local model with
  methodology + arsenal + scope, then **plans**, and (only when authorized, below) **runs** low/medium-
  impact steps live via shell on Kali, feeding results back. High-impact steps are surfaced for the
  operator to run, never auto-fired. Scope `shell.exec`.

**Authorization gates (not model guardrails), all off by default:**
1. target must be a HackerOne program in the pipeline (an authorized program);
2. live traffic needs `permissions.fullAccess` **and** the new `agents.offensive` toggle
   (Settings → Sub-agents → "Live offensive testing (Trinity)");
3. `security.operate` must be called with `execute: true`.

Without all three, Trinity plans/does passive work only.

**Knowledge files in the packaged app:** `build:server` copies the two `.md` into
`dist-server/agents/knowledge/`, and electron-builder includes `dist-server/**/*.md`.

---

## 6. API keys / `.env` (`server/core/env.ts`)

Keys live in a `.env` file (looked up at `$JARVIS_ENV`, then `<dataDir>/.env`, then `./.env`). The
secret store falls back to env vars via `ENV_SECRET_FALLBACK`. Keys set in the app (encrypted) win
over `.env`. Jarvis never writes or logs `.env`.

Currently wired env fallbacks: `HACKERONE_TOKEN`, `FISH_AUDIO_KEY`, `TRANSCRIPTION_API_KEY`/
`OPENAI_API_KEY` (Whisper), `EMAIL_PASSWORD`, `CALDAV_PASSWORD`. Add new services by extending
`ENV_SECRET_FALLBACK`.

---

## 7. Install / update on the user's machines

Installers are built by CI (`.github/workflows/desktop.yml`) as run artifacts: `jarvis-Windows`,
`jarvis-Linux`, `jarvis-macOS`. Wait for the **Desktop app** run to go green, then:

**Windows 11** (PowerShell) — replace `<run-id>` with the latest green run:
```powershell
gh run download <run-id> -R Sphinx3231/jarvis -n jarvis-Windows -D "$env:USERPROFILE\jarvis-update"; if ($?) { & (Get-ChildItem "$env:USERPROFILE\jarvis-update\*Setup*.exe").FullName }
```

**Kali Linux** (AppImage):
```bash
gh run download <run-id> -R Sphinx3231/jarvis -n jarvis-Linux -D ~/jarvis-update && chmod +x ~/jarvis-update/*.AppImage && ~/jarvis-update/*.AppImage --appimage-extract-and-run
```

**Roamies** (required, separate app): install the **AppImage** on Kali
(`--appimage-extract-and-run`; the `.deb` conflicts with NodeSource's `/usr/bin/node`). Sign in /
pick a model (local models work).

---

## 7b. Jarvis Mobile (Android) — `docs/MOBILE.md`

- **Architecture:** phone and PC both connect *out* to a self-hosted relay (`relay/`, Dockerfile +
  README); messages are E2E encrypted (P-256 ECDH → HKDF → AES-256-GCM). Contract in
  `shared/protocol/` (zod → JSON Schema + fixtures; Kotlin checked against them). ADRs in `docs/adr/`.
- **PC side:** `server/mobile/gateway.ts` (pairing, device registry, scopes, idempotency ledger,
  replay window, rate limit, audit — dispatches into the *existing* `app.jarvis`, `app.engine`,
  `app.permissions`). DB migration 9. Settings → **Jarvis Mobile** card (`web/src/components/MobileCard.tsx`).
- **App:** `mobile/android` (Kotlin, Compose, Room, DataStore, WorkManager, OkHttp, zxing).
  Remote PC mode = `remote/`; Mobile mode = `runtime/` (model provider, 20 tools, permission
  manager, router). Screens in `ui/screens` are stateless; `ui/JarvisApp.kt` wires them.
- **Pairing is permanent** until the user unpairs (phone or PC). Restarts of Jarvis/PC/relay/phone
  reconnect automatically and re-send queued commands (de-duplicated by the PC).
- **Tests:** `node --test tests/mobile.test.ts tests/protocol-contract.test.ts`,
  `node mobile/scripts/remote-e2e.ts` (real Kotlin client ↔ relay ↔ PC), `node tests/e2e/mobile.e2e.ts`,
  `cd mobile/android && ./gradlew testDebugUnitTest`. Screenshots: `mobile/android/app/screenshots/`.
- **Build:** `cd mobile/android && ./gradlew assembleDebug` → `app/build/outputs/apk/debug/app-debug.apk`.
- **Gotcha (cloud sandbox only):** Maven Central rate-limits through the proxy; a `~/.gradle/init.d`
  mirror script (not committed) was used. Normal machines don't need it.
- **Not yet verified on a physical phone** (no emulator in the build sandbox): QR camera, speech,
  TTS and the intent-based tools need an on-device pass.

## 8. Outstanding work (not yet built)

> **Biggest requested initiative: Computer Access Mode** — give Jarvis human-like control of the
> computer it runs on (see the mouse/keyboard, screen understanding, window/app/browser control, and a
> continuous "watch this and learn" pipeline). The **full verbatim brief is in §11 (Appendix)**, with
> an engineering reality-check at the top of it. The **PC system monitor** below (#3) is the safe first
> slice of it (observe-only telemetry).

From the user's requests, still open:

1. **Gmail connector** — wire Gmail as a first-class integration (IMAP/app-password or OAuth, or MCP).
   Email plumbing exists (`integrations/email.ts`, `tests/_imap.ts`); needs Gmail wiring + `.env` keys +
   Integrations UI.
2. **PayPal connector** — read-only balance/transactions via PayPal REST (client-credentials). Would
   feed **Friday**'s real profit numbers. New integration + `.env` keys (`PAYPAL_CLIENT_ID/SECRET`).
3. **PC system monitor / Computer Access Mode — Observe foundation** — ✅ **BUILT (Phase 1).** See
   §12 for the full module. Real cross-platform telemetry (processes, CPU/RAM, active window, network)
   behind a `ComputerAccessManager`, gated by a new `settings.computerAccess` block (`enabled` off by
   default, `level: observe|interact|extended`), two new permission scopes (`computer.observe`,
   `computer.control`), two skills (`computer.capabilities`, `computer.telemetry`), an emergency STOP
   that flips the setting + aborts in-flight work, an honest capability report, API (`GET /api/computer`,
   `POST /api/computer/stop`) and 7 unit tests.
   - **Phase 1b — Native Observation: ✅ BUILT & integration-tested on Linux/X11** (see §12). Real
     screenshot capture, OCR, active-window + window enumeration, a unified `observe()` API, and
     runtime self-verification probes. Windows/macOS adapters are implemented but **not yet verified on
     real hardware** (reported `unverified`, never `available`, until a probe passes there).
   - **Phase 4 — Native Interaction: ✅ BUILT & integration-tested on Linux/X11** (see §12). Mouse
     move/click/scroll, type/keys, window switching via xdotool, behind the consequential
     `computer.control` scope (never auto-allowed). Windows/macOS drivers implemented but `unverified`.
   - **Phase 5 — Learning pipeline ("watch this and learn"): ✅ BUILT** (see §12). Deterministic
     extraction of attributed FACT/INFERENCE/UNCERTAIN knowledge into persistent memory; the mandatory
     course acceptance test passes (persist → **restart** → recall → compare → refuse to invent).
   - **Phase 4b/3/4-loop/5b/6/7 — ✅ BUILT (this session):** browser control (DevTools, loopback,
     method allowlist), multi-step verified workflows with safe recovery, the critical-action gate
     (send/pay/delete/install/admin always confirm, even under Full Access), the persistent action log +
     live state machine, the top-bar Computer Access indicator/panel with STOP, the watch-and-learn loop
     (browser or screen; auto-scroll, next lesson, caption following, resumable progress), the scored
     real-browser course test, real X11 OS tests, and a cross-platform CI matrix. Full docs:
     `docs/COMPUTER_ACCESS.md`; evidence: `docs/COMPUTER_ACCESS_REPORT.md`.
   - **Still open:** native widget accessibility trees (AT-SPI/UIA/AX — today: web element tree via
     the browser, OCR text elsewhere); Wayland input; feeding observations to **Neo**; verifying macOS
     on a real Mac with the permissions granted (CI runners can't grant them).
4. **MCP presets** for the above services (optional; MCP client already verified — `tests/mcp.test.ts`).

Suggested order: browser control (Phase 4b) + the Computer Access UI/Neo surfacing, or Gmail + PayPal.

---

## 9. Conventions & gotchas

- **Do not add model guardrails.** The user is explicit: the harness (Jarvis) has none; guardrails come
  only from the model they connect, so the two never overlap. Jarvis adds no content rules to prompts and
  never refuses a request itself. What remains is **the user's own authorization**, and each part of it
  is a setting:
  - approvals for steps beyond what was asked (Settings → Permissions);
  - critical-action confirmations (`computerAccess.confirmCritical`, which also switches the permission
    engine's `Skill.critical`).

  Also kept: **protection from third parties**, which never limits the user:
  - prompt-injection quarantine;
  - loopback-only DevTools with the cookie/storage block;
  - origin and token checks on the API.
- **Memory must never "forget".**
  - Standing rules are captured instantly (`ConversationDigester.captureNow`) and are always in context
    (`MemoryStore.standing`).
  - Every conversation is digested (`server/agents/digest.ts`) and archived in the vault (`Conversations/`
    and `Digests/` are never removed by sync).
  - Conversations are kept forever by default (`conversationRetentionDays: 0`).
  - Keep `digested_until` monotonic, and only advance it after a digest is stored.
- Commit on the branch above; **don't open a PR unless asked.** Commit trailers used:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` and `Claude-Session: <url>`.
- Node ≥22.18 type-stripping: no enums/namespaces/param-properties; use `import type`; `.ts` extensions
  in imports.
- Some tests pin exact lists (e.g. `tests/skills.test.ts` lists every skill name; `tests/subagents.test.ts`
  pins the roster + colors). Adding a skill/agent means updating those.
- The e2e asserts exact node counts (`.anode` = 6) and the JARVIS wordmark; update when the roster or
  hero changes. Memory-search assertions are kept tolerant because search is hybrid semantic + agents
  write memories in the background.
- `scripts/launch.ts` is the dev entrypoint; `desktop/main.cjs` forks `dist-server/main.js` in the app.

---

## 10. Recent commits (newest first)

```
1d69849 Trinity: a security-operator sub-agent that orchestrates authorized bug-bounty testing
b4ddd70 Obsidian "shared mind": per-agent memory notes so Jarvis can recall all of them
f7630d7 Hero stage: JARVIS planet with Saturn ring and agents as labeled satellite nodes
0e9817a Sub-agents (Friday, Tom, Neo, Sentinel, Echo) orbiting Jarvis as colored cores
c3e94e4 Immersive full-screen Jarvis (backslash) and a full-access mode
aff9a61 Voice-first Jarvis: Hey-Jarvis, Fish Audio replies, .env keys, bigger core
```

---

## 11. Appendix — Computer Access Mode: master implementation brief

This is the next major initiative, captured here verbatim for whoever picks it up. **Read the
engineering reality-check first — it is not part of the original brief, it's grounding for this repo.**

### Engineering reality-check (specific to this codebase — read before starting)

- **This is a desktop-only capability.** It runs in the **Electron app on the user's own machine**
  (Kali Linux + Windows 11), never in a cloud session. The cloud container that normally edits this
  repo **cannot test real OS interaction** — all real screen/mouse/keyboard/accessibility tests must be
  run on the user's machines (or a desktop CI runner). Don't mark anything "works" from the cloud; wire
  the tests so the user runs them locally and reports results, and keep platform-independent logic
  (planning, learning pipeline, permission gating) unit-testable headlessly here.
- **Likely native tech** (verify/compare before committing):
  - Input (mouse/keyboard): **nut.js** (`@nut-tree-fork/nut-js`, maintained) — `robotjs` is stale.
  - Screenshots: Electron `desktopCapturer` or `screenshot-desktop`; per-window capture via OS APIs.
  - OCR: `tesseract.js` (bundled) or a system `tesseract`; run OCR **before** expensive vision calls.
  - Accessibility (the hard, high-value part): Windows **UI Automation**, Linux **AT-SPI** (X11; detect
    Wayland and degrade), macOS **AX API** (needs Accessibility + Screen Recording permissions). These
    need native bindings — expect per-OS native modules and `electron-builder` `asarUnpack`.
  - Browser: **Playwright is already pre-installed** in this repo (see the environment notes). Prefer
    driving a dedicated browser/profile or CDP against the user's Chrome over screen-scraping. Do **not**
    copy cookies/tokens into Jarvis memory (the brief forbids it).
- **Reuse what exists — do not duplicate:**
  - `RoamiesEngine` (`server/llm/engine.ts`) for screen understanding — **detect whether the signed-in
    model is vision-capable**; if not, fall back to OCR + accessibility and say so.
  - Memory store (`server/memory/store.ts`, FTS5 + embeddings + `retrieve()`) for the learning pipeline
    — store learning notes as memories (new kind or tags like `learn:<session>`), **do not build a
    second memory system.** Agent/vault "shared mind" (§4) already shows how findings persist + surface.
  - Permission engine (`server/permissions/engine.ts`), the **full-access** toggle and the approval
    flow (§3), the **activity/audit log**, and the **SSE event bus** for the live status indicator.
  - Task engine + scheduler for multi-step workflows and the observe→act→verify loop — **don't add a
    second scheduler or a competing agent.** Computer Access is a *capability surface* for Jarvis, modeled
    like the existing skills (`server/skills/builtin/*`, see `security.ts`/`shell.ts` for the pattern:
    `scope`, `risk`, `availability`, `execute`, `verify`). A natural shape: a `computer.*` skill family
    behind a `computer.control` scope, plus a `ComputerAccessManager` service, gated by a new
    `settings.computerAccess` block (`enabled`, `level: observe|interact|extended`) that mirrors how
    `permissions.fullAccess` / `agents.offensive` are wired.
- **Security is already partly in place:** untrusted-content handling exists
  (`server/intelligence/untrusted.ts` → `wrapUntrusted`/`UNTRUSTED_POLICY`). All screen/web/document
  text the observer ingests is **untrusted data, never instructions** — route it through that. The live
  "Jarvis is controlling the computer" indicator should ride the existing SSE events + a Home/stage
  badge; the emergency STOP should flip `settings.computerAccess.enabled` and abort in-flight actions
  via the existing `AbortSignal` plumbing.
- **Honest scope note that stood before this brief:** full screen-vision + app control (watching
  videos/courses/games, driving arbitrary GUIs) is exactly what this initiative builds, and it is a
  large, OS-native, desktop-tested effort — not a quick add. Follow the brief's own rule: *never claim
  it works without real testing on the actual OS.*

### The brief (verbatim)

# MASTER IMPLEMENTATION PROMPT — JARVIS COMPUTER ACCESS & CONTINUOUS LEARNING

## ROLE

You are the senior software architect, desktop automation engineer, AI systems engineer, security engineer, and QA lead responsible for implementing a major capability in the EXISTING Jarvis project.

Your task is to make Jarvis capable of interacting with the computer it runs on in a human-like way.

This is a real implementation assignment. Do not simply produce a design document, create placeholder functions, or claim success because the application compiles.

You must inspect the existing repository, understand its architecture, implement the feature, run tests, test actual computer interactions, investigate failures, fix them, and provide verifiable evidence.

You are expected to work autonomously within the repository. Do not stop after planning.

---

# 1. THE ACTUAL GOAL

I want Jarvis to be able to use the laptop it is running on.

Imagine a human sitting in front of the computer:

- They can see what is on the screen.
- They can understand windows and applications.
- They can move the mouse.
- They can click buttons.
- They can type.
- They can scroll.
- They can switch between applications.
- They can open files and folders.
- They can use a browser.
- They can navigate websites while logged into accounts.
- They can read information displayed on the screen.
- They can interact with applications that do not have MCP integrations.
- They can observe information, understand it, and remember useful knowledge.

Jarvis should gain these capabilities through a new, toggleable system called:

**COMPUTER ACCESS MODE**

This should make Jarvis capable of interacting with the actual operating system, rather than depending exclusively on MCP integrations or individual application APIs.

The user should be able to enable or disable this capability from the Jarvis interface.

When disabled, Jarvis must not perform computer-control actions.

When enabled, Jarvis can use the computer within the permission boundaries described in this prompt.

This is not a request to install Hermes or another autonomous agent framework. Jarvis remains the primary assistant, coordinator, reasoning system, and user-facing intelligence.

Do not introduce another competing AI agent.

---

# 2. FIRST: INSPECT THE EXISTING PROJECT

Before writing code, thoroughly inspect the current repository.

Understand:

- Existing application architecture.
- Existing RoamiesEngine and LLM integration.
- Existing agent architecture.
- Existing task system and scheduler.
- Existing memory system.
- SQLite database structure and FTS5 implementation.
- Existing embeddings and vector retrieval.
- Existing MCP integrations.
- Existing browser-related functionality.
- Existing voice interaction.
- Existing Electron main process and preload architecture.
- Existing frontend and backend communication.
- Existing permissions and security boundaries.
- Existing Java-based computer-control code, libraries, and experiments, if present.

The project already has substantial functionality. Preserve it.

Do not rebuild Jarvis from scratch.

Do not replace the existing agents.

Do not replace the existing memory system.

Do not remove MCP integrations. Computer Access Mode should make Jarvis less dependent on MCPs for ordinary desktop interaction, not destroy existing integrations that may be more reliable.

Before implementation:

1. Map the current architecture.
2. Identify reusable components.
3. Identify missing capabilities.
4. Identify security risks.
5. Identify platform-specific dependencies.
6. Create a practical implementation plan.
7. Record the current test baseline.

Then begin implementation.

Do not spend the entire assignment producing documentation.

---

# 3. COMPUTER ACCESS MODE

Create a modular computer-control subsystem.

Suggested architecture:

ComputerAccessManager
├── PermissionManager
├── OperatingSystemAdapter
│   ├── WindowsAdapter
│   ├── LinuxAdapter
│   └── MacOSAdapter
├── ScreenCapture
├── ScreenUnderstanding
├── AccessibilityEngine
├── MouseController
├── KeyboardController
├── WindowManager
├── ApplicationManager
├── BrowserController
├── FileSystemConnector
├── ActionExecutor
├── ObservationEngine
├── LearningPipeline
└── AuditLogger

Adapt the names and structure to the existing codebase rather than blindly creating duplicate systems.

## 3.1 Screen understanding

Jarvis must be able to:

- Capture the current screen.
- Capture individual application windows.
- Identify visible UI elements.
- Read text through OCR.
- Understand basic screen layouts.
- Identify buttons, text fields, menus, tabs, dialogs and other controls.
- Read accessibility trees when available.
- Determine which application is currently active.
- Identify whether a page is loading or an action has completed.
- Detect unexpected dialogs, errors and interruptions.
- Compare screen states before and after actions.

Use a combination of:

- Native accessibility APIs.
- OCR.
- Screenshot analysis.
- UI Automation.
- Browser accessibility information.
- Existing vision-model capabilities where available.

Do not rely exclusively on screenshots and coordinates.

Coordinates are fragile. Prefer semantic element identification and accessibility APIs whenever possible.

## 3.2 Mouse control

Implement:

- Move cursor.
- Single click.
- Double click.
- Right click.
- Click and hold.
- Drag and drop.
- Scroll vertically and horizontally.
- Locate an element and click it.
- Verify whether the intended interaction succeeded.

## 3.3 Keyboard control

Implement:

- Type text.
- Press individual keys.
- Key combinations.
- Copy and paste where permitted.
- Keyboard navigation.
- Select text.
- Navigate forms.
- Use shortcuts.
- Interact with dialogs and menus.

Handle keyboard layouts and platform-specific shortcuts correctly.

## 3.4 Window and application control

Jarvis must be able to:

- List running applications.
- Identify open windows.
- Identify the active window.
- Switch between windows.
- Minimize and maximize windows.
- Resize windows.
- Open applications.
- Close applications when authorized.
- Detect application crashes.
- Wait for applications to become ready.
- Understand which application it is currently interacting with.

## 3.5 Browser interaction

Jarvis must be able to operate the user's existing browser sessions.

It should be capable of:

- Opening tabs.
- Switching tabs.
- Navigating websites.
- Reading visible page content.
- Scrolling through pages.
- Clicking links and buttons.
- Filling forms.
- Interacting with web applications.
- Working with authenticated sessions already established by the user.
- Detecting login screens and session expiration.
- Recovering from navigation errors.

Prefer browser accessibility information or existing browser automation integrations where appropriate.

Do not assume every website exposes its content correctly.

Do not extract passwords, authentication tokens, cookies, or private browser storage for general-purpose access.

Jarvis should use the authenticated browser session as a human would, rather than copying credentials into its own storage.

---

# 4. OPERATING SYSTEM SUPPORT

The implementation must be designed for:

1. Windows
2. Linux
3. macOS

Do not build a Windows-only implementation and call the project cross-platform.

Create an operating-system abstraction layer so the same high-level Jarvis commands work across platforms.

Examples:

Jarvis.clickElement("Submit")
Jarvis.typeText("Example text")
Jarvis.scroll("down")
Jarvis.getScreen()
Jarvis.getActiveWindow()
Jarvis.openApplication("Browser")
Jarvis.readVisibleContent()

These are conceptual examples. Adapt the actual interfaces to the project's architecture.

## Windows

Investigate and use appropriate native technologies, including:

- Windows UI Automation.
- Win32 APIs where appropriate.
- Native input simulation.
- Window management APIs.
- Screen capture APIs.
- OCR integration.

Test standard applications and browser interactions.

Document limitations involving elevated applications, secure desktops and permission boundaries.

## Linux

Investigate:

- AT-SPI accessibility.
- X11 interaction.
- Wayland compatibility.
- XTest or equivalent input mechanisms.
- Screen capture.
- OCR.
- Window management.

Do not assume X11 and Wayland behave identically.

Detect the display server and expose accurate capability information.

## macOS

Investigate:

- Accessibility API.
- Screen Recording permissions.
- Input monitoring permissions.
- Core Graphics.
- AppleScript or other appropriate native interfaces.
- Window management capabilities.

Provide clear instructions for required macOS permissions.

Do not silently report functionality as working if macOS permissions prevent it.

## Platform capability detection

At startup, detect:

- Operating system.
- Display server where applicable.
- Available accessibility APIs.
- Screen capture availability.
- Input simulation availability.
- Required permissions.
- Available OCR and vision capabilities.

Expose a capability report to Jarvis.

For example:

Windows:
- Screen capture: AVAILABLE
- Accessibility: AVAILABLE
- Mouse: AVAILABLE
- Keyboard: AVAILABLE
- Browser interaction: AVAILABLE

Linux:
- Screen capture: AVAILABLE
- Accessibility: AVAILABLE
- Mouse: LIMITED
- Keyboard: AVAILABLE
- Browser interaction: AVAILABLE

These are illustrative statuses. Report actual detected capabilities.

Never pretend a feature is available when it is not.

---

# 5. TOGGLEABLE ACCESS AND PERMISSIONS

Computer Access Mode must be controllable from the existing Jarvis UI.

Add a clear toggle:

COMPUTER ACCESS
[ OFF / ON ]

When OFF:
- No computer-control actions may execute.
- No background input simulation may occur.
- No unattended screen observation should occur.
- Previously scheduled computer-control tasks must not continue executing.

When ON:
- Jarvis can use the enabled capabilities.
- The user can see that computer access is active.
- The user can immediately disable it.

Create configurable permission levels.

Suggested levels:

### Level 1 — Observe

Jarvis can:
- View the screen.
- Read visible content.
- Identify applications.
- Analyze windows.
- Learn from content the user explicitly asks it to observe.

No mouse or keyboard input.

### Level 2 — Interact

Jarvis can:
- Click.
- Type.
- Scroll.
- Navigate applications.
- Operate browser interfaces.
- Perform ordinary desktop workflows.

### Level 3 — Extended Control

Jarvis can:
- Open and manage applications.
- Create and organize files in approved locations.
- Perform multi-step workflows.
- Use approved local commands.
- Interact with broader system functionality.

Extended Control must have explicit permissions and appropriate approval gates.

## Critical approval boundaries

Require explicit user confirmation before:

- Sending emails or messages.
- Publishing content.
- Making purchases.
- Transferring money.
- Accepting contracts or legally significant agreements.
- Deleting important files.
- Installing software.
- Changing security settings.
- Changing account permissions.
- Running commands with administrator/root privileges.
- Sharing private information externally.
- Performing actions with significant irreversible consequences.

Never bypass CAPTCHA, MFA, account security, payment confirmation, or other access-control mechanisms.

Do not attempt to evade website restrictions or security controls.

The system must have:

- An emergency stop.
- An immediate disable switch.
- An action log.
- A visible indication when Jarvis is controlling the computer.
- A clear record of what Jarvis can access.

The user must remain in control.

---

# 6. THE MOST IMPORTANT FEATURE: JARVIS MUST LEARN FROM WHAT IT OBSERVES

This is a core requirement, not an optional future enhancement.

I want to be able to open something on my laptop and tell Jarvis:

"Watch this and learn from it."

For example:

I open a Udemy course.

I tell Jarvis:

"Watch this course and learn everything useful from it."

Jarvis should then be able to:

1. Identify the active browser tab.
2. Understand which course or lesson is open.
3. Read the visible lesson content.
4. Observe the presentation.
5. Read subtitles or transcripts when available and accessible.
6. Extract important concepts.
7. Follow the lesson as it progresses.
8. Take structured notes.
9. Identify terminology and definitions.
10. Identify examples and explanations.
11. Identify relationships between concepts.
12. Record questions or unclear sections.
13. Track lesson progress.
14. Store the knowledge in persistent memory.
15. Make the knowledge searchable.
16. Use the knowledge in future conversations.
17. Continue learning when instructed to move to the next lesson.

Do not implement this as a simple screenshot summarizer.

It needs a proper observation and knowledge-ingestion pipeline.

## 6.1 Observation loop

Build a controlled observation loop.

Example:

User instruction:
"Watch this lesson and learn from it."

Jarvis:

1. Inspects the current screen.
2. Identifies the relevant application and content.
3. Establishes an observation session.
4. Reads accessible content.
5. Observes relevant visual changes.
6. Extracts information.
7. Updates structured notes.
8. Detects lesson transitions.
9. Continues until the user stops the session or the task is complete.

Avoid capturing the screen continuously at unnecessarily high frequency.

Use event-driven observation, accessibility updates, page changes, and sensible sampling intervals.

The system should recognize when:
- A new slide appears.
- A video changes scenes.
- A new lesson begins.
- A transcript changes.
- A page scrolls.
- A dialog interrupts the lesson.
- The content becomes unavailable.
- The lesson has ended.

## 6.2 Learning pipeline

Implement a pipeline such as:

Observation
    ↓
Content Extraction
    ↓
OCR / Transcript / Accessibility Parsing
    ↓
Information Segmentation
    ↓
Concept Extraction
    ↓
Knowledge Structuring
    ↓
Deduplication
    ↓
Source Attribution
    ↓
Persistent Storage
    ↓
Embedding Generation
    ↓
Memory Retrieval

Adapt it to the existing memory system.

Do not create a completely separate memory system unless absolutely necessary.

## 6.3 What should be saved?

For each learning session, save:

- Source title.
- Website or application.
- Course name when available.
- Lesson title.
- Date and time.
- Session identifier.
- Extracted concepts.
- Definitions.
- Important examples.
- Key takeaways.
- Relationships between concepts.
- Unresolved questions.
- Relevant timestamps when available.
- Source references.
- Confidence level.
- Whether the information was directly observed or inferred.

The system must distinguish:

FACT:
Information directly visible in the source.

INFERENCE:
A conclusion derived from observed information.

UNCERTAIN:
Information that could not be reliably understood.

Do not turn guesses into stored facts.

## 6.4 Persistent knowledge

After a learning session, Jarvis should be able to answer questions about the material.

Example:

User:
"What did you learn from the course yesterday?"

Jarvis:
Returns a structured summary based on stored knowledge.

User:
"Explain the concept from lesson 4."

Jarvis:
Retrieves the relevant notes and explains the concept.

User:
"Compare that concept with what we learned in the previous course."

Jarvis:
Retrieves both sources and compares them.

User:
"Continue learning from the next lesson."

Jarvis:
Returns to the appropriate lesson and resumes the observation workflow if the course remains accessible.

This must work across application restarts.

The knowledge must not disappear when the computer is restarted.

## 6.5 Important learning limitations

Do not bypass DRM, download restrictions, paywalls, or other access controls.

Do not attempt to defeat video protections.

Use content that is legitimately accessible through the user's existing session, such as:
- Visible text.
- Accessible transcripts.
- Captions.
- Accessible lesson descriptions.
- Slides and other content exposed through normal interfaces.
- Information the user supplies.

Respect applicable website terms and copyright restrictions.

Store notes, summaries, concepts and references rather than attempting to reproduce entire copyrighted courses.

Do not claim that a course was fully learned if only a small portion was accessible.

If a video cannot be understood because no accessible transcript, captions, or usable visual information are available, explain that limitation honestly.

---

# 7. JARVIS SHOULD FEEL LIKE A HUMAN USING A COMPUTER

The goal is not to create a collection of disconnected mouse functions.

The goal is to give Jarvis the ability to reason about what it is doing.

Example:

User:
"Open my browser and find the document I was working on."

Jarvis should:

1. Inspect the desktop.
2. Identify the browser.
3. Open or switch to it.
4. Understand the currently available tabs.
5. Search the appropriate application if authorized.
6. Identify the likely document.
7. Open it.
8. Verify that it is the correct document.
9. Report what it found.

Another example:

User:
"Open my course and continue where you left off."

Jarvis should:

1. Recall the previous learning session.
2. Identify the course.
3. Inspect the current browser state.
4. Navigate to the correct lesson if needed.
5. Verify the lesson.
6. Continue the learning workflow.

Another example:

User:
"Look at what's on my screen and explain it."

Jarvis should:
1. Observe the screen.
2. Identify the relevant application.
3. Read the visible content.
4. Interpret it.
5. Explain what it sees.
6. Clearly identify anything it cannot read.

Jarvis must be able to reason through multi-step workflows rather than simply execute one command at a time.

---

# 8. ACTION PLANNING AND VERIFICATION

Every computer-control task should follow a structured cycle:

UNDERSTAND
    ↓
PLAN
    ↓
CHECK PERMISSIONS
    ↓
OBSERVE CURRENT STATE
    ↓
EXECUTE ACTION
    ↓
OBSERVE RESULT
    ↓
VERIFY SUCCESS
    ↓
CONTINUE OR RECOVER

Do not assume a click succeeded just because the input event was sent.

For example:

If Jarvis clicks a button:
- It must verify that the expected UI change happened.

If Jarvis types into a text field:
- It should verify that the intended text appeared.

If Jarvis navigates to a page:
- It should verify that the correct page loaded.

If an action fails:
- It should inspect the new state.
- Determine what went wrong.
- Retry only when safe.
- Avoid repeating actions that might create duplicate submissions.

Implement timeouts, cancellation, retries and recovery.

Avoid infinite loops.

The user must be able to interrupt any active workflow.

---

# 9. UI INTEGRATION

Integrate Computer Access Mode into the existing Jarvis interface.

Do not redesign the entire application.

Preserve the existing visual identity, agents, layout, navigation and functionality.

Add a compact Computer Access control.

It should communicate:

- Whether computer access is ON or OFF.
- Current permission level.
- Current active application.
- Whether Jarvis is observing or interacting.
- Current task.
- Whether a learning session is active.
- Whether approval is required.

During active control, show a clear indicator.

Example states:

IDLE
OBSERVING
ANALYZING
PLANNING
INTERACTING
VERIFYING
LEARNING
WAITING FOR APPROVAL
PAUSED
COMPLETED
ERROR

The user should be able to open a detail panel to see recent actions and the current task.

Add a STOP button.

Do not fill the main UI with unnecessary controls.

---

# 10. ARCHITECTURE AND PERFORMANCE

Computer Access Mode must not freeze Jarvis.

Use asynchronous operations and background execution.

Requirements:

- Do not block the main Electron process.
- Do not block the UI thread.
- Do not capture screenshots excessively.
- Avoid unnecessary model calls.
- Avoid sending huge screenshots repeatedly.
- Compress and resize images when appropriate.
- Use OCR before expensive vision calls when practical.
- Use accessibility data when it is more efficient.
- Cache information where safe.
- Support cancellation.
- Handle application crashes.
- Handle operating-system permission failures.
- Handle disconnected displays.
- Handle browser crashes.
- Recover from interrupted sessions.

Use the existing RoamiesEngine and agent/task infrastructure where appropriate.

Do not create a second scheduler or duplicate reasoning engine.

The computer-control subsystem should provide capabilities to Jarvis, not become another assistant.

---

# 11. SECURITY AND PRIVACY

This system has access to a computer containing logged-in accounts and potentially sensitive information.

Security must be treated as a core engineering requirement.

Implement:

- Explicit access toggle.
- Permission levels.
- Per-capability permissions.
- Task-scoped permissions where practical.
- Visible active-control indicator.
- Emergency stop.
- Action audit log.
- Secure handling of temporary screenshots.
- Configurable screenshot retention.
- Protection against accidental credential collection.
- Protection against prompt injection from webpages and documents.

IMPORTANT:

Text seen on a webpage, document, email, or video must be treated as untrusted content.

A webpage must not be able to instruct Jarvis to:
- Disable its security controls.
- Reveal private information.
- Exfiltrate files.
- Change its permissions.
- Execute arbitrary commands.
- Ignore the user's instructions.

The user is the authority.

External content is data, not authority.

Do not allow a website to silently turn Computer Access Mode on.

Do not allow an external page to approve its own actions.

Do not store passwords, session cookies, authentication tokens or other secrets in Jarvis memory.

Do not create a hidden remote-control service or expose the computer-control interface to the public internet.

Keep local control endpoints restricted to the appropriate local process and authenticated IPC.

---

# 12. TESTING REQUIREMENTS — DO NOT SKIP THIS

This project is not complete when the code compiles.

You must test whether Jarvis can actually use the computer.

Create automated tests and real integration tests.

## 12.1 Unit tests

Test:

- Screen capture.
- OCR extraction.
- Accessibility parsing.
- Mouse actions.
- Keyboard actions.
- Window detection.
- Application detection.
- Browser interaction.
- Permission enforcement.
- Toggle behavior.
- Emergency stop.
- Task cancellation.
- Action verification.
- Observation loop.
- Learning pipeline.
- Memory persistence.
- Knowledge retrieval.
- Source attribution.
- Recovery from failures.

## 12.2 Integration tests

Build a local test environment containing:

- A test webpage.
- Buttons.
- Forms.
- Text fields.
- Menus.
- Tabs.
- Scrollable content.
- Dialogs.
- A simulated lesson.
- Captions or transcript text.
- Multiple pages.
- A deliberately failing interaction.

Jarvis must be able to:

1. Observe the page.
2. Identify its elements.
3. Click the correct button.
4. Type into the correct field.
5. Navigate between pages.
6. Read content.
7. Detect a failed action.
8. Recover appropriately.
9. Extract knowledge.
10. Save knowledge.
11. Retrieve the saved knowledge later.

## 12.3 REAL COMPUTER-CONTROL TESTS

Do not rely exclusively on mocked mouse and keyboard functions.

Run real tests on the available operating system.

Create a dedicated local test application or browser page.

Have Jarvis interact with it using the actual operating-system integration.

Demonstrate that:
- The screen can be observed.
- UI elements can be identified.
- The mouse can click.
- The keyboard can type.
- Scrolling works.
- Window switching works where supported.
- The result is verified.
- Disabling Computer Access stops further actions.

## 12.4 LEARNING TEST — MANDATORY

Create a realistic course-learning test.

Use a local simulated course page with multiple lessons.

Each lesson should contain:
- A title.
- Several paragraphs.
- Definitions.
- Examples.
- A transcript.
- Captions or lesson text.
- Important concepts.
- Information that appears only after scrolling.

Test the following:

1. Open the simulated course.
2. Tell Jarvis to watch and learn from it.
3. Verify that Jarvis identifies the course.
4. Verify that it identifies the current lesson.
5. Verify that it extracts the lesson content.
6. Verify that it identifies the important concepts.
7. Verify that it creates structured notes.
8. Verify that it saves those notes persistently.
9. Restart the Jarvis application.
10. Ask Jarvis questions about the lesson.
11. Verify that it retrieves the correct information.
12. Ask it to compare two lessons.
13. Verify that it retrieves both lessons correctly.
14. Verify that it does not invent information that was never present.
15. Verify that it can identify missing or inaccessible content.

Create a scoring system.

Measure:
- Correctly extracted facts.
- Correct definitions.
- Correct lesson identification.
- Retrieval accuracy.
- Unsupported claims.
- Source attribution accuracy.
- Persistence after restart.

Do not mark the learning feature as successful merely because a summary was generated.

It must pass the retrieval and persistence tests.

## 12.5 CROSS-PLATFORM TESTING

Test on:

- Windows.
- Linux.
- macOS, if the necessary hardware or CI environment is available.

Use actual operating-system integration tests wherever possible.

Create a platform test matrix.

| Capability | Windows | Linux | macOS |
|---|---|---|---|
| Screen capture | Test | Test | Test |
| OCR | Test | Test | Test |
| Accessibility | Test | Test | Test |
| Mouse control | Test | Test | Test |
| Keyboard control | Test | Test | Test |
| Window detection | Test | Test | Test |
| Browser interaction | Test | Test | Test |
| Learning pipeline | Test | Test | Test |
| Emergency stop | Test | Test | Test |

For each platform, record:

- PASS
- FAIL
- PARTIAL
- BLOCKED BY ENVIRONMENT
- NOT TESTED

Do not mark a platform PASS because its code compiled.

If macOS hardware is unavailable, create macOS CI/build coverage where practical, run all platform-independent tests, and clearly report that real macOS interaction remains unverified.

Do not pretend that a simulated macOS test proves real macOS functionality.

---

# 13. FAILURE TESTING

Test situations such as:

- User disables Computer Access while Jarvis is clicking.
- User presses STOP during a workflow.
- Browser closes unexpectedly.
- Window disappears.
- Screen capture permission is revoked.
- Accessibility API becomes unavailable.
- OCR returns incorrect text.
- A button is not found.
- A page loads slowly.
- Internet connection is lost.
- The browser session expires.
- A login screen appears.
- A dialog blocks the workflow.
- The target application crashes.
- A webpage contains malicious instructions.
- Jarvis receives contradictory screen information.

Jarvis must fail safely.

If it cannot verify an action, it must say so.

---

# 14. DOCUMENTATION AND DELIVERABLES

Create or update appropriate project documentation.

Include:

1. Architecture of Computer Access Mode.
2. Supported operating systems.
3. Dependencies and installation requirements.
4. Permission requirements.
5. Security model.
6. How the user enables/disables Computer Access.
7. How to use learning sessions.
8. Known limitations.
9. Test results.
10. How to reproduce the tests.

Create a final implementation report containing:

### A. What was implemented
List actual files and components changed.

### B. Computer-control capabilities
Show which functions work in practice.

### C. Learning capabilities
Explain how observation becomes persistent knowledge.

### D. Test results
Provide actual test commands, counts, logs and results.

### E. Platform compatibility
Show the Windows/Linux/macOS matrix.

### F. Known limitations
Be explicit about anything incomplete or environment-dependent.

### G. Remaining work
List unresolved issues in priority order.

### H. Demonstration
Provide a reproducible demonstration of Jarvis:
- Observing a real application.
- Interacting with it.
- Learning from content.
- Saving knowledge.
- Retrieving that knowledge after restarting Jarvis.

---

# 15. DEVELOPMENT RULES

These rules are mandatory.

1. Do not replace the existing Jarvis architecture.
2. Do not introduce Hermes.
3. Do not create another competing AI assistant.
4. Do not remove existing agents.
5. Do not remove existing MCP integrations.
6. Do not replace the existing memory system unnecessarily.
7. Do not implement fake functionality.
8. Do not use mock results as evidence of real computer access.
9. Do not claim cross-platform support without platform testing.
10. Do not silently ignore failures.
11. Do not leave critical functions as TODOs.
12. Do not stop after writing a plan.
13. Do not stop after the first successful build.
14. Do not sacrifice security for convenience.
15. Do not break existing functionality to add this feature.

Use the existing project's coding standards and architecture.

Keep changes modular.

Add regression tests for existing functionality.

Run the existing test suite after implementation.

If the existing test suite is too large to run in one process, run it in sensible batches and document the exact results.

If a dependency or operating-system restriction prevents a test, document it and provide the closest valid alternative. Do not fabricate results.

---

# 16. IMPLEMENTATION ORDER

Work through these phases.

### PHASE 0 — Repository inspection
Understand the existing project, existing Java code, dependencies, architecture and test baseline.

### PHASE 1 — Computer-control foundation
Implement operating-system detection, capability reporting, screen capture, accessibility, mouse and keyboard control.

### PHASE 2 — Jarvis integration
Connect the computer-control capabilities to the existing Jarvis reasoning, task and agent infrastructure.

### PHASE 3 — Computer Access UI
Implement the toggle, permissions, status display, action history and emergency stop.

### PHASE 4 — Human-like interaction
Implement multi-step planning, execution, observation, verification and recovery.

### PHASE 5 — Continuous learning
Implement observation sessions, content extraction, structured knowledge, persistent storage and retrieval.

### PHASE 6 — Learning demonstration
Build and run the simulated course-learning test. Prove that Jarvis can learn, persist and recall knowledge after restarting.

### PHASE 7 — Cross-platform validation
Test Windows, Linux and macOS to the extent possible. Report real results.

### PHASE 8 — Regression and security testing
Run the existing test suite, new tests, failure tests and security checks.

### PHASE 9 — Final report
Provide evidence, results, limitations and reproducible demonstrations.

Do not move on from a phase with a critical failure that invalidates the next phase. Fix it or document why it is blocked.

---

# 17. DEFINITION OF DONE

This assignment is NOT complete until all of the following are true:

- [ ] Jarvis has a working Computer Access Mode toggle.
- [ ] Disabling the toggle actually prevents computer-control actions.
- [ ] Jarvis can capture and understand the screen.
- [ ] Jarvis can use accessibility information where available.
- [ ] Jarvis can move the mouse and click.
- [ ] Jarvis can type and use keyboard shortcuts.
- [ ] Jarvis can scroll and interact with windows.
- [ ] Jarvis can operate a browser through the existing logged-in session.
- [ ] Jarvis can execute multi-step workflows.
- [ ] Jarvis verifies the results of its actions.
- [ ] Jarvis can observe content when explicitly instructed.
- [ ] Jarvis can extract structured knowledge.
- [ ] Jarvis saves knowledge persistently.
- [ ] Jarvis can retrieve learned information after an application restart.
- [ ] Jarvis passes the simulated course-learning test.
- [ ] Jarvis has an emergency stop.
- [ ] Approval boundaries work.
- [ ] Existing Jarvis functionality remains intact.
- [ ] Windows has been tested.
- [ ] Linux has been tested.
- [ ] macOS has been tested or its real-world testing limitations are explicitly documented.
- [ ] The final report contains real test evidence.

A green build alone does not satisfy this definition of done.

A passing unit test alone does not satisfy this definition of done.

A simulated computer-control demonstration alone does not satisfy this definition of done.

I want working software, tested against actual operating-system interaction.

---

# FINAL INSTRUCTION

Start by inspecting the repository and reporting the current architecture and test baseline.

Then implement the feature.

You have permission to make the necessary code changes within the existing project.

Be proactive. Investigate dependencies, compare appropriate native technologies, reuse existing components, and solve problems rather than simply reporting them.

However, never claim that something works unless you have actually tested it.

The ultimate objective is:

**Jarvis should be able to sit in front of the computer, see what is happening, understand it, interact with it, learn from what it sees, remember useful knowledge, and use that knowledge later — with the user retaining control over the computer at all times.**

---

## 12. Computer Access Mode — implementation status (Phase 1: Observe foundation)

**Built in this slice** (the platform-independent, headlessly-testable spine + real telemetry):

- `server/computer/types.ts` — `AccessLevel` (observe<interact<extended), `Capability` + honest
  `CapabilityStatus` (available / limited / needs-permission / unverified / unavailable), `Telemetry`,
  and the `OsAdapter` interface.
- `server/computer/adapters.ts` — `LinuxAdapter` / `WindowsAdapter` / `MacAdapter` + `currentAdapter()`.
  Real telemetry: processes (`ps` / `tasklist`), display detection (X11 / Wayland / headless / quartz /
  windows), active window (xdotool on X11, osascript on macOS, PowerShell+GetForegroundWindow on
  Windows — all best-effort, honest failure), network counters (Linux `/proc/net/dev`). The native
  control capabilities (screen/OCR/accessibility/mouse/keyboard/windows/apps/browser) are reported
  `unavailable` with a `requires` note — **not wired yet, never faked.**
- `server/computer/manager.ts` — `ComputerAccessManager`: reads `settings.computerAccess`, enforces the
  on/off toggle + level (`permits(level)`), produces the capability report (`status()`), takes a live
  telemetry snapshot (`telemetry()`, with CPU% sampled over 120ms; **throws when access is off**), and
  owns the emergency STOP + abort plumbing (`emergencyStop()` flips the setting off and aborts the
  shared `AbortSignal`; `handleSettingsChanged()` aborts in-flight work when the user toggles off).
- `server/computer/skills.ts` — `computer.capabilities` (scope `internal`, always available, pure
  report) and `computer.telemetry` (scope `computer.observe`, gated behind the toggle, output flagged
  untrusted). Registered via `skills/builtin/index.ts`.
- Wiring: `settings.computerAccess { enabled:false, level:'observe', screenshotRetentionMin:0 }`;
  scopes `computer.observe` (ask) and `computer.control` (ask, never auto-allowed); `app.computer`;
  `settings.changed → computer.handleSettingsChanged()`; `statusSnapshot().computer`; an insight banner
  when ON; API `GET /api/computer` and `POST /api/computer/stop`; event `computer.changed`.
- Tests: `tests/computer.test.ts` (7) — capability honesty, toggle gating, level gating, skill
  availability, permission-engine path, emergency stop, toggle-off abort. Pinned skill list updated in
  `tests/skills.test.ts`. **121/121 tests pass (incl. real X11 integration), typecheck clean.**

**Verified HERE (cloud Linux, headless):** OS/display detection, process telemetry via `ps`, CPU/RAM
from `node:os`, network counters, gating, STOP/abort, the permission path, the capability report.
**NOT verified (needs the user's real desktop):** active-window read on X11/Windows/macOS, and every
native control capability (all currently reported `unavailable`). The capability report is built to
keep telling the truth about this — nothing flips to `available` until it is wired AND proven on the
actual OS.

**Next slices (in the brief's order):** 1b native observe (screen capture + OCR + accessibility),
Phase 3 UI (a Computer Access panel on the stage: ON/OFF, level, active app, live state, STOP) + feed
telemetry to **Neo**, Phase 4 interact (nut.js mouse/keyboard, the UNDERSTAND→PLAN→…→VERIFY loop),
Phase 5 the "watch this and learn" pipeline on the existing memory store (learning notes as memories
tagged `learn:<session>`, FACT/INFERENCE/UNCERTAIN, persistence + retrieval across restart).

### Phase 1b — Native Observation (committed next)

Screenshot capture, OCR, active-window and window enumeration, all by **spawning platform-standard
tools** (no native node-addons → nothing to ABI-rebuild for Electron; works in the forked server
process). New files: `server/computer/exec.ts` (run/hasBinary/firstBinary/pngSize),
`server/computer/capture.ts` (scrot/maim/import/grim · macOS `screencapture` · Windows PowerShell),
`server/computer/ocr.ts` (system `tesseract`, incl. a self-verification probe),
`server/computer/probe-image.ts` (embedded "JARVIS" PNG for the OCR probe). `adapters.ts` gained
`listWindows()` (wmctrl/xdotool · osascript · PowerShell) and a **detection-driven** capability
report; `manager.ts` gained `observe()` (unified, gated, STOP-abortable, screenshot-retention aware,
text-first — raw pixels never enter the model) and `verify()` (real probes that upgrade a capability
to `available` only on a passing probe). New skill `computer.observe`; API `POST /api/computer/verify`
and `POST /api/computer/observe`.

**Status by capability (be precise when reporting):**

| Capability | Implemented | Unit-tested | Integration-tested (real) | Real hardware | Notes |
|---|---|---|---|---|---|
| Screenshot capture (Linux/X11) | ✅ | ✅ | ✅ Xvfb 1024×768 | ⏳ Kali | `scrot`/`maim`/`import` |
| OCR (tesseract) | ✅ | ✅ (reads embedded probe headless) | ✅ reads real screen text | ⏳ Kali | `apt install tesseract-ocr` |
| Active window (X11) | ✅ | — | ✅ xterm title via xdotool | ⏳ Kali | `apt install xdotool` |
| Window list (X11) | ✅ | — | ✅ wmctrl | ⏳ Kali | `apt install wmctrl` |
| `observe()` gating + STOP | ✅ | ✅ | ✅ (STOP kills in-flight capture) | ⏳ | |
| Capture/OCR/windows (Windows) | ✅ | — | — | ❌ not verified | PowerShell/tasklist; reported `unverified` |
| Capture/active-win (macOS) | ✅ | — | — | ❌ not verified | `screencapture`/`osascript`; Screen-Recording perm needed; `unverified` |
| Wayland capture | ⚠️ grim/gnome-screenshot path only | — | — | ❌ | window list/active-win not exposed under Wayland (honest `unavailable`) |
| Accessibility *widget tree* (AT-SPI/UIA/AX) | ❌ (top-level windows only = `limited`) | — | — | ❌ | needs native bindings — deferred |

**How it was verified here:** this cloud container is headless Ubuntu 24.04; I `apt install`ed
tesseract-ocr/xdotool/wmctrl/scrot/openbox, ran the suite, and the integration tests
(`tests/computer.integration.test.ts`) stand up a real **Xvfb + openbox** session, put known text on
screen, launch a titled window, and assert real capture (1024×768 PNG), real OCR of the screen
(reads "PHOTOSYNTHESIS"), the active window, the window list, and that STOP aborts an in-flight
capture. Reproduce: `node --test tests/computer.integration.test.ts` on a Linux box with those tools
(self-skips otherwise). **Windows and macOS are implemented but NOT verified** — their capabilities
report `unverified` until a `verify()` probe passes on that OS.

**Kali install note for real use:** `sudo apt install tesseract-ocr scrot xdotool wmctrl` (X11). The
capability report's `requires` field names the exact package when something is missing; `POST
/api/computer/verify` returns per-capability pass/fail evidence from the actual machine.

**Next concrete milestone:** native **interaction** (Phase 4) — a `computer.control`-scoped skill
family for mouse move/click, keyboard typing, scroll and window switching, behind the `interact`
level, with the UNDERSTAND→PLAN→CHECK-PERMISSIONS→OBSERVE→ACT→VERIFY loop and real integration tests
(xdotool-driven click/type against a test X11 app). Then the **learning pipeline** (Phase 5) with the
mandatory multi-lesson course acceptance test (persist to memory, restart, recall, compare, refuse to
invent).

### Phase 4 — Native Interaction (mouse/keyboard/scroll/window switch)

Input by spawning the platform tool (no native addons). New file `server/computer/input.ts`:
`XdotoolDriver` (Linux/X11 — verified), `MacInputDriver` (osascript/cliclick — unverified),
`WindowsInputDriver` (PowerShell SendKeys / System.Windows.Forms — unverified). `manager.control()`
gates every action by the toggle **and** the `interact` level, threads the STOP signal, and records
the result as probe evidence (with an independent verify where cheap — e.g. a mouse move is checked
with `getmouselocation`). New skill `computer.control` (scope `computer.control`, risk
**consequential**, **never auto-allowed** — every action needs approval, or Full Access); its
availability is honest (unavailable unless the toggle is on, the level is `interact`+, **and** a real
input path exists on the host). API `POST /api/computer/control`.

| Capability | Implemented | Unit-tested | Integration-tested (real) | Real hardware | Notes |
|---|---|---|---|---|---|
| Mouse move (Linux/X11) | ✅ | ✅ (gating) | ✅ lands at exact x,y (getmouselocation) | ⏳ Kali | xdotool |
| Click / scroll (Linux/X11) | ✅ | — | plumbing via xdotool click/4-5 | ⏳ Kali | verified path, click target app not asserted |
| Type / key (Linux/X11) | ✅ | — | ✅ text reaches a focused window | ⏳ Kali | xdotool type/key |
| Window switch (Linux/X11) | ✅ | — | ✅ active window changes (Alpha→Beta) | ⏳ Kali | xdotool/wmctrl |
| Interact gating + approval | ✅ | ✅ (level gate, scope never auto-allow) | ✅ needs_approval via runner | ✅ (logic) | consequential scope |
| Mouse/keyboard (Windows) | ✅ | — | — | ❌ not verified | SendKeys/Cursor; `unverified` |
| Mouse/keyboard (macOS) | ✅ | — | — | ❌ not verified | osascript + cliclick; Accessibility perm; `unverified` |
| Browser control (all) | ❌ | — | — | — | Phase 4b — Playwright/CDP, deferred |

Integration evidence here (Xvfb + openbox): `computer.control` moved the cursor to 333,222 (verified),
typed "jarvis phase four" into a focused xterm (read back from a file), and switched the active window
Alpha→Beta (verified via `getactivewindow getwindowname`). **Windows/macOS input is implemented but
NOT verified** — reported `unverified` until a probe/action succeeds there.

**Next concrete milestone:** the **learning pipeline** (Phase 5) — a "watch this and learn"
observation loop that turns OCR'd lesson text into structured notes (FACT/INFERENCE/UNCERTAIN) stored
as memories with source attribution, plus the **mandatory multi-lesson course acceptance test**:
observe lessons → extract definitions/concepts → persist → restart → recall → compare across lessons →
refuse to invent absent facts. Then browser control (Phase 4b) and the Phase 3 UI/Neo surfacing.

### Phase 5 — Learning pipeline ("watch this and learn")

`server/computer/learning.ts` — `LearningPipeline`. Turns accessible lesson content (OCR'd screen
text, captions or supplied text) into discrete, **attributed** knowledge items and stores each as a
persistent memory. Two honesty guarantees: every item carries its source (course, lesson, time) and a
status — **FACT** (directly in the source), **INFERENCE** (derived), **UNCERTAIN**; and `recall()`
only ever returns stored items, so "I didn't find that in the material" is structural — the pipeline
cannot invent. Extraction is **deterministic** (it parses the lesson's own "Definition:/Key term —
/Example:/Caption:/Q:" structure), so stored knowledge is genuinely from the source, not a paraphrase.
New skill `computer.learn` (reads the screen via `observe()` when no text is supplied, then ingests);
API `POST /api/computer/learn`, `GET /api/computer/learning`.

| Requirement (from the brief) | Status | Evidence |
|---|---|---|
| Open/identify the course | ✅ | `courses()` lists learned courses; acceptance test asserts it |
| Observe multiple lessons | ✅ | 3-lesson course ingested |
| Extract definitions/concepts/examples | ✅ | deterministic extractor; asserted kinds + FACT/INFERENCE |
| Structured notes w/ source attribution | ✅ | each note stored with course/lesson/time + status tag |
| Store in **existing** persistent memory | ✅ | notes are ordinary `memory` rows (tag `learn`), searchable by `memory.search` |
| **Restart** the app, knowledge survives | ✅ | acceptance test closes the DB and reopens the same dataDir |
| Answer questions about lessons | ✅ | `recall('photosynthesis')` etc. after restart |
| Compare concepts across lessons | ✅ | `recall('nucleus')` returns notes from lessons 1 **and** 3 |
| Identify absent info, do NOT invent | ✅ | `recall('quantum entanglement')` / `'blockchain'` → `[]` |

The mandatory acceptance test is `tests/learning.test.ts` — it is **not** a generated-summary check:
it persists real rows, restarts the app, and reads them back. Run: `node --test tests/learning.test.ts`.

**Honest limitation:** end-to-end OCR of a *full lesson paragraph* off the screen depends on how the
course renders text; the observe→OCR step is proven on real screen text and the learn→persist→recall
pipeline is proven in full, but fidelity on a given real course (fonts, scrolling, video frames)
should be checked against that course. Supplying accessible text/transcripts (what the brief
recommends) is exact.

**Next concrete milestone:** Phase 4b browser control (Playwright/CDP against the user's logged-in
browser — read page text via the accessibility tree, not screen-scraping; never copy cookies/tokens),
and the Phase 3 UI (a Computer Access panel: ON/OFF, level, active app, live state, STOP) feeding
observation to the Neo sub-agent.
