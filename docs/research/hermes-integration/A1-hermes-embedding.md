# A1: Embedding Hermes Agent as Jarvis's execution harness

Source: NousResearch/hermes-agent, shallow clone at HEAD `38fde824`. All paths below are relative to that clone. I read the code statically and did not install or run Hermes. Anything marked **UNVERIFIED** was not executed.

## TL;DR

- The core loop is `AIAgent.run_conversation()`. It is synchronous and blocking, and it takes rich callbacks.
- In current main, the stock CLI (`hermes chat -q`) and the stock ACP server (`hermes acp`) both auto-start a separate per-profile gateway daemon. That daemon owns sessions, approvals and `state.db`. This conflicts with Jarvis keeping authority over the task lifecycle.
- **Recommendation:** Jarvis spawns a small Python bridge script that we own. The script imports `AIAgent` in-process and speaks JSON Lines (JSONL) over stdio. Jarvis passes the history on every turn, so Jarvis owns persistence. Approvals are routed back to Jarvis.
- **Second choice:** keep the standard ACP wire protocol, but use an in-process entry, `HermesACPAgent(session_manager=SessionManager())`, instead of `hermes acp`.

## 1. Execution lifecycle

- **Class.** `run_agent.py:215`, `class AIAgent(ClientLifecycleMixin, StreamDeliveryMixin, … InterruptControlMixin, … TurnFacadeMixin, …)`. `__init__` (`run_agent.py:237-290`) is a forwarder to `agent/agent_init.py:2042 init_agent`.
- **Entry points.** `agent/turn_facade.py:22 run_conversation(user_message, system_message=None, conversation_history=None, task_id=None, stream_callback=None, …) -> dict`. `turn_facade.py:222 chat(message) -> str` is a convenience wrapper.
- **Core loop.** `agent/conversation_loop.py:1782 run_conversation` calls `_run_conversation_turn`. The main loop is at `conversation_loop.py:1724`:
  ```python
  while _prelude_action != "break" and (
      (s.api_call_count < agent.max_iterations and agent.iteration_budget.remaining > 0) or agent._budget_grace_call):
  ```
  Each iteration runs these phases in order:
  1. `begin_iteration`, `prepare_iteration` and `assemble_api_request`.
  2. `run_preflight_gate`: compression and context-overflow checks.
  3. `_run_api_retry_loop` (`:1555`): build, call, check.
  4. `normalize_model_response`.
  5. `run_tool_round` if `assistant_message.tool_calls`, otherwise `finish_text_response` (`:1764`).

  The text-response branch ends the turn. The tool round appends the tool results and loops again. Finalization is in `agent/turn_finalizer.py`.
- **Result dict keys.** `final_response, messages, api_calls, completed, interrupted, failed, partial, turn_exit_reason, model, provider, base_url, last_reasoning, …`.
- **Max iterations.** The constructor default is `max_iterations=sys.maxsize`, i.e. unlimited (`run_agent.py:241`). The config key `agent.max_turns` defaults to `None` (unlimited) at `hermes_cli/config_defaults.py:67`. An `IterationBudget` is created at `agent/agent_init.py:2098`. When the budget runs out the agent gets one tool-less grace call (`agent/turn_iteration_prep.py:405-416`).
- **Interrupt and cancel.** Call `agent.interrupt(message=None, *, hard_cancel=False, …)` from another thread (`agent/interrupt_control.py:163`). It is checked at each iteration start (`turn_iteration_prep.py:382`, `if agent._interrupt_requested: … "interrupted_by_user"`). An interrupt during an API call raises `InterruptedError`, which is handled in `conversation_loop.py:1569`. The class also has `steer(text)` at `:310` and `redirect(text)` at `:323`, which inject a mid-turn correction. ACP cancel uses `request_hard_interrupt(agent)` (`acp_adapter/server.py:697-714`).
- **Timeouts.**
  - Per-call request timeout: `HERMES_API_TIMEOUT`, default 1800 s (`run_agent.py:566-570`).
  - Non-stream stale-call detector: default 90 s, override with `HERMES_API_CALL_STALE_TIMEOUT` (`:572-591`).
  - Optional wall-clock budget `run_budget_seconds`, as a constructor argument or `agent.run_budget_seconds` (`config_defaults.py:74`). At 80% of the budget a wrap-up notice is injected (`conversation_loop.py:138`).
