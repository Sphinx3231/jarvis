#!/usr/bin/env bash
# Jarvis — fully local setup for Linux (GEEKOM A6 on Ubuntu/Debian/Fedora and similar).
#
# Installs and wires up, all on this machine (no API keys, no cloud, no usage limits):
#   Ollama (local models, one kept loaded 24/7) · OpenJarvis (brain server + Whisper + Kokoro) ·
#   the brain model for this machine's RAM · Jarvis · systemd user services that start at boot.
#
#   bash scripts/local-setup/setup-linux.sh [--profile a6-32gb|a6-64gb|small] [--heavy] [--vulkan]
#                                           [--no-services] [--skip-models] [--skip-ollama]
set -euo pipefail

OPENJARVIS_COMMIT=427c2dd11d180ac254a03e92c5fb01189fb4b23b
OPENJARVIS_SPEC=${JARVIS_OPENJARVIS_SPEC:-"openjarvis[server,voice,speech] @ https://github.com/open-jarvis/OpenJarvis/archive/${OPENJARVIS_COMMIT}.zip"}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DATA=${XDG_DATA_HOME:-$HOME/.local/share}/jarvis
VENV=$DATA/openjarvis
LOGS=$DATA/logs
PROFILE_ARGS=() HEAVY=0 VULKAN=0 SERVICES=1 MODELS=1 OLLAMA=1
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE_ARGS=(--profile "$2"); shift ;;
    --heavy) HEAVY=1 ;;
    --vulkan) VULKAN=1 ;;
    --no-services) SERVICES=0 ;;
    --skip-models) MODELS=0 ;;
    --skip-ollama) OLLAMA=0 ;;
    *) echo "unknown option $1"; exit 2 ;;
  esac
  shift
done
mkdir -p "$DATA" "$LOGS"
step() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
jl() { node --disable-warning=ExperimentalWarning "$ROOT/scripts/jarvis-local.ts" "$@" ${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"}; }

step "Checking Node.js 22+"
if ! have node || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 22 ]; then
  echo "Install Node.js 22 or newer (https://nodejs.org or your package manager), then re-run."; exit 1
fi
jl profile

step "System packages (audio, OCR and screen tools for voice and Computer Access)"
if have apt-get; then
  sudo apt-get update -q && sudo apt-get install -y -q curl espeak-ng ffmpeg tesseract-ocr scrot xdotool wmctrl xdg-utils || true
elif have dnf; then
  sudo dnf install -y curl espeak-ng ffmpeg tesseract scrot xdotool wmctrl xdg-utils || true
fi

if [ "$OLLAMA" = 1 ]; then
  step "Ollama (local model runtime)"
  have ollama || curl -fsSL https://ollama.com/install.sh | sh
  # One model loaded 24/7, never swapped; settings applied to the Ollama service.
  sudo mkdir -p /etc/systemd/system/ollama.service.d
  {
    echo "[Service]"
    jl env --format systemd
    if [ "$VULKAN" = 1 ]; then echo "Environment=OLLAMA_VULKAN=1"; fi
  } | sudo tee /etc/systemd/system/ollama.service.d/jarvis.conf >/dev/null
  sudo systemctl daemon-reload && sudo systemctl enable --now ollama && sudo systemctl restart ollama
  for _ in $(seq 1 30); do curl -fs http://127.0.0.1:11434/api/tags >/dev/null && break; sleep 1; done
  if [ "$MODELS" = 1 ]; then
    step "Downloading the brain model (a few GB, once)"
    if [ "$HEAVY" = 1 ]; then jl models --heavy; else jl models; fi | while read -r cmd; do echo "$cmd"; $cmd; done
  fi
fi

step "OpenJarvis (brain server + Whisper + Kokoro)"
have uv || { curl -LsSf https://astral.sh/uv/install.sh | sh; export PATH="$HOME/.local/bin:$PATH"; }
[ -x "$VENV/bin/python" ] || uv venv --python 3.12 "$VENV"
uv pip install --python "$VENV/bin/python" --index-strategy unsafe-best-match --extra-index-url https://download.pytorch.org/whl/cpu "$OPENJARVIS_SPEC"
# Kokoro needs this spaCy model; install it now (a failed download at the first spoken reply makes
# spaCy exit and takes the OpenJarvis server down with it).
if ! "$VENV/bin/python" -c "import en_core_web_sm" 2>/dev/null; then
  uv pip install --python "$VENV/bin/python" pip >/dev/null
  "$VENV/bin/python" -m spacy download en_core_web_sm || {
    whl=$(mktemp -d)/en_core_web_sm-3.7.1-py3-none-any.whl
    curl -fsSL -o "$whl" https://huggingface.co/spacy/en_core_web_sm/resolve/main/en_core_web_sm-any-py3-none-any.whl
    uv pip install --python "$VENV/bin/python" "$whl"
  }
fi
jl configure

step "Building Jarvis"
(cd "$ROOT" && npm ci --no-audit --no-fund && npm run build)

if [ "$SERVICES" = 1 ] && have systemctl; then
  step "systemd user services: jarvis-brain (OpenJarvis) and jarvis (the app), started at boot"
  UNITS=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
  mkdir -p "$UNITS"
  cat > "$UNITS/jarvis-brain.service" <<EOF
[Unit]
Description=Jarvis brain (OpenJarvis: local models, Whisper, Kokoro)
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
  cat > "$UNITS/jarvis.service" <<EOF
[Unit]
Description=Jarvis (fully local assistant)
After=jarvis-brain.service

[Service]
WorkingDirectory=$ROOT
ExecStart=$(command -v node) --disable-warning=ExperimentalWarning server/main.ts
Restart=always
RestartSec=5
StandardOutput=append:$LOGS/jarvis.log
StandardError=append:$LOGS/jarvis.log

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now jarvis-brain.service jarvis.service
  # Keep running when you're logged out (24/7).
  loginctl enable-linger "$USER" 2>/dev/null || sudo loginctl enable-linger "$USER" || true
else
  nohup "$VENV/bin/jarvis" serve >>"$LOGS/openjarvis.log" 2>&1 &
fi

step "Waiting for the brain, listening and voice (first start downloads Whisper + Kokoro, ~0.5 GB)"
for _ in $(seq 1 90); do curl -fs http://127.0.0.1:8000/health >/dev/null && break; sleep 2; done
curl -fs -m 600 -X POST http://127.0.0.1:8000/v1/speech/synthesize -H 'content-type: application/json' -d '{"text":"Jarvis is online."}' -o "$DATA/hello.wav" || echo "voice warm-up failed — see $LOGS/openjarvis.log"
jl check || true
printf '\n\033[32mJarvis: http://127.0.0.1:7777   (logs: %s)\033[0m\n' "$LOGS"
