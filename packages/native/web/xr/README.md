# web/xr: WebXR for @iwer/native (IWER host mode over the native XR module)

The prelude `dist/xr.min.js` (evaluated after the web glue and the WebGL prelude, before the page) bundles IWER's
host entry point (`iwer/host`, from this checkout's IWER sources) and the adapter in `src/`, and installs IWER on
`navigator.xr` driven by `globalThis.__iwn.xr` (runtime/xr). Without the native XR module (headless runner without
XR natives) it leaves `navigator.xr` alone. Design, config, device results: `runtime/xr/README.md`.
Spec: `docs/spec/08`, `09`, `10`.

| file | what |
|---|---|
| `src/entry.ts` | the prelude entry |
| `src/install.ts` | the `XRDevice` (capabilities from OpenXR, controller profile by headset model), host input, session bookkeeping for the native side (offers and requests pending or all rejected, XR-LIFE-7), the feature set of this release (later features not granted, anchors reject, immersive-ar opt-in), the frame handler |
| `src/backend.ts` | IWER's `XRHostBackend` over the natives (swapchain, end, frame rate, foveation, passthrough, window rAF, tasks, errors) |
| `src/record.ts` | the frame record read in place: one long-lived `XRHostFrame` whose arrays are views onto native memory; input copied with one `TypedArray.set` per field |
| `src/graphics.ts` | the session's opaque colour texture that follows the acquired image, depth/stencil invalidation, the end-of-frame fence, then the image parked until the next frame (detached in GL from every framebuffer that renders into it, so drawing outside a frame reaches no image: XR-SC-3). Framebuffers are found by watching the session context's binds (plus the one bound when the layer is made); the list keeps at most 32, dropping deleted ones first, then the oldest that holds no session image: one that holds it is never dropped, however many targets the app cycles through |
| `src/geometry.ts` | `DOMPointReadOnly`/`DOMPoint` when no other layer provides them |
| `src/layout.gen.ts` | generated record indices (`runtime/xr/gen/generate-layout.mjs`) |
| `src/natives.ts`, `src/iwer-host.d.ts` | the contracts this adapter consumes |
| `test/` | Node tests against fake natives (the shipped bundle in a fresh V8 context), the record round trip with the native writer (`IWN_XR_RECORD_DUMP`), and the WebGL prelude's `retargetTexture` hook this adapter calls twice per frame (its GL calls per attachment kind, and no allocation per call: `retarget-hook.test.ts` runs `retarget-probe.mjs` in a child process with a fixed young generation) |

```bash
npm install                                                   # once (registry: DEVELOPING.md)
node build.mjs                                                # dist/xr.js, dist/xr.min.js + size line (XRF-P-1)
IWN_XR_RECORD_DUMP=<host-build>/xr/iwn_xr_record_dump npm run verify
```

Size: `xr.min.js` 191.9 KB minified, 59.6 KB min+gzip (IWER host entry 144.3 KB, gl-matrix 33.1 KB, adapter 14.2 KB).

Per-frame allocation: IWER + this adapter allocate ~17 B per frame in Node (x64, no pointer compression; a
three.js-shaped frame callback with two controllers). On device (pipeline app, its own loops stopped) the whole
host + IWER path is 144 B per frame, down from 576 in round 2: `retargetTexture` allocated ~216 B per call, twice per
frame since images are parked (`runtime/xr` m3-check `alloc` case). PERF-ALLOC-1 asks <= 64 B; the rest is outside
IWER and the adapter (a follow-up).
