# compat: which web APIs an app needs, and whether @iwer/native has them

Two tools:

1. **API-usage tracer + sweep**: records the web APIs an app touches while it boots and runs in XR (headless
   Chromium, IWER emulation providing the XR frames; blind spots below), across a set of samples, and ranks the
   result into a matrix: API → samples using it → provided by (V8 / a runtime layer / IWER host mode / gap /
   unsupported). The samples' own `iwsdk.config.json` and source, and the headset-only code path the headless run
   never takes, are added as rows too.
2. **The build:metavr compat checker** (`iwer-native compat`, and a gate inside `iwer-native pack`): a static scan of
   the built bundle, the app's own source and `iwsdk.config.json`, plus an optional headless trace run; it fails on
   unsupported APIs the app actually calls and on a bundled emulator, warns on the rest, and lists what to change.
   This alpha does not support every web API, and there is no fallback route: an app that needs a missing API must
   feature-detect it or stop using it.

Spec IDs this work serves (it is tooling around them, not their implementation): NET-5 (network allowlist),
PKG-6 / GAP-7 (injected emulator), XR-LAYER-1 (surfaced statically: the headless run cannot reach it), IN-9 and
XR-AR-1 (reported as gaps), and inputs for DOM-11, HL-2, HL-4 / M6, PKG-13 and PKG-14: the runtime's own miss
report (DOM-11), the Node headless runner (HL-2), the device nightly (HL-4), the triage skill (PKG-13) and the
developer page (PKG-14) are not part of this directory.

## Files

