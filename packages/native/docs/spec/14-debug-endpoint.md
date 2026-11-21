# 14. Host debug endpoint (eval, stats, screenshot, info)

Scope: the small JSON protocol that metavr, the agent skills and our tools use to drive a running app
without DevTools. The inspector itself is [03](03-console-inspector-logging.md).

Sources: the product design (debug endpoint: eval, stats, eye-buffer screenshot, used by metavr and
skills); the perf and RPC tools that drive it (they call only `eval`, `shot` and `stats`); RFC 6455; the known Quest constraint that
`adb shell screencap` is black during an immersive session, so eye-buffer screenshots must come from the
runtime.

Contract (what those tools expect): the client runs
`adb forward tcp:<port> tcp:<port>` (default port 9229), opens a WebSocket to `ws://127.0.0.1:<port>/host`,
sends one masked text frame `{"method": …, "params": {…}}` with no `id`, then treats the **first
WebSocket frame** it receives as the complete reply and closes. It does not reassemble fragmented
messages. It reads `result` from an `eval` reply, `png` (base64) from a `shot` reply, and stores the whole
`stats` reply as opaque JSON. The perf tool labels its tables from `eval('window.__info()')`, a function
its own injected script defines (DBG-STAGE), not from the `info` method.

The method set is deliberately small. Anything beyond it (log access, scripted input, pose overrides,
reload, a CDP facade for browser-oriented tools) is not required here. If the implementation adds such
methods, it chooses their names and shapes and documents them with the package.

**DBG-1 (MUST).** The endpoint is a WebSocket path on the inspector's port (or its own loopback port;
default: same port, path `/host`), enabled under the same rules as CDP-1/CDP-10. Each request is one text
message `{"method": string, "params": object, "id"?: number}`. Each reply is one text message that carries
the same `id` (when given) and either the method's result or `{"error": string}`. **Every reply is sent as a
single unfragmented WebSocket frame (FIN set, text opcode), whatever its size** (multi-MB `shot` replies
included), because our client reads only the first frame. Several requests may be sent on one connection;
replies may arrive out of order (matched by `id`). A client that sends one request per connection without
`id` gets exactly one reply. A method the runtime does not implement gets an error reply, not silence.
*Check:* a minimal Node client written from the inlined contract (or `tools/host-rpc.mjs` once moved,
README) sends `eval {expression: '1+1'}` and gets `{result: 2}`; the same first-frame-only client receives a
complete `shot {eye: 'both'}` reply that parses as JSON; a pipelined client gets id-matched replies; an
unknown method gets an error reply within 1 s.

**DBG-EVAL (MUST).** `eval {expression, awaitPromise = true, timeoutMs = 30000}` evaluates in the main
page's global, awaits a returned promise while frames and tasks keep running (LOOP-5), and returns
`{result}` with the JSON-serialisable value (`undefined` → no `result` key or `null`, documented) or
`{error}` with the exception text and stack. Values that cannot be serialised return their `String()` form.
*Check:* `eval('new Promise(r => setTimeout(() => r(42), 500))')` → 42 after ~0.5 s with frames
continuing; `eval('throw new Error("x")')` → error containing `x`.

**DBG-SHOT (MUST).** `shot {eye: 'left' | 'right' | 'both', scale = 1}` captures the eye buffer of the next
submitted frame after the app's rendering. The PNG shows what the compositor displays (sRGB-encoded RGBA8,
no double gamma, top row first). The reply is `{png: base64, width, height, frame}`. PNG encoding does not
run on the main thread. With no immersive session it captures what the runtime is presenting at that
moment (XR-IDLE-1). A capture costs at most one stale frame.
*Check:* the two-colour multiview test (GL-24) shows the right colour per eye; XR-COL-1 patches match; the
perf sweep's screenshot option writes PNGs.

**DBG-STATS (MUST).** `stats {}` returns a JSON object with at least: runtime/V8 versions, uptime, boot
timeline marks (process start, engine ready, entry evaluated, session granted, first XR frame, code cache
written), current fps and refresh rate, session/visibility state, swapchain size, per-frame averages over
the last stats window (wait/JS/end ms, GL calls, draws, JS→native transitions), CPU/GPU performance
levels, GC counts and pause time split into "during frame callbacks" and "outside them", heap used/limit,
external memory, allocation per frame (PERF-ALLOC-2), worker count, pending tasks/timers, audio state and
xrun count, blocked network origins, and the miss report (DOM-11) counts.
*Check:* the perf sweep against the APK stores it per view as `hostStats`.

**DBG-LOG (withdrawn).** Log access through the endpoint is not required (logcat and CDP cover it).
*Check:* none while withdrawn.

**DBG-INPUT (withdrawn).** Scripted input through the endpoint is not required.
*Check:* none while withdrawn.

**DBG-RELOAD (withdrawn).** A reload method is not required (`eval('location.reload()')` and CDP's
`Page.reload` cover it; PROC-8, CDP-9).
*Check:* none while withdrawn.

**DBG-6 (MUST).** `info {}` returns device model, OS build fingerprint, runtime version and build id, V8
version, GL renderer, OpenXR runtime, app package/version and enabled features, for metavr and the agent
skills to label runs. (Our perf tool does not call it today; see the contract above.)
*Check:* the minimal client from DBG-1 calls `info {}` on device and gets every listed field, non-empty.

**DBG-7 (MUST).** The endpoint never blocks the frame loop: socket I/O and parsing happen off the main
thread, JS-side work runs on the main thread as ordinary tasks (LOOP-2), and slow work (screenshot
encoding) completes off the main thread.
*Check:* 10 back-to-back `shot` requests during XR cause ≤ 10 stale frames in total and no ANR.

**DBG-8 (withdrawn).** A dedicated "enter XR" method is not required; DBG-STAGE uses `eval`.
*Check:* none while withdrawn.

**DBG-STAGE (MUST).** Our perf tool's staged build works with nothing from the endpoint beyond `eval`.
That build is the app's dist with one extra classic script placed before the entry in `index.html`. The
script replaces `navigator.xr.offerSession` with its own function that holds the offer; the driver later
calls, through `eval`, a global function the script defines, which calls `navigator.xr.requestSession` and
resolves the held offer. For that to work: classic scripts run before the entry (MOD-1); `navigator.xr`
exists before any page script runs; `offerSession` can be replaced by plain assignment on `navigator.xr`
and the bundle's later calls reach the replacement; `requestSession` from an `eval` task succeeds without
user activation (XR-LIFE-1). The staged build uses the default grant mode and does not rely on
XR-LIFE-2's explicit-grant switch.
*Check:* a staged APK of the showcase (the tool's `stage` output, packed with the inspector on) stays in
the idle presentation after launch; an `eval` that calls the staged script's enter function enters the
session within 5 s.

IDs: DBG-1, DBG-6 and DBG-7 keep their numbers next to the named IDs (the README convention forbids
renumbering), and the withdrawn IDs stay in place.
