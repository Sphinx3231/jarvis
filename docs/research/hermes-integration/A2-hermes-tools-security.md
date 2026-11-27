# A2: Locking down Hermes tools and security when embedded in Jarvis

Source: NousResearch/hermes-agent main @ `38fde82` (2026-11-21). Paths are relative to the clone. I read the source only and ran nothing. **[UNVERIFIED]** marks inferences I did not trace end to end.

## 1. Tool system

- **Registry.** `tools/registry.py:840` `ToolRegistry.register(name, toolset, schema, handler, check_fn=None, requires_env=None, is_async=False, ..., override=False, scope=None, execution_timeout=None)`. The schema is OpenAI function format `{"name","description","parameters"}`, and a non-dict `parameters` raises (`:851-859`). Handlers return a JSON string. Any `tools/*.py` that has a top-level `registry.register()` is imported automatically by `discover_builtin_tools()` (`:121`, `tools/AGENTS.md`). A registration that shadows a tool from another toolset is rejected unless `override=True` (`:886-907`).
- **Toolsets.** `toolsets.py:11` `_HERMES_CORE_TOOLS` lists the default tools: web_search and web_extract, terminal and process_manage, read/write/patch/search_files, vision, image_generate, skills_*, browser_*, tts, todo_list, memory, session_search, clarify, execute_code, delegate_task, cronjob_manage, kanban_*, computer_use and manage_connections. `TOOLSETS` at `:70` defines individual toolsets (`web, terminal, file, browser, skills, memory, session_search, cronjob, delegation, code_execution, computer_use, connections, ...`) and the composites `hermes-cli`, `hermes-acp` (`:186`) and `hermes-api-server`.
- **Selection.** `model_tools.get_tool_definitions(enabled_toolsets, disabled_toolsets)` (`:225`). `enabled_toolsets=None` means every tool, and `disabled_toolsets` is subtracted last (`:333-355`). The `AIAgent.__init__` arguments are `enabled_toolsets`, `disabled_toolsets`, `skip_context_files`, `skip_memory`, `skip_background_review` and `checkpoints_enabled` (`run_agent.py:237-282`). The agent snapshots `agent.tools` / `valid_tool_names` once at init (`agent/agent_init.py:1018-1020`). A model call naming a tool outside `valid_tool_names` is answered with an error and never dispatched (`agent/turn_tool_round.py:109-130`).
- **Config and CLI.**
  - `platform_toolsets.<platform>: [...]` in config.yaml selects toolsets per platform. Platforms include `cli`, `acp` and `api_server`. The top-level `toolsets:` key is deprecated (`cli-config.yaml.example:1637`).
  - `agent.disabled_toolsets` is a global subtraction (`hermes_cli/tools_config.py:640-646`).
  - An explicitly empty list means zero tools **and no MCP merge** (`tools_config.py:630-633`).
  - CLI flags: `-t/--toolsets a,b` (`hermes_cli/_parser.py:179,257`), `--ignore-rules`, `--ignore-user-config`, `--safe-mode`. `--safe-mode` also disables MCP, so Jarvis cannot use it.
- **Custom tools.** In-process Python can call `registry.register(...)` before the `AIAgent` is built and then name that toolset in `enabled_toolsets` (registry-only toolsets resolve through `toolsets.get_toolset`, `:266-300`). Plugins can call `ctx.register_tool(...)` (`tools/AGENTS.md`). Jarvis is Node, so MCP is the practical route.

## 2. MCP client

- **Transports.** stdio, Streamable HTTP and SSE are configured under `mcp_servers:` in `$HERMES_HOME/config.yaml` (`tools/mcp_tool.py:1-4`). Per-server keys are documented in `website/docs/reference/mcp-config-reference.md:15-76`:
  - `command/args/env` for stdio, or `url/headers` for HTTP
  - `enabled`
  - `timeout` (tool call, default 300 s; `tools/mcp_tool_common.py:41-58`)
  - `connect_timeout` (default 60 s)
  - `tools.include/exclude/resources/prompts`
  - `trust: full|untrusted`, `lazy`, `sampling`, `elicitation`