- **Retries and fallback.**
  - `agent.api_max_retries` defaults to 3 (`agent/agent_init.py:1273-1278`).
  - `auto_recovery_cycles` defaults to 5 (`:1280-1284`).
  - The constructor arguments `fallback_model=` and `credential_pool=` enable the init-time and runtime fallback chain (`agent_init.py:747-800`).

## 2. Embedding options

### (a) Import `AIAgent` directly (recommended, via our own bridge)

The constructor arguments that matter are at `run_agent.py:237-290`:

- **Model:** `base_url`, `api_key`, `provider`, `api_mode`, `model`.
- **Tools:** `enabled_toolsets` / `disabled_toolsets`. Toolset names come from `toolsets.py:70`, for example `file`, `terminal`, `web`, `todo`, `memory`, `delegation`, `session_search`, `code_execution`, `browser`, `skills`, `clarify`.
- **System prompt:** `ephemeral_system_prompt`.
- **Isolation flags:** `quiet_mode`, `skip_context_files`, `skip_memory`, `skip_background_review`, `load_soul_identity=False`.
- **Session:** `session_id`, `session_db`, `persistence`, `cwd`.
- **Limits:** `max_iterations`, `run_budget_seconds`, `fallback_model`, `request_overrides`, `max_tokens`, `reasoning_config`.
- **Callbacks:** `tool_progress_callback`, `tool_start_callback`, `tool_complete_callback`, `thinking_callback`, `reasoning_callback`, `step_callback`, `stream_delta_callback`, `interim_assistant_callback`, `status_callback`, `notice_callback`, `event_callback`, `clarify_callback`, `tool_result_metadata_callback`.

Notes on the system prompt:
- `ephemeral_system_prompt` is appended to Hermes's own system prompt at API time (`conversation_loop.py:1229`). It does not replace it.
- `run_conversation(system_message=…)` goes into the "context" tier of the prompt (`agent/system_prompt.py:806-808`).
- The Hermes identity and guidance text are always present in the stable tier, so Jarvis can only append to it, not replace it.

Approvals for dangerous terminal commands:
- The hook is `tools.terminal_tool.set_approval_callback(cb)`. It is per-thread, so it must be set on the thread that runs the agent (`tools/terminal_tool.py:101`).
- The callback signature is `cb(command, description, *, allow_permanent, allow_session, smart_denied, **kw) -> "once"|"session"|"always"|"deny"|"timeout"`. See `acp_adapter/permissions.py:136-151`; ACP binds it at `server.py:829-845`.
- Default config is `approvals.mode: smart`, which uses an LLM guardian (an extra model call). `single_query_mode` and `unattended_mode` default to `deny` (`config_defaults.py:1611-1627`).

Thread safety: the docs say to use one `AIAgent` per thread or task (`website/docs/guides/python-library.md:220`).

### (b) ACP adapter (`acp_adapter/`)

- **Protocol.** Agent Client Protocol: JSON-RPC 2.0 over stdio. It needs the `acp` extra (`agent-client-protocol==0.9.0`, `pyproject.toml:450`). Logs go to stderr; stdout is reserved for JSON-RPC (`acp_adapter/entry.py:1-8, 63-78`). Entry points are `hermes acp`, `hermes-acp`, or `python -m acp_adapter`.
- **Methods implemented** (`acp_adapter/server.py`):
  - `initialize` (`:572`): advertises `loadSession`, image prompts, and fork/list/resume.
  - `authenticate` (`:597`), `session/new` (`:670`), `load` (`:677`), `resume` (`:687`).
  - `session/cancel` (`:697`), `fork` (`:716`), `list` (`:730`).
  - `session/prompt` (`:868`): runs `AIAgent.run_conversation` in a `ThreadPoolExecutor`.
  - `set_session_model` (`:1092`), `set_session_mode` (`:1130`), `set_config_option` (`:1144`).
