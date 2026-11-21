#!/usr/bin/env bash
# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.
#
# Runs the image module's tests on a headset: the core unit tests (with AImageDecoder as the first backend) and the
# V8 binding smoke test. Nothing is installed; files go to /data/local/tmp/iwn-image and are removed afterwards.
#
#   tools/device-test.sh <serial> <android build dir>
#
# The build dir is a CMake build of runtime/image for arm64-v8a with -DIWN_IMAGE_BUILD_TESTS=ON (see README.md).
# adb calls run `adb -s <serial>`; IWN_ADB replaces that command (split on spaces), e.g. for an adb server on another
# machine: IWN_ADB="adb -H <host> -P 5037 -s <serial>".
set -euo pipefail
SERIAL=${1:?serial}
BUILD=${2:?android build dir}
V8_DIR=${IWN_V8_DIR:?set IWN_V8_DIR (prebuilt V8 15.5)}
# NDK r30 (30.0.16248370) from dl.google.com (android-ndk-r30-linux.zip, sha1
# 5107f898313790e449e87eee2183d9a20602dee9), the revision V8 was built with.
NDK=${IWN_NDK:-${ANDROID_NDK_HOME:?set IWN_NDK or ANDROID_NDK_HOME (NDK r30)}}
# Test images from the upstream trees under IWN_THIRD_PARTY_DIR (THIRD_PARTY.md), or one by one below.
TP=${IWN_THIRD_PARTY_DIR:?set IWN_THIRD_PARTY_DIR (upstream third-party trees: test images)}
LIBJPEG_TESTIMAGES=${IWN_LIBJPEG_TESTIMAGES:-$TP/libjpeg-turbo/libjpeg-turbo/testimages}
LIBWEBP_EXAMPLES=${IWN_LIBWEBP_EXAMPLES:-$TP/libwebp/examples}
AVIF=${IWN_AVIF_SAMPLE:-$TP/libavif/tests/data/abc_color_irot_alpha_NOirot.avif}
AVIF2=${IWN_AVIF_SAMPLE2:-$TP/libavif/tests/data/io/kodim03_yuv420_8bpc.avif}
AVIF3=${IWN_AVIF_SAMPLE3:-$TP/libavif/tests/data/colors_sdr_srgb.avif}
HEIC=${IWN_HEIC_SAMPLE:-$TP/libheif/tests/data/rainbow-451x461.heic}
HERE=$(cd "$(dirname "$0")/.." && pwd)
DEV=/data/local/tmp/iwn-image
read -r -a ADB <<<"${IWN_ADB:-adb -s $SERIAL}"

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
cp "$BUILD/iwn_image_tests" "$BUILD/iwn_image_v8_smoke" "$BUILD/iwn_image_bench" "$STAGE/"
cp "$V8_DIR/lib/arm64-v8a/libv8android.so" "$V8_DIR/snapshot_blob.bin" "$STAGE/"
cp "$NDK/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so" "$STAGE/"
cp "$HERE/tests/v8_smoke.js" "$HERE/tests/web_e2e.js" "$STAGE/"
WEB=$(cd "$HERE/../../web" && pwd)
E2E=0
# Bundles for the end-to-end run, built now from the current sources (web/glue's dist is left alone).
if node "$HERE/tools/bundle-glue.mjs" "$STAGE/glue.js" && node "$WEB/image/build.mjs" >/dev/null; then
  cp "$WEB/image/dist/image.js" "$STAGE/"
  E2E=1
fi
cp "$LIBJPEG_TESTIMAGES/testorig.jpg" "$LIBJPEG_TESTIMAGES/testimgint.jpg" "$STAGE/"
cp "$LIBWEBP_EXAMPLES/test.webp" "$LIBWEBP_EXAMPLES/test_ref.ppm" "$STAGE/"
[[ -f "$AVIF" ]] && cp "$AVIF" "$STAGE/sample.avif"
[[ -f "$AVIF2" ]] && cp "$AVIF2" "$STAGE/sample2.avif"
[[ -f "$AVIF3" ]] && cp "$AVIF3" "$STAGE/sample3.avif"
[[ -f "$HEIC" ]] && cp "$HEIC" "$STAGE/sample.heic"

"${ADB[@]}" shell "rm -rf $DEV && mkdir -p $DEV"
for f in "$STAGE"/*; do "${ADB[@]}" push "$f" "$DEV/" >/dev/null; done
"${ADB[@]}" shell "chmod 755 $DEV/iwn_image_tests $DEV/iwn_image_v8_smoke $DEV/iwn_image_bench"
"${ADB[@]}" shell getprop ro.build.fingerprint
status=0
echo "== core tests on device"
"${ADB[@]}" shell "cd $DEV && LD_LIBRARY_PATH=$DEV IWN_IMAGE_TEST_DATA=$DEV ./iwn_image_tests" || status=1
echo "== V8 binding smoke"
"${ADB[@]}" shell "cd $DEV && LD_LIBRARY_PATH=$DEV ./iwn_image_v8_smoke $DEV/snapshot_blob.bin $DEV/v8_smoke.js $DEV" || status=1
if [[ $E2E == 1 ]]; then
  echo "== web/image end to end (web/glue + web/image bundles over the native module)"
  "${ADB[@]}" shell "cd $DEV && LD_LIBRARY_PATH=$DEV ./iwn_image_v8_smoke $DEV/snapshot_blob.bin $DEV/glue.js,$DEV/image.js,$DEV/web_e2e.js" || status=1
else
  echo "== web/image end to end skipped: build web/glue (node build.mjs) and web/image (node build.mjs) first"
fi
echo "== decode cost (pool thread)"
"${ADB[@]}" shell "cd $DEV && LD_LIBRARY_PATH=$DEV ./iwn_image_bench 2048 5" || true
"${ADB[@]}" logcat -d -s iwn-image | tail -5 || true
"${ADB[@]}" shell "rm -rf $DEV"
exit $status
