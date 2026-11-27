"""
Jarvis ⇄ Hermes Agent bridge (one process per task run).

Hermes Agent (NousResearch, MIT) runs the agent loop: it decides the next step, calls a tool, reads the
result and repeats until it can answer. Jarvis keeps all authority:

  * Hermes's own tools (terminal, files, browser, memory, skills, cron, delegation, …) are not given
    to the agent. Its only tools are the Jarvis skills Jarvis lists in the run request, and every
    call is sent back to Jarvis, which runs it through its permission engine, approvals, verification
    and audit log — then returns the result here. This bridge executes nothing itself.
  * The model is Jarvis's: Hermes talks to Jarvis's loopback model endpoint (per-run token), which
    uses the model the user picked, with Jarvis's local-only rules.
  * State is Jarvis's: Hermes memory, background review, session database, context files and
    project rules are off; the message list is handed back to Jarvis at the end of the run.

Hermes is embedded in-process (AIAgent), not through `hermes acp` / `hermes chat` / the API server,
because those start Hermes's own gateway daemon, which owns sessions and approvals and runs a cron
scheduler — a second orchestrator.

Protocol: JSON lines. stdin → {"op":"run",…} once, then {"op":"tool_result",…} / {"op":"cancel"}.
stdout → {"ev":"hello"|"ready"|"tool_call"|"progress"|"result"|"error", …}. Logs go to stderr.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import traceback

# The protocol owns the real stdout; anything Hermes prints goes to stderr.
_PROTO = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1, encoding="utf-8")
sys.stdout = sys.stderr
_write_lock = threading.Lock()


def emit(ev: str, **data) -> None:
    line = json.dumps({"ev": ev, **data}, default=str, ensure_ascii=False)
    with _write_lock:
        _PROTO.write(line + "\n")
        _PROTO.flush()


def read_message() -> dict | None:
    line = sys.stdin.readline()
    if not line:
        return None
    try:
        return json.loads(line)
    except json.JSONDecodeError:
        return {"op": "invalid"}


LOCKED_CONFIG = """# Written by Jarvis for every run. Hermes here is an embedded agent loop with no tools,
# memory, skills, schedules or plugins of its own; Jarvis supplies tools and owns state.
model:
  context_length: {context_length}
tools:
  tool_search:
    enabled: "off"
memory:
  memory_enabled: false
  user_profile_enabled: false
approvals:
  mode: manual
delegation:
  max_spawn_depth: 0
skills:
  inline_shell: false
auxiliary:
  background_review:
    enabled: false
hooks: {{}}
quick_commands: {{}}
"""


def neutralize(text: str) -> str:
    """Hermes expands a leading `/command` and `@file`/`@url` in user text; Jarvis's text is data."""
    return ("​" + text) if text[:1] in ("/", "@") else text


class Run:
    def __init__(self, req: dict):
        self.req = req
        self.pending: dict[str, threading.Event] = {}
        self.results: dict[str, dict] = {}
        self.lock = threading.Lock()
        self.cancelled = False
        self.agent = None
        self.counter = 0

    # -- tool calls go to Jarvis and block until Jarvis answers --------------------------------------
    def call_jarvis(self, name: str, args: dict) -> str:
        with self.lock:
            if self.cancelled:
                return json.dumps({"error": "The task was cancelled."})
            self.counter += 1
            call_id = f"c{self.counter}"
            done = threading.Event()
            self.pending[call_id] = done
        emit("tool_call", callId=call_id, name=name, args=args)
        done.wait()
        with self.lock:
            res = self.results.pop(call_id, {"content": "The task was cancelled.", "isError": True})
            self.pending.pop(call_id, None)
        content = res.get("content", "")
        return json.dumps({"error": content}) if res.get("isError") else content

    def deliver(self, msg: dict) -> None:
        with self.lock:
            ev = self.pending.get(str(msg.get("callId")))
            if ev:
                self.results[str(msg["callId"])] = msg
                ev.set()

    def cancel(self) -> None:
        with self.lock:
            self.cancelled = True
            for ev in self.pending.values():
                ev.set()
        if self.agent is not None:
            try:
                self.agent.interrupt(hard_cancel=True)
            except TypeError:
                self.agent.interrupt()
            except Exception:  # noqa: BLE001 - cancellation must never crash the bridge
                pass