- **Updates and permissions.** The server streams `session/update` messages: `agent_message_chunk`, thought chunks, `tool_call` / `tool_call_update`, plan updates from the todo tool, usage, and session info (`acp_adapter/events.py`). It calls `session/request_permission` for dangerous commands and file edits (`server.py:979-990`).
- **Catch.** `HermesACPAgent.__new__` returns `GatewayACPAgent()` unless you pass a `session_manager` (`server.py:284-288`). `gateway_server.py:1` describes itself as "ACP projection of the profile gateway; never constructs an execution owner". Its `connect_gateway()` calls `ensure_gateway_runtime(home, idle_exit=True)`, which auto-spawns a WebSocket gateway daemon (`hermes_cli/gateway_client.py:330-370`). So the stock `hermes acp` means two processes and daemon-owned sessions.
- **In-process mode.** `HermesACPAgent(session_manager=SessionManager())` still exists and is covered by tests (`tests/acp_adapter/test_failed_turn_closure.py:134`). A custom entry point of about 10 lines could run `acp.run_agent(HermesACPAgent(session_manager=SessionManager()), use_unstable_protocol=True)`. Provider settings then come from `HERMES_HOME/config.yaml` via `resolve_runtime_provider` (`acp_adapter/session.py:595-660`). **UNVERIFIED end-to-end.** It is also a non-default path, so it may drift.

### (c) HTTP / OpenAI-compatible API server

- `gateway/platforms/api_server.py:1-6` serves `/v1/chat/completions`, `/v1/responses`, `/v1/models`, `/v1/capabilities`, `/api/sessions`, and `/v1/runs` with SSE events, approval, steer and stop (`api_server_runs.py:287-293`). The default port is 8642.
- **Run events:** `tool.started`, `tool.completed`, `reasoning.available`, `message.delta`, `approval.request`, `run.<status>`, `subagent.*` (`api_server_runs.py:121-146, 1008-1100`).
- **Requirements:**
  - Running the whole messaging gateway (`hermes gateway run`).
  - aiohttp, which is not a core dependency; it comes with the `sms`, `messaging` or `all` extras.
  - `API_SERVER_KEY` of at least 16 characters, or the adapter refuses to start (`gateway/config_env.py:121-129`, `gateway/config.py:572-581`).
- This option has the heaviest footprint, and the gateway owns sessions and state.

### (d) CLI one-shot

- Command: `hermes chat -q "…" --format stream-json` (flags at `hermes_cli/_parser.py:239-275`). Other useful flags: `--provider custom --base-url … --api-key … -m MODEL -t toolsets --max-turns N --source tool --ignore-rules --ignore-user-config`.
- **Output:** JSONL on stdout: `system/init`, `text`, `tool_use`, `tool_result`, then `result` (`hermes_cli/stream_json.py:1-111`).
- **Problems:**
  - It always goes through the gateway: `hermes_cli/main.py:1496` dispatches stream-json to `launch_gateway_chat`, whose module docstring is "never AIAgent" (`hermes_cli/gateway_chat.py:1`).
  - There are no approval round-trips: approvals use `single_query_mode: deny`.
  - It only reports start and finish events, and there is no cancel beyond killing the process.
- It is fine for fire-and-forget tasks, but weak for an interactive harness.

### Recommended: our own JSONL bridge around `AIAgent`

Invocation from Node:

```
spawn("<venv>/bin/python", ["-u", "jarvis_hermes_bridge.py"], { env: {
  HERMES_HOME: "<jarvisData>/hermes",
  HERMES_DISABLE_LAZY_INSTALLS: "1",
  HERMES_API_TIMEOUT: "600",
  PYTHONUNBUFFERED: "1" } })
```

The bridge's startup and per-request work:

- **Protect stdout.** `dup` the real stdout for the protocol, then point `sys.stdout` at stderr. This is defensive. Most prints are guarded by `quiet_mode` (e.g. `agent_init.py:917-920`), but tools, plugins and subprocesses may still write to stdout (**UNVERIFIED** which ones).
- **Read stdin on the main thread** and run each turn on a worker thread.
- **On `{"op":"run", id, session_id, message, history, system, toolsets}`,** build the agent:
  ```python
  AIAgent(base_url="http://127.0.0.1:8000/v1", api_key="local-dummy", model=..., quiet_mode=True,
          enabled_toolsets=toolsets, skip_memory=True, skip_context_files=True,
          skip_background_review=True, ephemeral_system_prompt=system, session_id=session_id,
          max_iterations=N, run_budget_seconds=T, cwd=..., callbacks=…)
  ```
  On the worker thread, call `set_approval_callback(bridge_cb)`, then `run_conversation(message, conversation_history=history, task_id=id)`.
