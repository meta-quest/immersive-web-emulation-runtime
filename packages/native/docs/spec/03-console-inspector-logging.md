# 03. Console, logging and the CDP inspector

Sources: Console Living Standard; Chrome DevTools Protocol (tip-of-tree: Runtime, Debugger, Profiler,
HeapProfiler, Console, Log, Inspector, Schema domains; the `/json/*` HTTP discovery endpoints); RFC 6455
(WebSocket) and RFC 9110 (HTTP field names are case-insensitive); V8 `v8-inspector.h`; Chrome DevTools
attaching to an Android app through `adb forward`.

## Console

**CON-1 (MUST).** `console.log/info/warn/error/debug/trace/assert/dir/dirxml/table/group/groupCollapsed/
groupEnd/count/countReset/time/timeLog/timeEnd` exist on the main thread and in workers. Formatting
follows the Console standard's `Formatter` (`%s %d %i %f %o %O %c`, `%c` ignored in logcat).
_Check:_ a runtime test per method; logcat shows `console.log('%d px', 3.7)` as `3 px`.

**CON-2 (MUST).** Every console call goes to logcat under the JS log tag with the Android priority that
matches the level (debug→D, log/info→I, warn→W, error/assert→E), prefixed for workers with the worker's
name or index. Objects are rendered one level deep and bounded (default 4 KB per line; longer messages are
split, not truncated silently).
_Check:_ `adb logcat -s <js tag>` while logging from main and a worker.

**CON-3 (MUST).** While a DevTools session is attached, every console call also arrives as
`Runtime.consoleAPICalled` with correct `type`, `args` (remote objects, inspectable), `stackTrace` and
`executionContextId` (workers: their own contexts, see CDP-6).
_Check:_ DevTools console shows clickable objects and source links into the app's modules.

**CON-4 (SHOULD).** Console output costs nothing measurable when no DevTools is attached and logcat is
the only sink: a console call in an XR frame costs under 20 µs for a short string.
_Check:_ micro-benchmark on device.

## Logging (native)

**LOG-1 (MUST).** Two stable logcat tags: one for the runtime's own messages and one for JS console output
and JS errors. (The names are an open question, see the index; perf tooling follows whatever is
chosen.)
_Check:_ documented; perf tooling parses the chosen tags.

**LOG-2 (MUST).** At boot the runtime logs one line with the runtime version and build id, V8 version,
GL vendor/renderer/version, OpenXR runtime name/version, device model and OS build, the app package and
version. At session start it logs the enabled OpenXR extensions, the swapchain size and format, the
refresh rate list and the chosen rate.
_Check:_ grep after launch.

**LOG-3 (MUST).** A periodic stats line (default every 2 s, configurable, off when 0) during XR with: fps
over the window, refresh rate, session state, swapchain size and array size, per-frame averages for time
blocked in `xrWaitFrame`, JS time between begin and end of frame, time in `xrEndFrame`, number of live
timers, the current CPU/GPU performance levels, GC pause totals and counts (split into inside/outside frame callbacks),
heap used, and allocation per frame (PERF-ALLOC-2). The exact field order is defined by the runtime and
mirrored in `tools/perf-lib.mjs`.
_Check:_ `tools/perf.mjs run --apk` (ported) reads `jsMs`, `waitMs`, `endMs`, perf levels and GC from it.

## Inspector (CDP)

**CDP-1 (MUST).** When enabled in the config (default: on for debug builds, off for release builds, and
switchable for release with an explicit flag), the runtime serves the V8 inspector on the device on an abstract
Unix socket named `<packageId>_devtools_<port>` (port default 9229), reachable from the developer machine with
`adb forward tcp:9229 localabstract:<packageId>_devtools_9229`. It serves only connections from root, the shell
(adb) and the app's own uid: any app could connect to a loopback TCP port and run JS in the page. It never
listens on a network interface. (Host builds, which have no other apps to guard against, use `127.0.0.1:<port>`.)
_Check:_ `adb shell ss -lx` lists `@<packageId>_devtools_9229` and `ss -ltn` no inspector port; a connection
from another app's uid is closed at once; a release build without the flag has no listener.

