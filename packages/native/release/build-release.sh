#!/usr/bin/env bash
# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.
#
# CI-reproducible release build of @iwer/native: template APK + npm package.
# Builds, checks and stages; never publishes (publishing is a separate, manual step: RELEASE.md).
#
#   release/build-release.sh [--skip-native] [--skip-web] [--pack]
#
# Steps
#   1. toolchain check: every input path must exist, and none may resolve under a directory listed in
#      IWN_FORBIDDEN_ROOTS (colon-separated; for build machines that hold trees the build must not read)
#   2. web preludes (glue, dom, net, storage, image, canvas2d, webgl, audio, xr, workers): npm ci from the committed
#      lockfile (only when node_modules is missing), IWER's generated src/version.ts, node build.mjs in every shipped
#      web/<area>. --skip-web reuses the web/*/dist of an earlier run (web/*/dist/ is gitignored: a clean checkout
#      needs this step)
#   3. native: cmake (Android arm64, Release, -j8) -> libiwernative.so + apk-libs.txt; llvm-strip copies
#   4. notices + third-party verification (release/notices.mjs --check, verify-third-party.mjs --apk --build:
#      every compiled source in compile_commands.json must belong to a recorded component)
#   5. template: release/stage-template-assets.mjs + packager/template/build-template.mjs (unsigned, PKG-1/PKG-3);
#      zipalign -c -P 16 4 + readelf 16 KB LOAD alignment (PKG-3)
#   6. package: npm run build, tests, release/stage-package.mjs --template <apk> (npm pack --dry-run, size report;
#      --pack writes the tarball)
# Outputs in $OUT (default release/out): template/iwer-native-template.apk, template-info.json, symbols/*.so
# (unstripped), package/ (the staged npm package), pack-dry-run.json, size-report.md, build-info.json.
#
# Inputs (environment; all required except the last six):
#   ANDROID_HOME      Android SDK with build-tools/35.0.0 and platforms/android-34 (dl.google.com
#                     build-tools_r35_linux.zip + platform-34-ext7_r02.zip)
#   ANDROID_NDK_HOME  NDK r30 30.0.16248370 (dl.google.com android-ndk-r30-linux.zip)
#   IWN_V8_DIR        prebuilt V8 15.5.35.25 (include/, lib/arm64-v8a/libv8android.so, snapshot_blob.bin)
#   IWN_V8_SRC        V8 15.5.35.25 source tree (licence files only)
#   IWN_THIRD_PARTY_DIR  upstream third-party source trees, one directory per project (THIRD_PARTY.md): openxr,
#                     jsoncpp, oboe, dr_libs, libogg, libvorbis, freetype, harfbuzz, brotli, stb, skia (its LICENSE)
#   IWN_SQLITE_DIR    SQLite amalgamation dir (default: $IWN_THIRD_PARTY_DIR/sqlite)
#   NPM_REGISTRY      npm registry for dependency installs (default: npm's configured registry)
#   IWN_CONTENT_DENYLIST  file of patterns no shipped text file may contain, one regular expression per line, for
#                     the publishing organisation's own hosts, repositories and tools (release/stage-package.mjs)
#   IWN_FORBIDDEN_ROOTS  colon-separated directories no input may resolve into (default: none)
#   JOBS              ninja -j (default 8)
#   ANDROID_PLATFORM  NDK API level (default android-29 = the template minSdkVersion)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "$HERE/.." && pwd)"
OUT="${OUT:-$PKG/release/out}"
JOBS="${JOBS:-8}"
SKIP_NATIVE=0 SKIP_WEB=0 PACK=""
for a in "$@"; do
  case "$a" in
    --skip-native) SKIP_NATIVE=1 ;;
    --skip-web) SKIP_WEB=1 ;;
    --pack) PACK="--pack" ;;
    *) echo "unknown option $a" >&2; exit 2 ;;
  esac
done

