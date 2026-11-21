# runtime/core: the V8 embedding (M1)

The core embeds V8 15.5, owns the main JS thread and its event loop, loads the app's ES modules from the APK with
a code cache, routes console output to logcat, reports errors, maps Android lifecycle to page events, serves the
CDP inspector and the debug endpoint, and runs the native module registry. Spec: `docs/spec/01`, `02`, `03`, `14`.

Sources: the behaviour spec (`docs/spec/`), V8 headers (`include/v8*.h`, `libplatform`,
`v8-inspector.h`), the Chrome DevTools Protocol docs, the WHATWG HTML/URL/Fetch/Console standards, RFC 6455/9110/
8259/4648, FIPS 180-4, Android NDK docs.

## Layout

| path | what |
|---|---|
| `include/iwn/core/` | public headers. V8-free: `log.h`, `clock.h`, `event_loop.h`, `timer_queue.h`, `url.h`, `text.h`, `html_scan.h`, `json.h`, `websocket.h`, `loopback_server.h`, `code_cache_store.h`, `lifecycle.h`, `asset_source.h`, `config.h`. V8: `runtime.h` (API for modules), `platform.h`, `module_registry.h`, `runtime_host.h` (for the app shell) |
| `src/base/` | V8-free logic, library `iwn_core_base` (Android + host) |
| `src/v8/` | V8 binding layer, library `iwn_core` (Android only, built `-fno-rtti`) |
| `js/bootstrap.js` | core JS (console, timers, rAF, microtasks, hooks), embedded into the library at build time |
| `test/host/` | host unit tests (`iwn_core_base_tests`, 89 tests) and `iwn_loopback_echo` (real server, echo backend) |
| `test/js/` | Node tests: `bootstrap.test.mjs` (fake natives), `loopback-echo.test.mjs` (Node clients vs the real server) |

## Native module contract

A module lives in `runtime/<module>/` as a CMake static library and exposes

```cpp
void iwn_register_<module>(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Object> natives);
```

It installs its functions on `natives` (JS: `globalThis.__iwn.<module>`). Registration: name the library target
`iwn_<dir>`, or `set_property(GLOBAL APPEND PROPERTY IWN_NATIVE_MODULES "<module>:<target>")`, and add one
`add_subdirectory(<dir>)` line to `runtime/CMakeLists.txt`. `cmake/registry.cmake` generates the table; the core
calls every entry once per page context (again after `location.reload()`), after the core natives exist and
before the core bootstrap and the preludes run. `-DIWN_MODULES_EXCLUDE="a;b"` leaves modules out of the app
(build the `iwernative` target alone to skip compiling them).

Inside the module, `iwn::Runtime::From(isolate)` (`runtime.h`) gives: the page context and its generation,
`post_task()` (any thread; runs as a JS task with scopes, a page TryCatch, error reporting and a microtask
checkpoint; dropped after a reload), `call_function()` (use it for every page callback: see "Errors" below),
`report_exception()`, the `EventLoop` (timers, delayed tasks),
`set_frame_pump()` (the XR loop hook, below), `assets()` / `read_app_file()`, the config, `add_debug_method()`
(e.g. `shot`), `add_stats_provider()`, `set_info_field()` (`glRenderer`, `openxrRuntime`), `mark_boot()`,
`add_shutdown_hook()` (PROC-7 order) and `post_lifecycle()` (`kExternalHidden/Visible` for OpenXR state).

Build notes for module authors: compile with `-DV8_GN_HEADER` (the `iwn::v8` target adds it) and, for classes
that derive from V8 interfaces, `-fno-rtti` (libv8android.so has no RTTI; otherwise the link needs V8 typeinfo).
Host test helper: `iwn_add_host_test(<name> SOURCES ... LIBS ...)` with `test/host/iwn_test.h`.

## Threads

`iwn-js` (8 MB stack: V8 isolate, event loop, all JS), `iwn-inspector` (sockets, HTTP, WebSocket framing),
`iwn-stdio` (stdout/stderr to logcat), `iwn-cache-write` (code cache files), `iwn-mod-read` (one thread for the
page, `SerialWorker`, nice 0 so below the JS thread: reads the files `import()` needs and their cache entries, in
order, joined at teardown), `V8 DefaultWorker` x3, plus the Android UI thread, which
only posts to the JS thread and waits at most 80 ms for it in `onDestroy` (PROC-3).

