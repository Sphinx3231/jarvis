"""Runs the app's exact on-device prompts through the real bundled model on this computer.

Uses Google's LiteRT-LM runtime (pip install litert-lm==0.19.2) on the same .task file the APK
ships. Like the app, it sends the fully formatted ChatML prompt with NO extra template, using the
app's sampler settings. Usage: python local-model-check.py <model.task> <prompts.json> <outputs.json>
"""
import json, sys, time
import litert_lm as L

import os
model, prompts_path, out_path = sys.argv[1:4]
# Keep the runtime's cache out of model-assets/ (everything there is packed into the APK).
engine = L.Engine(model, backend=L.Backend.CPU(), max_num_tokens=4096, cache_dir=os.path.dirname(os.path.abspath(out_path)))
results = []
for case in json.load(open(prompts_path)):
    session = engine.create_session(apply_prompt_template=False, sampler_config=L.SamplerConfig(top_k=40, top_p=0.9, temperature=0.4, seed=7))
    t = time.time()
    session.run_prefill([case["prompt"]])
    out = session.run_decode().texts[0]
    session.close()
    print(f"[{time.time() - t:4.1f}s] {case['question']!r} -> {out.strip()[:110]!r}", flush=True)
    results.append({**case, "output": out})
json.dump(results, open(out_path, "w"), ensure_ascii=False, indent=1)