def main() -> int:
    req = read_message()
    if not req or req.get("op") != "run":
        emit("error", fatal=True, message="expected a run request")
        return 2
    run = Run(req)
    home = os.environ.get("HERMES_HOME")
    if not home:
        emit("error", fatal=True, message="HERMES_HOME is not set")
        return 2
    os.makedirs(home, exist_ok=True)
    with open(os.path.join(home, "config.yaml"), "w", encoding="utf-8") as f:
        f.write(LOCKED_CONFIG.format(context_length=int(req["model"]["contextLength"])))

    try:
        import hermes_cli
        from toolsets import create_custom_toolset
        from tools.registry import registry
        from tools import terminal_tool
        from run_agent import AIAgent
    except Exception as e:  # noqa: BLE001
        emit("error", fatal=True, message=f"Hermes could not be imported: {e}")
        return 3
    emit("hello", hermes={"release": getattr(hermes_cli, "__release_date__", "unknown"), "commit": os.environ.get("JARVIS_HERMES_COMMIT", "")}, python=sys.version.split()[0])

    tool_names = []
    for spec in req.get("tools", []):
        name = spec["name"]
        tool_names.append(name)
        registry.register(
            name=name,
            toolset="jarvis",
            schema={"name": name, "description": spec.get("description", ""), "parameters": spec.get("parameters") or {"type": "object", "properties": {}}},
            handler=(lambda n: (lambda args, **_kw: run.call_jarvis(n, args or {})))(name),
            execution_timeout=float(req.get("budgetSec", 3600)),
        )
    create_custom_toolset("jarvis", "Jarvis skills (run by Jarvis, under its permissions)", tools=tool_names)
    # Hermes's dangerous-command prompt is never reached (no terminal tools); deny if it ever is.
    terminal_tool.set_approval_callback(lambda *a, **k: "deny")

    progress = lambda *a, **k: emit("progress", kind=str(a[0]) if a else "", tool=str(a[1]) if len(a) > 1 else None)  # noqa: E731
    try:
        agent = AIAgent(
            base_url=req["model"]["baseUrl"],
            api_key=req["model"]["apiKey"],
            model=req["model"]["name"],
            quiet_mode=True,
            enabled_toolsets=["jarvis"] if tool_names else [],
            skip_context_files=True,
            skip_memory=True,
            skip_background_review=True,
            session_db=None,
            ephemeral_system_prompt=req.get("system") or None,
            max_iterations=int(req.get("maxIterations", 24)),
            run_budget_seconds=float(req.get("budgetSec", 3600)),
            cwd=req.get("cwd") or home,
            tool_progress_callback=progress,
            step_callback=lambda n, *_a, **_k: emit("progress", kind="step", step=n),
        )
    except Exception as e:  # noqa: BLE001
        emit("error", fatal=True, message=f"Hermes could not start: {e}")
        return 4
    exposed = sorted(t["function"]["name"] for t in (agent.tools or []))
    if exposed != sorted(tool_names):
        emit("error", fatal=True, message=f"Hermes exposed tools Jarvis did not grant: {sorted(set(exposed) - set(tool_names))}")
        return 5
    run.agent = agent
    emit("ready", tools=exposed)

    # Control messages (tool results, cancel) arrive while the agent works.
    def reader() -> None:
        while True:
            msg = read_message()
            if msg is None:
                run.cancel()
                return
            if msg.get("op") == "tool_result":
                run.deliver(msg)
            elif msg.get("op") == "cancel":
                run.cancel()

    threading.Thread(target=reader, name="jarvis-control", daemon=True).start()

    try:
        result = agent.run_conversation(neutralize(str(req.get("prompt", ""))), conversation_history=req.get("history") or [], task_id=req.get("runId"))
    except Exception as e:  # noqa: BLE001
        emit("error", fatal=True, message=f"Hermes failed: {e}", trace=traceback.format_exc()[-2000:])
        return 6
    emit(
        "result",
        final=result.get("final_response"),
        completed=bool(result.get("completed")),
        interrupted=bool(result.get("interrupted")) or run.cancelled,
        failed=bool(result.get("failed")),
        exit=str(result.get("turn_exit_reason") or ""),
        apiCalls=result.get("api_calls"),
        messages=result.get("messages") or [],
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