Timed waits (event loop sleep, quit watchdog, `join`, the inspector's wait loops) use `MonotonicCondVar`
(`monotonic_cv.h`: a pthread condvar on `CLOCK_MONOTONIC`). At API 29 libc++'s `std::condition_variable` turns
timeouts into `CLOCK_REALTIME` deadlines (it needs API 30 for `pthread_cond_clockwait`), so a backwards wall-clock
step would stall timers and frames.

## Event loop (LOOP-1..5, TMR-1..5)

One iteration: V8 platform foreground tasks (GC, compile finalisation), then timers due at the start of the
iteration and the normal tasks queued at that point within a shared budget (8 ms with a frame pump, 50 ms
without; leftovers carry over), then frames, then sleep until the next timer/delayed task/frame/post. Neither
phase can starve the other (LOOP-2, DBG-7): each runs at least one item per iteration even when the other used the
whole budget, and a phase that was cut short goes first in the next iteration. So expensive timers cannot lock out
posted work (DevTools and debug-endpoint drains, lifecycle inputs, module completions, `import()`), and a task
flood cannot lock out timers. Microtasks policy is
`kExplicit`: a checkpoint after every task, timer, rAF callback, lifecycle event and hook. Timers are scheduled in
C++ (`TimerQueue`: HTML ids, nesting clamp, equal-delay order); JS keeps the callbacks. Window rAF runs at 60 Hz
until a `FramePump` is installed; the JS side snapshots the handles (`frameBegin`) and native code calls each
callback (`frameCallback`) and then runs a checkpoint.

Errors (LOOP-4, CDP-5): every page callback (timers, rAF and `queueMicrotask` callbacks, hooks, lifecycle and
readiness events, posted tasks, `call_function`, classic scripts) runs inside a `PageCallScope`, a *verbose*
`v8::TryCatch`, with no JS `try/catch` around page code. That is Chrome's model: V8's exception prediction then
classes the exception as uncaught, so DevTools' "Pause on uncaught exceptions" stops at the throw, and V8 reports it
once through the message listener with its URL, line and column (the window `error` event, logcat, DevTools).
`queueMicrotask` callbacks run from a native microtask for the same reason. `reportError(e)` reports natively with
the error's own location. While the `error` event is dispatched, a further exception only goes to the console (HTML
"error reporting mode"). Not covered by the core: listener exceptions inside the web glue's `EventTarget.dispatchEvent`
are caught in JS (glue code), so DevTools treats those as caught. The core offers `__iwn.core.invokeCallback(fn,
thisArg, ...args)` for that loop: it calls the listener under a `PageCallScope`, so its exceptions are reported and
paused on as uncaught. A microtask checkpoint between listeners of a runtime-dispatched event (LOOP-1) would also
need the runtime to call each listener itself, which needs the glue to expose its listener list; open.

