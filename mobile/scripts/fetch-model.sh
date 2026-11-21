#!/usr/bin/env sh
# Downloads the on-device model for a build that bundles it inside the APK (normally the phone
# downloads it itself from inside the app, so this is only for -Pjarvis.bundleModel=true builds):
#   Gemma 4 E2B abliterated (Apache-2.0; Google Gemma 4, abliteration by csabag76), LiteRT-LM format:
#   https://huggingface.co/csabag76/gemma-4-E2B-it-abliterated-litert-lm
# Then: cd mobile/android && ./gradlew assembleDebug -Pjarvis.bundleModel=true   (APK ≈ 2.7 GB)
set -eu
dir="$(cd "$(dirname "$0")/../android" && pwd)/model-assets"
file="$dir/gemma-4-E2B-it-abliterated.litertlm"
url="https://huggingface.co/csabag76/gemma-4-E2B-it-abliterated-litert-lm/resolve/6e6d6e68ab2ff9873e01d69d6c3421658fb4c840/gemma-4-E2B-it-abliterated.litertlm"
sha="0ebc29dcd1533a46a84b0078656ffa7010eaa07282fd2b0b6586556373409fd9"
mkdir -p "$dir"
if [ -f "$file" ] && echo "$sha  $file" | sha256sum -c --quiet 2>/dev/null; then echo "Already downloaded: $file"; exit 0; fi
echo "Downloading Gemma 4 E2B abliterated (2.6 GB)…"
curl -L --fail -o "$file.part" "$url"
echo "$sha  $file.part" | sha256sum -c --quiet || { echo "Checksum mismatch; deleted" >&2; rm -f "$file.part"; exit 1; }
mv "$file.part" "$file"
echo "Saved $file"
