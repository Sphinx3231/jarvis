# Running Jarvis fully locally (GEEKOM A6)

Jarvis's default brain is **OpenJarvis**, running on your own PC. That gives you:

- **Thinking:** a local model through Ollama, with tool calling, so Jarvis can act.
- **Listening:** Whisper (faster-whisper) on your CPU. This replaces paid dictation services such as Wispr Flow.
- **Speaking:** Kokoro, an 82M-parameter local voice. Jarvis uses the British voice `bm_george`. This replaces Fish Audio.
- **Everything else stays as it was:** memory, tasks, the sub-agents, Computer Access and the UI.

There are **no API keys, no tokens billed and no usage limits**. The default **local-only** mode refuses every cloud model, cloud voice and cloud transcription. It also stops using the browser's built-in speech recognition, because Chrome sends that audio to Google. The "Hey Jarvis" wake word runs on local Whisper too, and only transcribes short bursts when it actually hears speech.

```
 You ──mic──▶ Jarvis UI ──audio──▶ OpenJarvis /v1/speech/transcribe (Whisper, CPU)
                 │                     │
                 │◀──── WAV ───────────┘ /v1/speech/synthesize (Kokoro, CPU)
                 ▼
            Jarvis server (memory · tasks · permissions · Computer Access · sub-agents)
                 │  tools stay in Jarvis: every action still passes Jarvis's permission engine
                 ▼
            OpenJarvis /v1/chat/completions ──▶ Ollama ──▶ local model (kept loaded 24/7)
```

## The hardware: GEEKOM A6

The A6 has a Ryzen 7 6800H (8 cores, 16 threads), a Radeon 680M integrated GPU and dual-channel DDR5-4800. It ships with 32 GB of RAM and can be upgraded to 64 GB. On a CPU-first mini PC, memory bandwidth is what limits speed. That is why the larger profiles use **Mixture-of-Experts** models: only about 3B parameters are active per token, so they run much faster than their total size suggests.

| Profile | Brain (always loaded) | Optional "heavy" model | Listening | Context |
|---|---|---|---|---|
| **a6-32gb** (as shipped) | `qwen3.5:9b`, 6.6 GB. Tools, vision, thinking. | `qwen3:30b-a3b`, 18.6 GB MoE. Run it with other apps closed. | Whisper `small` | 16k |
| **a6-64gb** (after the upgrade) | `qwen3.6:35b-a3b`, 22.6 GB MoE. The full-potential brain. | `qwen3-next:80b`, 50.4 GB MoE | Whisper `medium` | 32k |
| small (under 24 GB) | `qwen3:8b`, 5.2 GB | — | Whisper `base` | 16k |

The setup picks the profile from your RAM automatically. To see what it would pick, run `node scripts/jarvis-local.ts profile`. When you upgrade to 64 GB, re-run the setup and it moves to the bigger brain on its own.

All model tags and sizes above were checked against the Ollama registry and are tagged **tools** there. Speeds on the 6800H are estimates until you measure them on the machine.

**Two tips for the A6:**

- Set the iGPU's memory (the "UMA frame buffer") to its minimum in the BIOS. RAM reserved for the 680M can't be used by the brain.
- `-Vulkan` (Windows) or `--vulkan` (Linux) lets Ollama try the 680M via Vulkan. It is **experimental** and I couldn't test it here (there's no AMD GPU in the build environment). CPU is the default and it works.

## Install (Windows 11, which the A6 ships with)

