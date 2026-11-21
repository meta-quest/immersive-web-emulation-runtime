# web/glue

This is the runtime's web-platform glue: the non-DOM globals an unmodified IWSDK / three.js bundle expects. It is built as one IIFE script, `dist/glue.min.js`. The host evaluates it in every new V8 context (after the core bootstrap, before the app's entry module). `__iwn.config.scope` tells it which kind of global it shapes: `window` (default) or `worker`.

`npm run build` also writes `dist/glue-subtle.min.js`, the opt-in digest-only `crypto.subtle` prelude (evaluate it right after `glue.min.js`; it does nothing unless config `subtle` is `'digest'`), and `dist/glue.NOTICES.txt`, the license notices of the bundled packages. The APK must ship the notices with the glue (THIRD_PARTY.md).

```
npm install
npm run verify          # typecheck + build (prints the min+gzip size) + tests
npm run perf            # absolute timings of the heavy paths against budgets (not part of verify)
```

## What it installs

`window`/`self`, `URL`/`URLSearchParams` (whatwg-url), `TextEncoder`/`TextDecoder`, `atob`/`btoa`,
`structuredClone`, `EventTarget`/`Event`/`CustomEvent`/`ErrorEvent`/`PromiseRejectionEvent`/`MessageEvent`/
`ProgressEvent`/`PopStateEvent`/`HashChangeEvent`, the global object as an EventTarget with `on<event>`
handlers, `reportError`, `queueMicrotask`, `AbortController`/`AbortSignal`, `DOMException`, `Blob`/`File`/
`FileReader`, `URL.createObjectURL`/`revokeObjectURL`, `crypto` (`getRandomValues`, `randomUUID`,
`subtle.digest`), `performance` (now, timeOrigin, User Timing), `navigator` basics, `matchMedia`,
`devicePixelRatio`, `location`, `history`, `origin`, `isSecureContext`, `crossOriginIsolated`, and DOM-1's
`top`/`parent`/`frames` (the window), `frameElement`/`opener` (null) and `name` ('').