need() { [ -n "${!1:-}" ] || { printf 'build-release: set %s (%s)\n' "$1" "$2" >&2; exit 2; }; }
need ANDROID_HOME "Android SDK with build-tools/35.0.0 and platforms/android-34"
need ANDROID_NDK_HOME "NDK r30 30.0.16248370"
need IWN_V8_DIR "prebuilt V8 15.5.35.25"
need IWN_V8_SRC "V8 15.5.35.25 source tree, for the licence files"
need IWN_THIRD_PARTY_DIR "upstream third-party source trees, one directory per project (THIRD_PARTY.md)"
IWN_SQLITE_DIR="${IWN_SQLITE_DIR:-$IWN_THIRD_PARTY_DIR/sqlite}"
export ANDROID_HOME ANDROID_NDK_HOME IWN_V8_SRC IWN_THIRD_PARTY_DIR
NPM_REGISTRY="${NPM_REGISTRY:-}"
IWN_FORBIDDEN_ROOTS="${IWN_FORBIDDEN_ROOTS:-}"
VERSION="$(node -p "require('$PKG/package.json').version")"
BUILD="$OUT/native-build"

log() { printf '\n== %s\n' "$*"; }
die() { printf 'build-release: %s\n' "$*" >&2; exit 1; }

# --- 1. toolchain --------------------------------------------------------------------------------------------
log "toolchain"
node -e 'const [maj,min]=process.versions.node.split(".").map(Number); if (maj < 22 || (maj === 22 && min < 18)) { console.error(`Node >= 22.18 needed (runs .ts directly); this is ${process.version}`); process.exit(1); }'
check_path() { # name path
  [ -e "$2" ] || die "$1 not found: $2"
  local real; real="$(readlink -f "$2")"
  local root; local IFS=:
  for root in $IWN_FORBIDDEN_ROOTS; do
    [ -n "$root" ] || continue
    case "$real/" in "$(readlink -f "$root")"/*) die "$1 resolves into $root ($real), which IWN_FORBIDDEN_ROOTS excludes" ;; esac
  done
  printf '  %-18s %s\n' "$1" "$real"
}
check_path ANDROID_HOME "$ANDROID_HOME"
check_path build-tools "$ANDROID_HOME/build-tools/35.0.0/aapt2"
check_path android.jar "$ANDROID_HOME/platforms/android-34/android.jar"
check_path ANDROID_NDK_HOME "$ANDROID_NDK_HOME/build/cmake/android.toolchain.cmake"
check_path IWN_V8_DIR "$IWN_V8_DIR/lib/arm64-v8a/libv8android.so"
check_path v8-snapshot "$IWN_V8_DIR/snapshot_blob.bin"
check_path IWN_V8_SRC "$IWN_V8_SRC/LICENSE"
for d in openxr jsoncpp oboe dr_libs libogg libvorbis freetype harfbuzz brotli stb skia; do
  check_path "third_party/$d" "$IWN_THIRD_PARTY_DIR/$d"
done
check_path IWN_SQLITE_DIR "$IWN_SQLITE_DIR/sqlite3.c"
grep -q 'Pkg.Revision = 30.0.16248370' "$ANDROID_NDK_HOME/source.properties" || die "NDK is not r30 (30.0.16248370): V8 was built against its libc++"
NDK_BIN="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin"
if [ -z "${CI:-}" ] && command -v free >/dev/null; then
  avail=$(free -g | awk '/^Mem:/{print $7}')
  [ "$avail" -ge 60 ] || die "only ${avail} GB of memory available; the build wants >= 60 GB (CI=1 skips this check)"
fi
mkdir -p "$OUT"

# Install a package's npm dependencies when node_modules is missing: npm ci from its committed package-lock.json.
# Every dependency that ends up in a shipped bundle is also pinned to an exact version in package.json (BUNDLED in
# each build.mjs; verify-third-party.mjs checks the bundled versions against THIRD_PARTY.md).
npm_deps() { # dir
  [ -f "$1/package.json" ] && [ ! -d "$1/node_modules" ] || return 0
  local flags=(--ignore-scripts --no-audit --no-fund)
  [ -z "$NPM_REGISTRY" ] || flags+=(--registry "$NPM_REGISTRY")
  if [ -f "$1/package-lock.json" ]; then
    (cd "$1" && npm ci "${flags[@]}")
  else
    (cd "$1" && npm install --no-save --no-package-lock "${flags[@]}")
  fi
}
# web/xr bundles IWER from source, which imports its generated src/version.ts (gitignored there; IWER's prebuild
# script writes it). Generate it the same way when it is missing.
IWER_DIR="$(cd "$PKG/.." && pwd)/iwer"
iwer_version() {
  [ -f "$IWER_DIR/package.json" ] || die "IWER sources not found at $IWER_DIR (web/xr bundles them)"
  [ -f "$IWER_DIR/src/version.ts" ] && return 0
  (cd "$IWER_DIR" && npm run --silent prebuild) || die "could not generate $IWER_DIR/src/version.ts"
  echo "  generated IWER src/version.ts"
}

# Build id: the commit, plus a digest of every uncommitted change in the sources this build reads (this package and
# the IWER sources web/xr bundles), so a build from a dirty tree never claims to be the commit it started from.
# Computed before any step writes into the checkout (web/*/dist, node_modules, IWER src/version.ts are generated
# and gitignored, but a stale or mis-ignored output must not turn the id dirty), and passed to cmake so the .so and
# template.json carry the same id.
source_build_id() {
  local head; head="$(git -C "$PKG" rev-parse --short=12 HEAD 2>/dev/null)" || { echo "nogit"; return; }
  local dirty
  dirty="$( { for d in "$PKG" "$IWER_DIR"; do
      git -C "$d" diff HEAD --binary -- . 2>/dev/null
      git -C "$d" ls-files -o --exclude-standard -z -- . 2>/dev/null | (cd "$d" && xargs -0 -r sha256sum)
    done; } | sha256sum | cut -c1-12)"
  if [ -n "$(git -C "$PKG" status --porcelain -- . "$IWER_DIR" 2>/dev/null)" ]; then echo "$head-dirty-$dirty"; else echo "$head"; fi
}
export IWN_BUILD_ID="${IWN_BUILD_ID:-$(source_build_id)}"
echo "  build id $IWN_BUILD_ID"

