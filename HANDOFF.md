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
npm test             # 98 unit tests (node --test, concurrency 1)
npm run build        # builds the web UI (vite → web/dist)
npm run typecheck    # tsc for server + web
npm run test:e2e     # Playwright e2e (ui.e2e.ts + voice.e2e.ts); Chromium is pre-installed
```

E2E screenshots: set `E2E_SCREENSHOTS=<dir>` (and `E2E_SCALE=2` for retina shots). The e2e boots a
real Jarvis on a temp dir, drives the built UI in Chromium, and asserts real behavior.

**Current status:** typecheck clean · 98/98 unit tests pass · both e2e flows pass.

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

## 3. The UI (immersive "whole-app Jarvis")

- Press **`\`** (backslash) to toggle **immersive mode**: sidebar/topbar/aside hide and Jarvis fills the
  screen. State persists in `localStorage`. There's also a corner toggle button.
- The home **stage**: a luminous **JARVIS planet** with a precessing **Saturn ring** and an in-SVG
  wordmark; **six agent satellite nodes** ringing it (labeled pills with colored icons + status);
  a pulsing **portal** beneath; a **voice-first command bar** ("Say 'Hey Jarvis', or tap to talk")
  with a keyboard fallback; and a live state pill (Idle/Listening/Working · wake word).
- In a conversation the hero collapses to a small core with the agent colors as orbs.
- Core is a real inline-SVG vector rig (`Core.tsx`), one `requestAnimationFrame` loop with eased
  per-state params; holds a static pose under `prefers-reduced-motion`.

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
3. **PC system monitor ("know what the PC is doing")** — BUILDABLE as real telemetry on Kali: process
   list, CPU/RAM/network, foreground/active window (cross-platform via `ps`/`tasklist` + `os`, per-OS
   active-window best-effort). Feed it to Neo + a dashboard.
   - **NOT buildable in this app:** screen vision, controlling other apps, "watching" videos/courses/
     games, or observing external tools' windows — that needs computer-use + vision, which Jarvis
     doesn't have. This has been flagged to the user repeatedly; don't promise it.
4. **MCP presets** for the above services (optional; MCP client already verified — `tests/mcp.test.ts`).

Suggested order: Gmail + PayPal, then the PC system monitor.

---

## 9. Conventions & gotchas

- **Do not add model guardrails.** The user is explicit: guardrails come from the connected model.
  Only enforce **authorization** (scope/approval), which is what the methodology itself requires.
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
