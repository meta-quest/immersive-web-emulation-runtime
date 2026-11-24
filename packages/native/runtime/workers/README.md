# runtime/workers: Worker, MessagePort and structured clone across isolates (M4)

Dedicated workers for the runtime: each `Worker` is its own V8 isolate on its own thread with its own
`iwn::EventLoop` (the core's loop, timers and platform task routing), classic and module workers with
`import.meta.url` and dynamic `import()`, `importScripts`, `postMessage` with the HTML structured
serialize-with-transfer algorithm over V8's `ValueSerializer`, `MessageChannel`/`MessagePort` within and across
threads, `SharedArrayBuffer` + `Atomics` and WebAssembly threads. JS side: `web/workers` (the prelude).
Spec: `docs/spec/05-workers.md` (WRK-1..12), plus JS-2, PROC-4, PROC-6, PROC-7, CC-5, GAP-4, REG-8, REG-11, REG-12.

Sources: the behaviour spec (`docs/spec/`), the WHATWG HTML standard (§9.3 postMessage, §9.4 channel
messaging, §10 workers, §2.7 structured data), ECMA-262 module semantics, WebIDL, the WebAssembly core spec
(binary format, for the feature probe), V8 headers (`v8-value-serializer.h`, `v8-isolate.h`, `v8-array-buffer.h`,
`v8-wasm.h`, `v8-script.h`), Android NDK docs, and our own runtime contracts (core `runtime.h`, `event_loop.h`,
`platform.h`, `iwn/loop_hooks.h`, `image/INTEROP.md`).

## Layout

| path                                                     | what                                                                                                                                                                                |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `include/iwn/workers/port_hub.h`, `src/core/port_hub.cc` | V8-free port table: entangled pairs, queued-until-started delivery, one delivery task per message, transfer (detach/adopt keeps the queue), close/disentangle, message log (WRK-10) |
| `include/iwn/workers/policy.h`, `src/core/policy.cc`     | V8-free policy: the `workers` config section, the live-worker limit (WRK-9), worker URL checks (WRK-1), script fetch (same-origin assets, `data:`), thread names (PROC-4)           |
| `src/v8/binding.cc`                                      | `__iwn.workers` natives, per-isolate bindings and owners, process-wide registry                                                                                                     |
| `src/v8/register.cc`                                     | `iwn_register_workers` (page and worker), shutdown hook, `workerStats` stats section, `workers` debug method                                                                        |
| `src/v8/worker_runtime.cc`                               | the worker thread: isolate, loop hooks, worker core natives, bootstrap, preludes, script, errors, teardown                                                                          |
| `src/v8/worker_modules.cc`                               | module workers, static/dynamic import, `import.meta`                                                                                                                                |
| `src/v8/serializer.cc`                                   | cross-isolate serialize/deserialize (transfer, SAB, wasm modules, host objects)                                                                                                     |
| `src/v8/script_cache.cc`                                 | compiling with the worker code cache (CC-5); the cache itself (memory + disk tiers, V8-free): `src/core/script_cache.cc`                                                            |
| `test/host/`                                             | host unit tests (`iwn_workers_core_tests`, 26 tests)                                                                                                                                |
| `test/device/`                                           | device test app (`app/`), runner (`run.mjs`), wasm feature probe (`wasm-features.mjs`)                                                                                              |

## How it works

**Threads and isolates.** `new Worker()` reserves a slot (WRK-9), creates an entangled port pair (the creator owns
the outside port, the worker adopts the inside one) and starts a detached pthread `iwn-w<id>-<name>` (4 MB stack,
nice 10: below the JS thread and the audio thread, WRK-11). The thread creates an isolate through the core's
`new_isolate()` (so V8's foreground tasks, `Atomics.waitAsync` included, land in the worker's own `EventLoop`),
with its own heap limit (256 MB) and an `array_buffer_allocator_shared`, so a `BackingStore` that leaves the worker
keeps its allocator alive (JS-2, REG-8). The isolate stays entered for the worker's whole life.

**Worker global.** `globalThis.__iwn` gets worker versions of the core natives (log, timers, rAF, hooks,
microtasks, error reporting, clock, crypto, clone, device info with the WRK-12 cap, `config` with `scope: 'worker'`
and the worker URL), then the native modules from the page's registry table except `workers.excludeModules`
(default `gl`, `audio`, `storage`, `xr`; WRK-2), with this loop's `IwnLoopHooks` bound first (net, image and
canvas2d complete their work on this loop). Then the core bootstrap (`kBootstrapJs`: console with a `[name]`
prefix, timers, microtasks, error hooks), worker-scope stubs (so the image prelude shapes a worker global), and the
preludes (default: the page's list: web glue in worker scope, image, canvas2d, net, workers, ...).

**Script.** `blob:` URLs are resolved by the creator in its own blob store and the bytes are handed over;
same-origin URLs and `data:` URLs are read on the worker thread (workers may block). Classic scripts run with a
verbose `TryCatch`; module scripts load their graph synchronously on the worker thread (assets, `data:`, the
worker's own `blob:` store) and evaluate (top-level await allowed). Then the implicit port's queue is enabled, so
messages posted before the script ran arrive in order (HTML "run a worker", WRK-6).

**Messages.** `postMessage` serializes natively with `ValueSerializer`: transferred `ArrayBuffer`s move their
`BackingStore` into the message and are detached only after serialization succeeded; `SharedArrayBuffer`s (and
shared `WebAssembly.Memory`) share their `BackingStore`; `WebAssembly.Module`s share the compiled module. Platform
objects implemented in JS (MessagePort, ImageBitmap, ImageData, Blob, File, DOMException, geometry types) are host
objects found by prototype (`hostPrototypes`); the JS `hostWrite` hook turns each into a plain descriptor. V8 runs no
JS while deserializing (`DisallowJavascriptExecution` inside `ValueDeserializer`), so descriptors travel in a second
buffer and the receiver revives them with `hostRead` before reading the value (identity and cycles through host
objects are kept: the value refers to them by index). The message goes through the `PortHub`: each delivery is one
task on the receiver's loop (`Runtime::post_task` on the page, the worker's loop otherwise), so a burst never
starves frames (LOOP-2). A message that is never delivered closes the ports it carried and discards its ImageBitmap
tokens (`iwn::image::TransferRegistry`).

**Errors (WRK-7).** An uncaught exception in a worker fires `error` at the worker global; if not cancelled, an
`ErrorEvent` (message, filename, lineno, colno) at the `Worker` object; if not cancelled there, HTML repeats the
report one level up (the creator's global `error` event; nested workers forward again); if nobody cancels it, the
page logs `[worker <id> '<name>'] Uncaught ...` with the location. A script that fails to load fires a plain `error`
event. Unhandled rejections are dispatched in the worker and logged with its name.

**Termination (WRK-8).** `terminate()` calls `Isolate::TerminateExecution()` (thread-safe; it interrupts JS loops,
wasm loops and `Atomics.wait`) and stops the loop; the creator's end of the port is closed at once (queued messages
are dropped). The worker thread then tears down in an order that cannot crash: terminate its own children, close its
ports, `image::DisposeIsolate` (while the loop hooks are bound, `image/INTEROP.md` §7), `canvas2d::DisposeIsolate`,
`iwn_net_dispose_isolate`, `iwn_storage_dispose_isolate` (weak references: modules not linked are skipped), unbind
the loop hooks, drop all handles, close the loop (queued tasks destroyed while the isolate is alive), dispose the
isolate, release the slot. `self.close()` lets the current task finish and discards later ones.

**Page lifecycle.** `location.reload()` terminates the old page's workers (a document's workers end with it).
App exit (PROC-7): a core shutdown hook terminates every worker and joins the threads (bounded by
`workers.joinTimeoutMs`): 8 workers (6 wasm-vips pthreads blocked in `Atomics.wait`, one in `for(;;){}`) stopped in
6.7 ms on a Quest 3S. Pause/resume (PROC-6, implementer's choice): workers keep running while the activity is
paused or hidden, like the page's timers (core policy); no worker is suspended or restarted.

**Code cache (CC-5).** The first isolate that compiles a script of at least 1 KB (prelude, worker script, worker
module) produces V8's code cache right away; later worker isolates consume it (in memory, LRU, 32 MB). Entries are
also written to `<cacheDir>/iwn-worker-code-cache/` (`CodeCacheStore`: source hash and V8 version/flags tag per
entry, corrupt files detected, LRU-bounded by `codeCacheMB`, wiped when the version code, runtime build or V8
changes; off when the page's `codeCache.enabled` is false), so the next launch consumes them too. `blob:` and
`data:` scripts are keyed by their source's hash (a `blob:` URL is new on every launch). Stats (`workerStats.codeCache`):
`hits` (including `diskHits`), `misses`, `diskWrites`. Quest 3, IWSDK app with a physics and a locomotion worker:
cold launch 8 misses, 8 disk writes; warm launches 14 hits (8 from disk), 0 misses (before: 8 misses on every
launch); the physics worker's preludes 68 → 48-56 ms. Earlier in-process measurement:
497 hits, 12 misses over a test run; a worker boots in ~59 ms median (first one ~104 ms), of which ~4 ms are
isolate + context + natives + bootstrap and ~55 ms the preludes (the web glue dominates): the next lever if worker
startup matters (a startup snapshot with the glue, or a smaller worker prelude set).

## `__iwn.workers` (contract with `web/workers/src/natives.ts`)

Both kinds of global: `setHooks({dispatch, hostWrite, hostRead, hostPrototypes})`, `info()`,
`create(url, type, name, sourceBytes|null, deviceInfo)` → `[workerId, outsidePort]`, `terminate(id)`,
`channel()` → `[a, b]`, `serialize(value, arrayBuffers)` → pending id, `post(port, pending, portIds, bitmapTokens)`,
`discard(pending)`, `start(port)`, `close(port)`, `stats()`. Worker globals only: `readScript(url)`,
`evalScript(source, url)`, `closeSelf()`, `forwardError(message, filename, lineno, colno)`.
Native events: `dispatch('message', port, data, portIds, tokens)`, `('messageerror', port, portIds, tokens)`,
`('error', workerId, info)`, `('loaderror', workerId, message)`, `('exit', workerId)`.

## Config (`assets/iwn/config.json`, top-level `workers`, all optional)

`maxWorkers` 32, `heapLimitMB` 256, `stackKB` 4096, `nice` 10, `crossOriginIsolated` true, `hardwareConcurrency` 4,
`preludes` (default: the page's), `excludeModules` `["gl","audio","storage","xr"]`, `messageLog` -1 (256 entries in
debuggable builds), `joinTimeoutMs` 2000, `codeCacheMB` 32. Documented in `include/iwn/workers/policy.h`.

## Decision to confirm: cross-origin isolation

The stream brief asks for `SharedArrayBuffer` + `Atomics` with `crossOriginIsolated = true` by policy (WebAssembly
threads need it: Emscripten pthread builds post shared memory to their workers). Spec revision 4 says the opposite
(WRK-5: SAB throws `DataCloneError`, DOM-1: `crossOriginIsolated` false, JS-1: "threads-off"). Implemented as config
`workers.crossOriginIsolated`, default **true**: SABs and shared `WebAssembly.Memory` cross threads, and the prelude
redefines `crossOriginIsolated` (the glue hardcodes false). With `false`, posting a SAB throws `DataCloneError` (the
spec's behaviour). The `SharedArrayBuffer` constructor exists either way (V8 default), and `Atomics.wait` is
refused on the page thread (core: as in browsers) and allowed in workers. A packaged app has no cross-origin
content to protect, so the browser's reason for gating SAB does not apply. The default is an open decision; the spec needs updating
whichever way.

## Status by requirement (device: Quest 3S, 2026-10-20)

| ID                     | status                                  | evidence                                                                                                                                                                                                                                                                                                                              |
| ---------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WRK-1                  | done                                    | same-origin, `data:`, `blob:` (classic + module), relative to the creator's base; cross-origin → `SecurityError`                                                                                                                                                                                                                      |
| WRK-2                  | done in this stream; one gap in web/net | the worker `typeof` list (43 present, 7 absent incl. `requestIdleCallback`) passes; relative `importScripts` in `blob:`/`data:` workers throws `SyntaxError`; relative `fetch` there does **not** reject (web/net's `baseURL()` falls back to the app origin for non-http locations; device test WRK-2-fetch fails until net changes) |
| WRK-3                  | done                                    | module worker static + dynamic import, `import.meta.url`/`resolve`; `import()` in classic workers                                                                                                                                                                                                                                     |
| WRK-4                  | done                                    | same-origin, `data:`, worker-made `blob:`, in order; `NetworkError`, `SyntaxError`; `TypeError` in module workers                                                                                                                                                                                                                     |
| WRK-5                  | done (SAB per the decision above)       | round trip of every listed type incl. Blob/File/ImageData/ImageBitmap; sync `DataCloneError`; 64 MB transfer: postMessage 0.19-0.42 ms, sender detached, same memory back                                                                                                                                                             |
| WRK-6                  | done                                    | cross-thread port transfer, 100-message RPC in order incl. messages queued before start; comlink 4.4.2 `wrap`/`expose`/`transfer`/`proxy` round trip                                                                                                                                                                                  |
| WRK-7                  | done                                    | `ErrorEvent` at the Worker with `filename`/`lineno`/`colno` (3:3), `preventDefault()` suppresses the log, load failure is a plain `Event`                                                                                                                                                                                             |
| WRK-8                  | done                                    | terminate in `for(;;){}` and in a wasm `loop br 0`: thread torn down and slot released 4.3-4.6 ms after `terminate()`; 300 random-point terminations while 64 KB buffers fly both ways (≈47k bounces): no crash; 500 create/message/terminate cycles: RSS -24 MB, threads 37 → 37                                                     |
| WRK-9                  | done                                    | `NotSupportedError` past `maxWorkers`; a worker past its 256 MB heap is terminated (`error` "Worker terminated: out of memory") and the app keeps running                                                                                                                                                                             |
| WRK-10                 | done (SHOULD) via the debug endpoint    | `workers` debug method: live workers, message totals and the last N messages (direction, worker label, bytes, time); `workerStats` in `stats`. DevTools worker targets (CDP-6) are not done                                                                                                                                           |
| WRK-11                 | done                                    | `ps -T`: workers NI 10 (PRI 9), page JS thread NI -10; no affinity is used                                                                                                                                                                                                                                                            |
| WRK-12                 | done                                    | `navigator.hardwareConcurrency` = min(cores, 4) in the page and workers                                                                                                                                                                                                                                                               |
| JS-2, REG-8            | done                                    | transferred memory freed by the last owner (shared allocator), workers terminated with buffers in flight                                                                                                                                                                                                                              |
| CC-5                   | done (SHOULD), in memory + on disk      | see Code cache                                                                                                                                                                                                                                                                                                                        |
| PROC-4, PROC-6, PROC-7 | done for workers                        | thread names; workers run through pause/resume (ticks continued, state kept); exit joins them                                                                                                                                                                                                                                         |
| SIMD + threads         | verified with real libraries            | Rapier SIMD build in a worker == on the page (bit-identical); Havok (IWSDK's engine) in a worker; wasm-vips pthreads: 6 `em-pthread` module workers, 1 thread 1084 ms vs 4 threads 342 ms (3.2x)                                                                                                                                      |

Not done: CDP-6 (worker targets in DevTools), BroadcastChannel (optional), `SharedWorker`, persistent on-disk
code cache for workers, `OffscreenCanvas` transfer (no transferable OffscreenCanvas in web/canvas2d yet: posting one
throws `DataCloneError`), cross-origin `importScripts` over the network allowlist.

## Build and test

```bash
# host: V8-free unit tests
cmake -S runtime -B build/host -G Ninja && ninja -C build/host -j 8 iwn_workers_core_tests
build/host/workers/iwn_workers_core_tests
# JS prelude: typecheck, build, Node tests (fake natives with the same contract)
cd web/workers && npm ci && npm run verify
# Android library: as in runtime/core/README.md (iwernative links iwn_workers through the registry)
# device: pack + install + run + report (a headset on adb; IWN_ADB replaces the `adb -s <serial>` command)
node runtime/workers/test/device/run.mjs --build <android build dir> --deps <deps dir> \
  --serial <serial> --port 9510 [--keep]
node runtime/workers/test/device/wasm-features.mjs <file.wasm>   # which libraries need SIMD / shared memory
```

The device run logs `WORKERS PASS n/m` and writes `report.json` (results, `ps -T`, `/proc/<pid>/status`, the
`workers` debug method, the 500-cycle RSS check, the pause/resume check) and `logcat.txt`.
