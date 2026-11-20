#!/usr/bin/env sh
# Downloads the on-device model bundled into the Jarvis Mobile APK:
#   Qwen2.5-1.5B-Instruct (Alibaba Qwen team, Apache-2.0), int8, packaged for on-device inference
#   by Google's litert-community: https://huggingface.co/litert-community/Qwen2.5-1.5B-Instruct
# Then build with:  cd mobile/android && ./gradlew assembleDebug -Pjarvis.bundleModel=true
set -eu
dir="$(cd "$(dirname "$0")/../android" && pwd)/model-assets"
file="$dir/qwen2.5-1.5b-instruct-q8.task"
url="https://huggingface.co/litert-community/Qwen2.5-1.5B-Instruct/resolve/main/Qwen2.5-1.5B-Instruct_multi-prefill-seq_q8_ekv4096.task"
mkdir -p "$dir"
if [ -f "$file" ] && [ "$(wc -c < "$file")" -eq 1598556720 ]; then echo "Already downloaded: $file"; exit 0; fi
echo "Downloading Qwen2.5-1.5B-Instruct (1.6 GB)…"
curl -L --fail -o "$file.part" "$url"
mv "$file.part" "$file"
[ "$(wc -c < "$file")" -eq 1598556720 ] || { echo "Unexpected size; delete $file and retry" >&2; exit 1; }
echo "Saved $file"
