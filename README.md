<p align="center"><img src="web/public/icon-192.png" width="120" alt="Jarvis — purple dragon"></p>

<h1 align="center">Jarvis</h1>
<p align="center">A persistent AI personal operating system, represented by a purple dragon.<br>It remembers context, organises and runs tasks in the background, coordinates skills and agents, and never acts beyond what you authorise.</p>

---

## Install the desktop app

Installers for **Windows** (`.exe`), **macOS** (`.dmg`) and **Linux** (`.AppImage`, `.deb`) are built by the *Desktop app* GitHub Actions workflow (Actions → Desktop app → latest run → Artifacts), or locally with `npm run dist` (output in `release/`). The desktop app includes everything it needs — no Node.js or browser required. It keeps running in the system tray when you close the window; choose **Quit Jarvis** from the tray to stop it.

The builds are not code-signed yet: macOS will ask you to confirm in System Settings → Privacy & Security, and Windows SmartScreen will ask you to choose “Run anyway”. Signing needs your own Apple Developer ID / Windows code-signing certificate (electron-builder reads them from `CSC_LINK` / `CSC_KEY_PASSWORD`).

## Run from source

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

`npm run app` (or `npm run desktop` for the Electron window) starts the Jarvis service on `http://127.0.0.1:7777` and opens it in its own app window (Chrome, Edge, Brave or Chromium in app mode). Closing the window shuts Jarvis down safely; interrupted work resumes on the next start. To keep Jarvis working after the window closes:

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

### Email, calendar, voice and more

- **Email** — any IMAP/SMTP account with an app password (Gmail, iCloud, Fastmail, Yahoo, most hosts). Jarvis searches and reads mail; every message it sends needs your approval. Outlook.com/Microsoft 365 require Microsoft sign-in (OAuth), which isn't supported yet.
- **Calendar** — CalDAV accounts (iCloud, Fastmail, Nextcloud…) to read and add events, plus read-only ICS feed links (Google, Outlook and most calendar apps can publish one).
- **Semantic memory** — built in and on by default: a 23 MB model downloaded once runs on your computer, so Jarvis finds memories by meaning without sending them anywhere.
- **Voice** — browser speech recognition where available; otherwise (desktop app, Firefox) Jarvis records and transcribes through OpenAI or a local Whisper server (Settings → Voice).
- **MCP servers** — add tools from the Model Context Protocol ecosystem; the official filesystem server is one click away.
- **Obsidian** — point Jarvis at your vault (Integrations → Obsidian) and it keeps a `Jarvis/` folder up to date automatically: a live manual (every skill, agent, permission, integration and background job, plus these docs), one note per memory, every task with its steps and results, and a daily journal — all linked with `[[wikilinks]]`, tags and frontmatter. Notes you edit are never overwritten, and edits to memory notes flow back into Jarvis as corrections. Jarvis can also write new notes and search your vault when you ask (with your permission).

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
npm test             # backend tests (node:test); calendar tests need `pip install radicale`
npm run test:e2e     # browser + voice end-to-end tests (needs Playwright + Chromium; run `npm run build` first)
npm run desktop      # run the Electron app from source
npm run dist         # build installers for this OS into release/
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it fits together.

## Brand assets

`assets/brand/jarvis-dragon-original.webp` is the official dragon icon. App icons in `web/public/` are generated from it with `python3 scripts/make-icons.py assets/brand/jarvis-dragon-original.webp web/public`.
