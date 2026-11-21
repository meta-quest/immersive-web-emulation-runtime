#!/usr/bin/env bash
# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.
#
# Fetch the compat-sweep sample set into a scratch directory (never into the repo):
#   - the 23 proto-* samples and 11 standard examples at commit 64966db1
#     (immersive-web-sdk/examples/<name> in a checkout of this repository that has the commit; fetch it first),
#   - three @iwsdk/create projects (vr, ar, browser) scaffolded from the SDK tarball, which is also the IWSDK
#     the baseline describes (scripts/baseline.mjs),
#   - local copies of the two CDNs the samples load at boot (their npm packages), served by the sweep with
#     --mirror where the network cannot reach cdn.jsdelivr.net.
#
#   compat/scripts/acquire.sh <repository checkout> <scratch dir> <dir with <pkg>/iwsdk-<pkg>.tgz>
#
# Then: node compat/scripts/sweep.mjs --samples <scratch>/examples --packages <pkgs> ... (README.md).
set -euo pipefail
REPO=${1:?repository checkout}
DEST=${2:?scratch dir}
PKGS=${3:?dir with the IWSDK tarballs}
COMMIT=${COMMIT:-64966db1}
REGISTRY=${npm_config_registry:-https://registry.npmjs.org/}
mkdir -p "$DEST/examples" "$DEST/mirror" "$DEST/create-tool"

git -C "$REPO" cat-file -e "$COMMIT^{commit}" || { echo "commit $COMMIT is not in $REPO (fetch it first)" >&2; exit 1; }
names=$(git -C "$REPO" ls-tree --name-only "$COMMIT" immersive-web-sdk/examples/ | xargs -n1 basename)
for n in $names; do
  # a sample is a directory with a package.json
  git -C "$REPO" cat-file -e "$COMMIT:immersive-web-sdk/examples/$n/package.json" 2>/dev/null || continue
  [ -e "$DEST/examples/$n" ] && { echo "skip $n (exists)"; continue; }
  mkdir -p "$DEST/examples/$n"
  git -C "$REPO" archive "$COMMIT" "immersive-web-sdk/examples/$n" | tar -x --strip-components=3 -C "$DEST/examples/$n"
  echo "fetched $n"
done

# @iwsdk/create from the tarball, then the three templates (no install: the sweep installs)
(cd "$DEST/create-tool" &&
  printf '{"name":"ct","private":true,"dependencies":{"@iwsdk/create":"file:%s"}}\n' "$PKGS/create/iwsdk-create.tgz" > package.json &&
  npm install --no-audit --no-fund --registry "$REGISTRY" > install.log 2>&1)
for t in vr ar browser; do
  [ -e "$DEST/examples/create-$t" ] && continue
  (cd "$DEST/examples" && "$DEST/create-tool/node_modules/.bin/create-iwsdk" "create-$t" --yes --target "$t" --language ts \
    --no-install --no-git --skip-reference-warmup > "$DEST/create-$t.log" 2>&1)
  echo "scaffolded create-$t"
done

# CDN mirrors: the npm packages behind https://cdn.jsdelivr.net/npm/<pkg>@<ver>/
for pair in input-profiles:@webxr-input-profiles/assets@1.0.20 example-assets:@iwsdk/example-assets@0.4.2; do
  spec=${pair#*:}
  d="$DEST/mirror/${pair%%:*}"
  [ -e "$d/package" ] && continue
  mkdir -p "$d"
  (cd "$d" && npm pack "$spec" --registry "$REGISTRY" > /dev/null && tar -xzf ./*.tgz)
  echo "mirrored $spec -> $d/package"
done
echo "done: $(ls "$DEST/examples" | wc -l) samples in $DEST/examples"
