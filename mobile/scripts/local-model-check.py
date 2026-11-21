"""Runs the app's exact on-device requests through the real model on this computer.

Uses Google's LiteRT-LM runtime (pip install litert-lm==0.19.2) with the same .litertlm file the
phone downloads. Like the app: the conversation API with the app's system prompt, the app's tool
descriptions, automatic tool calling OFF (calls come back for validation), the app's sampler.
Usage: python local-model-check.py <model.litertlm> <cases.json> <outputs.json>
"""
import json, os, sys, time
import litert_lm as L
from litert_lm import interfaces as I

model, cases_path, out_path = sys.argv[1:4]
# Keep the runtime's cache next to the outputs (never in model-assets/, which is packed into APKs).
engine = L.Engine(model, backend=L.Backend.CPU(), max_num_tokens=4096, cache_dir=os.path.dirname(os.path.abspath(out_path)))


class AppTool(I.Tool):
    def __init__(self, desc): self.desc = desc
    def get_tool_description(self): return {"type": "function", "function": self.desc}
    def execute(self, param): raise RuntimeError("tools are never run automatically")


results = []
for case in json.load(open(cases_path)):
    msgs = case["messages"]
    conv = engine.create_conversation(messages=msgs[:-1] or None, tools=[AppTool(t) for t in case["tools"]], automatic_tool_calling=False,
                                      system_message=case["system"], sampler_config=I.SamplerConfig(top_k=40, top_p=0.95, temperature=0.6, seed=7))
    t = time.time()
    reply = conv.send_message(msgs[-1])
    dt = round(time.time() - t, 1)
    j = reply.to_json() if hasattr(reply, "to_json") else reply
    print(f"[{dt:4.1f}s] {case['question']!r} -> {json.dumps(j)[:140]}", flush=True)
    results.append({**{k: case[k] for k in ("question", "expect", "check") if k in case}, "reply": j, "seconds": dt})
json.dump(results, open(out_path, "w"), ensure_ascii=False, indent=1)
