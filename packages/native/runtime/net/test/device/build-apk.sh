#!/usr/bin/env bash
# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.
#
# Builds the net + storage device test APK (test only):
#   OUT=/tmp/iwn-devtest ./build-apk.sh   →  $OUT/iwn-devtest.apk
# Needs the web preludes built: web/glue/dist/glue.min.js, web/net/dist/net.min.js,
# web/storage/dist/{storage,idb}.min.js (npm run build in each).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "$HERE/../../../.." && pwd)"   # packages/native
OUT="${OUT:-/tmp/iwn-devtest}"
TC="${IWN_TOOLCHAIN_DIR:?set IWN_TOOLCHAIN_DIR (android/ SDK + NDK r30, v8-15.5/)}"
NDK="$TC/android/ndk/30.0.16248370"
BT="$TC/android/build-tools/34.0.0"
JAR="$TC/android/platforms/android-34/android.jar"
V8="$TC/v8-15.5"

mkdir -p "$OUT"
cmake -S "$HERE" -B "$OUT/build" -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$NDK/build/cmake/android.toolchain.cmake" \
  -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-29 -DANDROID_STL=c++_shared \
  -DCMAKE_BUILD_TYPE=Release -DIWN_V8_DIR="$V8" >"$OUT/cmake.log"
ninja -C "$OUT/build" -j 8 iwn_devtest >"$OUT/ninja.log"

STAGE="$OUT/stage"
rm -rf "$STAGE" && mkdir -p "$STAGE/lib/arm64-v8a" "$STAGE/assets/app/_app" "$STAGE/assets/app/.well-known" \
  "$STAGE/assets/app/assets" "$STAGE/assets/devtest"
cp "$OUT/build/libiwn_devtest.so" "$STAGE/lib/arm64-v8a/"
cp "$V8/lib/arm64-v8a/libv8android.so" "$STAGE/lib/arm64-v8a/"
cp "$NDK/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so" "$STAGE/lib/arm64-v8a/"
"$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip" --strip-unneeded "$STAGE/lib/arm64-v8a/libiwn_devtest.so"

# Fixture dist (NET-1): _-prefixed and .-prefixed folders, a non-ASCII name, a 32 MB binary.
printf 'export const x = 1;\n' >"$STAGE/assets/app/_app/x.js"
printf '{"y":2}' >"$STAGE/assets/app/.well-known/y.json"
printf 'umlaut' >"$STAGE/assets/app/ü.txt"
head -c $((32 * 1024 * 1024)) /dev/urandom >"$STAGE/assets/app/assets/big.glb"
sha256sum "$STAGE/assets/app/assets/big.glb" | cut -d' ' -f1 >"$OUT/big.sha256"

cp "$V8/snapshot_blob.bin" "$STAGE/assets/devtest/"
cp "$PKG/web/glue/dist/glue.min.js" "$PKG/web/net/dist/net.min.js" "$PKG/web/storage/dist/storage.min.js" \
  "$PKG/web/storage/dist/idb.min.js" "$HERE/test.js" "$HERE/reload.js" "$STAGE/assets/devtest/"

# Manifest + resources table only; assets and libs are added with zip so aapt2's default ignore
# patterns (".*", "_*" folders: REG-3) do not drop fixture files, and big binaries stay stored.
"$BT/aapt2" link -o "$OUT/base.apk" --manifest "$HERE/AndroidManifest.xml" -I "$JAR" \
  --min-sdk-version 29 --target-sdk-version 34
cp "$OUT/base.apk" "$OUT/unaligned.apk"
(cd "$STAGE" && zip -q -r -0 "$OUT/unaligned.apk" lib assets/app/assets assets/devtest/snapshot_blob.bin \
  && zip -q -r -9 "$OUT/unaligned.apk" assets -x 'assets/app/assets/*' -x 'assets/devtest/snapshot_blob.bin')
"$BT/zipalign" -f -p 4 "$OUT/unaligned.apk" "$OUT/aligned.apk"

KS="$OUT/debug.keystore"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -storepass android -keypass android -alias devtest -keyalg RSA \
    -keysize 2048 -validity 3650 -dname "CN=iwn devtest" >/dev/null 2>&1
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android --ks-key-alias devtest \
  --out "$OUT/iwn-devtest.apk" "$OUT/aligned.apk"
ls -la "$OUT/iwn-devtest.apk"
