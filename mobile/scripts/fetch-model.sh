#!/usr/bin/env sh
# Downloads the on-device model for a build that bundles it inside the APK (normally the phone
# downloads it itself from inside the app, so this is only for -Pjarvis.bundleModel=true builds):
#   Gemma 4 E2B (Google, Apache-2.0), LiteRT-LM format: https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm
# Then: cd mobile/android && ./gradlew assembleDebug -Pjarvis.bundleModel=true   (APK ≈ 2.7 GB)
set -eu
dir="$(cd "$(dirname "$0")/../android" && pwd)/model-assets"
file="$dir/gemma-4-E2B-it.litertlm"
url="https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/2e12bfd869b2962984f97a1f2a26807316d534cc/gemma-4-E2B-it.litertlm"
sha="181938105e0eefd105961417e8da75903eacda102c4fce9ce90f50b97139a63c"
mkdir -p "$dir"
if [ -f "$file" ] && echo "$sha  $file" | sha256sum -c --quiet 2>/dev/null; then echo "Already downloaded: $file"; exit 0; fi
echo "Downloading Gemma 4 E2B (2.6 GB)…"
curl -L --fail -o "$file.part" "$url"
echo "$sha  $file.part" | sha256sum -c --quiet || { echo "Checksum mismatch; deleted" >&2; rm -f "$file.part"; exit 1; }
mv "$file.part" "$file"
echo "Saved $file"
