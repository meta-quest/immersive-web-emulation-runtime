# 13. Packaging, the template APK, signing and app configuration

Sources: the product design (template APK, Node packer/signer, `build:metavr`, `iwsdk.config.json` section, no
native toolchain on the developer's machine, debug and store keys, IWER injection off); Android
documentation (APK structure, binary XML / `resources.arsc`, `zipalign`, APK Signature Scheme v2/v3,
16 KB page-size alignment, `android:extractNativeLibs`); Meta Horizon OS developer documentation (VR
manifest requirements: head-tracking feature, OpenXR permissions and runtime-broker `<queries>`,
`com.oculus.intent.category.VR`, `com.oculus.supportedDevices`, hand-tracking permission/feature, store
target SDK floor); packaging the showcase app (aapt drops `_`-prefixed folders; IWSDK's `injectOnBuild`
puts an IWER emulator into production builds; release vs debug native builds; an APK that launches
straight into VR); Android's rule that an update signed with a different key is refused; the IWSDK
integration design and the IWER monorepo's release setup (PKG-12..15).

## The template APK

**PKG-1 (MUST).** CI builds the native runtime once per runtime release and publishes a *template APK*
(and its unstripped symbols) per supported ABI (arm64-v8a only) with a placeholder package id, no app
assets, the runtime's JS prelude, V8 snapshot and fonts. The developer's machine never compiles native
code and needs no Android SDK, NDK, Gradle or JDK.
*Check:* M5 exit: a fresh machine with only Node 20+ and npm turns a fresh IWSDK project into an APK that
installs and enters XR.

**PKG-2 (MUST).** The template is downloaded on demand (first pack, cached per version under the user's
cache dir) from a configured URL with a checksum pinned in the npm package; `npm install` of the package
stays small (< 5 MB). Offline packing works once cached; a corrupted or mismatched download is rejected.
*Check:* tamper with the cached file: the packer refuses and re-downloads.

**PKG-3 (MUST).** Native code in the template is a release build (optimised; debug native builds are for
runtime developers only) with `.so` files stored uncompressed and 16 KB page-aligned, and
`extractNativeLibs` false.
*Check:* `zipalign -c -P 16 4` passes; `readelf -l` shows 16 KB alignment of LOAD segments.

## Packing an app

**PKG-4 (MUST).** `pack` takes a Vite `dist/` and the app's config and writes an APK by: copying the
`dist/` verbatim into the template's assets (all files, including `_`- and `.`-prefixed names), storing
large and already-compressed binary types uncompressed (`.glb .bin .ktx2 .basis .wasm .mp3 .ogg .wav .png
.jpg .webp .hdr .exr`) so they can be mapped (NET-3), excluding configured globs (default `*.map` in
release), adding the generated runtime config, rewriting the binary manifest and resources (package id,
label, icon in the required densities, version name/code, permissions and features, metadata), then
`zipalign` (4-byte for assets, 16 KB for `.so`) and signing.
*Check:* `aapt2 dump badging` (as a CI check only) shows the new package and label; every dist file is in
the APK (list diff); the APK installs and runs.

**PKG-5 (MUST).** The packer finds the entry module from `index.html` (`<script type="module" src>`),
the `modulepreload` links, classic scripts, the document title, and the static element tree (DOM-7), and
fails with a clear error if there is no module entry.
*Check:* a dist with no module script fails with that message.

**PKG-6 (MUST).** The packer detects an IWER emulator injected by IWSDK's build (`dev.emulator.
injectOnBuild`) or any other injected WebXR polyfill it can identify, and fails with a message that names
both fixes: build with `build:metavr` (the `metavr` mode leaves the emulator out whatever the config key
says) or turn the config key off. (Regression guard; GAP-7.)
*Check:* the showcase built with its shipped config fails to pack with that message; built via
`build:metavr` it packs.

**PKG-7 (MUST).** Signing: debug builds use a per-machine debug key generated on first use (stored in the
user's config dir, never in the project); release builds use the developer's keystore (PKCS12 or JKS) given
by path, with the store password, key alias and key password read from environment variables whose
names the config supplies (never the secrets themselves in config). Signatures: APK Signature Scheme v2
and v3 (v1 not required for minSdk ≥ 29). Implemented in Node with no Java dependency.
*Check:* `apksigner verify --verbose` (CI check) passes v2+v3; a store-keystore build with the store
package id installs over an existing install signed with that key.

**PKG-8 (MUST).** Manifest content generated from config: the package id, label, icon, version; launcher
activity with the VR intent category and immersive start, plus the activity metadata Meta's VR manifest
documentation lists at pack time (including the focus-aware flag if still listed; checked against the
current docs per runtime release); the launcher activity's component name stays `android.app.NativeActivity` (our perf tool starts the
app with `am start -n <pkg>/android.app.NativeActivity`) unless the tool is changed to resolve the
launcher activity;
`android.hardware.vr.headtracking` (required), OpenXR permissions and
the runtime-broker `<queries>` entries; `com.oculus.supportedDevices` (default all current Quest models;
configurable); hand-tracking permission and feature (`required="false"`) when the app enables hand
tracking (or always, configurable); `android.permission.INTERNET` whenever the network allowlist is
non-empty **or** the build can serve the inspector or debug endpoint (all debug builds, and release builds
packed with the inspector flag), because Android refuses any AF_INET socket, loopback included, without
it; passthrough/scene/anchor permissions only for AR features (later); minSdk 29 (or Meta's current
floor), targetSdk per Meta's store rule at pack time (configurable; default kept current by the runtime
release).
*Check:* `am start -S -n <pkg>/android.app.NativeActivity` launches a packed app (or the moved perf tool
launches it by resolving the activity); a manifest snapshot test per config combination (including: empty allowlist + debug build →
INTERNET present; empty allowlist + plain release → absent); M1's "DevTools attaches" passes for a
network-free hello-js debug build; the store's upload validator (manual, once per release) accepts a
release build.

**PKG-9 (MUST).** Packing is fast and reproducible: ≤ 10 s for the showcase dist (~45 MB) on a laptop,
and the same inputs (dist, config, template, key) give a byte-identical APK (fixed zip timestamps and
ordering).
*Check:* pack twice, compare hashes; time it.

**PKG-10 (MUST).** `--install` and `--run` go through metavr (device selection, install, launch, logs),
with launch arguments for debug switches (inspector, wait-for-debugger, query override) passed as intent
extras that the runtime reads.
*Check:* `build:metavr --install --run` on a headset; the app launches into XR.

**PKG-11 (MUST).** The packer prints the APK size, the runtime's share, the asset total and the largest
assets.
*Check:* output review.

## App configuration

**PKG-CFG-1 (MUST).** The app's native-target settings live in one section of `iwsdk.config.json` (name
is an open question), validated by a JSON schema the package ships; unknown keys warn; invalid values fail with
the path and the expected type. The packer converts it into the runtime config inside the APK.
*Check:* schema tests; a typo'd key warns with the path.

**PKG-CFG-2 (MUST).** The section lets the app set at least (defaults in brackets): package id [derived
from the project name, must be set for release], app label [project name], version name [package.json
version] and version code [derived monotonic, or explicit], icon [IWSDK default], preferred refresh rate
[none: the app or runtime default decides], fixed foveation default [the Quest Browser default level],
required and optional WebXR features [as the app requests], hand tracking [on], supported devices [all
current], extra Android permissions [none], network allowlist [empty], the URL the app sees (origin and an
optional query string, DOM-5) [open question 1], explicit-grant mode for `offerSession` (XR-LIFE-2)
[off], the no-session warning and exit timeouts (XR-LIFE-7) [10 s, 30 s], inspector and debug endpoint
[debug builds], stats line interval [2 s], worker cap, code-cache and shader-cache sizes, the launch splash and loading screen (XR-IDLE-1: on or off, the
image [generated from the icon and label], the background [black; contextual passthrough for apps that declare
passthrough]), the session-end grace
period (XR-LIFE-5), and signing (keystore path, alias and the env-var names for passwords). Key names and
nesting are the package's own design, chosen with the section name (PKG-CFG-1).
*Check:* the schema covers each; defaults documented on the developer page (PKG-14).

**PKG-CFG-3 (MUST).** Runtime config is read once at launch; launch intent extras may override the debug
subset (inspector on, wait for debugger, the URL query string, stats interval, explicit-grant mode) without
re-packing, in debug builds and, for inspector/stats only, in release builds when the APK was packed with
debug overrides allowed.
*Check:* launch with an extra that turns the inspector on; `/json/version` answers; launch with the
explicit-grant extra; the app holds its offer (XR-LIFE-2's check).

## Size

**PKG-SIZE-1 (MUST).** Runtime overhead per APK (template minus an empty app) ≤ 12 MB compressed download
size (project target), measured on the release template.
*Check:* CI size report per runtime release; regression > 5 % fails the build.

## IWSDK integration and repository constraints

**PKG-12 (MUST).** `npm run build:metavr` exists in the IWSDK project templates, with the equivalent
`iwsdk build --target metavr` and `metavr build` entry points. It runs `vite build` with IWER injection off
(no `dev.emulator.injectOnBuild` leak; PKG-6), then packs to `dist-metavr/<name>.apk`; `--install --run`
go through metavr (PKG-10).
*Check:* in a freshly created IWSDK project, `npm run build:metavr` writes `dist-metavr/<name>.apk`, the
packer's injection check passes, and `--install --run` enters XR on a headset.

**PKG-13 (MUST).** Agent skills ship for: build/install/run, logs, eval, eye-buffer screenshot, perf sweep
against Quest Browser, and compat-gap triage (headless runner first, then device). Each uses only the
package's commands, metavr and the debug endpoint (DBG-*).
*Check:* each skill runs end to end against the showcase on a headset (the triage skill also
headless).

**PKG-14 (MUST).** One developer docs page states what works and what does not (no DOM layout/CSS, no
`<video>` yet, no WebGPU, no 2D panel mode), how to build and sign, every config key with its default
(PKG-CFG-2), and the debug tools.
*Check:* owner review; every PKG-CFG-2 key appears on the page (script check against the schema).

**PKG-15 (MUST).** The `@iwer/native` package is `"private": true` and outside the IWER changesets
`fixed` group until a release is decided; it lives in `packages/native/` of the IWER monorepo, outside its pnpm
workspace.
*Check:* `package.json` has `"private": true`; the changesets config's `fixed` group does not list it.