- **Emit events:**
  - `text_delta`, from `stream_delta_callback`.
  - `reasoning`, from `reasoning_callback`.
  - `tool_started` and `tool_completed`, from `tool_progress_callback` or `tool_start_callback` / `tool_complete_callback`.
  - `step`, from `step_callback(api_call_count, prev_tools)`.
  - `subagent.*`, from progress events.
  - `approval_request`: the callback blocks on a `threading.Event` until Node sends `{"op":"approval","request_id","decision":"once|deny"}`.
  - Finally `result` with `{final_response, messages, completed, interrupted, failed, turn_exit_reason, api_calls}`.
- **Cancel and steer.** `{"op":"cancel", id}` calls `agent.interrupt(hard_cancel=True)` (**UNVERIFIED** that `hard_cancel=True` is the right flag here). `{"op":"steer", text}` calls `agent.steer(text)`.

Why this option: Jarvis keeps the lifecycle, the permissions (every dangerous command goes back to Jarvis), and the memory (Hermes memory and background review are off, and the message list is returned to Jarvis). There is a single process and no daemon. **UNVERIFIED:** I did not run it end-to-end.

## 3. Pointing it at OpenJarvis (OpenAI-compatible, no real key)

- **Constructor.** Pass both `base_url` and a non-empty dummy `api_key`. That takes the explicit path, `if api_key and base_url: client_kwargs = _explicit_client_kwargs(...)` (`agent/agent_init.py:889-892`). With an empty key it falls through to the provider router, which may fail with "No LLM provider configured" (`:747-800`).
- **Config file.** Put this in `HERMES_HOME/config.yaml` (from `website/docs/integrations/providers.md:720-728`):
  ```yaml
  model: {default: <model>, provider: custom, base_url: http://127.0.0.1:8000/v1, api_key: "", context_length: 32768}
  ```
  `OPENAI_BASE_URL` is honoured only for the `openai-api` provider (same doc).
- **CLI flags:** `--provider custom --base-url … --api-key …`.
- **Set `context_length` explicitly.** `get_model_context_length` returns early when it is set (`agent/model_metadata.py:2220-2221`). Otherwise Hermes walks endpoint probes, the models.dev cache and the OpenRouter catalog, which can hit the network.
- **Startup network calls:**
  - Local-server `num_ctx` detection queries the configured base_url (`agent/agent_init_ollama.py:20-24`). That is local only. Set `model.ollama_num_ctx` to skip it.
  - Lazy package installs (PM): set `HERMES_DISABLE_LAZY_INSTALLS=1` or `security.allow_lazy_installs: false` (`pm/install.py:183-198`).
  - Update checks exist only in CLI banner and `--version` paths (`hermes_cli/banner.py:275-288`, `hermes_cli/_startup_fast.py:236`). They are not reached when `AIAgent` is imported directly.
  - NeMo Relay "shared metrics installs no network exporter" (`pyproject.toml` comment near `:209`). OTLP is an opt-in extra.
  - Auxiliary LLM calls for compression, smart approval and vision use `provider: auto`, which means "inherit the main model" (`config_defaults.py:742-751`). The auto-chain can step to OpenRouter only if `OPENROUTER_API_KEY` is set (`:730-737`).
- **UNVERIFIED:** I found no global telemetry or analytics SDK (no posthog or sentry imports in the agent paths I searched), but I did not audit every plugin.

## 4. Sessions, context, persistence

- **State location.** `HERMES_HOME` is honoured: context override, then the `HERMES_HOME` env var, then `~/.hermes` (`hermes_constants.py:207-214`). Under it, Hermes uses:
  - `config.yaml` and `.env` (loaded by the ACP entry, `acp_adapter/entry.py:80-90`).
  - SQLite `state.db` through the `persistence/` storage interface (`acp_adapter/session.py:220`, `persistence/sqlite/_state/holders.py:151`).
  - `sessions/` logs (`agent/agent_init.py:1069`), plus memories, skills and logs.