- **Naming.** Tools are exposed as `mcp__<server>__<tool>` (`tools/mcp_tool_schema.py:176`) and registered under toolset `mcp-<server>`, with the bare `<server>` as an alias (`mcp_tool_registration.py:166,368`). Do not give the server a built-in toolset name such as "file" or "browser": the alias merges with the static toolset (`toolsets.py:289-294`).
- **MCP as the only tools.** `platform_toolsets.acp: [jarvis]` resolves to an explicit MCP allowlist (`tools_config.py:737-757`). In-process, pass `enabled_toolsets=["mcp-jarvis"]`.
- **Gotchas:**
  - Before spawning a stdio server through `npx`/`uvx`/`pipx`, Hermes runs an OSV malware preflight that is a network call (`mcp_tool.py:38-50`, `tools/osv_check.py:166-171`). Launch `node` directly to skip it.
  - `tools.tool_search` can collapse MCP tools behind `tool_search`/`tool_describe`/`tool_call`. These unwrap to the real tool name and still dispatch to MCP (`model_tools.py:938-962`). Setting `tools.tool_search.enabled: "off"` keeps the schema surface plain.
  - In the ACP adapter, MCP servers supplied by the editor in session/new are namespaced roughly `mcp-editor_<hash>_<name>` (`gateway/session_local_mcp.py:125-126`), are fingerprint-pinned, and must be resupplied after a restart. Prefer config-defined servers. **[UNVERIFIED end-to-end]**

## 3. Approvals and permissions

- **Built-in gate.** `tools/approval.py` gates dangerous **terminal/execute_code** commands: hardline and dangerous patterns, a "smart" guardian LLM, allowlists, and `approvals.mode` (default `smart`, `hermes_cli/config_defaults.py:1611`). Other gates:
  - MCP calls on `trust: untrusted` servers prompt for write-capable tools.
  - ACP edit approval covers `write_file`/`patch` (`model_tools.py:816-826`).
  - `memory.write_approval` and `skills.write_approval` (both default false).
- **ACP bridge.** `acp_adapter/permissions.py:128` `make_approval_callback` sends the prompt as ACP `session/request_permission`. Timeout means deny, after `approvals.timeout` (default 300 s).
- **Deferring every decision to the host.**
  - The structural answer: expose **only** Jarvis's MCP tools and gate inside Jarvis's MCP server.
  - Belt and braces: a plugin `pre_tool_call` hook can `block`, `approve` (escalate) or `modify` every call. Its chokepoint is `agent/tool_executor.py:677 _dispatch_authorized_once`, which covers sequential, concurrent and batched calls.
  - A hook that times out or raises fails **closed** (`website/docs/user-guide/features/hooks.md:396,598`). However, an exception in the hook *dispatcher* is swallowed at debug level (`model_tools.py:811-812`) and fails open for that path.
- **Side channels outside the tool layer.** Hermes keeps its own inventory of these in `tools/hosted_tool_policy.py:44-66` `HOST_FEATURES`. That list is enforced only in an internal "hosted scope" that also refuses MCP, so Jarvis cannot use it.

  | Side channel | Where | Default and control |
  |---|---|---|
  | Context files: AGENTS.md (git root down to cwd), CLAUDE.md, .cursorrules, SOUL.md. Read into the prompt, a prompt-injection vector. | `agent/prompt_builder.py:1624-1688` | Off with `skip_context_files`. Gateway: `policy.ignore_rules` or `gateway.platforms.<p>.skip_context_files` (`gateway/session_execution.py:42-54`). |
  | Subdirectory AGENTS.md hints | — | Same control as context files. |
  | Workspace snapshot: runs `git status` in cwd | `agent/coding_context.py:538-560` | — |
  | Skill inline shell: `` !`cmd` `` in SKILL.md runs `bash -c` | `agent/skill_preprocessing.py:47-80,157` | **Off by default**: `skills.inline_shell: false`. |
  | Shell hooks: `hooks:` in config.yaml | — | Consent-gated unless `hooks_auto_accept`. |
  | Gateway event hooks: `$HERMES_HOME/hooks/*/handler.py` | `hooks.md:24-32` | Placing the files is the opt-in. |
  | Plugins: `~/.hermes/plugins`, pip entry points, project `.hermes/plugins` | `hermes_cli/plugins.py:1-8,531` | Opt-in; project plugins need `HERMES_ENABLE_PROJECT_PLUGINS`. |
  | `@file` / `@url` references in user text | `agent/context_references.py:229` | Expanded by the gateway and TUI paths. |
  | Cron pre-run scripts | — | — |
  | `quick_commands` (exec type, bypass the agent loop) | `gateway/run_inbound.py:932` | Empty by default. |
  | Registered slash commands in prompt text execute as gateway verbs | `acp_adapter/gateway_server.py:24-43` | — |
  | Session transcripts always written to `$HERMES_HOME/state.db` | — | Not switchable. |

## 4. Delegation