`navigator.permissions.query()` resolves `granted` for the features the app already holds: config
`permissions.granted` (the packager's list; default `['xr-spatial-tracking']`) plus `device.info().grantedPermissions`.
Other valid names resolve `prompt`; unknown names reject with `TypeError`, as in browsers.

Not owned here (no stream owns them yet; see the open question in the report): DOM-2's UI event
constructors (`UIEvent`, `MouseEvent`, `PointerEvent`, `WheelEvent`, `KeyboardEvent`, `FocusEvent`,
`StorageEvent`) and DOM-3's `innerWidth`/`outerWidth`, `screen`, `visualViewport`, `scrollTo`,
`getComputedStyle` and friends. They belong with the DOM stand-ins.

`crypto.subtle` is off by default (NET-STORE-4); config `subtle: 'digest'` plus the `glue-subtle.min.js` prelude add a digest-only SubtleCrypto. `@noble/hashes` lives only in that prelude, so `glue.min.js` does not carry it.

In a worker (`scope: 'worker'`, WRK-2) there is no `window`, `history`, `matchMedia`, `devicePixelRatio`, `PopStateEvent`/`HashChangeEvent`; `location` is a read-only `WorkerLocation` of `config.url` (the worker script URL), `self` is read-only, and the global gets the worker event handlers (`onmessage`, `onerror`, ...). The core bootstrap's `window` alias is removed. Everything else (URL, Blob, FileReader, encoding, crypto, performance, structuredClone, AbortController, DOMException) is the same.

Global attributes follow WebIDL: `window`, `navigator`, `crypto`, `history`, `isSecureContext` and `crossOriginIsolated` are read-only (assignment is ignored, or throws in strict code), `self`, `origin`, `performance` and `devicePixelRatio` are `[Replaceable]`, and `location = url` navigates (`[PutForwards=href]`). This holds after the core bootstrap too: its plain `window`/`self` aliases are replaced by these attributes. The global object inherits from `EventTarget.prototype` (`globalThis instanceof EventTarget`); in a worker `navigator` is a `WorkerNavigator` with the worker members only.

The core bootstrap installs minimal `structuredClone` and `performance` and plain `window`/`self` aliases first; the glue replaces those even in `missing` mode, and keeps the bootstrap's timers, `queueMicrotask` and `reportError`. `AbortSignal.timeout(ms)` waits in chunks of at most 2^31-1 ms because the core's timers take a WebIDL `long`.

The glue does not own timers, fetch, `document`/DOM stand-ins, workers, storage or `navigator.xr`. Other streams provide those. They can attach to the objects the glue creates. For example, `navigator` is extensible, and DOM stand-ins subclass the global `EventTarget`.

## Inputs: `globalThis.__iwn`

These are the native hooks and the config. Every hook is optional. The contract is in `src/natives.ts`:

| hook | used for | without it |
|---|---|---|
| `crypto.random(u8)` | `getRandomValues`, `randomUUID`, blob URL ids | `getRandomValues`/`randomUUID` throw `OperationError` (never `Math.random`); blob URL ids use a time + counter id |
| `clock.now()`, `clock.timeOrigin()` | `performance`, `event.timeStamp` | `Date.now()`, coarse; tests only |
| `encoding.decodeUtf8(u8, fatal)`, `encoding.encodeUtf8(s)` | buffers/strings of 256 or more units | JS codec (~150 MB/s on a Linux build host) |
| `clone.structuredClone(v, transfer)` | `structuredClone` of plain data via `v8::ValueSerializer`; graphs with registered platform objects, accessors or non-ArrayBuffer transfers stay on the JS path. It must throw `DataCloneError` for refused values; if it returns `undefined` for a non-undefined value instead (core's `clone.cc` today), the glue throws the `DataCloneError` itself | the glue's own implementation |
| `loop.queueMicrotask(cb)` | `queueMicrotask` | `Promise.resolve().then` |
| `blobUrls.{register,revoke,resolve}` | process-wide `blob:` store (NET-15) | per-global store |
| `device.info()` | `navigator` language(s), cores, memory, onLine, UA model/release, `grantedPermissions` (Android runtime grants that `permissions.query` reports `granted`) | defaults |
| `app.reload()` | `location.reload()`, `history.go(0)`, and `assign`/`replace`/`href`/`search` set to the current URL (restart at the current URL) | logs a warning |
| `app.navigate(url)` | navigation to another same-origin document (`location.assign`, `location.search = ...`) | logs a warning and stays (it never falls back to `reload()`, which would reload the current URL and loop on a conditional redirect) |
| `core.setBlobResolver(fn)` | the glue registers `url => ({ bytes, type }) \| null` so the core's module loader (and worker loading) can import `blob:` URLs (NET-14) | `import(blobURL)` fails in the core loader |
| `config` | `{ url, userAgent, runtimeVersion, viewport, subtle, scope, permissions: { granted } }` (object or JSON string; invalid JSON warns) | `https://app.local/`, honest UA, 1280×720, no `crypto.subtle`, window scope, only `xr-spatial-tracking` granted |

## Outputs: `globalThis[Symbol.for('iwn.glue')]`

Other runtime JS uses this registry (type `GlueRegistry` in `src/index.ts`):

- `blobUrls.resolve(url)`: returns the `Blob` for a `blob:` URL, or `null`. `fetch`, image decode and XHR use it directly; the core's module loader and worker loading reach it through the resolver the glue registers with `__iwn.core.setBlobResolver`.
- `blobBytes(blob)`: the blob's bytes, without a copy. `blobFromBytes(u8, type)` does the reverse.
- `events.GET_THE_PARENT`: a symbol. DOM stand-ins implement it to get capture/bubble paths. Also `events.dispatchTrusted`, `markTrusted`, `defineEventHandler`, `reportException`.
- `abort.addAbortAlgorithm(signal, fn)` (returns an unsubscribe function), `abort.signalAbort(signal, reason)`, `abort.dependentCount(signal)` (diagnostics).
- `installSubtle(ctor, instance)`: called by `glue-subtle.min.js`; installs `crypto.subtle` only when config `subtle` is `'digest'`.
- `navigation`: the URL behind `location`, for `document.URL` and `baseURI` (`null` in a worker).
- `cloneRegistry`: `registerCloneable({ is, clone })`, `registerTransferable({ is, transfer })`, `registerNonSerializable(test)`. `ImageData`, `ImageBitmap`, `MessagePort` and DOM stand-ins register here; registered types always use the JS clone path, so they work with or without the native hook.
- `scope`: `'window'` or `'worker'`.
- `verifyIntl()`: the JS-6 report on V8's Intl. The debug endpoint and device tests use it.
- `clock`, `utf8Encode`, `base64Encode`, `installed`.


## Tests

The tests evaluate the shipped minified bundle in a fresh `vm` context. That context has only V8 builtins, like the runtime's isolate. `both()` runs each scenario in Node's realm and in the glue realm and compares the results. Where Node does not follow the spec, the test checks against the spec instead and says why. Those cases are `new DOMException(msg, { name, cause })` (Node takes an options object; WebIDL and browsers stringify the second argument), windows-1252 decoding, EventTarget capture at the target, `removeEventListener` matching on capture, `endings: 'native'`, User Timing negative timestamps, `getRandomValues` argument errors, FileReader `readyState` during `progress`, event handler re-activation order, primitive `addEventListener` options, `AbortSignal.timeout(-0.5)`, detached buffers in `Blob`, and `decode()` option validation. Timing checks in the suite are relative (against V8's own serializer or a dense-array scan measured in the same run), so a loaded build machine does not fail them; absolute budgets live in `npm run perf`. `test/edge-cases-clone-hook.test.ts` covers, among others, a clone hook that returns `undefined` like core's `clone.cc` today and listener exceptions reaching `core.reportError` on the device-like boot. `test/edge-cases-device-boot.test.ts` runs several cases on a device-like boot (`createDeviceContext`: the real `runtime/core/js/bootstrap.js` with a fake `__iwn.core`, then the glue). `test/edge-cases-abort-clone-scope.test.ts` covers, among others, `AbortSignal.any()` under forced GC (`--expose-gc` through `v8.setFlagsFromString`) and structuredClone with a native hook that behaves like core's `clone.cc`.

Known gaps of `structuredClone`:

- A live Proxy whose traps do not throw is cloned through its traps on the JS path (JS cannot detect a Proxy). With the native hook, a plain-data graph holding a Proxy goes to V8's serializer, which refuses it, so it throws `DataCloneError` there. (The round 4 report said the device's V8 15.5 cloned a Proxy. That was wrong: core's hook lost the exception and returned `undefined` for every refused value; the glue now turns that into `DataCloneError`.) A revoked Proxy, or one whose `getPrototypeOf` trap throws, is a `DataCloneError` on both paths.
- An object created with `Object.create(Promise.prototype)` (or another refused built-in's prototype without a brand check) throws `DataCloneError` where V8 clones `{}`.
- A Map/Set/ArrayBuffer whose prototype was replaced clones as a plain object on the JS path.
- A length-tracking view comes back fixed-length; `WebAssembly.Module` comes back as the same object.
- A non-detachable buffer in the transfer list is found only after earlier entries were detached (it then throws `DataCloneError`).
- Routing scan: named (non-index) properties of a densely walked array longer than 4096 elements are not scanned (that means `Object.keys` over every element), so a platform object stored as `bigArray.blob` takes the native path and comes back as `{}` (a URL there is cloned as `{}` instead of throwing). Shorter arrays, sparse arrays and every index are scanned. The same holds for the entries of a Map/Set whose prototype was replaced (scanned as a plain object, cloned by V8 as a Map).
- Routing cost: the scan reads one property descriptor per element, so a 1e6-number array costs about 7x the bare native clone on the Quest 3S (204 ms vs 29 ms; 20k small objects: 69 ms vs 35 ms). `structuredClone` is not on the frame path.

The WPT URL data lives in `test/fixtures/`.
