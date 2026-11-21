# packager: template APK + Vite dist → signed APK, in Node (M5)

`iwer-native pack` turns an IWSDK/Vite `dist/` into an installable Quest APK with **no Android SDK, NDK,
Gradle or JDK** on the developer's machine (PKG-1). Everything here is plain Node (no npm dependencies): ZIP,
binary AndroidManifest, PNG, ASN.1/X.509, PKCS#12 keystores, APK Signature Scheme v2 + v3.

Status (2026-10-20): working end to end, verified on two Quest 3S:

- with **the runtime template** (`runtime/app/template/build-apk.mjs` output, V8 15.5): `runtime/app/hello-js`
  packed by this packer logs `HELLO-JS PASS 32/32` (incl. REG-3, the `_`-prefixed folder) and its inspector
  answers `/json/version` through `run --forward 9508`; the `--release` pack of the same app installs over it,
  drops INTERNET/debuggable and boots with "inspector and debug endpoint disabled", 32/32 again;
- with the **stand-in template** (`template/`, a NativeActivity whose library logs what the packer put in the
  assets): the 42 MB showcase dist packs in 0.4 s, installs and launches; a release-keystore build installs over
  a build signed with the same key and is refused over a debug-key install (the hint names the uninstall).

## Pipeline

```
iwsdk.config.json "native" ──validate/resolve (src/config)──┐
dist/ ──list, scan index.html, refuse injected IWER──────────┤
template APK ──open, check contract──────────────────────────┤
                                                             ▼
 AndroidManifest.xml  decode → set package/label/version/debuggable, append permissions+features → encode
 assets/iwn/config.json  template defaults ⊕ app values (canonical JSON, no timestamps)
 res/mipmap-*/ic_launcher.png  the app icon resized to each density (PNG) or copied (WebP)
 assets/vr_splash.png  the launch splash (native.splash): generated (icon above appName, Roboto from the template)
                       or the app's own PNG; the manifest declares com.oculus.ossplash and
                       com.oculus.ossplash.background (passthrough-contextual or black)
 assets/app/**  every dist file, verbatim (incl. `_`/`.`-prefixed and non-ASCII names)
 template entries  copied raw (no recompression), META-INF/* dropped
                                                             ▼
 ZIP layout: fixed timestamps + order; stored entries 4-byte aligned, .so 16 KiB aligned (0xd935 extra)
 sign: APK Signing Block with v2 + v3 (+ 4096 padding) → self-verify → atomic write
```

