# 05. Workers, messaging and structured clone

Sources: HTML §10 (Web workers, `WorkerGlobalScope`, module workers, `importScripts`), §2.7 (structured
serialize/transfer), §9.4–9.5 (MessageChannel, MessagePort, BroadcastChannel); V8 `ValueSerializer`
docs; WPT `workers/interfaces/WorkerUtils/importScripts/`; three's `KTX2Loader`
worker pool as used by IWSDK; the showcase's dist (its worker chunks).

**WRK-1 (MUST).** `new Worker(url, { type: 'classic' | 'module', name })` runs the script on its own
thread and isolate with its own event loop (LOOP-1 semantics). `url` may be same-origin, `blob:` or
`data:`; relative URLs resolve against the creating global's base URL.
*Check:* one test per URL kind and type.

**WRK-2 (MUST).** Worker global scope (`self`, `globalThis`): `postMessage`, `onmessage`/
`onmessageerror`/`addEventListener`, `close()`, `name`, `location` (`WorkerLocation` of the worker URL; relative
URLs inside the worker use the worker's URL as their base, as the HTML spec and browsers do, so in a
`blob:` or `data:` worker a relative `fetch` rejects with a `TypeError` and a relative `importScripts`
throws a `SyntaxError` DOMException (URL parse failure, as WPT `workers/interfaces/WorkerUtils/
importScripts/` expects), and apps pass absolute URLs), `navigator` (userAgent, hardwareConcurrency, language, onLine), timers, microtasks,
`fetch` and the whole of [04](04-fetch-assets-network-storage.md) except storage, `URL`, `Blob`,
`FileReader`, encoding, `atob/btoa`, `crypto.getRandomValues`, `console`, `performance`, `WebAssembly`,
`structuredClone`, `AbortController`, `DOMException`, `ImageData`, `createImageBitmap`, `OffscreenCanvas`
with the 2D context ([06](06-images-canvas2d.md)), `MessageChannel`. Not present: `document`, `window`,
WebGL, WebXR, Web Audio.
*Check:* a worker reports `typeof` for each name; matches the list; in a `blob:` worker a relative
`fetch` rejects with `TypeError` and a relative `importScripts` throws `SyntaxError`.

**WRK-3 (MUST).** Module workers have `import.meta.url` (the worker URL) and dynamic `import()`;
relative static and dynamic imports resolve against the importing module's URL; modules load from the
same sources as MOD-2. (Regression guard; GAP-4.)
*Check:* a module worker imports a relative chunk statically and another dynamically and logs both URLs.

**WRK-4 (MUST).** Classic workers support synchronous `importScripts(...urls)` from same-origin, `blob:`
(including blob URLs created by the worker itself) and `data:` URLs, evaluated in order; failures throw
`NetworkError` DOMException. Module workers throw `TypeError` on `importScripts`.
*Check:* tests per URL kind, including a classic worker that creates a blob URL from a string itself and
passes it to `importScripts`.

**WRK-5 (MUST).** `postMessage(message, transfer | { transfer })` in both directions uses the HTML
structured serialize-with-transfer algorithm: primitives, `Object`, `Array`, `Date`, `RegExp`, `Map`,
`Set`, `Error` types (with `name`, `message`, `stack`, `cause`), `ArrayBuffer`, all typed arrays and
`DataView`, `Blob`/`File`, `ImageData`, `ImageBitmap` (transfer), `MessagePort` (transfer), BigInt,
boxed primitives, cycles. Functions, symbols-as-values, DOM-ish stand-ins throw `DataCloneError` at the
sender synchronously. A transferred ArrayBuffer becomes detached on the sending side (`byteLength` 0);
the receiver gets the same memory, not a copy, and that memory is freed exactly once, whichever side drops
it last, even after the worker that created it has terminated (JS-2). `SharedArrayBuffer` throws `DataCloneError` (the app is not cross-origin isolated:
`crossOriginIsolated === false`).
*Check:* a serializer conformance test in Node (same runtime JS with fake natives) and on device; transfer
of a 64 MB buffer completes in under 2 ms on device.

**WRK-6 (MUST).** `MessageChannel`/`MessagePort`: in-thread and cross-thread ports, `start()`
(implicit with `onmessage`), `close()`, port transfer inside messages and in the transfer list, messages
queued before the far end starts are delivered in order. `BroadcastChannel` optional.
*Check:* comlink round trip (`wrap`/`expose` through a transferred port), as the MSDF generator uses.

**WRK-7 (MUST).** Errors: an uncaught exception in a worker fires `error` (`ErrorEvent` with message,
filename, lineno, colno) on the `Worker` object at the creating side and logs it with the worker's name;
`preventDefault()` on it suppresses the log; an undeserializable message fires `messageerror`. A worker
script that fails to load fires `error` with no `ErrorEvent` details (as browsers do).
*Check:* tests.

**WRK-8 (MUST).** `terminate()` stops the worker promptly even inside a long-running JS or wasm loop
(within 50 ms), releases its memory and thread, and its pending messages are dropped. Terminating a worker
at any moment (mid-task, mid-message, while a transfer to or from it is in flight, while the main thread
is in a frame callback) never crashes either side.
*Check:* terminate a worker in `while(true){}` and in a wasm infinite loop; thread count returns to
baseline; repeat 500 times with no growth in RSS beyond 5 MB; a stress test terminates workers at random
points while 64 KB buffers are transferred both ways: no crash in 1,000 cycles.

**WRK-9 (MUST).** Limits: at most N live workers (default 32, config), creating more throws
`NotSupportedError` with a clear message; each worker's isolate has its own heap limit (default 256 MB).
*Check:* create N+1.

**WRK-10 (SHOULD).** A developer can see the messages exchanged with each worker (direction, worker
name or URL, size, time) when diagnosing a stalled boot, through DevTools worker targets (CDP-6) or any
documented debug-build facility the implementer chooses.
*Check:* in a debug build of the showcase, the round trips with its MSDF text worker (the comlink calls
that generate glyph atlases; the dist's `msdf-worker-*.js` chunk) are visible with direction and size,
as are the physics worker's messages if the showcase starts it.

**WRK-11 (MUST).** Workers run at a lower scheduling priority than the main JS thread and the audio
thread, and are never bound to the core the main JS thread prefers if the runtime uses affinity.
*Check:* `ps -T -o PRI,NI` shows the ordering.

**WRK-12 (SHOULD).** `navigator.hardwareConcurrency` reports the number of cores worker pools may use,
capped at a documented value (proposed 4) on Quest so pools sized from it (a common web pattern) stay
small.
*Check:* value read in main and worker equals the documented cap.
