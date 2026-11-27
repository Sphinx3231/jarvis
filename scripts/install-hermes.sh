#!/usr/bin/env bash
# Install Hermes Agent (NousResearch, MIT) as Jarvis's agent harness — Linux and macOS.
#
# Installs the exact commit Jarvis's bridge was audited and tested against, from Hermes's own lockfile,
# into <Jarvis data dir>/hermes/runtime, where Jarvis finds it automatically. Nothing else on the
# computer is changed: Hermes gets its own Python 3.14 (via uv) and its own folder.
#
# Usage: scripts/install-hermes.sh            (data dir: $JARVIS_DATA_DIR or ~/.jarvis)
# Remove: delete <data dir>/hermes/runtime — Jarvis then plans every task natively again.
set -euo pipefail

HERMES_REPO="https://github.com/NousResearch/hermes-agent"
# Audited and tested with Jarvis's bridge (server/harness/hermes_bridge.py). Bump only after re-running
# tests/harness.test.ts against the new commit: Hermes's embedding API is its constructor.
HERMES_COMMIT="38fde82474b5d370590e314358cc05076dc9ae70"
DATA_DIR="${JARVIS_DATA_DIR:-$HOME/.jarvis}"
TARGET="$DATA_DIR/hermes/runtime"

need() { command -v "$1" >/dev/null 2>&1 || { echo "Needs $1: $2" >&2; exit 1; }; }
need git "install git"
if ! command -v uv >/dev/null 2>&1; then
  echo "Installing uv (Python package manager) for this user…"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi
need uv "see https://docs.astral.sh/uv/"

echo "Hermes Agent $HERMES_COMMIT → $TARGET"
mkdir -p "$TARGET"
cd "$TARGET"
if [ ! -d .git ]; then git init -q; git remote add origin "$HERMES_REPO"; fi
git fetch -q --depth 1 origin "$HERMES_COMMIT"
git -c advice.detachedHead=false checkout -q --force FETCH_HEAD

# Hermes's core dependencies are only pinned for Python 3.14; its lockfile is the supported install.
uv python install 3.14 >/dev/null
uv sync --frozen --python 3.14 --quiet

HERMES_HOME="$(mktemp -d)" .venv/bin/python -c "import hermes_cli, run_agent; print('Hermes', hermes_cli.__release_date__, 'imports OK')"
printf '{"commit":"%s","installedAt":"%s"}\n' "$HERMES_COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > jarvis-hermes.json
echo "Done. Jarvis uses it automatically (Settings → Agent harness shows its status)."
