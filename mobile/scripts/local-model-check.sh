#!/usr/bin/env sh
# Real-model check of the on-device assistant: the app's exact requests (Kotlin) → Gemma 4 E2B
# (LiteRT-LM on this computer) → the app's conversion and validation (Kotlin). Needs the model
# file (MODEL=path, e.g. from fetch-model.sh) and Python with `pip install litert-lm==0.19.2` (set PYTHON to that interpreter).
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
android="$here/../android"
out="$android/app/build/local-model"
mkdir -p "$out"
cd "$android"
JARVIS_PROMPT_DUMP="$out/prompts.json" ./gradlew -q :app:testDebugUnitTest --tests 'ai.jarvis.mobile.LocalModelTest.dumpPromptsForTheRealModel' --rerun-tasks
"${PYTHON:-python3}" "$here/local-model-check.py" "${MODEL:?set MODEL to a gemma-4-E2B-it-abliterated.litertlm file (see fetch-model.sh)}" "$out/prompts.json" "$out/outputs.json"
JARVIS_MODEL_OUTPUTS="$out/outputs.json" ./gradlew -q :app:testDebugUnitTest --tests 'ai.jarvis.mobile.LocalModelTest.realModelOutputsParseIntoTheRightCalls' --rerun-tasks
cat "$out/local-model-report.txt"
