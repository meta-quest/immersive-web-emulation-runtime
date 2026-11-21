# canvas2d device suite (C2D-9..12, IMG-7 on a headset)

A test app for the runtime APK. It renders every golden case (`../../test/golden/cases.mjs`) on the device and writes
them to logcat as PNG chunks (`C2DIMG <case> <i> <n> <base64>`), plus measureText rows, bundled-font and fallback
checks, texImage2D from a 2D canvas into WebGL, the 512x128 label benchmark and the IMG-7 loop (500 dropped 1024²
canvases). `compare.mts` rebuilds the PNGs on the host and compares them with the Chrome goldens (same rule and
per-case limits as `golden.test.ts`) and with the host rendering.

Dist: `index.html`, `main.js`, a copy of `cases.mjs`, and `fonts/Roboto-Regular.ttf`, `fonts/Roboto-Bold.ttf` (from
`runtime/canvas2d/fonts`, loaded with `FontFace(url())` as the "IwnTest"/"IwnRegular" families). Preludes: glue, net,
image, webgl, canvas2d. The APK also needs the files in `runtime/canvas2d/apk-assets.json` (bundled fonts under
`assets/iwn/fonts/`, notices); the 2026-10-20 run added them with a scratch copy of `runtime/app/template/build-apk.mjs`
(`--apk-assets`), until the packer copies that list.

```bash
adb logcat -c; adb logcat -v brief > run.log &   # adb -s <serial> when more than one device is attached
adb shell am start -n <package>/android.app.NativeActivity
IWN_CANVAS2D_ADDON=<build>/canvas2d.node node web/canvas2d/tools/device-suite/compare.mts run.log
```