| file | what |
|---|---|
| `src/tracer.ts` | the tracer, injected before the app (main thread and every worker). Self-contained function, serialised with `toString()`. |
| `src/server.ts` | static server for a `dist/`: injects the tooling `<script>`s at the top of `<head>`, prepends the worker tracer to worker scripts, collects worker reports. 127.0.0.1 only. |
| `src/trace-run.ts` | the headless run: Playwright (from the project), IWER emulator (`iwer/build/iwer.js`), the headset trim, grant the offered session (or request via an "Enter XR"-like button), scripted input (controller aim, trigger, squeeze, thumbsticks, hands + pinch), collect. Cross-origin requests and WebSockets are blocked (native default) unless allowlisted or served from a local mirror. |
| `src/inventory.ts` | what the runtime provides **today**, measured: evaluates the core bootstrap and every `web/<area>/dist/<area>.js` (only the area's own bundle: other bundles there are opt-in preludes) in a bare V8 context with permissive fake natives (without the opt-in WebSocket transport) and records the globals/members each layer adds, and which of them are stubs (members, and constructors that throw `NotSupportedError`). Unbuilt areas fall back to source tokens. |
| `src/providers.ts` | the rule table (API → owning area, spec IDs, policy: provide / later / absent / inert) and status resolution against the inventory and IWER host mode's classes (`iwer-host.module.js`). |
| `src/matrix.ts` | aggregation into the ranked matrix (Markdown + JSON). |
| `src/scan.ts` | static scan of a dist (signal catalogue, cross-origin URLs, injected emulator: its own markers plus the packager's `detectInjection`, so the gate and `pack` agree). |
| `src/project.ts` | what the app itself declares: `iwsdk.config.json` `world.xr` (session mode, features, required or not) and the app's own source (`src/`, scripts at the project root, the entry scripts `index.html` references, its inline scripts; comments stripped; IWSDK `XRQuadLayer`/`XRCylinderLayer` components; IWSDK XR options given in code; `<video>` playback; feature checks of absent APIs). |
| `src/check.ts`, `src/cli.ts`, `src/surface.ts` | the checker, its CLI command, and the surface loader (live in a checkout, else `data/surface-snapshot.json`). |
| `scripts/sweep.mjs` | build + trace a directory of IWSDK samples. |
| `scripts/matrix.mjs` | traces → `compat-matrix.md` + `matrix.json`. |
| `scripts/snapshot.mjs` | write `data/surface-snapshot.json` (what an installed CLI resolves against). |
| `scripts/baseline.mjs` | write `data/static-baseline.json` (static signals the create templates carry in dormant library code, with counts). |
| `scripts/acquire.sh` | fetch the sample set into a scratch dir: the IWSDK samples, the three create templates, the two CDN mirrors. |
| `test/` | node:test, headless; `npm run test:compat`. |

## How the tracer works

- **Headset trim** (`providers.ts` `headsetTrim`, applied by `compat --trace` and the sweep): before anything is
  wrapped, the globals and `navigator` / `crypto` / `BaseAudioContext` members the rule table marks absent are deleted
  from the page and its workers (WebGPU, WebCodecs, media streams and `mediaDevices`, `AudioWorklet` and
  `ctx.audioWorklet` (AUD-6), `BroadcastChannel` (optional in WRK-6), `SharedWorker`, clipboard, service workers,
  `crypto.subtle`, and the alpha's out-of-scope `WebSocket`, `indexedDB`, `caches`, ...; about 140 names in Chromium
  1208), unless a runtime layer the packer ships provides them anyway (opt-in preludes and natives the packed runtime
  config never enables, such as web/storage's `idb.js` and web/net's WebSocket transport, do not count; a layer's
  *stub* does not count as providing either: an absent-by-design member a layer only stubs,
  such as web/audio's `createScriptProcessor`, is replaced by a method that throws `NotSupportedError`, as on the
  headset), and `getContext` returns null for context types other than
  `2d` / `webgl` / `webgl2`. The emulated device offers `inline` and `immersive-vr` only (the headset has no
  `immersive-ar` until XR-AR-1; the sweep turns AR on to record what the AR samples use in XR). So the app's feature
  detection takes the headset's branch in the trace: three.js's WebGPURenderer falls back to WebGL2, a
  `typeof VideoDecoder` guard skips the clip, an optional "Enter AR" button stays hidden. A guarded probe of a
  removed `navigator` member is recorded (`miss:Navigator.gpu`); an unguarded use throws in the page as it would on
  the headset. The miss probe fires for unguarded reads too (`navigator.gpu.requestAdapter()` reads `gpu` first), and
  Chromium's message names the *next* member ("Cannot read properties of undefined (reading 'requestAdapter')"), not
  the root. So when the trimmed run has a TypeError-like page error (reading or calling something undefined) and the
  app touched a removed root (`navigator.gpu`, or `AudioWorklet` through `ctx.audioWorklet`), `compat --trace` runs
  a **control run**: the same trace with that root left in place (at most 3 roots, one browser at a time). An error
  the trimmed run had and the control run does not is caused by the removal: an unguarded use, an error finding.
  An error both runs have (an unrelated bug next to a guarded probe) is not. This holds when the app stores the
  root in a variable and uses it lines later, or far along a minified line. Errors are compared by first line and
  top frame, without the per-run server origin. Without a control run (library callers, a control run that hung,
  more than 3 roots), the checker falls back to heuristics: an error that reads a member the app uses of that root,
  that names the root, or whose top frame is at the miss site (same line, a little to the right). `dump().removed`
  lists what went.
- **Interface members**: every own method and accessor of every exposed interface prototype is replaced through its
  property descriptor by a wrapper (`HTMLCanvasElement.getContext()`, `HTMLCanvasElement.width`,
  `HTMLCanvasElement.width=`). WebGL extension objects are wrapped when `getExtension` returns them (`ext:NAME.m()`).
- **Globals**: global functions/accessors are wrapped the same way (`fetch()`, `innerWidth`); interface objects are
  replaced by a Proxy with apply/construct traps (`new Image`), their reads are recorded (`OffscreenCanvas`), static
  members are wrapped in place (`URL.createObjectURL()`), `prototype.constructor` points at the Proxy so
  `instanceof` and `x.constructor === X` still hold. ECMAScript built-ins are not traced; `Intl`, `WebAssembly`,
  `console`, `CSS` members are.
- **Misses**: a probe object (a Proxy over an empty object whose prototype is the real next link, so `instanceof`
  and `isPrototypeOf` still hold) is spliced into the prototype chain below `Node` (and below `Navigator`) and
  records failed lookups (`miss:HTMLCanvasElement.depth`). Chromium makes the global's own chain immutable, so
  probes of missing *globals* are left to the static scan.
- **Non-global classes**: objects that come back from a traced getter and whose class is not a global (IWER's
  `Gamepad`, `GamepadButton`, `GamepadHapticActuator` through `XRInputSource.gamepad`) get their prototype wrapped
  on first sight.
- **Argument details** that decide compatibility: context types, extension names (and whether they returned null),
  element tags, event types listened for, fetch/XHR/image URL classes (same-origin / cross-origin host / data: /
  blob:, extension), worker type and URL scheme, XR session mode and every required/optional feature, reference space
  types, `updateRenderState` keys, audio formats passed to `decodeAudioData` (sniffed from the bytes), canvas fonts.
- **Attribution**: a use counts for the app only when the nearest JS frame below the tracer is an app script (by URL;
  V8 structured call sites). Frames from the injected tooling (the IWER emulator, the driver) are "tool" uses: on the
  headset IWER host mode is part of the runtime, so what IWER itself calls is the runtime's business. Every call is
  classified until the app is seen using the API (so an app use is never hidden behind a long run of IWER's own
  calls), then stack capture is sampled (first 64 calls, then powers of two), so counts are exact and the app/tool
  split is an estimate; the tracer's own internal reads are not counted;
  members with argument details capture the stack on every call, so detail rows and their sites are exact.
- **Wrappers** are method-syntax functions: like native methods they are not constructors and have no `prototype`;
  `Function.prototype.toString` shows the original.
- **Workers**: `new Worker` is wrapped, in the page and in workers (nested workers are traced). Same-origin worker
  scripts get the worker tracer prepended by the server (`importScripts` after any `"use strict"` prologue, or
  `import`, by the type the page registered, else by module syntax); `blob:`/`data:` workers start through a small
  wrapper blob that loads the tracer first. Workers report at 50 ms, 200 ms, then every 500 ms, and synchronously in
  `self.close()`; each report's answer carries the page's phase, so worker records get `xr` too.
- **Phases**: records note whether the first app use was at boot or in XR, and calls made while in XR, so the matrix
  can show an estimate of app calls per XR frame.
- **Session ends**: if the scripted input ends the session (the trigger can hit the app's own exit control), the
  run records it in `sessionEnds` and re-enters XR (a new offer, or the "Enter XR" button) so the rest of the
  script (hands, pinch) still runs.

- **Event targets**: listeners record `on:<Interface>.<type>`. The global object reads as `Window` /
  `WorkerGlobalScope`; the real XR interfaces (the globals IWER installs) keep their names; any other JS subclass of
  `EventTarget` (the app's own classes, also one named `XR...`) is recorded as `EventTarget`, since that is what the
  runtime has to provide for it.
- **IWER after the tracer**: the emulator is installed after the tracer, so `wrapLate` re-wraps what it adds: the
  `XR*` globals, `navigator.xr`, the own data properties `installRuntime` defines on the navigator instance
  (`navigator.userAgent`, which shadows the wrapped `Navigator.prototype` getter; three.js tests it for
  `OculusBrowser`), and the `makeXRCompatible` it puts on the WebGL prototypes.
- **WebSockets**: they do not go through Playwright's request routing, and Playwright's `routeWebSocket` installs a
  page-side WebSocket mock before the tracer whose own calls (`crypto.getRandomValues`, `URL`, `document.baseURI`,
  `EventTarget` listeners) would be charged to the app's `new WebSocket`. So the tracer gates them itself: a socket
  to an origin that is neither the page's nor covered by `native.network.allow` is opened to the compat server's
  `/__iwn_compat/ws-blocked?u=<url>` instead, which refuses the upgrade (403) and reports the URL as blocked. The app
  gets the browser's own `WebSocket` with the error and close events of a refused connection; only its `url` (and
  the console error Chromium prints) shows the redirect. As in the runtime (runtime/net `url.h`, web/net
  `allowlist.ts`), `ws://` and `wss://` URLs are matched against the `http://` / `https://` origin: `wss://host` is
  covered by the entry `https://host` (the config validator accepts only http(s) entries, so a `wss://` entry covers
  nothing). URLs the WebSocket constructor rejects (a scheme other than ws/wss/http/https, a fragment) reach it
  unchanged, so the app gets its `SyntaxError`.
- **Hangs**: every `page.evaluate` and the page load have a timeout (60 s; proto-levels keeps the main thread busy
  for more than 15 s while it loads under SwiftShader) and the whole run a hard cap (boot + XR time + 90 s); a page
  whose main thread never yields, before or after the load event, ends the run with `hung` set instead of hanging
  `compat --trace` or the sweep (the static findings are still reported). A browser that finishes launching after
  the cap fired is closed at once. `--boot-ms` / `--xr-ms` take (0, 1800000] ms, so the cap is always a valid timer
  delay (Node clamps larger delays to 1 ms). An unreadable `dist/` file is a 500 for
  that request (and a finding), not a crash of the run.

Blind spots: `[LegacyUnforgeable]` members cannot be redefined, so main-thread `location.*`, `window.document` reads
and `Event.isTrusted` are not recorded (a navigation the app starts is still seen: the run watches main-frame
navigation requests, cancels cross-origin ones with a 204 answer, as the headset ignores them (DOM-5), and reports
each as a "page navigation" finding; a same-origin reload replaces the traced page, so that finding says the trace is
incomplete); members of classes that are neither globals nor returned by a traced getter
are not wrapped; symbol-keyed members (iterators, async iterators, `Symbol.toPrimitive`) are not wrapped; indexed
and named property access (`collection[0]`, `localStorage.key = v`, `style.width = ...` on a
`CSSStyleDeclaration`'s named properties, `HTMLCollection` items) is not recorded, because those are exotic-object
behaviours rather than prototype members; a worker terminated within ~50 ms of starting may not report.

Known limits: the trace sees code paths the run reaches (a 6 s XR window with scripted input); the static scan sees
everything but cannot tell dead code or feature detection from use. IWER runs in emulation mode in Chromium, so
the app takes three.js's `XRWebGLLayer` path; on the headset IWER host mode offers `XRWebGLBinding.createProjectionLayer`
and the app takes the projection-layer path instead. That path is not traced: the matrix adds it as `device` rows
(`createProjectionLayer`, `getViewSubImage`, `updateRenderState({layers})`), and IWSDK's quad/cylinder layers
(XR-LAYER-1: `createQuadLayer`/`createCylinderLayer`, called unguarded, absent in IWER host mode, so those apps throw
on the headset today) come from the app's source (`XRQuadLayer`/`XRCylinderLayer` components). Likewise WebGL
extensions SwiftShader does not offer (`OCULUS_multiview`, `KHR_parallel_shader_compile`,
`WEBGL_multisampled_render_to_texture`) return null headlessly, so the extension path is untraced; those rows read
`provided` when the WebGL layer names them, else `gap` (GL-20, the M3 MSAA-multiview check).

"Provided" means a built layer installs it, measured in a Node `vm` context (Node 24's V8, not the runtime's V8 15.5).
Members that fail unconditionally (the first statement of the body throws or rejects `NotSupportedError`, or warns
"not implemented") or that admit it in a warning (`ctx.filter`) are `partial` (stub). A stub of an API the spec
wants absent (web/audio's `createScriptProcessor`; the DOM-6 media stand-ins' `play()` once a DOM layer stubs it) is
`unsupported` when called and `partial` when only read, never `provided`; a feature check does not route around it,
since the stub is present on the headset. A real implementation with a
spec-mandated error path (`AbortSignal.timeout` without timers, `ConvolverNode.buffer=`, `setValueCurveAtTime`
overlaps, `Blob.stream` without `ReadableStream`) is not a stub. An interface that exists without the member is a `gap` (missing), unless a layer assigns it as an instance field
(`this.<name> =`), which is `partial`. `console.*` counts only when runtime/core replaces V8's inert console (CON-1).
`WebAssembly.compileStreaming` / `instantiateStreaming` exist in Node's V8 only because Node installs the wasm
streaming callback; the inventory drops them from the V8 layer, so they read `gap` until the runtime installs the hook
(NET-10). Worker-scope globals (`postMessage()`, `close()`, `importScripts()`; the tracer records them without the
scope prefix) resolve against `DedicatedWorkerGlobalScope` / `WorkerGlobalScope` members, which is where web/workers
defines them; a main-thread call is keyed `Window.postMessage()` / `Window.close()` and reads as a gap (no layer
installs them on the page). Constructors of out-of-scope Web Audio nodes (`new DynamicsCompressorNode()`,
`WaveShaperNode`, `IIRFilterNode`) and their factory methods throw `NotSupportedError` (web/audio's alpha gate).
APIs a layer implements (or stubs, or leaves out, like `OfflineAudioContext`) but the alpha does not ship as supported
(Web Audio beyond the basic set, `OfflineAudioContext`, `window.open()`) read `later` (a warning), matching "not yet" in the README's support matrix. AR and depth members
IWER host mode's classes define (`XRFrame.detectedPlanes`, `XRSession.requestHitTestSource`, ...) read `later` too:
nothing feeds them on the headset until XR-AR-1. Image loads in a format outside IMG-1's decoder set (AVIF, SVG,
BMP, ICO, TIFF, HEIC, JXL; from the `img.src` extension or `data:` type, or the `createImageBitmap` Blob type) read
`unsupported`. The inventory evaluates
the layers in the order `release/template-assets.json` gives the packed preludes, since some layers patch others at
install time (canvas2d patches `HTMLCanvasElement.prototype` only if it exists by then).

## Running the sweep

```bash
export PATH=$HOME/.local/bin:$PATH   # Node 24; set npm_config_registry if you use a registry mirror
# samples in <dir>/<name>/ (IWSDK projects); SDK tarballs in <pkgs>/<pkg>/iwsdk-<pkg>.tgz
node compat/scripts/sweep.mjs --samples <dir> --out <out> --packages <pkgs> \
  --iwer ../iwer/build/iwer.js \
  --mirror https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@1.0/=<local copy of the npm package> \
  --jobs 4 --trace-jobs 4
node compat/scripts/matrix.mjs --traces <out>/traces --samples <dir> --out <out>/compat-matrix.md --json <out>/matrix.json
```

Traces run with the headset trim and with `immersive-ar` offered by the emulated device (so the AR samples' XR-phase
use is recorded for XR-AR-1); `--no-trim` / `--no-ar` turn either off. `--packages` rewrites `@iwsdk/*` to the local tarballs (with npm `overrides`: the nested `file:` deps inside
`iwsdk-core.tgz` are relative to the SDK repo) and turns `dev.emulator.injectOnBuild` off. Playwright is pinned to
1.58.2 (its Chromium revision 1208 is the one in `~/.cache/ms-playwright`; the Playwright CDN is unreachable from the
machine it was developed on). Headless Chromium renders WebGL with SwiftShader, so XR frame rates are low (5–50 fps); per-frame
numbers are relative.

The dormant-library baseline (`data/static-baseline.json`) comes from the three create templates (`create-vr`,
`create-ar`, `create-browser`, which `scripts/acquire.sh` scaffolds from the SDK tarballs) of the IWSDK version the
package README names, swept as above, then:

```bash
node compat/scripts/baseline.mjs --dist <dir>/create-vr/dist --dist <dir>/create-ar/dist \
  --dist <dir>/create-browser/dist --traces <out>/traces [--iwsdk <version>]
```

It records the templates' installed `@iwsdk/core` version; `--iwsdk` labels it with the version those IWSDK sources
will ship as when the tarballs still carry the previous release's version. Make it again whenever that IWSDK
version changes (RELEASE.md, section 8).

## The checker

```
iwer-native compat [--project <dir>] [--dist <dir>] [--trace] [--mirror <url-prefix>=<dir>] [--boot-ms <ms>] [--strict] [--verbose] [--json]
iwer-native pack ...            # runs the static check first; --skip-compat turns it off
```

Three static sources, one optional dynamic one:

- **the bundle** (`dist/`): mentions, including library code the app never runs. For IWSDK apps (the project depends
  on `@iwsdk/core`, or the bundle carries IWSDK's scene-runtime markers), signals every create template carries in
  dormant library code (`data/static-baseline.json`: IWSDK's camera utilities with `getUserMedia` and a `<video>`,
  its AR and quad-layer code; three.js itself has neither) are info, unless the bundle mentions them more often than
  the templates did. Any other bundle (plain three.js, ...) gets no baseline: every hit is the app's;
- **the app's own source** (`src/`, scripts at the project root such as Vite's vanilla `main.js`, the entry scripts
  `index.html` references, inline scripts) and **`iwsdk.config.json`** (`world.xr.mode`, `world.xr.features`,
  `world.xr: false` / `offer: "none"`, `world.features.camera`): app-owned, never dormant. IWSDK options given in code
  count the same (`World.create(el, { xr: { sessionMode: SessionMode.ImmersiveAR, features: { hitTest: { required:
  true } } }, features: { camera: ... } })`, `launchXR(world, ...)`, `xr: false`, `offer: 'none'`). This is how AR
  sessions, required AR features, `XRQuadLayer`/`XRCylinderLayer` components, IWSDK's camera feature (`CameraSource` /
  `CameraUtils`, which call `getUserMedia`; XR-SEC-1), desktop-only apps (XR-LIFE-7), `<video>`/`<audio>` playback
  (an element made, then *that element* played or given a source: a variable or field assigned from
  `createElement('video'|'audio')` / `new Audio(`, one whose name says media (`introVideo`, `this.bgm`), or
  `new Audio(url)`; an element made only for `canPlayType`, a three.js `action.play()` or an `img.src =` is not
  playback, and neither is `new Audio(listener)` where the file binds `Audio` itself, as `import { Audio } from
  'three'` (Web Audio) does), audio worklets (AUD-6) and WebGPU / WebCodecs use are reported without
  a trace. Comments are stripped with a tokenizer that knows strings, template literals and regular expressions; XR
  feature names count only inside `requiredFeatures` / `optionalFeatures` lists (UI text such as `'anchors'` does not;
  a `requiredFeatures` entry is the `(required)` key);
  `isSessionSupported('immersive-ar')` is a probe, not an AR request. A feature check of an absent API in the app's
  source (`typeof VideoDecoder`, `'gpu' in navigator`, `if (navigator.gpu)`, `navigator.mediaDevices?.getUserMedia`,
  and for AudioWorklet the instance forms `if (ctx.audioWorklet)`, `'audioWorklet' in ctx`, `ctx.audioWorklet?.`;
  for crypto.subtle `if (crypto.subtle)`, `'subtle' in crypto`, `crypto?.subtle?.`) is recorded with the signal.
  `window.X` counts as a check only as a value (`if (window.X)`, `window.X?.y()`), not when it is called or a member
  of it is used (`window.indexedDB.open()` throws on the headset like `indexedDB.open()`). The catalogue also flags
  the alpha's out-of-scope uses that have a distinctive form: `window.open(`, a navigation to a literal cross-origin
  URL (`location.href = 'https://…'`, `location.assign/replace('https://…')`; a same-document `assign` is not
  flagged), and Web Audio beyond the basic set (`create<Oscillator|BiquadFilter|…>(`, `new OfflineAudioContext`,
  `new <…>Node(`);
- **`--trace`**: what the app called in a headless run trimmed to the headset's surface (above). Requests and
  WebSockets to `native.network.allow` origins go through, `--mirror` prefixes are answered from local directories,
  every other cross-origin request is blocked (as on the headset). `--boot-ms` (default 25000) is how long the run
  waits for a session offer or request: heavy apps load slowly under SwiftShader (proto-levels needs about 90000), and
  a run that ends before the app touched `navigator.xr` says so instead of blaming the app.

| finding | bundle only | app source / config | seen in the headless trace |
|---|---|---|---|
| unsupported API (absent by design, or not in the spec) called/constructed | warn (`--strict`: error) | warn (`--strict`: error) | **error** (with the trim, only APIs not removed can be called: not-in-spec ones) |
| an absent-by-design API used without a feature check: the trimmed run threw (`ReferenceError` for a global; for a `navigator` member or `ctx.audioWorklet`, a TypeError the control run with it left in place did not have; a TypeError that names it, as `navigator.share is not a function` or `window.WebSocket is not a constructor`) | | | **error**, advice |
| the app feature-detects an absent API, and its fallback branch (taken with the API removed) threw where the control run did not | | | **error** ("the app's fallback without it threw") |
| an absent API the app feature-detects (a check in its source, or the trimmed run saw the probe) and the trace did not hit | info | info | info |
| unsupported API only read / probed (feature detection) | info | warn | info |
| in the spec, not implemented yet (`gap`), or specified for later (`later`: AR, quad/cylinder layers) | warn (info if only probed) | warn | warn |
| a stub (warns "not implemented" / throws `NotSupportedError`) | info | warn | warn |
| a stub of an API the spec wants absent (`createScriptProcessor`), called | warn (`--strict`: error) | warn | **error**, advice |
| `<video>`/`<audio>` created (inert stand-in, DOM-6) | info | warn | info |
| `<video>`/`<audio>` played (`play()`, `src=`, `srcObject=`; DOM-6) | warn | warn, advice | **error** |
| cross-origin asset URL not covered by `native.network.allow` (a `ws://`/`wss://` URL: WebSocket is not supported in this alpha) | warn (origins every IWSDK build names in library code: info) | | warn |
| `https://unpkg.com` (IWSDK's default Draco / KTX2 decoder path) while `dist/` has `.ktx2`, Basis or Draco glTF assets | warn | | warn |
| the app never offers an immersive session (`world.xr: false`, `offer: "none"`; XR-LIFE-7, open question 11) | | warn | |
| the app's `@iwsdk/core` is older than the IWSDK the dormant-library baseline was made from (an older minor or major), or a newer major | warn (the message says what to update) | | |
| the app's `@iwsdk/core` is a newer minor, another patch or a prerelease of the baseline's version | info (`--strict` passes) | | |
| IWER (or another WebXR polyfill) bundled into the build | **error** | | |
| the app navigated its page during the run (`location.href = …`, an OAuth redirect, a reload; DOM-5) | | | warn |
| the app never reached XR (with the reason: an `immersive-ar` request the headset rejects, blocked origins, an uncaught error, or still loading at the boot timeout); uncaught errors; a hung main thread | | | warn |

The advice block (feature-detect or remove; there is no fallback route) is printed when an unsupported API is a trace error, or when the app's own source, config or trace
needs `immersive-ar` (asking `isSessionSupported` does not count), a required feature that is specified for later, or an unsupported API (WebGPU, camera, video
playback, WebCodecs), or when the app never offers an immersive session (XR-LIFE-7). `pack --json` carries the
gate's warnings and the advice under `compat` also when the gate passes.

Exit codes: 0 ok, 1 errors (or warnings with `--strict`, or the check could not run), 2 usage. `--trace` resolves
Playwright and IWER from the project's `node_modules` (IWSDK projects have both through `@iwsdk/cli` and
`@iwsdk/vite-plugin-dev`). In a checkout the checker measures the runtime's layers live; an installed CLI uses
`data/surface-snapshot.json` and `data/static-baseline.json` (`node compat/scripts/snapshot.mjs` refreshes the first;
`scripts/baseline.mjs` the second, which records the IWSDK version it was made from; `compat/data` is in the
package's `files`, this README and `scripts/` are not).

## What to do when the check fails

This alpha does not provide every web API (the README's support matrix lists what it does). Out of scope for now:
WebGPU, `<video>` and media streams, WebCodecs, camera/microphone, `AudioWorklet` and Web Audio beyond the basic
set (AudioContext lifecycle, AudioBufferSource, Gain, Panner/Listener, `decodeAudioData`; other nodes and
`OfflineAudioContext` warn as "planned for a later release"), WebSocket, IndexedDB, the Cache API, `crypto.subtle`,
service workers, the system keyboard, `window.open()` / external links / OAuth redirects (`open()` warns: it returns
null on the headset; a cross-origin navigation is logged and ignored there), images other than PNG/JPEG/WebP/GIF, DOM layout/CSS-driven UI, and `immersive-ar` until XR-AR-1. There is no fallback route. When
the checker fails:

1. **Feature-detect the API**: absent APIs are `undefined` on the headset, so `if ('VideoDecoder' in globalThis)`
   or `if (navigator.gpu)` guards take the app's path without it (the stubbed Web Audio nodes, such as
   `createDynamicsCompressor`, are present but throw `NotSupportedError`, so a guard does not help: do not call them). Rebuild and re-run `iwer-native compat --trace`: the trace removes the
   absent APIs before the app runs, so a guarded use takes the fallback there too, and the static mention turns into
   info when the guard is in the app's source (or the trace saw the app probe it). If the fallback branch itself
   throws, the checker says so.
2. **Or remove the use**, then rebuild and check again.

## Sources

The runtime's behaviour spec (requirement IDs and policies), IWER host mode (read for its exported class surface),
the IWSDK samples and `@iwsdk/create` templates as black-box inputs. Public references: WebIDL (where attributes and operations live; `[Global]` interfaces), the HTML Living
Standard (workers, `Sec-Fetch-Dest`), V8's stack trace API (`Error.captureStackTrace`, structured call sites),
Playwright's public API docs.
