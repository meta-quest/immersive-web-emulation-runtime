# @iwer/native (alpha)

> **Alpha: 0.1.0-alpha.0.** Not every web API is supported yet. @iwer/native runs your WebXR app without a browser,
> so the app only gets the web APIs this runtime implements. Check the [support matrix](#support-matrix) and run
> `npx -p @iwer/native@alpha iwer-native compat` on your build before you rely on it. Nothing falls back to a
> browser: an API the runtime lacks is absent, throws a `NotSupportedError` that names the API, or (for a few
> event-driven APIs, which the matrix notes name) is accepted but inert, for example listeners that never fire.
> Commands, config keys and the APK layout may change between alpha releases. Please [report what breaks](#reporting-issues).

@iwer/native turns an unmodified WebXR bundle (IWSDK, three.js) into a native Android app for Meta Quest and other
Android OpenXR headsets. The package contains a prebuilt runtime (V8, WebGL 2 over OpenGL ES, OpenXR with
[IWER](https://github.com/meta-quest/immersive-web-emulation-runtime) host mode, Canvas 2D, Web Audio, workers,
fetch), a packer that writes and signs the APK in plain Node, a compat checker and the `iwer-native` CLI. You do not
need the Android SDK, NDK, Gradle or a JDK.

## Requirements

- Node.js 20.19+, 22.12+ or 24+.
- A Vite build of your app (`dist/` with an `index.html` that loads a module script).
- To install and run the APK: a Quest in developer mode, connected over USB, and `adb` (Android platform-tools)
  found through `$ADB`, `$ANDROID_HOME/platform-tools` or `PATH`. Run `npx iwer-native doctor` to check your setup.
- For the IWSDK path below: `@iwsdk/core` and `@iwsdk/vite-plugin-dev` **1.2.0 or later** (and `@iwsdk/create`
  1.2.0+ for `--metavr-native`). IWSDK 1.1.0 and earlier reject the `native` key in `iwsdk.config.json`. Until IWSDK
  1.2.0 is published, only apps without IWSDK can be packed (the [plain Vite path](#without-iwsdk)).
- Developed for Quest 3 and Quest 3S (Horizon OS). The runtime is arm64-v8a only.

The `iwer-native` command is the package's bin. In a project that has the package installed, `npx iwer-native ...`
runs it. Without a local install, use `npx -p @iwer/native@alpha iwer-native ...`: a bare `npx iwer-native` would
look up a different, unscoped package name on npm.

## Quick start (IWSDK project)

1. Add the package:

   ```bash
   npm install --save-dev @iwer/native@alpha
   ```

   New projects can opt in when you create them: with `@iwsdk/create` 1.2.0 or later,
   `npm create @iwsdk@latest my-app -- --metavr-native` adds steps 2 and 3 for you (VR starting point only).

2. Add a `native` section to `iwsdk.config.json`. Only `packageId` is required; every key is listed under
   [Configuration](#configuration-the-native-section-of-iwsdkconfigjson).

   ```json
   "native": {
     "packageId": "com.yourcompany.myapp",
     "appName": "My App",
     "network": { "allow": ["https://cdn.jsdelivr.net"] }
   }
   ```

   The runtime refuses requests to origins outside `network.allow`. The IWSDK starter loads its controller models
   from `https://cdn.jsdelivr.net` (the WebXR input profiles), so keep that entry unless you ship the models
   yourself, and add every other origin your app fetches from. `pack` warns about origins the bundle uses that are
   not listed.

   Add it as a top-level key next to `version`, `scene`, `world` and `dev`. The file is plain JSON: no comments, no
   trailing commas.

   The app has to offer its XR session: the headset has no 2D page where someone could press an "Enter XR"
   button. IWSDK's default (`world.xr.offer` `"always"`) does, so there is nothing to add; do not set it to
   `"none"`.

3. Add the build script to `package.json`:

   ```json
   "scripts": {
     "build:metavr": "vite build --mode metavr && iwer-native pack"
   }
   ```

   The `metavr` mode tells `@iwsdk/vite-plugin-dev` to leave the IWER emulator out of this build. Your
   `dev.emulator.injectOnBuild` setting still applies to normal browser builds. Vite also picks its env files by
   mode: this build loads `.env`, `.env.local`, `.env.metavr` and `.env.metavr.local`, **not** `.env.production`. If your app
   reads values from `.env.production`, copy them to `.env.metavr`. `import.meta.env.PROD` is still `true`.

4. Build the APK:

   ```bash
   npm run build:metavr        # writes dist-metavr/<appName>.apk (debug build, signed with your machine's debug key)
   ```

   In the file name, each run of characters other than letters, digits, `.`, `_` and `-` becomes one `-`
   (`"appName": "IWSDK Showcase"` packs to `dist-metavr/IWSDK-Showcase.apk`); `pack` prints the path.

   `pack` runs the static part of the compat checker first. It fails on an injected WebXR emulator and warns about
   unsupported APIs the bundle calls (`pack --strict` turns those warnings into errors). `npx iwer-native compat
   --trace` also runs the app headlessly and reports what it actually called.

5. Install and run it on the headset:

   ```bash
   npx iwer-native install     # adb install -r dist-metavr/<appName>.apk
   npx iwer-native run         # launches the app; it enters XR
   # or both at once: npx iwer-native pack --install --run
   ```

6. For a release build, add a `signing` section and set the two password environment variables. Then run
   `npx iwer-native pack --release`. See [Signing](#signing).

### Without IWSDK

Other Vite + three.js apps work the same way. Add an `iwsdk.config.json` that contains only the `native` section
(`{ "native": { "packageId": "com.yourcompany.myapp" } }`), make sure nothing injects a WebXR emulator into the
production build, then run `vite build && npx iwer-native pack`.

## Support matrix

<!-- support-matrix:begin -->
Generated by `node release/support-matrix.ts --write` from the compat checker's API inventory (surface snapshot 2026-10-26, `compat/data/surface-snapshot.json`) and the alpha scope. **supported**: implemented in 0.1.0-alpha and present in the measured API surface (the surface is measured headlessly; each release's device sweep covers the supported rows). **implemented, not yet device-tested**: in 0.1.0-alpha and in the measured surface, tested on the host, but not yet exercised on a headset. **not yet**: planned after the alpha (absent or throws `NotSupportedError` today). **out of scope**: absent by design; feature detection sees `undefined`. `npx iwer-native compat` lists what your own app uses.

| area | API | status | notes |
|---|---|---|---|
| Engine | ECMAScript 2024+, WebAssembly (SIMD, threads) | supported | V8 15.5 with JIT |
| Engine | Intl (incl. Intl.Segmenter) | supported |  |
| Engine | Timers, microtasks, requestAnimationFrame, structuredClone, reportError | supported |  |
| Engine | console, performance.now() | supported |  |
| WebXR | navigator.xr, immersive-vr sessions, reference spaces, XRWebGLLayer | supported | IWER host mode over OpenXR |
| WebXR | Controllers (XRInputSource, gamepad buttons and axes, haptics) | supported | tested on Quest 3 and Quest 3S with simulated Touch Plus controllers, side by side with Quest Browser 156: same profiles, buttons, axes, press thresholds and events. Differences from Quest Browser: the left menu button is buttons[7] (Quest Browser: buttons[12], after extra buttons 7-11 this runtime does not expose), and the grip pose is tilted about 15° from Quest Browser's |
| WebXR | Hand tracking (XRHand, hand-tracking feature) | supported | tested on Quest 3 and Quest 3S with simulated hands (25 joints, pinch select, switching to controllers and back) and with real hands (microgestures on hand buttons 5-9, as in Quest Browser); the system menu gesture is not yet device-tested |
| WebXR | Projection layers (XRWebGLBinding.createProjectionLayer) | supported |  |
| WebXR | Quad / cylinder layers (createQuadLayer, createCylinderLayer, getSubImage) | supported | mono and stereo layouts, texture and texture-array; the redraw event never fires (the runtime keeps layer content) |
| WebXR | Equirect / cube layers, XRMediaBinding | not yet |  |
| WebXR | immersive-ar (passthrough) | supported | for apps that declare passthrough (IWSDK's world.xr.mode "ar" does); environmentBlendMode alpha-blend |
| WebXR | Plane / mesh detection, hit test, anchors, depth | not yet |  |
| WebXR | Eye / gaze tracking | not yet |  |
| Graphics | WebGL 2 and WebGL 1 (over OpenGL ES 3.2) | supported |  |
| Graphics | WebGL extensions incl. OVR_multiview2, EXT_color_buffer_float, compressed textures | supported |  |
| Graphics | Canvas 2D incl. text (fillText, measureText), Path2D, OffscreenCanvas, FontFace | supported |  |
| Graphics | Images: Image / HTMLImageElement, createImageBitmap, ImageData (PNG, JPEG, WebP, GIF) | supported |  |
| Graphics | WebGPU | out of scope |  |
| Graphics | WebCodecs (VideoFrame, VideoDecoder, ...) | out of scope |  |
| Network and storage | fetch, Request / Response / Headers, XMLHttpRequest (APK assets + allowlisted HTTPS) | supported | cross-origin hosts need native.network.allow |
| Network and storage | Streams (ReadableStream, ...) | supported |  |
| Network and storage | localStorage, sessionStorage | supported |  |
| Network and storage | URL, TextEncoder/Decoder, Blob, File, FileReader, AbortController, atob/btoa, crypto.getRandomValues | supported |  |
| Network and storage | WebSocket | not yet | out of the alpha scope (absent: typeof WebSocket === "undefined") |
| Network and storage | IndexedDB | not yet | out of the alpha scope (absent) |
| Network and storage | Cache API (caches) | not yet | out of the alpha scope (absent) |
| Network and storage | crypto.subtle | out of scope | absent by default; a digest-only SubtleCrypto is opt-in |
| Network and storage | Service workers, EventSource, WebTransport | out of scope |  |
| Workers | Worker (module and classic), MessageChannel, SharedArrayBuffer + Atomics (WASM threads) | supported | KTX2, Draco, physics workers |
| Workers | SharedWorker | out of scope |  |
| Audio | AudioContext lifecycle, AudioBufferSourceNode, GainNode, PannerNode + AudioListener, decodeAudioData (MP3, Ogg Vorbis, WAV, AAC) | supported |  |
| Audio | Other Web Audio nodes (Oscillator, BiquadFilter, Convolver, Analyser, DynamicsCompressor, StereoPanner, Delay, WaveShaper, OfflineAudioContext) | not yet | beyond the basic Web Audio set the alpha validates |
| Audio | AudioWorklet, ScriptProcessorNode | out of scope |  |
| DOM and page | document / element stand-ins (createElement canvas/img/script, querySelector, style accepted), events, location, history, matchMedia | supported | no layout or CSS rendering |
| DOM and page | Gamepad API (navigator.getGamepads) | supported | XR controllers come through XRInputSource.gamepad, not navigator.getGamepads() |
| DOM and page | DOM layout, CSS rendering, HTML UI / 2D panel, pointer and keyboard events | out of scope | listeners are accepted and never fire |
| DOM and page | `<video>` / `<audio>` playback, MediaSource | not yet | video is out of the alpha scope (play() rejects with NotSupportedError) |
| DOM and page | System keyboard / text input | not yet | out of the alpha scope |
| DOM and page | window.open, external links, OAuth redirects | not yet | out of the alpha scope |
| DOM and page | WebRTC | not yet | out of the alpha scope (absent) |
| DOM and page | Camera / microphone (getUserMedia), clipboard, notifications, geolocation, Web Bluetooth/USB/HID/Serial, speech | out of scope |  |
<!-- support-matrix:end -->

## Known limitations

- **No browser page.** There is no DOM layout, no CSS rendering, no 2D panel and no HTML UI. Build your UI in 3D
  (for example IWSDK's spatial UI). The `document` and element stand-ins let your app create its canvas, find the
  elements of its `index.html` and use the common DOM APIs (events, `querySelector`, `style`, observers), but nothing
  is laid out or drawn: element sizes are the canvas's (1280x720 by default) or zero, and pointer and keyboard events
  never fire.
- **XR only.** The app must offer an immersive-vr session. An app that never offers one shows black and logs an error
  after 10 s. A release build then returns to home after 30 s; a debug build that serves the debug endpoint or
  inspector (the default `pack`) keeps running so you can attach and investigate.
- **Not in the alpha:** WebSocket, IndexedDB, the Cache API, `<video>`/`<audio>` playback, the system keyboard and
  text input, `window.open`/external links/OAuth redirects, WebRTC, and Web Audio beyond the basic set
  (AudioContext, AudioBufferSourceNode, GainNode, PannerNode + AudioListener, decodeAudioData).
- **Not yet in WebXR:** plane/mesh detection, hit test, anchors, depth sensing, eye/gaze tracking, and
  equirect/cube layers (quad and cylinder layers are supported). immersive-ar (passthrough) needs the `passthrough`
  feature, which IWSDK's AR mode declares.
- **Never planned:** WebGPU, WebCodecs, camera/microphone, service workers, clipboard, notifications, geolocation.
- **Network:** the app's own files load from the APK. Cross-origin HTTPS requests work only for origins listed in
  `native.network.allow`. Only HTTP/1.1 is supported, with no HTTP cache. `navigator.onLine` is always `true`.
- **Size:** each APK carries the runtime (V8 included): it adds about 47 MB (44.6 MiB, the `runtime` figure `pack`
  prints) to the APK file on top of your assets, because the native libraries are stored uncompressed so they load
  in place. Compressed for download the runtime is about 18 MB (17.2 MiB). The npm package bundles the template
  APK, so `npm install` downloads about 18 MB (17.4 MiB).
- **Devices:** the runtime is arm64-v8a only. It is tested on Quest 3 and Quest 3S. Other Horizon OS and Android
  OpenXR headsets have not been tried.
- **Controllers:** tested on Quest 3 and Quest 3S with Meta's simulated Touch Plus controllers, side by side with
  Quest Browser 156. Profiles, buttons 0-6, the thumbstick axes, the trigger and squeeze press points, the
  select/squeeze events, the target-ray pose, and controllers being added and removed all behaved as in Quest
  Browser. Two differences remain:
  - the left menu button is `buttons[7]`, while Quest Browser reports it as `buttons[12]`, after extra buttons 7-11
    that this runtime does not expose;
  - the grip pose (`gripSpace`) is tilted about 15° from Quest Browser's, so controller models and held objects sit
    at a slightly different angle.

  Nobody has yet worn a headset with real controllers to judge tracking feel and vibration.
- **Hands:** hand tracking (`XRHand`, 25 joints, pinch `select`) and switching between hands and controllers are
  tested on Quest 3 and Quest 3S with Horizon OS's simulated hands, and microgestures (thumb swipes and tap, hand
  gamepad buttons 5-9, as in Quest Browser) with real hands. The system menu gesture (button 4) has not been tried
  on a headset yet. A gesture lasts about 35 ms, so a JS frame that stalls longer than that can miss one. In a
  session without `hand-tracking`, a tracked hand is reported as a controller that points and selects, so an IWSDK
  app draws a controller model for it; Quest Browser reports a hand profile there.
- **Performance:** in our tests on Quest 3 and Quest 3S an IWSDK app held the display rate at the same CPU level as
  in Quest Browser and entered XR sooner. With fixed foveation on (`fixedFoveation = 1`, the three.js default) its
  GPU time per frame was 1-8 % higher than in Quest Browser, because the runtime's foveation saves less GPU time;
  without foveation the two cost the same.
- Shaders compile on first launch, so the first frame can take longer than in Quest Browser, which keeps a shader
  cache warm. Until it comes, the app's splash and a spinner show ([launch splash](#launch-splash-and-loading-screen)).
- The splash's generated image draws the app name with the bundled Roboto font only. A name with characters
  Roboto lacks (for example CJK) is left out, and `pack` warns; set `splash.image` to your own artwork.

## Troubleshooting

| symptom | what to do |
|---|---|
| `Invalid IWSDK project manifest` … `unknown property "native"` from IWSDK | IWSDK 1.1.0 and earlier do not accept the `native` key. Update `@iwsdk/core` and `@iwsdk/vite-plugin-dev` to 1.2.0 or later. |
| `pack` fails with `[fail] injected WebXR emulator: a WebXR emulator is bundled into the build` | You built with plain `vite build` while `dev.emulator.injectOnBuild` is on. Use `npm run build:metavr` (`vite build --mode metavr`), or turn `injectOnBuild` off. |
| `pack`/`compat` reports an unsupported API | That API is missing from the runtime and your app calls it. Feature-detect it and take another path, or drop it. `npx iwer-native compat --verbose` shows where the app calls it. |
| `the template bundled with @iwer/native … does not match its checksum` | The installed package is damaged. Reinstall it (`rm -rf node_modules/@iwer/native && npm install`). |
| `the template bundled with @iwer/native is missing` | The package was installed without its `prebuilt/` folder. Reinstall it, or pass `--template <apk>`. `npx iwer-native doctor` checks the template. |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | The installed app was signed with a different key (for example a debug build over a release build). Uninstall it first: `adb uninstall <packageId>`. |
| `adb` not found, or no headset listed | Run `npx iwer-native doctor`. Set `$ADB` or `$ANDROID_HOME`. Put the headset in developer mode and accept the USB debugging prompt inside the headset. |
| App never enters XR (its splash and spinner stay up) | Check that `world.xr.offer` is `"always"` (IWSDK's default) or `"once"`, not `"none"`. Read the logs: `adb logcat -v tag \| grep '/iwn'` (every runtime tag starts with `iwn`, e.g. `iwn-gl` for EGL failures). |
| `fetch` to another host fails | Add the origin (`https://host[:port]`, no path) to `native.network.allow`. |
| You need a debugger | Run `npx iwer-native run --inspect --forward 9229`, then open `chrome://inspect` in Chrome and add `localhost:9229`. Debug builds only (or `pack --release --inspector`). On the headset the inspector is a socket only adb and the app can open; `--forward` sets up `adb forward tcp:9229 localabstract:<packageId>_devtools_9229`. |
| The inspector does not answer (`@<packageId>_devtools_9229 is still in use` in the log) | Another debug build is still running in the background and holds the port. Stop it (`adb shell am force-stop <its packageId>`), then run your app again. |

## Reporting issues

File issues at <https://github.com/meta-quest/immersive-web-emulation-runtime/issues> with "[native]" in the title.
Please include:

- `npx iwer-native --version` and `npx iwer-native doctor --json`;
- the headset model and OS build (`adb shell getprop ro.build.fingerprint`);
- `npx iwer-native compat --json` for your build;
- the log of a failing run: `adb logcat -d -v threadtime > iwn.log` (the whole log: runtime tags all start with `iwn`);
- a minimal project or steps that reproduce it.

Never attach keystores, passwords or `.env` files.

## Configuration: the `native` section of `iwsdk.config.json`

Every key, annotated. `iwsdk.config.json` itself is plain JSON, so drop the comments and trailing commas when you
copy from this block.

```jsonc
{
  "version": "iwsdk.project.v1",
  // … scene, world, dev …
  "native": {
    "packageId": "com.yourcompany.showcase", // required; Android application id
    "appName": "Proto Showcase VR", // default: package.json name (scope stripped)
    "version": "1.2.3", // default: package.json version, else 1.0.0
    "versionCode": 1002003, // default: major*1000000 + minor*1000 + patch
    "icon": "./public/icon.png", // project-relative .png/.webp
    "splash": { "image": "./public/splash.png", "background": "black" },
    // default: on, generated from icon + appName, on "black" ("contextual" for apps that declare passthrough);
    // background "black", "contextual" or "#rrggbb"; false: no image or spinner (the background stays)
    "frameRate": 90, // 60 | 72 | 80 | 90 | 120; default: runtime default
    "foveation": { "level": "medium", "dynamic": true }, // or "none" | "low" | "medium" | "high"; default none
    "features": { "handTracking": "required", "planeDetection": true },
    // default: derived from world.xr.features (+ passthrough for AR)
    "permissions": ["android.permission.RECORD_AUDIO"],
    "network": {
      "allow": ["https://cdn.jsdelivr.net", "https://*.example.org"],
    },
    // default: APK assets only; INTERNET is added when non-empty
    "signing": {
      // omit for a debug key (sideloading only)
      "keystore": "../keys/release.jks",
      "keyAlias": "upload",
      "storePasswordEnv": "IWER_NATIVE_STORE_PASSWORD",
      "keyPasswordEnv": "IWER_NATIVE_KEY_PASSWORD",
    },
  },
}
```

Features accept `true`/`"optional"`, `"required"`, `{ "required": bool }` or `false`, and map to manifest entries:
`handTracking` → `com.oculus.permission.HAND_TRACKING` + `oculus.software.handtracking`; `planeDetection`,
`meshDetection`, `hitTest`, `depthSensing` → `com.oculus.permission.USE_SCENE`; `anchors` →
`com.oculus.permission.USE_ANCHOR_API`; `passthrough` → `com.oculus.feature.PASSTHROUGH`; `gazeTracking` →
`com.oculus.permission.EYE_TRACKING` + `oculus.software.eye_tracking`; `camera` → `android.permission.CAMERA` +
`horizonos.permission.HEADSET_CAMERA` + `com.oculus.feature.PASSTHROUGH`. A `<uses-feature>` is `required` if any
feature that needs it is. Passthrough turns `immersive-ar` on (the packer writes `xr.immersiveAr`). USE_SCENE,
CAMERA and HEADSET_CAMERA are runtime permissions: the app asks for them with the system dialog when a session (or
`getUserMedia`) first needs them, once per app process, and a denied feature is dropped (optional) or rejects the
session (required). A permission the manifest lacks (a feature left out of an explicit `native.features` while the
app still requests it) is never asked for: the feature is dropped or the session rejects, naming the manifest.
(In the alpha the scene, anchor, gaze and camera features are declared but the runtime does not expose them to
WebXR yet; see Known limitations.) Without a `features` key the set is derived from `world.xr.features` (plus
`camera` from IWSDK's `world.features.camera`, or, for a bundle that is not IWSDK, from a `getUserMedia` call in
the dist), so it can include features the alpha does not support yet: an IWSDK app that asks for
gaze tracking (`world.xr.features.gazeTracking`) gets `gazeTracking`, with the eye-tracking permission and a
`pack` warning. Set `native.features` explicitly to leave such features out.

### Launch splash and loading screen

An app takes a few seconds from launch to its first XR frame (V8 starts, the bundle loads, shaders compile). So
that nobody thinks it failed to start, every APK shows its own splash and a spinner while it starts:

1. Horizon OS shows the image as the **system splash** during its launch transition (`pack` writes it to
   `assets/vr_splash.png` and declares `com.oculus.ossplash` in the manifest, as Meta's "Add a Splash Screen"
   documentation describes). Horizon OS draws it on the horizon ahead, so it is only in view with the head roughly
   level, and it fades in about 0.8 s after launch. Before that, Horizon OS shows its own transition for a moment.
2. From the runtime's first frame, about 1 s after launch (0.9-1.3 s in our tests), the runtime shows the **same
   image** with an animated spinner below it. With the head within 30° of level it sits exactly where the system
   splash was (same place and size), so one turns into the other; with the head pitched further (lying down,
   looking at the floor) it appears straight ahead of the eyes instead. It stays put while you look around and
   glides back in front when you look more than 35° away.
3. When the app renders its first XR frame, the splash fades out over the app's scene (about 0.25 s). It comes
   back while a reload boots the page again, and between WebXR sessions (when the page enters its next session at
   once, the scene comes back without fading in again).

Behind the image, `splash.background`:

- `"black"` (default): black behind both, whatever environment the user launched the app from. The loading screen
  covers the whole view with an opaque layer, so nothing the system may show behind an app (passthrough, for
  example) comes through.
- `"contextual"` (the default for apps that declare passthrough: `features.passthrough`, which `world.xr.mode: "ar"`
  implies; refused without it): the user's room for a user whose home is passthrough, black for everyone else, as
  Meta's "Passthrough Loading Screen" documentation describes for mixed reality apps. `pack` declares
  `com.oculus.ossplash.background` = `passthrough-contextual` for the system splash, and the runtime shows the room
  behind its loading screen with a passthrough layer of its own (`XR_FB_passthrough`, which needs the passthrough
  declaration) when the system recommends passthrough (`XR_META_passthrough_preferences`: the user's home is
  passthrough). After a reload or the end of a session it continues what the session showed: black after an
  immersive-vr session. The system splash follows Horizon OS's own decision and the loading screen the system's
  recommendation; in rare cases the two differ (the system splash on the room, then the loading screen on black,
  or the other way round).
- `"#rrggbb"` (or `#rgb`): that colour behind the loading screen; the system splash, which knows only black or
  contextual passthrough, is on black.

The default image is generated at pack time: the app's icon (the launcher icon, or the default one) above
`appName`, white, on transparency, 1024x512. Bring your own with `splash.image`: a PNG, at most 1500x1500 px
(Meta's recommendation), designed to be drawn on black (and on the room, with `"contextual"`). Horizon OS and the
runtime fit it to 20° tall at 6 m (up to 80° wide). `"splash": false` turns off the system splash image and the card
and spinner; until the first XR frame the view shows the background alone.

The validator reports **every** problem with a JSON path, and the errors say what to do: did-you-mean for
misspelled keys and enum values, the underscore form for a package id with `-`, the `android.permission.` prefix
for a bare permission, the origin to use when an allowlist entry has a path. It also checks:

- package id: two or more segments, each starting with a letter, no Java keywords (aapt2 rejects them); warns
  on `com.example.*`;
- versionCode: an integer in 1 … 2,100,000,000;
- splash: `"background": "contextual"` needs passthrough declared (`features.passthrough`, or an AR world);
- network allowlist: origins only (`https://host[:port]`, `*.` only as the whole first label); no catch-all,
  no credentials, no cleartext except `http://localhost` (warning);
- **secrets**: any key that looks like a password/secret/token/PIN (`storePassword`, `keyPass`, …) is an
  error, and so is a `*PasswordEnv` value that is not a valid variable name (someone pasted the password).
  These messages never echo the value. A keystore under `public/`, `dist/` or `dist-metavr/` is an error
  (it would ship inside the app).

`iwer-native validate` and `doctor` also check that `icon`, `splash.image` and `keystore` exist. A missing
`keystore` (and, in `doctor`, unset password variables) is a warning: only `pack --release` needs them.

### Signing

Debug builds (the default) are signed with a per-machine debug key, created on first use in your user config
directory (never in the project). They are for sideloading. `pack --release` signs with the keystore named in
`signing` (PKCS#12 or JKS). The passwords come from the environment variables that `storePasswordEnv` and
`keyPasswordEnv` name; never put a password in the config. Without a `signing` section, a release build is signed
with the debug key and the packer warns. The signatures use APK Signature Scheme v2 + v3.

## CLI

```
iwer-native doctor   [--project <dir>] [--json]      Node version, adb, connected headsets, config, signing env, template
iwer-native validate [--project <dir>] [--json]      validate and print the resolved target
iwer-native pack     [--project <dir>] [--release] [--out <apk>] [--template <apk>] [--install] [--run]
                                                     dist/ + template APK -> signed dist-metavr/<appName>.apk
iwer-native install  [<apk>] [--serial <id>] [--dry-run]   adb install -r (default: the packed APK)
iwer-native run      [<packageId>] [--serial <id>] [--inspect] [--forward <port>] [--dry-run]
                                                     am start -n <pkg>/android.app.NativeActivity + debug extras
iwer-native compat   [--dist <dir>] [--trace] [--strict] [--verbose] [--json]   web APIs the runtime lacks; pack runs the static part first (--skip-compat)
```

`iwer-native --help` lists every option. In the default APK name, each run of characters other than letters,
digits, `.`, `_` and `-` in `appName` becomes one `-`. adb is found through `$ADB`, then `$ANDROID_HOME/platform-tools`,
`$ANDROID_SDK_ROOT/platform-tools`, then `PATH`. The CLI never sets `ANDROID_SERIAL` or `ADB_SERVER_SOCKET`; pass
`--serial`. Exit codes: 0 ok, 1 failure, 2 usage.

## How it works

| layer | what | home |
| --- | --- | --- |
| WebXR implementation | IWER **host mode** + host input: frames, views, projection layers and input driven through `XRHostBackend`. Pure TS, no native code. | `iwer` (`immersive-web-emulation-runtime/packages/iwer`) |
| Native runtime | V8 embedding, WebGL2 over GLES, OpenXR, audio, the browser surface IWSDK needs, the template APK, packaging/signing, debug endpoint. **This package.** | `@iwer/native` |
| IWSDK integration | `npm run build:metavr`, the `native` section of `iwsdk.config.json`, IWER injection off for native builds. Thin: it validates and forwards to this package. | IWSDK |

`pack` copies your `dist/` into the template APK's assets, writes the runtime config, rewrites the binary
manifest (package, label, icon, version, permissions), aligns and signs. The template is the same for every app
and ships inside this package (`prebuilt/iwer-native-template.apk`); its SHA-256 is pinned in
`packager/templates.json` and checked on every pack.

## Licenses

MIT (see [LICENSE](LICENSE)). The template APK, and so every APK packed from it, contains third-party software
(V8, ICU, the OpenXR loader, FreeType, HarfBuzz, Oboe, libvorbis, stb, Roboto and others). Their notices are in
[THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) and inside the APK at `assets/iwn/licenses/`. If you distribute
your app, distribute these notices with it.