Open PowerShell in the Jarvis folder and run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\local-setup\setup-windows.ps1 -KeepAwake
```

The script does the following:

1. Installs Node.js 22+ and Ollama (with winget) if they're missing.
2. Configures Ollama for 24/7 use. It keeps one model loaded and never unloads it (`OLLAMA_KEEP_ALIVE=-1`, `OLLAMA_MAX_LOADED_MODELS=1`). It also halves the RAM used by the context cache (`OLLAMA_KV_CACHE_TYPE=q8_0`).
3. Downloads the brain model for your RAM.
4. Installs OpenJarvis into `%LOCALAPPDATA%\Jarvis\openjarvis`, pinned to the version Jarvis was tested with. That version has the Kokoro voice endpoint, which is newer than the PyPI 1.0.4 release. It also pre-installs the spaCy English model Kokoro needs.
5. Writes `~/.openjarvis/config.toml`: Ollama engine, your profile's model, Whisper on the CPU, Kokoro `bm_george`.
6. Builds Jarvis.
7. Registers two logon tasks, **Jarvis Brain** (OpenJarvis) and **Jarvis** (the app). They restart if they stop.
8. Warms up the voice, then runs a health check.

Options:

| Option | Effect |
|---|---|
| `-HardwareProfile a6-64gb` | Force a profile instead of choosing from RAM |
| `-Heavy` | Also download the heavy model |
| `-Vulkan` | Try the iGPU (experimental) |
| `-NoServices` | Don't register the logon tasks |
| `-SkipModels` | Don't download models now |
| `-KeepAwake` | Stop the PC sleeping on mains power |

Then open **http://127.0.0.1:7777**.

## Install (Linux)

```bash
bash scripts/local-setup/setup-linux.sh            # --profile a6-64gb --heavy --vulkan --no-services
```

This does the same as the Windows script. Ollama runs as a system service with the 24/7 settings. `jarvis-brain` and `jarvis` run as systemd **user** services, with lingering enabled so they keep running when you're logged out. It also installs `espeak-ng`, `ffmpeg`, plus `tesseract`, `scrot`, `xdotool` and `wmctrl` for Computer Access.

## Checking it

```bash
node scripts/jarvis-local.ts check
```

This checks Ollama, the brain model, OpenJarvis, the local models and listening and voice readiness, and reports free RAM. In the app, **Settings → Brain** shows the same status. **Integrations → Brain — OpenJarvis (local)** shows whether thinking, listening and the voice are ready.

## Settings

- **Settings → Brain:** choose OpenJarvis (local) or the Roamies engine. Also: the **Local only** switch, the OpenJarvis address (this computer or your LAN only) and the local model.
- **Settings → Voice:**
  - *Jarvis's voice:* **Local (Kokoro)**, with a choice of British or American, male or female voices. The browser voice is a fallback. Fish Audio is unavailable in local-only mode.
  - *Transcription:* **OpenJarvis (local Whisper)**.
  - *Wake word:* "Hey Jarvis", local.

## Troubleshooting

- **"OpenJarvis isn't running":** start the *Jarvis Brain* task (Windows) or run `systemctl --user restart jarvis-brain` (Linux). Logs are in `%LOCALAPPDATA%\Jarvis\logs` or `~/.local/share/jarvis/logs`.
- **The voice fails at the first reply, or OpenJarvis exits:** Kokoro's spaCy model is missing. Re-run the setup, which installs it. Also make sure you're on the pinned OpenJarvis version, because PyPI 1.0.4 has no voice endpoint.
- **Slow answers on 32 GB:** stay on `qwen3.5:9b`, close the heavy model, and check `ollama ps` shows only one model loaded.
- **OpenJarvis lists cloud models (`owned_by: nim`):** that is NVIDIA's hosted catalogue. It needs an `NIM_API_KEY` that the setup never sets, and Jarvis's local-only mode filters those models out anyway.

## What was tested

These were run in the build environment (Linux, 4 CPU cores, no GPU), using the real OpenJarvis with llama.cpp serving Qwen3-1.7B:

| What | Result |
|---|---|
| Tool call | The local model called a Jarvis tool and answered "391" (3.3 s) |
| Speaking | Kokoro `bm_george` produced a 247 KB WAV (4.6 s, including the first model load) |
| Listening | Whisper `base` heard that WAV back correctly except one word, "Geekom" → "Geekam" (1.3 s) |
| Acting | Jarvis stored the memory |
| Test suite | `tests/openjarvis.test.ts`, including the real-server test (`JARVIS_TEST_OPENJARVIS=http://127.0.0.1:8000`) |

The A6 itself and Windows need testing on real hardware: the setup scripts are written for it, and the Linux script was run end to end here.
