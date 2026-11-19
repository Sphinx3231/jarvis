#!/usr/bin/env bash
# Jarvis — fully local setup for Linux (a GEEKOM A6 on Ubuntu/Debian/Fedora, or any PC).
#
# Installs and wires up, all on this machine (no API keys, no cloud, no usage limits):
#   Ollama (one model kept loaded 24/7) · your model, with the largest context that fits your RAM ·
#   OpenJarvis (brain server) + the Python for on-demand local listening/voice · Jarvis ·
#   systemd user services that start at boot.
#
#   bash scripts/local-setup/setup-linux.sh [--model <ollama-model>] [--engine] [--vulkan]
#                                           [--no-services] [--skip-ollama]
#   --model   any Ollama tag (e.g. a DeepSeek); omit to choose later: node scripts/jarvis-local.ts use <tag>
#   --engine  talk to the engine directly (no OpenJarvis server: ~0.6 GB more RAM for the model)
set -euo pipefail

OPENJARVIS_COMMIT=427c2dd11d180ac254a03e92c5fb01189fb4b23b
OPENJARVIS_SPEC=${JARVIS_OPENJARVIS_SPEC:-"openjarvis[server,voice,speech] @ https://github.com/open-jarvis/OpenJarvis/archive/${OPENJARVIS_COMMIT}.zip"}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DATA=${XDG_DATA_HOME:-$HOME/.local/share}/jarvis
VENV=$DATA/openjarvis
LOGS=$DATA/logs
MODEL="" ENGINE=0 VULKAN=0 SERVICES=1 OLLAMA=1
while [ $# -gt 0 ]; do
  case "$1" in
    --model) MODEL="$2"; shift ;;
    --engine) ENGINE=1 ;;
    --vulkan) VULKAN=1 ;;
    --no-services) SERVICES=0 ;;
    --skip-ollama) OLLAMA=0 ;;
    *) echo "unknown option $1"; exit 2 ;;
  esac
  shift
done
mkdir -p "$DATA" "$LOGS"
step() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
ENGINE_ARGS=()
if [ "$ENGINE" = 1 ]; then ENGINE_ARGS=(--engine); fi
jl() { node --disable-warning=ExperimentalWarning "$ROOT/scripts/jarvis-local.ts" "$@" ${ENGINE_ARGS[@]+"${ENGINE_ARGS[@]}"}; }

ollama_env() {
  # Ollama settings for 24/7 use, applied to its systemd service.
  sudo mkdir -p /etc/systemd/system/ollama.service.d
  {
    echo "[Service]"
    jl env "$@" --format systemd
    if [ "$VULKAN" = 1 ]; then echo "Environment=OLLAMA_VULKAN=1"; fi
  } | sudo tee /etc/systemd/system/ollama.service.d/jarvis.conf >/dev/null
  sudo systemctl daemon-reload && sudo systemctl restart ollama
  for _ in $(seq 1 30); do curl -fs http://127.0.0.1:11434/api/tags >/dev/null && break; sleep 1; done
}

step "Checking Node.js 22+"
if ! have node || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 22 ]; then
  echo "Install Node.js 22 or newer (https://nodejs.org or your package manager), then re-run."; exit 1
fi
jl budget

step "System packages (audio, OCR and screen tools for voice and Computer Access)"
if have apt-get; then
  sudo apt-get update -q && sudo apt-get install -y -q curl espeak-ng ffmpeg tesseract-ocr scrot xdotool wmctrl xdg-utils || true
elif have dnf; then
  sudo dnf install -y curl espeak-ng ffmpeg tesseract scrot xdotool wmctrl xdg-utils || true
fi

if [ "$OLLAMA" = 1 ]; then
  step "Ollama (the local model engine)"
  have ollama || curl -fsSL https://ollama.com/install.sh | sh
  sudo systemctl enable --now ollama
  ollama_env --context 16384
  if [ -n "$MODEL" ]; then
    step "Downloading your model: $MODEL (once)"
    ollama pull "$MODEL"
    # The largest context window that fits beside the model on this machine.
    ollama_env "$MODEL"
  fi
