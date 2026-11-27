# B — OpenJarvis as a component behind Jarvis + Hermes Agent

Source: `open-jarvis/OpenJarvis` main @ `5a9b526` (2026-11-21). All paths are relative to `src/openjarvis/` unless noted. **Caveat:** Jarvis pins commit `427c2dd` (`scripts/local-setup/setup-linux.sh:15`). The clone is shallow, so I could not diff the pin against main. Line numbers are for main.

## 1. Architecture

- **Size:** about 181k LOC of Python plus a Rust workspace with 17 crates (`rust/crates/*`, a PyO3 extension called `openjarvis_rust`). There are 729 test files.
- **Main packages (LOC):**
  - `evals` 37k, `agents` 24k, `cli` 18k, `learning` 14.5k, `tools` 14.5k, `connectors` 13.7k, `server` 12k
  - `channels` 6.3k (about 30 messengers), `engine` 5.8k, `security` 5k, `telemetry` 4.3k
  - `skills`, `scheduler`, `memory`, `mcp`, `a2a`, `mining` (crypto "Pearl" mining), `speech`
- **Engines:**
  - `engine/ollama.py` (native `/api/chat`).
  - OpenAI-compatible engines registered from a data table in `engine/openai_compat_engines.py:8-19`: vllm, sglang, llamacpp, mlx, lmstudio, exo, nexa, uzu, apple_fm, lemonade.
  - Optional engines: `nim`, `cloud`, `litellm`, `gemma_cpp`, `afm` (`engine/__init__.py:31`).
  - `discover_engines()` probes every registered engine in parallel (`engine/_discovery.py:122`). `MultiEngine` routes a request by model name to the engine that lists it (`engine/multi.py:15`).
- **Engine wrapper stack in `jarvis serve`:**
  1. `GuardrailsEngine` (`cli/serve.py:279-282`)
  2. `InstrumentedEngine`, which records telemetry and energy (`:310-327`)
  3. `MultiEngine` (`:345`)
- **"Router":**
  - The server does **not** pick a model. It runs `score_complexity()` only to *raise* `max_tokens` (`server/routes.py:257-281`).
  - The `RouterPolicyRegistry` heuristic and learned routers are used only by the CLI `ask` path (`cli/ask.py:1000-1042`).
  - `GET /v1/recommended-model` returns "the second-largest local chat model" (`server/agent_manager_routes.py:345-370`).

### All HTTP routes (`jarvis serve`)

| File | Routes |
|---|---|
| `server/routes.py` | POST `/v1/chat/completions` (158); GET `/v1/models` (1164); POST `/v1/models/pull` (1219, Ollama only); DELETE `/v1/models/{name}` (1257); POST `/v1/cloud/reload`; GET `/v1/savings` (1369); POST `/v1/telemetry/reset`; GET `/v1/info` (1448); GET `/health` (1463); GET `/v1/channels`, POST `/v1/channels/send`, GET `/v1/channels/status`; GET `/v1/security/scan` (1526) |
| `server/api_routes.py` | `/v1/agents` GET/POST/DELETE, POST `/{id}/message` (105-184); `/v1/memory` store/search/stats/config/index (236-336); `/v1/traces`, `/{id}`; `/v1/telemetry/stats` and `/energy` (482, 509); `/v1/skills` GET/POST/DELETE; `/v1/sessions`, `/{id}`; `/v1/budget` GET and PUT `/limits`; GET `/metrics` (Prometheus, 658); WS `/v1/chat/stream` (766); `/v1/learning/stats` and `/policy`; `/v1/speech/transcribe`, `/health`, `/synthesize`, `/tts/health` (993-1177); `/v1/feedback`, `/stats`; `/v1/optimize/runs` GET/GET-by-id/POST |
| `server/approval_routes.py` | GET `/v1/approvals/pending`, POST `/{id}/approve` and `/{id}/deny` |
| `server/agent_manager_routes.py` | `/v1/managed-agents` CRUD, pause/resume/run/recover, tasks CRUD, channels, messages, state, learning, learning/run, traces (1648-2284); `/v1/templates` and `/{id}/instantiate`; `/v1/agents/errors` and `/health`; `/v1/recommended-model`; `/v1/tools` and its credentials routes; `/v1/channels/sendblue/*` |
| Other files | WS `/v1/agents/events` (`ws_bridge.py:66`); `/v1/connectors` list/get/connect/disconnect/oauth start/callback/sync (`connectors_router.py:432-905`); `/v1/connectors/upload/ingest` and `/ingest/files`; `/api/digest` GET, `/audio`, `/generate`, `/history`, `/schedule` GET/POST; POST `/api/research`; `/v1/analytics/identity` and `/preference`; `/webhooks/{twilio,bluebubbles,whatsapp,sendblue}` (conditional, `app.py:540`); `/dashboard`; `/comparison`; SPA catch-all GET `/{path}` (`app.py:555`) |