**CDP-2 (MUST).** HTTP discovery: `GET /json`, `/json/list` return a JSON array with one entry per
debuggable target (the main page, plus one per live worker when worker debugging is on), **the page
target always first** (`tools/profile.mjs` profiles element 0), with `id`,
`type` (`page` / `worker`), `title`, `url`, `webSocketDebuggerUrl`, `devtoolsFrontendUrl`, `faviconUrl`
(may be empty); `GET /json/version` returns `Browser` (runtime name/version), `Protocol-Version` (`1.3`),
`V8-Version`, `User-Agent`, `webSocketDebuggerUrl`; `GET /json/protocol` may 404. Unknown paths return
404 with a short body.
_Check:_ `curl -s localhost:9229/json/version | jq` shows the V8 version; Chrome's `chrome://inspect`
with "localhost:9229" configured lists the app.

**CDP-3 (MUST).** The WebSocket upgrade follows RFC 6455 and accepts header names in any case and
header values per the RFC (`Upgrade: websocket` case-insensitive, `Connection` containing the `upgrade`
token among others). Node's built-in `WebSocket`, `ws`, Chrome DevTools and Puppeteer all connect.
(Regression guard: a case-sensitive handshake rejects Node's lowercase headers; GAP-5.)
_Check:_ connect with Node 24's global `WebSocket` (lowercase headers), with `ws`, and with a raw client
sending `UPGRADE: WebSocket` / `connection: keep-alive, Upgrade`; all get `101`.

**CDP-4 (MUST).** Frames: the runtime accepts text and binary, fragmented messages, ping/pong and the close
handshake from clients; it sends every CDP message as **one unfragmented text frame** whatever its size
(our `tools/profile.mjs` does not reassemble fragments); payloads over 64 KB (heap snapshots, profiles:
tens of MB) move in both directions without blocking the main thread on socket writes.
_Check:_ `HeapProfiler.takeHeapSnapshot` of the showcase completes in DevTools; XR keeps rendering
during the transfer (some stale frames allowed during the snapshot itself, none after); a raw-socket test
client sees FIN set on every frame of a multi-MB `Profiler.stop` reply.

**CDP-5 (MUST).** Domains served by V8's inspector work as in Chrome for a page target: `Runtime`
(evaluate with `awaitPromise`, `returnByValue`, `includeCommandLineAPI`; callFunctionOn; getProperties),
`Debugger` (breakpoints by URL/regex, `debugger;` statements, pause on exceptions, step, source maps when
the dist ships `.map` files or the developer serves them, `scriptParsed` with the app URLs of MOD-3),
`Profiler` (sampling profile; `tools/profile.mjs` works unchanged apart from the port, given CDP-2's
target order and CDP-4's single-frame messages), `HeapProfiler`
(snapshot, sampling), `Console`. Messages are dispatched on the main JS thread.
_Check:_ `node tools/profile.mjs 4` prints a by-function table from the device; DevTools pauses on
`debugger;` inside an XR rAF callback.

**CDP-6 (SHOULD).** Workers are debuggable: either as separate `/json/list` targets or through
`Target.setAutoAttach` with flattened sessions (Chrome's model). A worker's `console.*` reaches DevTools.
_Check:_ set a breakpoint in the KTX2 transcoder worker in DevTools.

**CDP-7 (MUST).** Pausing: while paused, the main thread services only inspector messages; the OpenXR
session is allowed to lose focus/frames (the compositor shows its own loading/tracking state), the audio
callback keeps running (silence or the queued graph, documented), and on resume the app continues. While
JS is paused the app is not killed or closed by the system: whatever frame cadence OpenXR and the
compositor require is met without the paused JS thread (how is the implementer's choice).
_Check:_ pause 60 s in an XR session, resume: session still running, no crash, no ANR.

**CDP-8 (SHOULD).** `--inspect-brk` equivalent: a config/launch flag that waits for a debugger before
evaluating the entry, with `Runtime.runIfWaitingForDebugger` releasing it.
_Check:_ launch with the flag (`am start --ez` extra or config), attach, set a breakpoint in the entry,
release.

**CDP-9 (MUST).** Page-domain stand-ins that tools expect: `Page.enable`, `Page.getResourceTree` (one
frame with the app URL), `Page.reload` (= PROC-8), `Network.enable` (accepted; events optional),
`Emulation.*`/`Overlay.*` (accepted no-ops), unknown domains/methods answer a CDP error naming the method.
_Check:_ DevTools opens without errors in its own console about missing domains other than unsupported
features.

**CDP-10 (MUST).** Security: the inspector and the debug endpoint ([14](14-debug-endpoint.md)) are the
only listening sockets; both refuse connections whose `Host` header names a non-loopback host (DNS
rebinding defence) and both are off in release builds unless explicitly enabled.
_Check:_ `curl -H 'Host: evil.example' localhost:9229/json` → 403.