# --- 2. web preludes -----------------------------------------------------------------------------------------
if [ "$SKIP_WEB" = 0 ]; then
  log "web preludes"
  for area in glue dom net storage image canvas2d webgl audio xr workers; do
    dir="$PKG/web/$area"
    [ -f "$dir/build.mjs" ] || die "web/$area/build.mjs missing"
    npm_deps "$dir"
    if [ "$area" = xr ]; then iwer_version; fi
    (cd "$dir" && node build.mjs) >"$OUT/web-$area.log" 2>&1 || { tail -20 "$OUT/web-$area.log"; die "web/$area build failed"; }
    echo "  web/$area ok"
  done
fi

# --- 3. native runtime ---------------------------------------------------------------------------------------
if [ "$SKIP_NATIVE" = 0 ]; then
  log "native runtime (Release, arm64-v8a, -j$JOBS)"
  # Map build-machine paths out of the binaries (__FILE__ in asserts/logs, debug info): the shipped .so must not
  # carry a developer's home directory or checkout layout, and must not depend on where it was built.
  PREFIX_MAP="-ffile-prefix-map=$PKG=iwer-native -ffile-prefix-map=$(readlink -f "$PKG")=iwer-native"
  PREFIX_MAP+=" -ffile-prefix-map=$IWN_THIRD_PARTY_DIR=third_party -ffile-prefix-map=$(readlink -f "$IWN_THIRD_PARTY_DIR")=third_party"
  PREFIX_MAP+=" -ffile-prefix-map=$IWN_SQLITE_DIR=third_party/sqlite -ffile-prefix-map=$(readlink -f "$IWN_SQLITE_DIR")=third_party/sqlite"
  PREFIX_MAP+=" -ffile-prefix-map=$IWN_V8_DIR=v8 -ffile-prefix-map=$ANDROID_NDK_HOME=ndk -ffile-prefix-map=$OUT=out"
  cmake -S "$PKG/runtime" -B "$BUILD" -G Ninja \
    -DCMAKE_TOOLCHAIN_FILE="$ANDROID_NDK_HOME/build/cmake/android.toolchain.cmake" \
    -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM="${ANDROID_PLATFORM:-android-29}" -DCMAKE_BUILD_TYPE=Release \
    -DIWN_BUILD_TESTS=OFF -DIWN_RUNTIME_VERSION="$VERSION" -DIWN_BUILD_ID="$IWN_BUILD_ID" -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
    -DCMAKE_C_FLAGS="$PREFIX_MAP" -DCMAKE_CXX_FLAGS="$PREFIX_MAP" \
    -DIWN_V8_DIR="$IWN_V8_DIR" -DIWN_THIRD_PARTY_DIR="$IWN_THIRD_PARTY_DIR" -DIWN_SQLITE_DIR="$IWN_SQLITE_DIR" \
    -DIWN_TOOLCHAIN_DIR="$OUT/no-toolchain" >"$OUT/cmake.log" 2>&1 || { tail -30 "$OUT/cmake.log"; die "cmake failed"; }
  ninja -C "$BUILD" -j "$JOBS" iwernative >"$OUT/ninja.log" 2>&1 || { tail -30 "$OUT/ninja.log"; die "ninja failed"; }
