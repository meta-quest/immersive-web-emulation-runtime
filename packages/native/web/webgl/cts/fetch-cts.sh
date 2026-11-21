#!/usr/bin/env bash
# Downloads the Khronos WebGL conformance tests (sdk/tests) at a pinned commit from Chromium's mirror of
# KhronosGroup/WebGL into ~/.cache/iwn-webgl-cts/sdk-tests (outside the checkout; test-only, not shipped).
# Uses the usual https_proxy environment behind a proxy.
set -euo pipefail
COMMIT="${1:-193020cd37c3ad6aa068805ef7fb7eca187734b5}"
DEST="${IWN_WEBGL_CTS:-$HOME/.cache/iwn-webgl-cts}"
mkdir -p "$DEST/sdk-tests"
curl -sSf -o "$DEST/tests.tar.gz" \
  "https://chromium.googlesource.com/external/khronosgroup/webgl/+archive/${COMMIT}/sdk/tests.tar.gz"
tar -xzf "$DEST/tests.tar.gz" -C "$DEST/sdk-tests"
echo "commit ${COMMIT}" > "$DEST/REVISION"
echo "WebGL CTS ${COMMIT} in $DEST/sdk-tests"