**Not present:** `/v1/embeddings`, `/v1/completions`, `/v1/responses`, and any external MCP endpoint. `mcp/server.py` is used only in-process, through `InProcessTransport` in `system/builder.py:477`.

## 2. OpenJarvis's own harness pieces (all compete with Hermes and Jarvis)

- **Agents:** 27 registered agents, including:
  - `simple`, `orchestrator`, `native_react`, `operative`, `deep_research`, `rlm`
  - Wrappers for `claude_code`, `openhands` and `opencode`
  - Hybrid research agents: `archon`, `minions`, `conductor`, `toolorchestra`, `mini_swe_agent`
  
  `OrchestratorAgent` is a multi-turn tool-calling loop (`agents/orchestrator.py:1-10,64`). The default server agent is `orchestrator` (`core/config.py:1167`); Jarvis sets `agent = "simple"` (`jarvis/server/llm/profiles.ts:186`). Agents can be used as a library: `agent_cls(engine, model, **kwargs)` (`cli/serve.py:481`).
- **Managed agents platform:** `AgentManager` (SQLite `agents.db`) plus `AgentScheduler` (cron/interval). Both are **enabled by default** and started by `serve` (`core/config.py:1659`, `cli/serve.py:605-715`). This duplicates Jarvis's task lifecycle.
- **Scheduler:** `scheduler/` `TaskScheduler` (cron/interval/once, SQLite, runs an agent per task). This competes with any host scheduler.
- **Tools:** about 60 registered tools (`ToolRegistry.register`), including shell_exec, file_read/write, apply_patch, browser_*, web_search, http_request, git_*, code_interpreter(_docker), calendar, channel_send, memory_*, kg_*, agent_spawn/kill, and approval-queue tools. `ToolExecutor` (`tools/_stubs.py:283,341`) applies a rate limiter and a capability policy.
- **Memory:**
  - Retrieval backends: sqlite/FTS5 (needs the Rust extension), bm25, faiss, colbert, dense, hybrid, knowledge_graph.
  - `MemoryService`: LLM fact extraction, **off by default** (`core/config.py:973`).
  - Chat context injection is **on by default**: `agent.context_from_memory=True` (`core/config.py:1141`), applied in `routes.py:172-245`.
- **Skills:** a skill manager that imports from **Hermes Agent** (`skills/sources/hermes.py:22`, `HERMES_REPO_URL`), OpenClaw and GitHub, plus a tool translator (`skills/tool_translator.py:3`).
- **Approvals:** `/v1/approvals` and `security.enforce_tool_confirmation=True`. These duplicate Jarvis permissions.
- **Learning:** DSPy/GEPA/ACE optimizers, SFT/GRPO trainers, learned router. `POST /v1/optimize/runs` is a **stub**: it returns `{"run_id": "placeholder"}` (`api_routes.py:1285-1288`). Budget limits are an in-memory dict that nothing enforces (`api_routes.py:627-652`).

## 3. Capabilities Jarvis doesn't use yet