| source file                      | what                                                                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `src/pack.ts`                    | the orchestrator, signing-key choice, report (PKG-11)                                                                      |
| `src/zip.ts`                     | ZIP reader, deterministic aligning writer, `zipalign -c -P 16 4` equivalent                                                |
| `src/axml.ts`, `src/manifest.ts` | Android binary XML codec; manifest rewrite and summary (PKG-8)                                                             |
| `src/apk-sign.ts`                | APK Signature Scheme v2/v3 signer and verifier (PKG-7)                                                                     |
| `src/keystore.ts`, `src/der.ts`  | PKCS#12 reader (PBES2/AES, SHA-1/SHA-2 MAC); refuses JKS, JCEKS and legacy 3DES/RC2 PKCS#12 with the conversion command    |
| `src/signing-key.ts`             | per-machine debug key, self-signed X.509                                                                                   |
| `src/dist.ts`                    | dist walk, compression policy, `index.html` scan (PKG-5), injection check (PKG-6)                                          |
| `src/runtime-config.ts`          | `assets/iwn/config.json`                                                                                                   |
| `src/template.ts`                | template resolution, pinned download + cache + checksum (PKG-2)                                                            |
| `src/png.ts`                     | PNG decode/encode/resize for icons                                                                                         |
| `src/splash.ts`, `src/ttf.ts`    | the launch splash image (generated card or the app's PNG) and the small TrueType reader/rasterizer that draws the app name |
| `template/`                      | stand-in template build (`build-template.mjs`, manifest, `src/template_main.c`)                                            |
| `templates.json`                 | the pinned template for this package version (null until CI publishes one)                                                 |

## Template contract (for the runtime's template build)

A template is an **unsigned** (or signed; signatures are dropped) APK with:

1. `AndroidManifest.xml` (binary, aapt2 output) with the launcher activity `android.app.NativeActivity` (PKG-8:
   tools start it with `am start -n <pkg>/android.app.NativeActivity`), the VR category, focus-aware flag,
   `android.hardware.vr.headtracking` (required), OpenXR permissions and runtime-broker `<queries>`,
   `com.oculus.supportedDevices`, `android:extractNativeLibs="false"`, `android:icon="@mipmap/ic_launcher"`,
   `minSdkVersion` 29 and the store's `targetSdkVersion`. `INTERNET` and `debuggable` are the packer's call per
   build: it adds them to debug builds and removes them from plain release builds even if the template has them. The packer sets `package`, `versionCode`, `versionName`, the application label (a literal
   string; an activity label too if the template has one).
2. `resources.arsc` stored uncompressed (the packer fixes a compressed one: Android 11+ refuses it).
3. `lib/arm64-v8a/*.so` stored uncompressed (the packer 16 KiB-aligns them; link with `-z max-page-size=16384`
   for PKG-3's `readelf` check).
4. `assets/iwn/template.json` (optional but wanted: without it the packer warns, sets no icon and reports the
   runtime version as unknown; the current runtime build has none):
   `{"format":1,"runtimeVersion":"…","buildId":"…","placeholderPackage":"…","icons":[{"path":"res/mipmap-mdpi-v4/ic_launcher.png","px":48},…],"abis":["arm64-v8a"],"nativeBuild":"release"}`.
   `icons` lists the files the packer replaces with the app icon.
5. Optional `assets/iwn/config.json` with runtime defaults (`preludes`, `inspector.port`, …): the packer keeps
   every key it does not set.
6. Runtime assets anywhere under `assets/iwn/` (prelude, `v8/snapshot_blob.bin` stored uncompressed, fonts).
   `assets/app/` is reserved for the app.

The packer checks the manifest part of the contract and warns when the launcher activity lacks
`com.oculus.intent.category.VR`, or the manifest lacks `android.hardware.vr.headtracking` or
`org.khronos.openxr.permission.OPENXR` (the APK then installs as a 2D panel app). A compressed `lib/*/*.so`
is re-stored uncompressed (with a warning), and the self-check refuses compressed native libraries. Relative
component class names (`.Foo`) are qualified with the template's package before the package is renamed, and
`activity-alias` labels follow the app name like activity labels.

`node packager/template/build-template.mjs` builds the stand-in. It also wraps the runtime's build:
`--native-lib libiwernative.so --native-lib libv8android.so --native-lib libc++_shared.so --assets <runtime
assets dir> --lib-name iwernative --runtime-version <v>` (its manifest's `android.app.lib_name` must then name
the runtime library; today the stand-in manifest says `iwntemplate`). Output: `out/iwer-native-template.apk`
and `out/template-info.json` (sha256/size to paste into `templates.json` when CI publishes the file).

## What the app APK contains

- `assets/app/<dist path>`: the dist, byte for byte. Stored uncompressed (mappable, NET-3) for
  `.glb .bin .ktx2 .basis .wasm .mp3 .ogg .wav .png .jpg .jpeg .webp .hdr .exr` (+ a few more already-compressed
  types); everything else deflated when that is smaller. Release builds exclude `*.map`; `--exclude <glob>` adds more.
- `assets/iwn/config.json` (runtime `RuntimeConfig` shape, runtime/core `config.h`, plus sections other modules
  read):

  | key                                  | value                                                                                                                                                                                                                                                                                                                                                                                           |
  | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `appRoot`, `index`                   | `"app"`, `"index.html"`                                                                                                                                                                                                                                                                                                                                                                         |
  | `app`                                | `packageId`, `name`, `versionName`, `versionCode`, `buildType`                                                                                                                                                                                                                                                                                                                                  |
  | `inspector.enabled`, `debug.enabled` | debug builds, or release packed with `--inspector`                                                                                                                                                                                                                                                                                                                                              |
  | `launchOverrides.allowed`            | same condition (PKG-CFG-3: launch extras honoured)                                                                                                                                                                                                                                                                                                                                              |
  | `stats.logIntervalMs`                | 2000 (PKG-CFG-2 default)                                                                                                                                                                                                                                                                                                                                                                        |
  | `network`                            | `{ "allow": [origins], "debug": <debug build> }` (runtime/net reads it)                                                                                                                                                                                                                                                                                                                         |
  | `xr`                                 | `frameRate`, `foveation {level, dynamic}`, `features {name: required/optional}`, `loading {enabled, image: "vr_splash.png", background}` (the runtime's loading screen, from `native.splash`; `background` is `"black"`, `"contextual"` (apps that declare passthrough) or `"#rrggbb"`; with `splash: false`, `{enabled: true, image: null, spinner: false, background}`: the background alone) |
  | `page`                               | `title`, `entry` (from `index.html`)                                                                                                                                                                                                                                                                                                                                                            |
  | `pack`                               | packer and template versions                                                                                                                                                                                                                                                                                                                                                                    |

- `assets/vr_splash.png` (stored) unless `native.splash` is `false`: Horizon OS shows it as the system splash while
  the app starts (the application's `<meta-data android:name="com.oculus.ossplash" android:value="true"/>`, a typed
  boolean, which the packer adds or removes to match), and the runtime's loading screen shows the same file until
  the app's first XR frame. The application also gets `<meta-data android:name="com.oculus.ossplash.background">`
  (a string, also with `splash: false`: it is the launch transition's background): `passthrough-contextual` for
  `splash.background` `"contextual"` (passthrough when the user's home is passthrough, else black; the default for
  apps that declare passthrough, refused without it), `black` otherwise (the default for every other app).
  Generated by default: the app's PNG icon (or the template's placeholder) above
  `appName` in Roboto Bold (`assets/iwn/fonts/Roboto-Bold.ttf` from the template), 1024x512 on transparency. A name
  with glyphs Roboto lacks, a WebP icon, or a template without the font give a smaller card and a warning.
- Manifest permissions: the template's + the config's (`features` → Horizon OS permissions/features,
  `permissions`) + `android.permission.INTERNET` when the allowlist is non-empty, in every debug build, and in
  release builds packed with `--inspector` (Android refuses even loopback sockets without it).

## Signing (PKG-7)

- **Debug builds** (default) always use the per-machine debug key: RSA 2048, self-signed `CN=Android Debug,
O=Android, C=US`, 30 years, created on first use in the user's config dir (`$XDG_CONFIG_HOME/iwer-native/debug-key/`,
  `~/Library/Application Support/iwer-native/` on macOS, `%APPDATA%\iwer-native` on Windows;
  `IWER_NATIVE_CONFIG_DIR` overrides). Never in the project. Concurrent first packs are safe: the key pair is
  written to a temporary directory renamed to `debug-key/` in one step, so one key wins and every process signs
  with it. A corrupt or mismatched pair is refused up front with the directory to delete.
- **Release builds** (`--release`) use the `signing` section: `keystore` (PKCS#12), `keyAlias` (optional
  when the keystore has one key), `storePasswordEnv`/`keyPasswordEnv` name the environment variables. Without a
  `signing` section a release build is signed with the debug key and warns (sideload only). Debug packs never
  need the keystore file: when it is absent (kept only on release machines) they warn and continue; `--release`
  fails. Only the selected alias is decrypted, so other aliases may have their own key passwords. Unsupported
  key types (DSA, Ed25519, other curves) are refused before any packing work.
- v2 + v3 (v3 signer range 28..max), block padded to 4096 bytes. Signatures are deterministic, so the same
  inputs give the same APK (PKG-9): RSA PKCS#1 v1.5 by construction, ECDSA (P-256/P-384/P-521) with RFC 6979
  nonces (`src/ecdsa.ts`; k\*G via node:crypto ECDH, every signature verified before use).
- Read: PKCS#12 with PBES2/AES (keytool from JDK 12, 11.0.12 and 8u301; OpenSSL 3; Android Studio). Refused,
  with the `keytool -importkeystore ... -deststoretype pkcs12` command that converts them: JKS, JCEKS, PKCS#12
  with the legacy 3DES/RC2 PBE schemes (keytool 8-11, OpenSSL 1.x). Not read: PKCS#12 with PBMAC1 integrity
  (the error says so). No key rotation (v3 proof-of-rotation) yet.

## Template download (PKG-2)

Order: `--template <apk>` / `$IWER_NATIVE_TEMPLATE`; the template **bundled** in the npm package (`templates.json` `"bundled": {file, version, sha256, size}`, re-hashed on every pack, a mismatch is refused with a reinstall hint; the 0.1.0 alpha ships this way, see `../RELEASE.md`); the pinned entry in `templates.json` (`{version, url,
sha256, size}`) downloaded once into the user cache (`$XDG_CACHE_HOME/iwer-native/templates/<version>/`,
`IWER_NATIVE_CACHE_DIR` overrides), checked on every use (mismatch → deleted, fetched again; a bad download is
refused); then `template/out/iwer-native-template.apk` in a checkout. `templates.json` is `null` until a CI
publishes a template (no CI or URL exists yet). Node's `fetch` honours `HTTPS_PROXY` only with
`NODE_USE_ENV_PROXY=1` (Node 24).

## CLI (`src/cli/main.ts`)

```
iwer-native pack    [--release] [--inspector] [--dist <dir>] [--out <apk>] [--template <apk>] [--exclude <glob>]… [--json] [--install] [--run]
iwer-native install [<apk>] [--serial <id>] [--dry-run]        # default: dist-metavr/<appName>.apk
iwer-native run     [<pkg>] [--inspect] [--inspect-brk] [--query <qs>] [--v8-flags <f>] [--forward <port>] [--activity <cls>]
```

- `run` is `adb shell am start -S -W -n <pkg>/android.app.NativeActivity` plus extras the runtime reads
  (runtime/core `RuntimeOptions`): `--ez iwn.inspector true`, `--ez iwn.inspectBrk true`, `--es iwn.query
'<qs>'`, `--es iwn.v8flags '<flags>'` (string extras are quoted for the device shell; the runtime honours
  `iwn.inspectBrk` and `iwn.v8flags` in debug builds only). `--forward 9508` runs
  `adb forward tcp:9508 localabstract:<pkg>_devtools_<device port>` first. The device port is the packed APK's `inspector.port`
  (`dist-metavr/<app>.apk`); with an explicit `<pkg>` it is read from the APK installed on the device
  (`pm path` + `adb pull`); `--device-port <p>` overrides both; 9229 is the last resort.
- `install` explains signature mismatches (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`: names the package and the
  uninstall command), version downgrades and ABI mismatches.
- Some adb wrappers want a global option before every subcommand, for example `--reason "<why>"`:
  `IWER_NATIVE_ADB_ARGS='--reason "<why>"'` prefixes every adb call; it is split like a shell would (quotes and
  backslashes), so a reason may contain spaces. Stock adb needs nothing.
- PKG-10 asks for install/run **through metavr**; this CLI talks to adb directly and is what metavr (or IWSDK)
  calls or replaces (below).

## `npm run build:metavr`: integration design for IWSDK (PKG-12, GAP-7)

What IWSDK needs (the IWSDK diff of this stack implements it):

1. **Config section.** `iwsdk.config.json` gains the `native` section this package validates
   (`src/config/schema.ts`, documented in `../README.md`): `packageId` (required), `appName`, `version`,
   `versionCode`, `icon`, `frameRate`, `foveation`, `features`, `permissions`, `network.allow`, `signing`
   (`keystore`, `keyAlias`, `storePasswordEnv`, `keyPasswordEnv`). IWSDK's `validateIwsdkProjectManifest`
   rejects unknown root keys today, so IWSDK must accept `native` and delegate its validation to
   `@iwer/native` (`validateIwsdkConfigNativeSection`), or ship the JSON schema copy.
2. **Template script.** `"build:metavr": "iwsdk build --target metavr"` in the create templates (and
   `metavr build` as the same thing from the metavr side), `dist-metavr/` in `.gitignore`.
3. **`iwsdk build --target metavr`** does:
   1. `vite build` with **IWER injection forced off**: the env var `IWSDK_BUILD_TARGET=metavr` (proposed), which
      `@iwsdk/vite-plugin-dev`'s `shouldInjectRuntime()` treats like `injectOnBuild: false` for `build` (no
      emulator bundle, no `/@iwer-injection-runtime` tag) and which also skips the managed-workspace/MCP bridge.
      The project's `dev.emulator.injectOnBuild` is not edited; it keeps applying to browser builds.
      `NODE_ENV=production`, the project's normal `vite.config`, output `dist/` (or a temp outDir passed to
      pack with `--dist`, so a browser `dist/` is not clobbered).
   2. `iwer-native pack [--release]` → `dist-metavr/<appName>.apk`. The packer re-checks the dist and refuses
      an injected emulator with a message naming `dev.emulator.injectOnBuild` (PKG-6; checked against real
      injected builds from IWSDK 0.5.3 and 1.0.x, and clean builds are not flagged), so a plugin that ignores the
      env var cannot ship a broken APK. The detector keys on config object keys present in every IWSDK release
      (`userAgentException:` and `activation:`), not on later additions such as `nativeXRControl`.
   3. `--install --run`: through metavr's device commands (`metavr app install <apk>`, `metavr app launch
<pkg>`, logs) when metavr is present; otherwise `iwer-native install`/`run` (adb). Debug switches map to
      `iwer-native run` flags.
4. **Template download**: on first `build:metavr` the packer fetches the pinned template into the user cache
   (needs the CI publication step; until then `--template`).

## Checks

`npm test` (from `packages/native`) runs everything headless: 190 tests incl. 71 here (`packager/test/`):
ZIP/alignment, binary XML round trip on aapt2 output, manifest rules (INTERNET matrix), PNG, PKCS#12
fixtures (and the refusal of JKS and legacy PKCS#12), v2/v3 sign/verify/tamper, pack contents/reproducibility/refusals, template
download/cache/tamper. When the Android SDK is present (CI, or `$ANDROID_HOME`), the
SDK cross-check runs `apksigner verify` (v2 and v3), `aapt2 dump badging` (package, label, debuggable,
permissions, launchable activity) and `zipalign -c -P 16 4` (build-tools 35) on packer output; these are CI
checks only, the packer never calls them.

Test fixtures: `test/fixtures/*.p12|.jks` are throwaway keys made with keytool 8/17 and OpenSSL 3.5 (store
password `iwn-test-store`; `jdk8.jks` and `p12-jdk8.p12` are keytool 8 files kept to test their refusal);
`two-keys.p12` (aliases `upload`/`second`) joins two OpenSSL-made PKCS#12 files (PBES2 AES-256) under one
HMAC-SHA256 MAC; `template-manifest.axml` is aapt2 34's output for
`template/AndroidManifest.xml`.

## Gaps and open questions

- **"Enters XR"** (M5 exit) waits for the runtime's XR module (M3); the runtime template is a 2D-panel M1 build
  without the VR category or an icon resource yet. No CI publishes a template, so `templates.json` is null.
  PKG-3's `readelf` and PKG-SIZE-1 are template-side checks.
- **Config keys PKG-CFG-2 lists that the schema does not have yet** (the schema is shared, not changed here):
  supported devices, app origin/query string, explicit-grant mode, no-session timeouts, inspector/debug
  endpoint, stats interval, worker cap, code/shader cache sizes, loading image, session-end grace. The runtime
  config has room for them; the packer forwards only what the schema validates.
- WebP icons are copied, not resized (no WebP decoder in Node without a dependency).
- PKG-13 (agent skills) and PKG-14 (developer page) are not written; PKG-10's metavr route needs metavr changes.
