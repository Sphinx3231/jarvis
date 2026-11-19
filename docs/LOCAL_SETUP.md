# Running Jarvis fully locally (any PC; the GEEKOM A6 is the target)

Jarvis is a **harness**. It holds the memory, tasks, permissions, Computer Access, sub-agents and UI. The **model** you choose does the thinking. Everything runs on your own computer: no API keys, no tokens billed, no usage limits. Because the model is what earns its keep, the harness is built to take as little RAM as possible and leave the rest to the model.

```
 You ──mic──▶ Jarvis UI ─▶ voice worker (Whisper; starts when you talk, exits when idle)
                 ▲              │
                 └─ WAV ◀── voice worker (Kokoro; same)
                 ▼
            Jarvis harness (~115 MB): memory · tasks · permissions · Computer Access · sub-agents
                 │  tools stay in Jarvis: every action still passes Jarvis's permission engine
                 ▼
            OpenJarvis server (~0.6 GB, optional) ──▶ Ollama ──▶ YOUR model (kept loaded 24/7)
```

## Measured RAM

These are measurements from this codebase, not estimates:

| Part | RAM |
|---|---|
| Jarvis harness, idle (lean defaults) | **~115 MB** (was ~350 MB). The Roamies engine, the mail and calendar libraries and the Claude Agent SDK only load if you use them. The 200 MB embedding model is opt-in. |
| OpenJarvis server, idle | ~500 MB. Skip it with **direct to the engine** (`-Engine` / `--engine`, or Settings → Brain → Route). |
| Listening worker (Whisper base / small) | ~0.3 / ~0.5 GB, **only while in use**. It exits after `idleSec` (default 120 s). |
| Voice worker (Kokoro) | ~1.4 GB, **only while in use**. It exits when idle and starts loading the moment you start speaking. |
| Your model | Everything else: weights plus the context cache. |

In practice, between conversations the stack costs about 0.1–0.7 GB, and the rest of your RAM goes to the model.

## Choosing a model (yours)

Pull any Ollama model, then check it and make it the brain:

```bash
ollama pull <model>                              # e.g. a DeepSeek tag of your choice
node scripts/jarvis-local.ts fit <model>         # will it run here, and with how much context?
node scripts/jarvis-local.ts use <model>         # make it Jarvis's brain
```

`fit` reads the model's real architecture from Ollama: layers, KV heads and head size. For DeepSeek's Multi-head Latent Attention (MLA) it reads the compressed latent size instead. From that it computes:

- the RAM this machine has for the model: total RAM minus the OS minus the Jarvis stack;
- the context cache per 1,000 tokens, at Ollama's `q8_0` cache setting;
- the **largest context window that fits without swapping**, and the setup sets Ollama to it;
- advice: when a smaller quantization is needed, when the model has no native tool calling, and when it is a reasoning model.

Examples using published model configurations:

| | 16 GB (Windows) | 32 GB (A6) | 64 GB (A6 upgraded) |
|---|---|---|---|
| A Qwen3-8B q4 (0.075 GB per 1k tokens) | 32k context | 32k (the model's maximum) | 32k |
| DeepSeek-V2-Lite q4 (MLA, **0.016 GB per 1k**) | doesn't fit | 128k | 128k |

**Any model works**, because Jarvis adapts to what the engine reports about it:

- **Native tool calling** (`tools`): Jarvis passes its tools to the model natively.
- **No tool calling** (some DeepSeek and older models): Jarvis writes its tools into the prompt and runs the `<tool_call>` the model writes. Settings → Brain → *Tools for this model* can force either mode.
- **Reasoning models** (DeepSeek R1 and other thinking models): `<think>…</think>` blocks are stripped from replies, and the model gets a larger output budget (8k tokens or more) so its thinking isn't cut off. Some servers switch thinking off, which leaves a thinking-only model with an empty answer. When that happens, Jarvis asks the engine directly and stays on that route.

## Install (Windows; the A6 ships with Windows 11)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\local-setup\setup-windows.ps1 -Model <your-model> -KeepAwake
```

| Option | What it does |
|---|---|
| `-Model <tag>` | The model to run. Omit it to choose later with `jarvis-local use <tag>`. |
| `-Engine` | Go direct to the engine (no OpenJarvis server, ~0.6 GB more for the model). |
| `-Vulkan` | Let Ollama try the iGPU. Experimental and untested here; CPU is the default. |
| `-KeepAwake` | Keep the PC from sleeping on mains power, for 24/7 use. |
| `-NoServices` | Install only; don't register the logon tasks. |

The setup:

1. Installs Node.js 22+ and Ollama (with winget, or Ollama's own installer).
2. Configures Ollama for 24/7 use: one model kept loaded, never unloaded, with a `q8_0` context cache.
3. Pulls your model and sets the context window from `fit`.
4. Installs OpenJarvis into `%LOCALAPPDATA%\Jarvis\openjarvis`, pinned to the tested version. Its Python also runs the voice workers. The spaCy model that Kokoro needs is pre-installed.
5. Builds Jarvis.
6. Registers logon tasks, which restart if they stop. Jarvis's Node heap is capped at 384 MB.

Then open **http://127.0.0.1:7777**. You don't need the desktop window running 24/7: any browser works, and Electron would cost about 200–300 MB more.

## Install (Linux)

```bash
bash scripts/local-setup/setup-linux.sh --model <your-model>        # --engine --vulkan --no-services
```

This does the same as the Windows setup. Ollama gets a systemd drop-in, and Jarvis plus OpenJarvis run as systemd user services with lingering enabled.

## Hardware notes (GEEKOM A6: Ryzen 7 6800H, Radeon 680M, 32 GB DDR5, upgradable to 64 GB)

- On a CPU-first mini PC, speed is set by memory bandwidth: every generated token reads the active weights once.
  - **Mixture-of-Experts** models (DeepSeek-V2-Lite and other "A3B"-style models) read only their active parameters per token, so they are much faster than dense models of the same size.
  - **MLA** (DeepSeek) keeps long contexts cheap.
- Set the iGPU memory (UMA frame buffer) to the minimum in the BIOS. RAM reserved for the 680M can't hold model weights.
- Going from 32 GB to 64 GB doesn't change the setup. Re-run `jarvis-local use <model>` and it recomputes the budget and context window.

## Checking it

```bash
node scripts/jarvis-local.ts budget    # RAM left for the model on this machine
node scripts/jarvis-local.ts check     # engine, OpenJarvis, the model in memory and its context, free RAM
```

In the app:

- **Settings → Brain** shows the model's capabilities (tools, reasoning, vision, maximum context), the route and the tool mode.
- **Settings → Voice** has on-demand loading, the idle timeout and the Whisper size.

## Troubleshooting

- **Replies are empty with a reasoning model:** Jarvis falls back to the engine automatically. Check that `engineUrl` (Settings → Brain) points at Ollama.
- **The first spoken reply after a quiet spell is slow:** the voice worker is loading, which takes a few seconds on the A6. Raise `idleSec` to keep it loaded longer, at the cost of about 1.4 GB.
- **The model is slow or the disk is busy:** it doesn't fit, and the computer is swapping. Run `jarvis-local fit <model>`, then use a smaller quantization or the direct-to-engine route.
- **OpenJarvis lists cloud models (`owned_by: nim`):** that's a hosted catalogue. It needs keys the setup never sets, and local-only mode filters it out.
