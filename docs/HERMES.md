# Hermes Agent in Jarvis — the agent harness

Jarvis uses [Hermes Agent](https://github.com/NousResearch/hermes-agent) (Nous Research, MIT) as the
**agent loop for open-ended tasks**: Hermes decides the next step, calls a tool, reads the result and
repeats until it can answer. **Jarvis stays the product and the authority**: the task and its lifecycle,
which tools exist, every execution, every approval, the model, memory and the UI.

[OpenJarvis](https://github.com/open-jarvis/OpenJarvis) remains Jarvis's local model and voice
provider. Its own agents, schedulers, tools, approvals and memory are not used (see "OpenJarvis" below).

```
            ┌──────────────────────────── Jarvis (one product, one UI) ────────────────────────────┐
 you ──────▶│ chat / voice / Tasks page ─▶ TaskEngine (one task id, one lifecycle, one event stream) │
            │                                  │                                                    │
            │                ┌─────────────────┴──────────────────┐                                 │
            │      explicit steps                      open-ended (no steps)                        │
            │                │                                   │                                  │
            │     native planner + step loop      HermesHarness ─ spawn ─▶ hermes_bridge.py (Python)│
            │                │                                   ▲          │ AIAgent loop          │
            │                │            tool_call (JSONL) ─────┘◀─────────┘ only Jarvis skills    │
            │                ▼                                   ▼                                  │
            │        SkillRunner ── permission engine ── approvals ── verification ── audit log     │
            │                                                                                       │
            │  model calls: Hermes ─▶ /harness/v1/chat/completions (loopback, per-run token)        │
            │                       ─▶ RoamiesEngine.completeOnce ─▶ the model the user picked      │
            │                          (OpenJarvis / local server / Roamies sign-in; local-only rules)│
            └───────────────────────────────────────────────────────────────────────────────────────┘
```

## Who owns what

| Concern | Owner | How |
|---|---|---|
| Task, task id, status, cancel/pause/resume, recovery | **Jarvis** `tasks/engine.ts` | A Hermes task is an ordinary task with `harness = 'hermes'`. |
| Routing (Hermes or native) | **Jarvis** | No explicit steps + Hermes available → Hermes; otherwise native planner. Explicit steps, reminders, recurring work → native. |
| Agent loop (next step, retries of its reasoning, iteration budget) | **Hermes** | `AIAgent.run_conversation`, max model calls and wall-clock budget set by Jarvis. |
| Which tools exist | **Jarvis** | Only Jarvis skills allowed for the task's agent profile (`harness/profiles.ts`). Hermes's own tools are never enabled; the bridge refuses to run if Hermes exposes anything else. |
| Executing a tool | **Jarvis** | Each call becomes a step of the task, run by `SkillRunner` → permission engine → approval → verification → audit log. |
| Approvals | **Jarvis** | Same approval prompts and "part of what you asked" coverage as native steps. The Hermes run waits; approve = runs once; deny = Hermes is told and nothing is done. |
| Model | **Jarvis** | Hermes calls Jarvis's loopback endpoint; Jarvis calls the model the user chose (local-only mode enforced). |
| Memory | **Jarvis** | Hermes memory, background review, session DB, context files and project rules are off. Hermes can search/remember only through Jarvis's memory skills. Task results go to Jarvis memory as task history. |
| Hermes conversation | **Jarvis** (stored on the task, bounded) | Used to continue a paused task. |
| Events & UI | **Jarvis** | `task.updated`, task events (`harness_started`, `step_*`, `approval_requested`, `harness_finished`), `harness.activity`. |

**One orchestrator.** Hermes is embedded in-process (`AIAgent`), not through `hermes acp`,
`hermes chat` or Hermes's API server — those start Hermes's own gateway daemon, which owns sessions
and approvals and runs a cron scheduler. With the bridge there is no second scheduler, no second
task store and no second approval authority. Delegation (`delegate_task`) is off.

## The six agents

Friday, Tom, Neo, Sentinel, Echo and Trinity keep their native background jobs
(`agents/subagents.ts`), unchanged. They can additionally **own a Hermes task**: the run works as that
agent (its role as the brief) with only that agent's skills:

| Agent | Skills offered to its Hermes runs |
|---|---|
| Jarvis (default) | every available skill except Trinity's security actions and `llm.generate` |
| Friday | earnings, reports, programs, memory, tasks, status, notify |
| Tom | programs, scopes, web fetch, memory, notify |
| Neo | tasks, status, telemetry, capabilities, workspace files (read), memory, notify |
| Sentinel | scopes, programs, memory, notify |
| Echo | memory, tasks, reports, vault notes, notify |
| Trinity | security toolkit **and `security.operate`**, programs, scopes, reports, **report submission**, web fetch, files, memory, notify |

Security actions (`security.operate`, `hackerone.submit_report`) are Trinity's alone, and still go
through the permission engine, the offensive-testing switch and approvals. A profile only narrows
what the model is offered; it never widens what is permitted. Ask for an agent in chat ("have Trinity
…") or with `agent` on `POST /api/tasks`.

## Capabilities

`GET /api/capabilities[?agent=…]` lists every capability from the one skill registry (native skills
and MCP tools): source, schema, scope, risk, policy, critical inputs, timeout, cancellation,
where it runs, availability and which agents' Hermes runs are offered it. Hermes's own tools are listed
as a source that is not used; OpenJarvis as the model/voice provider (not tools).

## Security

- Hermes gets **no** terminal, file, browser, web, memory, skills, cron, delegation, code-execution or
  computer-use tools. Its only tools are Jarvis skills; the bridge checks the exact tool list after
  building the agent and stops if it differs.
- Every call runs through `SkillRunner`: role allow-list, input validation, permission policy,
  critical-action rule, approvals, timeout/cancellation, verification and the audit log. Nothing
  Hermes does can bypass it. Untrusted tool output is wrapped as data.
- The bridge process gets a minimal environment (no API keys or other secrets), its own
  `HERMES_HOME` under Jarvis's data folder, an empty non-git working directory, project rules off
  (`HERMES_IGNORE_RULES`), lazy installs off, and a locked-down `config.yaml` written for every run
  (tool search off, memory off, background review off, approvals manual, delegation depth 0,
  no hooks, no quick commands). A leading `/` or `@` in task text is neutralised (Hermes expands them).
- The model endpoint accepts only a per-run token that dies with the run, on 127.0.0.1.

## Requirements and limits (verified)

- **Python 3.14.** Hermes declares `>=3.11`, but its core dependencies are only pinned for 3.14; on
  3.13 it installs without them and cannot start. The installer uses uv's Python 3.14.
- **Install from Hermes's lockfile.** Hermes refuses wheel builds and plain `pip install` fails on
  conflicting pins at the audited commit; `uv sync --frozen` works.
- **64K context.** Hermes refuses models served with less than 64,000 tokens of context. Jarvis reads
  the served window from cloud providers and local servers that report it; OpenJarvis reports a
  model's maximum, not the served window, so for OpenJarvis set *Settings → Agent harness → Context*
  if your engine serves 64K or more (for Ollama: `OLLAMA_CONTEXT_LENGTH=65536`). Below 64K, or when
  unknown, Jarvis uses its native planner — it never claims a window it can't confirm.
- The model must support tool calling. The Claude Code bridge route (a whole agent) can't be used as
  Hermes's model.
- Hermes's system prompt is its own; Jarvis appends the agent's brief and rules to it.
- A Hermes run waiting for approval holds a running-task slot. If Jarvis restarts during a run, the
  task pauses; resuming continues from the stored conversation and the recorded steps.

## Install

Linux/macOS: `scripts/install-hermes.sh` (installs the pinned, audited commit into
`~/.jarvis/hermes/runtime`; Jarvis finds it automatically). Elsewhere, or for your own install, set
*Settings → Agent harness → Hermes install (Python)* or `JARVIS_HERMES_PYTHON` to that install's Python.
The Windows installer is not written yet; the steps are the same (`git` checkout of the pinned commit,
`uv sync --frozen --python 3.14`).

## OpenJarvis

Kept: the OpenAI-compatible chat endpoint (Jarvis's model), `/v1/models`, `/health`, speech-to-text
and text-to-speech. Not used, on purpose: its agents and orchestrator, managed-agent and task
schedulers, ~60 tools, approvals, memory/retrieval, skills manager and learning/optimisation — each
duplicates Hermes's loop or Jarvis's tasks, permissions and memory. Hermes does **not** talk to
OpenJarvis directly: OpenJarvis's chat route by default redacts PII inside messages (including tool
arguments), injects memory into prompts and can silently drop tools on an engine error; Jarvis's
engine already works around those. Deferred: its telemetry/energy endpoints and hardware/model
catalogue (useful later behind an adapter).

## Files

`server/harness/hermes_bridge.py` (Python side), `server/harness/hermes.ts` (process, status, run),
`server/harness/model-endpoint.ts` (loopback model API), `server/harness/profiles.ts` (agents),
`server/harness/capabilities.ts`, `server/tasks/engine.ts` (`executeHarness`), `tests/harness.test.ts`.