fi
[ -f "$BUILD/apk-libs.txt" ] || die "$BUILD/apk-libs.txt missing (run without --skip-native)"
rm -rf "$OUT/libs" "$OUT/symbols"; mkdir -p "$OUT/libs" "$OUT/symbols"
LIB_ARGS=()
while IFS= read -r lib; do
  [ -n "$lib" ] || continue
  check_path "$(basename "$lib")" "$lib"
  cp "$lib" "$OUT/symbols/"
  "$NDK_BIN/llvm-strip" --strip-unneeded -o "$OUT/libs/$(basename "$lib")" "$lib"
  LIB_ARGS+=(--native-lib "$OUT/libs/$(basename "$lib")")
done <"$BUILD/apk-libs.txt"
for so in "$OUT"/libs/*.so; do # no build-machine paths in shipped binaries
  if "$NDK_BIN/llvm-strings" -n 6 "$so" | grep -E '/home/|/data/users/|/Users/' >"$OUT/paths-$(basename "$so").txt"; then
    head -5 "$OUT/paths-$(basename "$so").txt"; die "$(basename "$so") embeds build-machine paths (see $OUT/paths-$(basename "$so").txt)"
  fi
  rm -f "$OUT/paths-$(basename "$so").txt"
done

# --- 4. notices and third-party verification -----------------------------------------------------------------
log "notices"
node "$PKG/release/notices.mjs" --check || die "THIRD_PARTY_NOTICES.txt is stale: run npm run release:notices and commit it"


# --- 5. template APK -----------------------------------------------------------------------------------------
log "template APK"
node "$PKG/release/stage-template-assets.mjs" --out "$OUT/template-assets" --snapshot "$IWN_V8_DIR/snapshot_blob.bin"
node "$PKG/packager/template/build-template.mjs" --out "$OUT/template" "${LIB_ARGS[@]}" \
  --lib-name iwernative --assets "$OUT/template-assets" --runtime-version "$VERSION" --native-build release
APK="$OUT/template/iwer-native-template.apk"
"$ANDROID_HOME/build-tools/35.0.0/zipalign" -c -P 16 4 "$APK" || die "zipalign -c -P 16 4 failed (PKG-3)"
for so in "$OUT"/libs/*.so; do
  "$NDK_BIN/llvm-readelf" -lW "$so" | awk '$1=="LOAD" && $NF!="0x4000" && $NF!="0x10000" {bad=1} END {exit bad}' \
    || die "$(basename "$so"): LOAD segments not 16 KB aligned (PKG-3)"
done
node "$PKG/release/verify-third-party.mjs" --apk "$APK" --build "$BUILD" || die "third-party verification failed"

# --- 6. npm package ------------------------------------------------------------------------------------------
log "npm package"
npm_deps "$PKG"
(cd "$PKG" && npm run --silent build && npm test --silent >"$OUT/test.log" 2>&1) || { tail -30 "$OUT/test.log"; die "build/tests failed"; }
node "$PKG/release/support-matrix.ts" --check || die "README support matrix is stale: node release/support-matrix.ts --write"
node "$PKG/release/stage-package.mjs" --template "$APK" --out "$OUT" $PACK

node -e '
const fs = require("fs"), path = require("path");
const [out, version] = process.argv.slice(1);
const info = JSON.parse(fs.readFileSync(path.join(out, "template", "template-info.json"), "utf8"));
const dry = JSON.parse(fs.readFileSync(path.join(out, "pack-dry-run.json"), "utf8"));
fs.writeFileSync(path.join(out, "build-info.json"), JSON.stringify({ version, template: info, tarballBytes: dry.size, unpackedBytes: dry.unpackedSize, integrity: dry.integrity, shasum: dry.shasum }, null, 2) + "\n");
' "$OUT" "$VERSION"
log "done: $OUT (template sha256 $(node -p "require('$OUT/template/template-info.json').sha256"))"