| Capability | How to call it | Dependencies | Maturity |
|---|---|---|---|
| Telemetry: tokens, latency, ITL, throughput, energy (NVIDIA/AMD/Apple/RAPL), cost | `GET /v1/telemetry/stats`, `/v1/telemetry/energy`, `/metrics`, `/v1/savings`. `InstrumentedEngine` wraps every engine call. | Core; energy needs pynvml, amdsmi or zeus extras | 23 telemetry test files. The code comments discuss fixing double-counted records (`routes.py:532-557`). Energy is off unless counters are readable (`config.py:1206`). |
| Hardware detection plus engine/model recommendation | Library only: `core.config.detect_hardware/recommend_engine/recommend_model` (`config.py:249-311`); `jarvis doctor` | Core | No route. Simple heuristics. |
| Model management | POST `/v1/models/pull`, DELETE `/v1/models/{m}` | Ollama only (`routes.py:1228-1233`) | Thin proxy over Ollama's `/api/pull`. |
| Model catalog | `intelligence/model_catalog.py` (78 `ModelSpec` entries with context length and engines) | Core | Static data. |
| Retrieval | POST `/v1/memory/index`, `/store`, `/search` | sqlite backend **requires** `openjarvis_rust`, otherwise 503 (`api_routes.py:207-230`). Rust is in a uv dependency group, not on PyPI (`pyproject.toml:319-327`), so Jarvis's pip install probably lacks it (**unverified**). | 14 memory test files. There is no embeddings endpoint. The connector pipeline embeds through Ollama `nomic-embed-text` (`connectors/embeddings.py`). |
| Connectors | `/v1/connectors/*`: Gmail, GCal, Drive, Notion, Obsidian, Slack, IMAP, Apple apps, Oura, Strava and others, with OAuth and sync | Per-connector SDKs | Large and broad. Quality per connector not verified. |
| Voice extras | STT: faster-whisper, deepgram, openai. TTS: kokoro, cartesia, elevenlabs, openai_tts (`speech/*.py`). `/v1/speech/health`. | Extras | 12 speech test files. Jarvis already uses faster-whisper and Kokoro; the others are cloud services. |
| Security scanners | `security/scanner.py` (secret and PII regex, Rust-accelerated), `injection_scanner.py`, `ssrf.py`, `GET /v1/security/scan` | Core | 30 test files. |
| Traces | `GET /v1/traces` | Core | Only covers OpenJarvis-side agent runs. |

## 4. Overlap with Hermes Agent (don't use)

The following duplicate the harness and should stay **off** when Hermes owns the loop and Jarvis owns tasks, permissions and memory:

- Server agent, managed agents and their scheduler, `TaskScheduler`
- The tool registry and executor, approvals
- `MemoryService`, chat memory-context injection
- The skills manager (it even pulls Hermes skills), learning/optimizers
- Channels, digest, the A2A server

Hermes's own loop, tools, memory and skills are **not verified in this report**.

## 5. License and runtime

- **License:** Apache-2.0 (`LICENSE`, `pyproject.toml:13`). Classifier: "Development Status :: 3 - Alpha".
- **Python:** `>=3.11,<3.14`.
- **Core dependencies are heavy for a "brain" process:** `datasets`, `posthog`, `python-telegram-bot`, `nvidia-ml-py`, `ddgs`, `openai`, `croniter`, `lxml`, and others (`pyproject.toml:25-48`). The server, speech and voice extras add fastapi/uvicorn, faster-whisper/av/onnxruntime, and kokoro (which pulls spaCy).
- **Memory use:** Jarvis measured about 500 MB idle (`jarvis/docs/LOCAL_SETUP.md:23`).
- **Engine:** an external engine (Ollama etc.) must be running.
- **Analytics:** PostHog analytics is off by default (`config.py:1224`).
- **Auth:** optional bearer token via `OPENJARVIS_API_KEY` (`server/auth_middleware.py:39`). Binding to a non-loopback address without a key is refused (`:104-118`).

## 6. Is `/v1/chat/completions` a good backend for an external harness?

**What works:**
- `tools` are passed through. When `tools` is present, the server agent is bypassed (`routes.py:163-167,284-306,319-339`).
- Non-streaming responses return OpenAI-shaped `tool_calls` (`routes.py:584-597`).
- With `stream:true` plus tools, SSE carries `delta.tool_calls` (`_handle_stream_tools`, `routes.py:840-967`). Ollama's tool calls are converted to indexed fragments (`engine/ollama.py:455-488`).
- Multiple models are supported through `MultiEngine`, and `/v1/models` lists them.
- Tests exist: `tests/server/test_routes.py:370,407,746`.

**Gaps and risks** (these are the reasons to put a thin adapter in front, or to talk to Ollama directly):

1. **Narrow request schema.** The request accepts only `model, messages, temperature, max_tokens, stream, tools` (`server/models.py:24-30`).
   - `tool_choice`, `parallel_tool_calls`, `response_format`, `stop`, `top_p` and `seed` are silently dropped.
   - The OpenAI-compatible engines force `tool_choice="auto"` (`engine/_openai_compat.py:99-101`).
