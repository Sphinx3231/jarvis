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
