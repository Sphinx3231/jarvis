<p align="center"><img src="web/public/icon-192.png" width="120" alt="Jarvis — purple dragon"></p>

<h1 align="center">Jarvis</h1>
<p align="center">A persistent AI personal operating system, represented by a purple dragon.<br>It remembers context, organises and runs tasks in the background, coordinates skills and agents, and never acts beyond what you authorise.</p>

<p align="center"><strong>Built on <a href="https://github.com/KenKaiii/Roamies">Roamies</a></strong> — Jarvis thinks with the Roamies engine and needs Roamies installed.</p>

---

## Requires Roamies

Jarvis is built on [Roamies](https://github.com/KenKaiii/Roamies) by KenKaiii. It thinks with the same engine (the [GG framework](https://github.com/KenKaiii/gg-framework)), the model you picked in Roamies and the sign-ins you made there — Claude, ChatGPT, Gemini, an API key or a local model. Jarvis never asks for your passwords or keys and never stores them: it asks the GG framework for a fresh credential for each request.

1. [Install Roamies](https://github.com/KenKaiii/Roamies/releases/latest) and open it once to sign in on its Model page.
2. Open Jarvis.

Until Roamies is found, Jarvis shows only a **Roamies required** screen with a download link and **Check again** (it also re-checks by itself every few seconds and starts the moment Roamies appears — no restart). It looks for `Roamies.app` in `/Applications` or `~/Applications` on macOS, the Roamies installer's folder (or its uninstall entry) on Windows, and the `roamies` command (`.deb`/`.rpm`) or a `Roamies*.AppImage` in the usual folders on Linux. Installed somewhere else? Choose **Installed it somewhere else?** and give its path.

Change model or sign in from the Model page in Roamies; Jarvis follows within seconds. Settings → Model can pick a different model from the same sign-ins and how much it thinks.

### Local models (Ollama, LM Studio, llama.cpp…)

Jarvis runs on local models too, with no account. It finds a running [Ollama](https://ollama.com) by itself (at `127.0.0.1:11434`, or wherever `OLLAMA_HOST` points) and lists its models under Integrations → Model; add any other OpenAI-compatible server (LM Studio, llama.cpp, vLLM…) by its address there. Pick a local model in Roamies or in Settings → Model. If nothing is signed in, Jarvis uses a running local model by itself.

Models that support tools (e.g. Qwen 3, Llama 3.1) can do everything. Models that don't (e.g. DeepSeek-R1 in Ollama) can still chat, and direct commands still work, but they can't search memory, plan tasks or act — Jarvis says so rather than pretending. Give a local model at least 16k (better 32k) tokens of context (Ollama: Settings → Context length).

### Guardrails come from the model

Jarvis adds no content rules of its own: what it will or won't talk about is decided entirely by the model it is connected to — Claude's own behaviour with Claude, DeepSeek's with a local DeepSeek, and so on. Your message reaches the model as you wrote it and its answer comes back as written; if the model declines, Jarvis tells you the model declined. What Jarvis does keep is *your* control over actions taken on your behalf (below) and its protection against instructions hidden in web pages and files.

### Your request is the approval

Jarvis does what you ask without asking again: every step of a task you asked for is checked against your own words, and steps that are clearly part of it — the command you typed, the page you asked it to fetch, the email you asked it to send — just run. Anything **not** part of what you asked needs your explicit approval, with the reason shown on the approval card: extra steps the model added, tasks Jarvis or a schedule started on its own, and any action containing text that looks like instructions from a web page or file. The check uses your literal words first, then a separate model call with no tools that sees only your words, Jarvis's previous reply and the exact action — never the planning model's own claims. When in doubt, it asks. A permission set to *Deny* stays denied. Turn it off in Settings → Permissions → *Do what I ask without asking again* to approve every consequential step yourself.

## Install the desktop app

Installers for **Windows** (`.exe`), **macOS** (`.dmg`) and **Linux** (`.AppImage`, `.deb`) are built by the *Desktop app* GitHub Actions workflow (Actions → Desktop app → latest run → Artifacts), or locally with `npm run dist` (output in `release/`). The desktop app includes everything it needs — no Node.js or browser required. It keeps running in the system tray when you close the window; choose **Quit Jarvis** from the tray to stop it.

The builds are not code-signed yet: macOS will ask you to confirm in System Settings → Privacy & Security, and Windows SmartScreen will ask you to choose “Run anyway”. Signing needs your own Apple Developer ID / Windows code-signing certificate (electron-builder reads them from `CSC_LINK` / `CSC_KEY_PASSWORD`).

On Linux, the `.AppImage` needs FUSE (`sudo apt install libfuse2`). When you run as **root** (common on Kali Linux) Jarvis disables the Chromium sandbox automatically so it can start; as a normal user the sandbox stays on.

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

### The model

Jarvis uses the model from Roamies (see **Requires Roamies** above). Without a Roamies sign-in it still handles direct commands (“remember that …”, “remind me in 10 minutes to …”, “fetch https://…”, “run \`…\`”, “list files”, “show tasks”, “status”). When Roamies is signed in with Claude, Jarvis runs through Claude Code exactly as Roamies does — with none of Claude Code's own tools, only Jarvis's, each still checked by Jarvis's permission engine.

### Email, calendar, voice and more

- **Email** — any IMAP/SMTP account with an app password (Gmail, iCloud, Fastmail, Yahoo, most hosts). Jarvis searches and reads mail; every message it sends needs your approval. Outlook.com/Microsoft 365 require Microsoft sign-in (OAuth), which isn't supported yet.
- **Calendar** — CalDAV accounts (iCloud, Fastmail, Nextcloud…) to read and add events, plus read-only ICS feed links (Google, Outlook and most calendar apps can publish one).
- **Semantic memory** — built in and on by default: a 23 MB model downloaded once runs on your computer, so Jarvis finds memories by meaning without sending them anywhere.
- **Voice** — browser speech recognition where available; otherwise (desktop app, Firefox) Jarvis records and transcribes with the OpenAI API key saved in Roamies, or your own (e.g. local) Whisper server (Settings → Voice).
- **MCP servers** — add tools from the Model Context Protocol ecosystem; the official filesystem server is one click away.
- **Bug-bounty pipeline (HackerOne)** — connect your HackerOne account (username + an API token from HackerOne → Settings → API Tokens) and Jarvis tracks your bounty **earnings** (total, last 30 days, average, by month), your **reports** by state, and **discovers new programs**. Turn on *Keep running* and it refreshes and keeps discovering on its own for as long as you leave it on — see it all on the **Pipeline** page. It is strictly read-only: Jarvis observes and analyses the pipeline and never tests, scans or attacks anything. Actually working a target is a normal task that goes through your approvals. The token is encrypted on disk and sent only to HackerOne.
- **Jarvis vault (Obsidian)** — Jarvis creates its own Obsidian vault on first start (`~/Documents/Jarvis Vault`, changeable in Integrations) and keeps everything it learns there: one note per memory, every task with its steps and results, your conversations, a daily journal and a live manual (every skill, agent, permission, integration and background job, plus these docs) — linked with `[[wikilinks]]`, tags and frontmatter, and updated within seconds. Open it in Obsidian with “Open folder as vault” once. Notes you edit are never overwritten, edits to memory notes flow back into Jarvis, and notes you add yourself are left alone. Jarvis never writes into another vault: it refuses any folder that already holds other files.

Account passwords and server keys Jarvis keeps (email, calendar, MCP, a transcription server) are encrypted on disk and never sent to the browser. Model sign-ins stay in Roamies.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `JARVIS_PORT` | `7777` | Port (bound to 127.0.0.1 only) |
| `JARVIS_DATA_DIR` | `~/.jarvis` | Database, encryption key, workspace folder |
| `JARVIS_MASTER_KEY` | generated file | 64 hex chars; overrides the generated key file |
| `JARVIS_BROWSER` | auto-detected | Browser executable for the app window |
| `ROAMIES_DATA_DIR` | `~/.gg` | Where Roamies keeps `sidekick.json` (as in Roamies) |
| `JARVIS_ROAMIES_PATH` | auto-detected | Treat this path as the Roamies install (tests and CI; an empty or missing path means “not installed”) |
| `JARVIS_GG_DIR` | `~/.gg` | Roamies/GG settings and sign-ins folder (tests) |
| `OLLAMA_HOST` | `127.0.0.1:11434` | Where Jarvis looks for Ollama (same variable Ollama uses) |

Everything else is in **Settings** inside the app.

## What Jarvis does

- **Any model.** Whatever Roamies is signed in to, or a local model on your own computer.
- **Runs an ethical-hacking pipeline.** Tracks your HackerOne bounty earnings and report status and discovers new programs, refreshing on its own while you leave it on — read-only, it never tests or attacks anything.
- **Talks and understands.** Natural-language requests go to the central intelligence: fast rule-based intents for explicit commands, otherwise a model with tools. Read-only tools (memory, tasks, status, workspace files) run inline; anything that does work becomes a task.
- **Runs tasks in the background.** A persistent task engine with priorities, scheduling, recurrence, pause/resume/cancel/retry, per-step verification, retries for steps that are safe to repeat, and crash recovery that **never repeats an action whose outcome is uncertain**.
- **Does what you ask; asks about the rest.** Every skill call goes through one permission engine. What you asked for runs; anything beyond it asks first, with the reason. Approvals are single-use and bound to the exact action; you can remember one *exact* action for recurring work. Saying "approve" in chat or by voice never approves a pending action.
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

## License

Jarvis is free software under the [GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`), like Roamies and the GG framework it is built on. You may use, study, change and share it; if you distribute a changed version or let others use it over a network, you must offer its source under the same license. See [NOTICE.md](NOTICE.md) for credits and third-party components.

## Brand assets

`assets/brand/jarvis-dragon-original.webp` is the official dragon icon. App icons in `web/public/` are generated from it with `python3 scripts/make-icons.py assets/brand/jarvis-dragon-original.webp web/public`.