2. **`content: str`** (`models.py:18`). A `null` content (the normal assistant tool-call turn from the OpenAI SDK) or content given as a list of parts fails validation. Jarvis already works around this (`openjarvis.ts:80`). Hermes would need a shim.
3. **Silent tool drop.** On HTTP 400 the engine retries **without tools** (`ollama.py:194-197`, `_openai_compat.py:105-108`). The agent then just sees text.
4. **Wrong `finish_reason` from Ollama.** The non-streaming Ollama path always returns `finish_reason="stop"`, even when tool calls are present (`ollama.py:221,240-266`). The streaming path sets `"tool_calls"` correctly (`:489`).
5. **Errors arrive as content.** Mid-stream errors are emitted as assistant text ("Error during generation") with `finish_reason=stop`, not as an HTTP error (`routes.py:922-942`).
6. **Hidden prompt mutation:**
   - PII and secret **redaction of every input message** is on by default (`security.enabled/pii_scanner/mode="redact"`, `config.py:1437-1447`; `guardrails.py:165-188`). It redacts email addresses, for example (`scanner.py:208-212`), so a tool argument from a prior turn can be mangled.
   - The memory-context system prompt is injected (`routes.py:172-245`).
   - An identity prompt is injected when no system message is given (`routes.py:61-155`).
   - `max_tokens` can be bumped up (`routes.py:273-276`).
   - Ollama `think` is forced to `False` (`ollama.py:170-176`).
7. **Usage reporting.** Streaming tool responses report no `usage` in the finish chunk (`routes.py:944-953`); only an extra `telemetry` field is added.

## Recommendation

| Component | Verdict | Reason |
|---|---|---|
| `/v1/chat/completions` as Hermes's model endpoint | **Integrate via adapter** (or Defer in favour of direct Ollama) | Tool calls are passed through and streamed, but there are schema gaps (null content, tool_choice), silent tool drop, a wrong finish_reason, and default PII redaction. Set `security.enabled=false` (or `pii_scanner=false`) and `agent.context_from_memory=false` before using it. |
| `/v1/models`, `/health`, `/v1/info` | **Reuse** | Already used; simple and stable. |
| Speech STT/TTS endpoints | **Reuse** | Already used. Keep Jarvis's on-demand workers as the primary path. |
| Cloud STT/TTS backends (deepgram, elevenlabs, cartesia) | **Defer** | Cloud-only; conflicts with the local-only goal. |
| Telemetry, energy, savings, `/metrics` | **Integrate via adapter** | Cheap, read-only, and adds tokens, latency and energy for Jarvis's dashboard. Energy depends on hardware counters. |
| Hardware detect and model catalog | **Integrate via adapter** (library or CLI) | Useful for setup and model selection. There's no HTTP route, so it needs a small Python shim. |
| Model pull/delete | **Defer** | Thin Ollama proxy; calling Ollama directly is simpler. |
| Complexity scorer / routers | **Defer** | The scorer only raises max_tokens. The routers are CLI-only, and the learned router needs traces. |
| `/v1/memory`, retrieval backends | **Reject** for now | Jarvis owns memory. It needs the Rust extension and has no embeddings endpoint. |
| Connectors (OAuth and sync) | **Defer** | Potentially valuable as data sources, but large surface; evaluate individually. |
| Security scanners (as a library) | **Defer** | Could feed Jarvis's permissions layer later; must not run inline on prompts. |
| Agents, orchestrator, managed agents, AgentScheduler, TaskScheduler | **Reject** | Duplicates Hermes's loop and Jarvis's task lifecycle and scheduler. Set `agent_manager.enabled=false`. |
| Tools registry, approvals, MCP (in-process) | **Reject** | Hermes and Jarvis own tools and permissions. No external MCP endpoint exists. |
| MemoryService, skills manager | **Reject** | Duplicates Jarvis memory and Hermes skills. |
| Learning, optimize, evals, budget | **Reject/Defer** | Research-grade. The optimize POST and budget are stubs. |
| Channels, digest, A2A, mining | **Reject** | Out of scope, and they add attack surface. |

**Unverified:** Hermes Agent's own internals and how it treats `null` content and `finish_reason`; whether Jarvis's pinned commit `427c2dd` matches main for the lines cited; whether `openjarvis_rust` is absent from Jarvis's pip install; quality of individual connectors.
