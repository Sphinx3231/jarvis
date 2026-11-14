<p align="center"><img src="web/public/icon-192.png" width="120" alt="Jarvis — purple dragon"></p>

<h1 align="center">Jarvis</h1>
<p align="center">A persistent AI personal operating system, represented by a purple dragon.<br>It remembers context, organises and runs tasks in the background, coordinates skills and agents, and never acts beyond what you authorise.</p>

---

## Quick start

Requirements: **Node.js 22.18 or newer** (uses the built-in SQLite and runs TypeScript directly — no native modules, no build step for the service).

```bash
npm install
```

```bash
npm run build
```

```bash
npm run app
```

`npm run app` starts the Jarvis service on `http://127.0.0.1:7777` and opens it in its own app window (Chrome, Edge, Brave or Chromium in app mode). Closing the window shuts Jarvis down safely; interrupted work resumes on the next start. To keep Jarvis working after the window closes:

```bash
npm run app -- --keep-running
```

To run only the service (then open the printed address in a Chromium-based browser):

```bash
npm start
```

### Connect a model

Jarvis works without a model for direct commands (“remember that …”, “remind me in 10 minutes to …”, “fetch https://…”, “run \`…\`”, “list files”, “show tasks”, “status”). For open-ended requests, planning and summaries, configure a provider on **Integrations**:

- **Anthropic Claude** (default primary, `claude-opus-5-5`) — paste an API key, or set `ANTHROPIC_API_KEY` before starting.
- **OpenAI** or any **OpenAI-compatible** endpoint — paste a key or set `OPENAI_API_KEY`.
- **Ollama / LM Studio** (local, no key) — enable it and set the model name.

Keys are encrypted on disk and never sent to the browser. Providers are tried in order (primary, then fallbacks).

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `JARVIS_PORT` | `7777` | Port (bound to 127.0.0.1 only) |
| `JARVIS_DATA_DIR` | `~/.jarvis` | Database, encryption key, workspace folder |
| `JARVIS_MASTER_KEY` | generated file | 64 hex chars; overrides the generated key file |
| `JARVIS_BROWSER` | auto-detected | Browser executable for the app window |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `JARVIS_<PROVIDER>_API_KEY` | — | Provider keys from the environment |

Everything else is in **Settings** inside the app.

## What Jarvis does

- **Talks and understands.** Natural-language requests go to the central intelligence: fast rule-based intents for explicit commands, otherwise a model with tools. Read-only tools (memory, tasks, status, workspace files) run inline; anything that does work becomes a task.
- **Runs tasks in the background.** A persistent task engine with priorities, scheduling, recurrence, pause/resume/cancel/retry, per-step verification, retries for steps that are safe to repeat, and crash recovery that **never repeats an action whose outcome is uncertain**.
- **Asks before acting.** Every skill call goes through one permission engine. Internal work runs automatically; external actions ask first by default; shell commands always ask. Approvals are single-use; you can remember one *exact* action for recurring work. Voice and chat can never approve anything.
- **Remembers.** Long-term memory (preferences, projects, decisions, procedures, facts, task history, tool docs) with sources, confidence, verified/unverified status, deduplication, full-text search and optional semantic embeddings. You can search, confirm, correct and delete everything.
- **Keeps watch.** Background jobs monitor tasks, recover stalled work, remind you about pending approvals, organise memory and check integrations — without unnecessary model calls.
- **Extends.** Skills are modular; MCP servers add tools (calendar, email, notes, dev tools…) as permission-gated skills.
- **Shows its state honestly.** The dragon animates only for real states: idle, thinking, listening, speaking, working, success, error.

## Development

```bash
npm run dev:server   # service with auto-restart (set JARVIS_DEV=1 to allow the Vite origin)
npm run dev:web      # Vite dev server on :5173, proxies /api to the service
npm run typecheck    # service + UI
npm test             # 47 backend tests (node:test)
npm run test:e2e     # browser end-to-end test (needs Playwright + Chromium; run `npm run build` first)
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it fits together.

## Brand assets

`assets/brand/jarvis-dragon-original.webp` is the official dragon icon. App icons in `web/public/` are generated from it with `python3 scripts/make-icons.py assets/brand/jarvis-dragon-original.webp web/public`.
