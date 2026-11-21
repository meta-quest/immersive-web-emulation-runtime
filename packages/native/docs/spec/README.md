# `@iwer/native` behaviour spec

What the native runtime must do: each requirement says **what** must happen and how to check it, not how
to implement it. Implementers build from this spec, the public specifications named in each file, IWER's
host contract (`packages/iwer/HOST-INPUT.md`, IWER's `src/host/types.ts`) and the package's own docs and
tools.

Status: draft. Requirements that depend on an open question say so; the questions are listed below.

## Conventions

- **IDs.** Each requirement has a stable ID (`AREA-n`). Never renumber. Retire an ID by marking it
  *withdrawn* and leave it in place.
- **Strength.** MUST, SHOULD and MAY are used as in RFC 2119. "MUST, decision pending" means the
  behaviour is required but one choice in it is still open (see the open questions below).
- **Check.** Every requirement ends with an acceptance check: a test (runtime unit test in Node, headless
  runner, host-side native test, device test on a headset) or a measured number. A requirement is done
  when its check passes and is automated where the check says so.
- **"As Quest Browser".** When a behaviour is defined by matching Quest Browser, the comparison runs on
  the same headset, OS build and day. Record the browser's observed value in the requirement once
  measured.
- **Milestones** M1–M6 are the project's milestones (table below).

## Files

| file | area | ID prefixes | milestone |
|---|---|---|---|
| [01-process-event-loop.md](01-process-event-loop.md) | process, threads, lifecycle, event loop, timers, window rAF | PROC, LOOP, TMR | M1 |
| [02-modules-code-cache.md](02-modules-code-cache.md) | V8, ES modules, dynamic import, code cache, `Intl.Segmenter` | JS, MOD, CC | M1 |
| [03-console-inspector-logging.md](03-console-inspector-logging.md) | console, logcat, CDP inspector | CON, LOG, CDP | M1 |
| [04-fetch-assets-network-storage.md](04-fetch-assets-network-storage.md) | fetch over APK assets, network allowlist, URL, Blob, XHR, encoding, storage, crypto | NET, NET-STORE | M1 (assets, modules), M4 |
| [05-workers.md](05-workers.md) | workers, structured clone, MessageChannel | WRK | M4 |
| [06-images-canvas2d.md](06-images-canvas2d.md) | decode, `Image`, `ImageBitmap`, canvases, Canvas 2D **with text** | IMG, C2D | M4 |
| [07-webgl2.md](07-webgl2.md) | WebGL 2 binding: objects, arguments, errors, state, shaders, extensions incl. MSAA multiview, binding perf | GL, GL-CTS, GL-PERF | M2 |
| [08-openxr-session-frame.md](08-openxr-session-frame.md) | OpenXR instance/session lifecycle, idle presentation (no 2D panel), frame loop, swapchain, layers, rate, foveation, perf levels, spaces | XR-* | M3 |
| [09-iwer-host-frame-record.md](09-iwer-host-frame-record.md) | IWER host mode: the shared frame record, input states, host backend, IWER as shipped | XRF | M3 |
| [10-input.md](10-input.md) | controllers, hands, haptics | IN | M3 |
| [11-audio.md](11-audio.md) | Web Audio, decode, real-time rules | AUD | M4 |
| [12-browser-globals.md](12-browser-globals.md) | `window`, `document`, `navigator`, events, observers | DOM | M4 |
| [13-packaging-config.md](13-packaging-config.md) | template APK, Node packer/signer, manifest, `iwsdk.config.json` section, size, `build:metavr`, skills, docs page, package constraints | PKG, PKG-CFG, PKG-SIZE | M5 (PKG-15 from M0) |
| [14-debug-endpoint.md](14-debug-endpoint.md) | host debug endpoint: eval, shot, stats, info | DBG | M1 (eval), M3 (shot) |
| [15-perf-budgets.md](15-perf-budgets.md) | the release gate: fps, GPU, CPU&GPU, JS, perf level, allocation, boot, first-sight, memory | PERF | M6 |
| [16-known-gaps-and-regressions.md](16-known-gaps-and-regressions.md) | known failure modes → requirements; regression guards; headless runner and device suite | GAP, REG, HL | all |

312 requirement IDs and table rows in total, 5 of them withdrawn.

## Milestone exit checks mapped to requirements

| milestone | exit check | requirements that make it up |
|---|---|---|
| M1 V8 embedding | `hello-js` equivalent on device; DevTools attaches | PROC-1..9, LOOP-1..5, TMR-1..5, JS-1..6, MOD-1..9, CC-1..5, CON-1..4, LOG-1..2, CDP-1..6, CDP-8..10, NET-1..4, NET-9, NET-10, NET-12, NET-STORE-1..4, DBG-1, DBG-EVAL, DBG-STATS, DBG-6, DBG-7, HL-3, GAP-5, GAP-12, REG-4, REG-9, REG-20 |
| M2 WebGL2 binding | gl-bench equivalent within GL-PERF-1; conformance subset green | GL-1..27, GL-CTS-1, GL-PERF-1..4, REG-19 |
| M3 OpenXR + IWER host mode | showcase renders in both eyes; one render pass per frame | XR-*, XRF-*, IN-1..7, IN-9, GL-PERF-5, LOG-3, CDP-7, DBG-SHOT, DBG-STAGE, GAP-10, REG-6, REG-7, REG-17, REG-18 |
| M4 browser surface | showcase parity incl. labels and audio; headless runner green | NET-5..8, NET-11, NET-13..16, WRK-*, IMG-*, C2D-*, AUD-*, DOM-*, HL-1..2, GAP-1, GAP-4, REG-1, REG-2, REG-5, REG-8, REG-10..16 |
| M5 packaging | fresh IWSDK project → APK → installs and enters XR, no Android SDK | PKG-*, PKG-CFG-*, XRF-P-2, GAP-7, REG-3 |
| M6 perf gate | targets met; 23 proto samples headless + device | PERF-*, PKG-SIZE-1, HL-4, GAP-2, GAP-3, GAP-6, GAP-8, GAP-9, GAP-11 |

`XR-*` includes XR-IDLE-1..3 (the idle presentation), XR-LIFE-7 (apps that never offer a session),
XR-LAYER-1 (quad and cylinder layers), XR-SEC-1 and XR-CAM-1 (the passthrough cameras). SHOULD and MAY
requirements in a row are planned for that milestone but do not block its exit check. Withdrawn IDs (IN-8,
DBG-LOG, DBG-INPUT, DBG-RELOAD, DBG-8) are in no row.

## Sources used for this spec

- Public specifications: WebXR Device API, WebXR Layers, WebXR Gamepads Module, WebXR Hand Input, WebXR
  Input Profiles; WebGL 1.0/2.0, the WebGL 2.0 IDL and extension registry; OpenGL ES 3.2, Khronos
  `gl.xml`, the GLES/EGL extensions named in [07](07-webgl2.md); OpenXR 1.1 and the KHR/EXT/FB/META
  extensions named in [08](08-openxr-session-frame.md) and [10](10-input.md); Web Audio API; Fetch, URL,
  File API, XMLHttpRequest, Encoding, Streams; HTML (event loop, timers, workers, canvas, images, structured
  clone, Web Storage), DOM, UI Events, Pointer Events, CSSOM View, CSS Fonts; ECMA-262 module semantics;
  Chrome DevTools Protocol; RFC 6455 and RFC 9110; V8 embedder documentation; Android NDK/AAudio/APK
  signing docs; Meta Horizon OS manifest documentation.
- Conformance material: WebGL 1.0 §5.14.8 and WebGL 2.0 (pixel-store rules for `ImageBitmap` and unpack
  buffers, §5.1 buffer types), the `WEBGL_multi_draw` extension XML and conformance test
  `conformance/extensions/webgl-multi-draw.html`, Chromium's `webgl_multi_draw_common.cc` and WebXR
  sources, and WPT `workers/interfaces/WorkerUtils/importScripts/002.worker.js`.
- IWER's host contract: `packages/iwer/HOST-INPUT.md`, `src/host/types.ts`, `src/host/XRHostSession.ts`
  and `src/host/XRHostWebGLBinding.ts`, `src/initialization/XRSystem.ts` and
  `XRDevice.grantOfferedSession` (for the contract's semantics); IWSDK `packages/core`
  (`layers/xr-layer-system.ts`, `init/world-initializer.ts`) and its `layers` example.
- The showcase app (`proto-showcase-vr`, plus the IWSDK proto samples for coverage): its `src/`, its built
  `dist/`, and on-device measurements of it on Quest 3 against Quest Browser (2026-10-19: frame rate,
  stale frames, App GPU, CPU&GPU, CPU level, per-frame JS and GL time, first-frame work).
- The default origin `https://app.local` is a placeholder until open question 1 is settled.

## Open questions

1. **Names in the product surface:** the two logcat tags (LOG-1), the `iwsdk.config.json` section name
   (PKG-CFG-1), and the default app origin (MOD-2; the draft uses `https://app.local`).
2. **`navigator.userAgent` (DOM-4):** keep it honest (`Android`, runtime name/version, no browser
   tokens), or add Quest Browser tokens so that UA-sniffing code (including IWSDK's injected emulator,
   which stands down on `OculusBrowser`) treats the app like Quest Browser? The draft requires only
   `Android` + runtime name/version.
3. **`VENDOR`/`RENDERER` (GL-13):** browser-masked strings (`WebKit` / `WebKit WebGL`) with the real
   ones behind `WEBGL_debug_renderer_info`, or the driver strings directly?
4. **Index range checking (GL-11):** robust buffer access context (spec-conformant, GPU cost to be
   measured) vs documented non-validation.
5. **IWER host input backing store (XRF-IN-2):** change IWER so the host can supply the state arrays
   (zero copy), or accept one `set()` per field per frame?
6. **The four open IWER host-input decisions (XRF-P-4):** hand gamepad layout (10 vs Quest Browser's 5
   buttons), left `menu` at 7 by default, `getPose` typed `XRPose | null`, no gaze source with host input
   on.
7. **Audio autoplay (AUD-1):** context starts `running`, or starts `suspended` and `resume()` always
   succeeds?
8. **Bundled font (C2D-9):** which font(s) to ship with every APK (license and size: one Latin sans is
   ~300 KB; a CJK fallback would be several MB and is not in the draft).
9. **Proposed budgets:** IWER host path ≤ 0.15 ms/frame (XRF-P-3), ≤ 64 B/frame for "~0" allocation
   (PERF-ALLOC-1), ≤ 2 JS→native transitions per draw (GL-PERF-4), whole prelude ≤ 1.3 MB (XRF-P-1),
   worker `hardwareConcurrency` cap 4 (WRK-12), C2D-3's two-context costs. PERF-LVL-1 uses "≤ 2" in every
   second; an earlier draft relaxed it to 90 % of seconds. Should a short ramp at view changes be
   tolerated?
10. **Scope:** the draft leaves a Meta Platform SDK provider (entitlement, leaderboards, achievements) out
    and records `immersive-ar` (passthrough, planes/meshes) as later (XR-AR-1). Confirm.
11. **No 2D panel; what happens around sessions (XR-IDLE-*, XR-LIFE-5):** the draft has no 2D panel mode,
    shows black (or an optional loading image) before the first WebXR frame and between sessions, and
    exits to home if the app ends its session and does not start another within 2 s. Alternatives: exit
    at once on `end()`, stay in the idle presentation indefinitely, or add a 2D panel mode (which would
    bring back IN-8 pointer input). The same question covers apps that never offer or request a session
    (XR-LIFE-7: error line at 10 s, exit to home at 30 s in the draft), and whether `pack` should also
    warn when it can tell the app will not offer one.
12. **rAF `time` argument (XR-LOOP-5):** IWER host mode passes the predicted display time; Quest Browser
    passes the frame start time and keeps the prediction in `predictedDisplayTime`. Change IWER to match
    Quest Browser (needs a frame-start time in the host frame record), or keep it? Either way window
    rAF callbacks get the frame start time (TMR-5, XRF-B-2).
13. **Quad and cylinder layers (XR-LAYER-1):** decided: implemented (IWER host mode adds both methods and the host
    hooks; the runtime submits OpenXR quad and cylinder layers), so IWSDK needs no feature-detection change.

## Measurements still to take (needed to finish some checks)

On a test headset (Quest 3S, re-baselined; Quest 3 where available), same session:

- gl-bench nanoseconds per call for each GL function, in the runtime and in Quest Browser (GL-PERF-1).
- Quest Browser values to match: `getSupportedExtensions()` (GL-23), all `getParameter` limits (GL-14),
  trigger/squeeze `pressed` thresholds and hysteresis (IN-3), `inputSource.profiles` per controller (IN-2),
  whether window rAF keeps running during an immersive session (TMR-5),
  `session.trackedSources` contents, `getViewerPose(local-floor)` height on a marked spot (XR-SPACE-1),
  boot-to-first-XR-frame for the showcase (PERF-BOOT-1).

## Tools the checks use

Device checks drive a running app through the debug endpoint ([14](14-debug-endpoint.md), whose contract
the perf and RPC tools rely on), the CDP inspector ([03](03-console-inspector-logging.md)) and the VrApi
log line per second ([15](15-perf-budgets.md)). The headless runner (HL-*) boots the same runtime JS in
Node with fake natives.

## Changing this spec

Every change names its source. A requirement found wrong during implementation is updated here first,
with the reason, then implemented.