- **Mechanism.** `delegate_task` lives in the `delegation` toolset. Children run with isolated context.
- **Children never gain tools the parent lacks.** Child toolsets are intersected with the parent's (`tools/delegate_tool_toolsets.py:79-125`). With a `None` parent (all tools), the child inherits everything.
- **Blocked for children.** `delegate_task`, `clarify`, `memory`, `send_message` and `cronjob_manage` (`:14-21`).
- **Limits.** `delegation.max_spawn_depth` defaults to 1 (flat; `config_defaults.py:1326`; `tools/AGENTS.md` says 2, which is stale). Also `orchestrator_enabled`, `max_concurrent_children` (10) and `max_iterations` (250).
- **Approvals in children.** `subagent_auto_approve: false` means auto-deny.
- **Disable.** Leave the `delegation` toolset out. A separate `/review` slash path starts children outside any tool call (HOST_FEATURES "delegation").

## 5. Memory and skills

- **Built-in memory.** `$HERMES_HOME/memories/MEMORY.md` and `USER.md` (`tools/memory_tool_store.py:1,306`).
  - The store is loaded into the prompt whenever `skip_memory=False`, **even without the memory tool** (`agent/agent_init.py:1162`).
  - Set `memory.memory_enabled: false` and `memory.user_profile_enabled: false`.
  - External providers (honcho, mem0, ...) come from `memory.provider` and must stay `""`.
- **Session search.** `session_search` does FTS over `state.db`.
- **Background review.** After a turn, a daemon thread can fork the agent to write memory and skills (`agent/background_review.py:1-6`, `agent/turn_finalizer.py:632-645`). Off via `skip_background_review=True` or `auxiliary.background_review.enabled: false` (`background_review.py:261-319`). It is also inert when `memory`/`skill_manage` are not in `valid_tool_names` (`agent/turn_iteration_prep.py:166`, `turn_context.py:821`).
- **Skills.**
  - Location: `$HERMES_HOME/skills`, plus `skills.external_dirs` and trusted project `.hermes/skills`.
  - Auto-creation happens only through `skill_manage`, nudged by `skills.creation_nudge_interval`.
  - The skills index is injected only when skill tools are present (`agent/system_prompt.py:316-320`).
  - Curator: `curator.enabled` is true by default. It archives agent-created skills and runs from the gateway, TUI and web idle loops (`hermes_cli/plugins_idle_tasks.py:338-345`, `gateway/run.py:4252`).

## 6. Cron and background work

- **The gateway always starts the cron ticker** (`gateway/run_bootstrap.py:400-450`), and the desktop/web backend runs one too (`hermes_cli/web_server.py:95`). I found no off switch; it only fires jobs that exist in the store.
- **`hermes acp` is now a gateway viewer.** `HermesACPAgent.__new__` returns `GatewayACPAgent` (`acp_adapter/server.py:284-287`). It calls `ensure_gateway_runtime(home, idle_exit=True)` (`hermes_cli/gateway_client.py:358-361`), so ACP use spins up a gateway daemon with the cron ticker, curator idle jobs and plugin update checks (`plugins.auto_update_check_hours`, default 24).
- **Multiplexing.** The gateway ticks **every profile under the root** (`gateway/run.py:1630-1656`, `hermes_cli/profiles.py:1091`). A dedicated `HERMES_HOME` keeps the user's own `~/.hermes` jobs out. **[UNVERIFIED: root resolution for a custom HERMES_HOME, `hermes_constants.py:315`]**
- **Other autonomous paths.** `/goal` and `/loop` are slash-driven continuation loops. Kanban dispatcher workers force-add the kanban toolset when `HERMES_KANBAN_TASK` is set (`model_tools.py:339-342`).

## 7. Extension points for a host

- Plugin hooks: `pre_tool_call` (block/approve/modify), `post_tool_call`, `transform_tool_result`, `pre_llm_call` (can veto a turn) and `subagent_stop` (`hooks.md:449-721`).
- `ctx.register_tool`, approval transports (`register_approval_transport`, `plugins.py:572`), memory/context-engine/delegation provider plugins, and `plugins.isolation: host` (out-of-process).
- Agent callbacks: `tool_start_callback`, `tool_complete_callback`, `clarify_callback`, `event_callback`, and the other `AIAgent` callbacks.

## Recommended locked-down embedded configuration

**Transport.** The best option is an in-process Python sidecar that constructs `AIAgent` directly, since that is the only path where every flag is guaranteed:

```python
AIAgent(enabled_toolsets=["mcp-jarvis"],
        disabled_toolsets=["delegation", "memory", "skills", "cronjob", "code_execution", "terminal", "file",
                           "browser", "web", "computer_use", "session_search", "connections", "kanban"],
        skip_context_files=True, skip_memory=True, skip_background_review=True,
        checkpoints_enabled=False, platform="acp", cwd=<empty sandbox dir>, max_iterations=N)
```

Call `tools.mcp_tool_discovery.register_mcp_servers({...})` beforehand. If Jarvis must use `hermes acp` instead, accept that a gateway daemon runs and launch it with `--ignore-rules`.

Use a dedicated `HERMES_HOME=<jarvis-data>/hermes` that contains no `plugins/`, `hooks/`, `skills/` or `cron/` jobs and a `.env` with only the LLM key:

```yaml
platform_toolsets:
  acp: [jarvis]            # explicit MCP allowlist; also set cli / api_server the same way if used
agent:
  disabled_toolsets: [terminal, file, browser, web, search, code_execution, computer_use, delegation,
                      memory, session_search, skills, cronjob, kanban, connections, image_gen, tts,
                      vision, video, clarify, todo, messaging, moa]
mcp_servers:
  jarvis:
    command: /path/to/node          # direct binary: skips the npx/uvx OSV network preflight
    args: [/path/to/jarvis-mcp.js]
    timeout: 600                    # Jarvis approval waits must finish inside this
    connect_timeout: 30
    trust: full                     # Jarvis gates; use untrusted to double-gate via request_permission
    sampling: {enabled: false}      # tools/mcp_tool_server_run.py:281-283
    elicitation: {enabled: false}
    tools: {resources: false, prompts: false}
tools:
  tool_search: {enabled: "off"}
  connectors: {enabled: false}
memory: {memory_enabled: false, user_profile_enabled: false, provider: "", nudge_interval: 0}
auxiliary: {background_review: {enabled: false}}
skills: {inline_shell: false, project_discovery: false, auto_load: [], external_dirs: [], creation_nudge_interval: 0}
curator: {enabled: false}
delegation: {orchestrator_enabled: false, max_spawn_depth: 1, subagent_auto_approve: false}
cron: {allow_agent_scheduling: false}
checkpoints: {enabled: false}
approvals: {mode: manual, cron_mode: deny, single_query_mode: deny, unattended_mode: deny}  # modes manual|smart|off: tools/approval_context.py:276
hooks: {}
hooks_auto_accept: false
quick_commands: {}
plugins: {auto_update_check_hours: 0, auto_apply: false}
updates: {check: false}
gateway: {platforms: {acp: {skip_context_files: true}}}   # [UNVERIFIED for acp source]
```

Environment: do not set `HERMES_ENABLE_PROJECT_PLUGINS`, `HERMES_YOLO_MODE`, `HERMES_ACCEPT_HOOKS` or `HERMES_KANBAN_TASK`. Set `HERMES_IGNORE_RULES=1`.

**Verify at runtime.** Inspect `agent.valid_tool_names`, or run `hermes chat --list-tools` / `hermes tools --summary`, and assert that it contains only `mcp__jarvis__*`. I did not run Hermes, so that assertion is the real gate.

## Residual risks

1. **ACP means a gateway daemon.** The cron ticker and housekeeping always run, and the daemon multiplexes every profile under the root. Isolate `HERMES_HOME`, never expose `cronjob`, and treat the gateway as a long-lived process Jarvis must supervise and kill.
2. **Context files and `@`-references** are prompt-injection and read channels outside the tool layer. Use an empty, non-git `cwd`, `skip_context_files`, and escape a leading `/` or `@` in user text, since registered slash commands execute.
3. **The `pre_tool_call` dispatcher can fail open** (`model_tools.py:811`). Enforce in Jarvis's MCP server, not only in a hook.
4. **Hermes still writes its own files:** `state.db` transcripts, logs, `.curator_ledger`, MCP schema cache. It also makes network calls: LLM, auxiliary models (compression, titles), and OSV/update checks when not disabled.
5. **Toolset re-adding paths:**
   - `_recover_platform_native_toolsets` (`tools_config.py:713`) can re-add platform-native toolsets.
   - With `context_engine` active, `lcm_*` tools can appear.
   - A config resolver change upstream could widen the set.
   Pin the Hermes version and assert the tool list at every startup.
6. **Delegation.** If `enabled_toolsets` is ever `None`, children inherit all tools. Always pass an explicit list.
7. **Upstream churn.** The code moves fast (doc and default drift seen in `max_spawn_depth`, and in ACP comments versus behaviour). Re-audit on every version bump.