fi

step "OpenJarvis + local voice runtime (Whisper, Kokoro)"
have uv || { curl -LsSf https://astral.sh/uv/install.sh | sh; export PATH="$HOME/.local/bin:$PATH"; }
[ -x "$VENV/bin/python" ] || uv venv --python 3.12 "$VENV"
uv pip install --python "$VENV/bin/python" --index-strategy unsafe-best-match --extra-index-url https://download.pytorch.org/whl/cpu "$OPENJARVIS_SPEC"
# Kokoro needs this spaCy model; install it now (a failed download at the first spoken reply makes
# spaCy exit and takes its process down with it).
if ! "$VENV/bin/python" -c "import en_core_web_sm" 2>/dev/null; then
  uv pip install --python "$VENV/bin/python" pip >/dev/null
  "$VENV/bin/python" -m spacy download en_core_web_sm || {
    whl=$(mktemp -d)/en_core_web_sm-3.7.1-py3-none-any.whl
    curl -fsSL -o "$whl" https://huggingface.co/spacy/en_core_web_sm/resolve/main/en_core_web_sm-any-py3-none-any.whl
    uv pip install --python "$VENV/bin/python" "$whl"
  }
fi
if [ -n "$MODEL" ]; then jl use "$MODEL"; else jl configure; fi

step "Building Jarvis"
(cd "$ROOT" && npm ci --no-audit --no-fund && npm run build)

VIA_ENV=""
if [ "$ENGINE" = 1 ]; then VIA_ENV="Environment=JARVIS_BRAIN_VIA=engine"; fi
if [ "$SERVICES" = 1 ] && have systemctl; then
  step "systemd user services, started at boot"
  UNITS=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
  mkdir -p "$UNITS"
  if [ "$ENGINE" = 0 ]; then
    cat > "$UNITS/jarvis-brain.service" <<EOF
[Unit]
Description=Jarvis brain (OpenJarvis)
After=network.target

[Service]
ExecStart=$VENV/bin/jarvis serve
Restart=always
RestartSec=5
StandardOutput=append:$LOGS/openjarvis.log
StandardError=append:$LOGS/openjarvis.log

[Install]
WantedBy=default.target
EOF
  fi
  cat > "$UNITS/jarvis.service" <<EOF
[Unit]
Description=Jarvis (fully local assistant)
After=jarvis-brain.service

[Service]
WorkingDirectory=$ROOT
Environment=JARVIS_VOICE_PYTHON=$VENV/bin/python
$VIA_ENV
# A small, capped harness: the RAM belongs to the model.
ExecStart=$(command -v node) --max-old-space-size=384 --disable-warning=ExperimentalWarning server/main.ts
Restart=always
RestartSec=5
StandardOutput=append:$LOGS/jarvis.log
StandardError=append:$LOGS/jarvis.log

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  if [ "$ENGINE" = 0 ]; then systemctl --user enable --now jarvis-brain.service; fi
  systemctl --user enable --now jarvis.service
  # Keep running when you're logged out (24/7).
  loginctl enable-linger "$USER" 2>/dev/null || sudo loginctl enable-linger "$USER" || true
elif [ "$ENGINE" = 0 ]; then
  nohup "$VENV/bin/jarvis" serve >>"$LOGS/openjarvis.log" 2>&1 &
fi

if [ "$ENGINE" = 0 ]; then
  step "Waiting for the brain"
  for _ in $(seq 1 90); do curl -fs http://127.0.0.1:8000/health >/dev/null && break; sleep 2; done
fi
jl check || true
[ -n "$MODEL" ] || printf '\n\033[33mNo model yet: pull one (ollama pull <model>), then run: node scripts/jarvis-local.ts use <model>\033[0m\n'
printf '\n\033[32mJarvis: http://127.0.0.1:7777   (logs: %s)\033[0m\n' "$LOGS"