- **Avoiding Hermes-side state.** If `session_db=None`, the agent skips DB writes (`run_agent.py:321-323`). However, `session_search` may lazily open the home's store (`run_agent.py:294-313`), so do not enable that toolset. Multi-turn works by passing `conversation_history` (OpenAI message dicts) and reading `result["messages"]` back.
- **Compression.** `agent/context_compressor.py` summarizes middle turns with an auxiliary model, keeping the head and tail. It is on by default at `compression.threshold: 0.50`, floored at 0.75 for windows under 512K, with `tail_mode: lean` (`config_defaults.py:564-590`). Compression can rotate `agent.session_id` (`acp_adapter/server.py:917-919`). It emits `event_callback("session:compress", …)` (`agent/conversation_compression.py:3374`).

## 5. Python and dependencies

- **Python version.** `requires-python = ">=3.11,<3.15"` (`pyproject.toml:15`), but every core dependency carries the marker `python_version >= '3.14'`; the older range exists only so old installs can update (`pyproject.toml:4-12`). **In practice Python 3.14 is required.** It is present on this box at `/root/.local/bin/python3.14`.
- **Install.** `uv` is the pinned workflow (`uv.lock` has 355 packages across all extras; `setup-hermes.sh`, `scripts/install.sh` defaults to 3.14). Example: `uv venv -p 3.14 && uv pip install -e ".[acp]"`.
- **Core dependencies are not lean.** They include openai, httpx, pydantic, rich, prompt_toolkit, fastapi, uvicorn, Pillow, pillow-heif, resvg-py, browser-harness, websockets, cryptography, PyJWT, firecrawl-anydoc, croniter, and the native `nemo-relay` wheel.
- **Optional and heavy:** `voice` and `wake` (faster-whisper, av, numpy, onnx), `kittentts` (torch), `messaging`, `google`, `matrix`, `mcp`, `documents`, `bedrock`, `modal`/`daytona`.
- **Size.** The repo is 433 MB. The agent, tools, gateway, hermes_cli and acp_adapter directories hold about 780K lines of Python. Installed venv size is **UNVERIFIED**; I did not install, per the read-only rule.

## 6. Observability hooks a host can map to UI events

| Hermes signal | Where emitted | Jarvis UI event |
|---|---|---|
| `stream_delta_callback(text)` | streaming transport | assistant text delta |
| `reasoning_callback` / `tool_progress_callback("reasoning.available", …)` / `("_thinking", line)` | `agent/turn_response_intake.py:150,165` | thinking |
| `tool_progress_callback("tool.started", name, preview, args, tool_call_id=…)` | `agent/tool_executor.py:1048` | tool started |
| `tool_progress_callback("tool.completed", name, …, duration=, is_error=, result=)` | `tool_executor.py:1190-1193` (after persist) | tool finished |
| `tool_start_callback(call_id, name, args)` / `tool_complete_callback(call_id, name, args, result)` | `tool_executor.py:1049,1068-1074` | same, with IDs |
| `step_callback(api_call_count, prev_tools)` | `agent/turn_iteration_prep.py:161` | step N |
| `subagent.start/progress/tool/text/thinking/complete/spawn_requested` | `tools/delegate_tool_progress.py` (via the parent's progress callback) | delegation |
| `event_callback("session:compress", …)` | `conversation_compression.py:3374` | context compacted |
| `status_callback`, `notice_callback`, `interim_assistant_callback`, `clarify_callback` | constructor (`run_agent.py:250-262`) | status, notices, ask-user |
| approval callback | `tools/terminal_tool.py:101` | permission request |
| result dict (`turn_exit_reason`, `interrupted`, `failed`, token counters) | `agent/turn_finalizer.py` | task end |

The exact argument shapes of `status_callback`, `notice_callback` and `interim_assistant_callback` are **UNVERIFIED**; I did not trace them.

## Risks

- The codebase is very large and moves fast (≈780K LOC). The `AIAgent` constructor is a de-facto API with about 70 keyword arguments, so pin a commit.
- The system prompt always includes the Hermes identity and guidance; Jarvis can only append.
- The default `approvals.mode: smart` adds guardian LLM calls. Set it to `manual` and supply our own approval callback.
- Use one `AIAgent` per task.