`Runtime::call_function` (for modules) runs its checkpoint only when no JS is on the stack (HTML "clean up after
running a callback"); called from a native function the page called, it leaves the microtasks to the enclosing
task. There is no JS-callable checkpoint (`runMicrotasks` was removed for that reason).

Clock (TMR-4): `performance.now()` is `CLOCK_MONOTONIC` in nanoseconds divided by 1e6, so its resolution is
sub-microsecond: the clock's 1 ns, and a double keeps better than 1 µs for far longer than any uptime. There is
no coarsening, since a packaged app has no cross-origin isolation concerns. `performance.timeOrigin` is the Unix-epoch time of clock zero (`clock.cc`).

Paused / hidden page (PROC-6, implementer's choice): window timers keep their normal rate while the activity is
paused or the page is hidden; the window rAF fallback stops while `document.visibilityState` is `hidden` (as in
browsers) and the pending request runs on the first frame after the page is visible again. The XR frame rate while
hidden follows the OpenXR session state (M3).

Teardown (PROC-7): the `import()` reader is joined, shutdown hooks run, the context is disposed, then the loop is
closed: every queued task is destroyed on the JS thread while the isolate is alive, and later posts are refused.
A `post_task()` after that is logged and its closure deliberately leaked (it may hold `v8::Global`s of the
disposed isolate); module threads should stop in their shutdown hook.

Reload (`location.reload()`, `Page.reload`, PROC-8): `pagehide`, then the context is disposed and the page's
timers and animation-frame request are dropped. Posted, delayed and platform tasks are kept: they belong to V8
(MemoryReducer, heartbeats), DevTools and the debug endpoint (drains, eval timeouts), or the host (lifecycle,
quit); page completions from `post_task()` carry the context generation and drop themselves in the new page.

XR hook (M3): implement `iwn::FramePump` and call `Runtime::set_frame_pump()`. While `active()`, the loop calls
`run_frame(run_window_frame)` once per iteration instead of sleeping; block in `xrWaitFrame`, run the session's
callbacks, then call `run_window_frame(now_ms)` for window rAF (TMR-5 order), and wrap callbacks in
`set_in_frame_callbacks(true/false)` for GC attribution.

## Assets and boot (PROC-5, MOD-1)

APK assets: `iwn/config.json` (runtime config, `config.h` documents every field), `iwn/v8/snapshot_blob.bin`,
`iwn/prelude/*.js` (classic runtime scripts listed in `config.preludes`, e.g. the web glue), `app/**` (the Vite
dist, verbatim). Boot: V8 init (once per process), isolate, context, `__iwn` natives, registered modules, core
bootstrap, preludes, then `index.html` is scanned at launch: classic scripts in document order, then module
scripts (the first is the entry), then `DOMContentLoaded` and `load`. The app origin is `https://app.local`
(configurable; open question 1), the document URL `https://app.local/`.

Modules: same-origin URLs map to `assets/app/<path>`; `data:` URLs decode inline; `blob:` URLs go through a
resolver the web glue sets with `__iwn.core.setBlobResolver(url => ({bytes, type}) | null)`; cross-origin URLs
fail with a TypeError until the network allowlist exists (NET-5). Bare specifiers are TypeErrors naming the
specifier. `import()` loads and evaluates in a later task. `import.meta.url` / `import.meta.resolve()` are set.
The module map is keyed by the full URL, fragment included, so `./x.js#a` and `./x.js#b` are two module records
and `import.meta.url` keeps the fragment (HTML); the bytes and the code-cache entry are shared (keyed without it).

Code cache (CC-1..4): `<cacheDir>/iwn-code-cache/`, one file per URL with a 128-bit content hash of the source
plus its length (`fast_hash128`: 0.94 ms for 7 MiB on a Quest 3S, against 55 ms for SHA-256), V8's
`CachedDataVersionTag` and a payload checksum; consumed on compile, rejected/stale/corrupt entries are deleted and
regenerated, written 5 s after boot (`codeCache.delayMs`) from the JS thread's `CreateCodeCache` and stored on a
background thread, bounded to 64 MB (LRU), wiped when the version code, runtime build or V8 version changes.
App modules, app classic scripts and the runtime preludes (`iwn-runtime:///...`: web glue, IWER bundle) are
cached; inline scripts are not. Scripts compiled after the first pass (late `import()` chunks) trigger another
debounced pass `delayMs` later. Writes are off the JS thread.

Pack-time code cache (CC-3), decision: not offered. The packer runs on an x86_64 host and cannot run the
byte-identical arm64 V8 15.5 build with the device's flags, so caches are only created on the device on first run
(CC-1/CC-2). Revisit if a pack step ever runs the exact runtime on a device or an arm64 emulator.

File reads and PROC-2: for `import()` (the case that can happen during XR), the page's one `iwn-mod-read` thread
reads the target and the not-yet-loaded files of its static import graph (found with a lexical scan of `import`/`export ...
from` specifiers, at most 256 files) from the APK, which inflates the deflated `.js` entries there, hashes them and
looks up their code-cache entries. Then the JS thread compiles from those bytes. Files the scan misses are read
synchronously as a fallback. Concurrent imports of one URL (fragment ignored) share one read, like HTML's module
map "fetching" state: later callers wait for it and load in the same task, each with a checkpoint before it. A
dependency an earlier read already delivered is not read again. Reads run in order; past 4096 queued imports, or
after teardown, an import reads synchronously in a task. Logged as `import(<url>): read N files (KB) off the JS
thread in X ms` once per read. At boot
(preludes, `index.html`, the entry graph) sources and cache files are still read on the JS thread with
`AAsset_getBuffer`/`fread`. Nothing else runs then, and boot is serial anyway. MOD-8's parallel modulepreload
compile is not done. Compiling (or consuming the cache) stays on the JS thread, as V8 requires for module
compilation without streaming.
Logged per script: `code cache hit|miss|stale|corrupt`, then `consumed` / `rejected by V8`.

## Natives the core installs (`globalThis.__iwn`)

- `core`: `log(level, text)`, `timerAdd/timerClear`, `requestFrame`, `setHooks`, `setBlobResolver`,
  `invokeCallback(fn, thisArg, ...args)` (calls a page callback under the page catch scope: an exception is
  reported as uncaught and DevTools pauses on it; for the glue's `EventTarget` listener loop),
  `enqueueMicrotask` (native microtask, page catch scope), `reportException` (log + DevTools
  only), `reportError` (full "report an exception"), `lifecycleState()` (`{visibilityState, focused,
  readyState}`: the glue's `document` should read it), `reload`, `close`, `inspectorSessions`, `runtimeVersion`,
  `v8Version`, `origin`, `documentUrl`, `isWorker`.
- For the web glue (`web/glue/src/natives.ts`): `clock {now, timeOrigin}`, `loop {queueMicrotask}`,
  `clone {structuredClone}` (ValueSerializer, ArrayBuffer transfer), `crypto {random(view)}` (fills in place from
  the OS CSPRNG: `arc4random_buf` on bionic, `getrandom(2)` on the host; NET-STORE-4), `app {reload, close}`,
  `device {info}`,
  `config` (the config's `glue` section plus `url` and `runtimeVersion`).

The bootstrap installs `console`, `setTimeout/setInterval/clear*`, `queueMicrotask`, `requestAnimationFrame/
cancelAnimationFrame`, `requestIdleCallback/cancelIdleCallback`, `structuredClone`, `reportError`, a minimal
`performance` (only if absent), and `window`/`self` aliases (only if absent). It dispatches error,
`unhandledrejection`, `rejectionhandled`, lifecycle and readiness events through whatever `EventTarget`,
`Event`/`ErrorEvent`/`PromiseRejectionEvent`/`PageTransitionEvent` and `document` the glue provides (falling back
to `on<type>` handlers), so the glue should not redefine timers, console or rAF.

The bootstrap is compiled with an inline source map that ignore-lists it (`ignoreList`, `x_google_ignoreList`).
Console calls and timer callbacks pass through bootstrap wrappers, so their raw CDP stack traces start with
`iwn-runtime:///core/bootstrap.js` frames. DevTools skips ignore-listed frames, so console source links and
uncaught timer errors point at the app's code (CON-3). Logcat stacks still show those frames.

## Logging (LOG-1, LOG-2, CON-2)

Tags: `iwn` (runtime) and `iwn-js` (console and JS errors); working names (spec open question 1). Levels map
debug→D, log/info→I, warn→W, error/assert→E. Messages over 4000 bytes are split on UTF-8 boundaries (newlines
preferred), never truncated. One boot line with runtime/V8/device/OS/app/GL/OpenXR. `stats.logIntervalMs > 0`
adds a periodic stats line (LOG-3; XR fields come with M3).

## Inspector and debug endpoint (CDP-1..10, DBG-*)

On the headset an abstract Unix socket per port, `<packageId>_devtools_<port>` (`inspector.port`, default 9229),
reached with `adb forward tcp:<p> localabstract:<packageId>_devtools_<port>`; a connection from any uid other than
root, the shell (adb) or the app itself is refused (CDP-1: a loopback TCP port would let any app on the device run
JS in the page). Host builds listen on `127.0.0.1:<port>`. Fail closed (CDP-1, CDP-10): when
`inspector.enabled` / `debug.enabled` are absent, or `config.json` is missing or invalid, both follow the APK's
`FLAG_DEBUGGABLE`. They are on in debug builds and off in release builds unless the config turns them on.
`/json`, `/json/list` (one page target), `/json/version`, `/json/activate/<id>`; `/json/protocol` is 404.
WebSocket handshake with case-insensitive header names and token-list `Connection`/`Upgrade` values; every
message out is one unfragmented text frame; `Host` must be loopback (403 otherwise). WebSocket upgrades that carry
an `Origin` other than `devtools://devtools` are refused with 403. Browsers allow cross-origin WebSockets, so
without this check a web page on the headset, or on a desktop with `adb forward` active, could drive `/host` eval.
Node, `ws`, Puppeteer and websocat send no `Origin`, so they still connect. V8 serves Runtime, Debugger,
Profiler, HeapProfiler, Console, Schema; Page/Network/Log/Inspector/Target enable calls, `Emulation.*` and
`Overlay.*` are accepted no-ops, `Page.getResourceTree` returns one frame, `Page.reload` reloads,
`Network.loadNetworkResource` + `IO.read`/`IO.close` serve source maps and their sources to DevTools (CDP-5) from
the app's dist (same-origin URLs), the runtime's assets (`iwn-runtime:///`) and `data:` URLs (not `blob:`, which
would run page JS, possibly while paused). Other methods get `-32601 '<method>' wasn't found`. Debugger/Profiler messages are also dispatched from a V8 interrupt while JS runs
(`Debugger.pause` works mid-task), and so is `Runtime.terminateExecution`, which stops a runaway evaluate or page
loop. Sessions come from `connectShared`; a closed session is parked and freed only outside the pause loop and
outside interrupts, once V8 holds no other reference (v8-inspector.h). While paused, the JS thread serves only inspector messages; the UI thread is
never blocked. If the activity finishes while JS is paused, the pause loop turns on skip-all-pauses and resumes, so
`pagehide`, teardown and the port release still happen; an exit request also ends an `--inspect-brk` wait at
once, and the page does not run. Same-process relaunch: Android runs the new `onCreate` before the old
`onDestroy`, so the old runtime may hold 9501/9601 until its 3 s quit watchdog fires. The new server binds what is
free and retries a busy port on its own thread every 100 ms for 30 s, so the new page boots at once and gets its
endpoints as soon as the old instance lets go (logged `... released by its previous holder; now listening`).
`--inspect-brk`: config `inspector.waitForDebugger` or `am start --ez iwn.inspectBrk true` (the extra only in
debuggable builds); it pauses on the first statement after `Runtime.runIfWaitingForDebugger`.

Debug endpoint: WebSocket path `/host` on the inspector port and, if `debug.port > 0`, on its own port. Request
`{"method", "params", "id"?}`; the reply is the method's result object plus `id` (or `{"error"}`), one frame.
Built in: `eval {expression, awaitPromise = true, timeoutMs = 30000}` → `{result}` (`undefined` → `null`,
non-JSON values → `String(value)`), `stats`, `info`. `shot` answers an error until the XR module registers it.

## V8 flags (JS-3)

The runtime fixes the flags JS-1 needs and applies them after any diagnostic flags, so they cannot be weakened:
`--no-jitless --no-lite-mode --sparkplug --maglev --turbofan --liftoff --wasm-tier-up` (V8's arm64 defaults,
re-asserted one flag per `SetFlagsFromString` call, because V8 drops the rest of a string after an unknown flag;
`platform.cc` `kRuntimeFlags`). V8 15.5 has no `--expose-wasm` flag. Heap (old space 1.5 GB, near-limit callback raises it 25 %
once, JS-4) and the stack limit are per isolate. Diagnostic flags come from `config.v8Flags` (honoured only in
debuggable builds; a release build logs that it ignored them) or `am start --es iwn.v8flags "..."` (debuggable
builds only: the activity is exported, so any app could pass extras). They are applied first and logged, and V8's own complaint about
an unknown flag reaches logcat through the stderr redirect; the app keeps running.

## Thread checks (PROC-2)

Every entry into the main isolate from the loop (tasks, timers, animation frames, `Runtime::call_function`)
checks that it runs on `iwn-js`. A violation logs `PROC-2 violation: ...` and aborts in builds without `NDEBUG`.

## Build and test

```bash
# host: V8-free unit tests + the echo server
cmake -S runtime -B build/host -G Ninja && ninja -C build/host -j 16 iwn_core_base_tests iwn_loopback_echo
build/host/core/iwn_core_base_tests
node --test runtime/core/test/js/*.test.mjs        # bootstrap (fake natives) + Node clients vs the real server
# Android arm64 (NDK r30, the NDK V8 was built with)
NDK=$ANDROID_NDK_HOME
cmake -S runtime -B build/android -G Ninja -DCMAKE_TOOLCHAIN_FILE=$NDK/build/cmake/android.toolchain.cmake \
  -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-29 -DANDROID_STL=c++_shared -DCMAKE_BUILD_TYPE=RelWithDebInfo
ninja -C build/android -j 16 iwernative
```

The `iwernative` link ends with the JS-1 ABI check (`cmake/abi-check.cmake`). It runs `llvm-nm -D` on
libiwernative.so and libv8android.so and fails the build if `std::__Cr` (Chromium libc++) appears or `std::__ndk1`
is missing.

APK and device steps: `runtime/app/README.md`.
