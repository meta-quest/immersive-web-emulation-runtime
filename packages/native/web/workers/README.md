# web/workers

The workers prelude, built as one IIFE script, `dist/workers.min.js` (14.7 KB, 5.2 KB gzip). The runtime evaluates
it in the page and in every worker global, after the web glue and the image prelude; make it the last runtime
prelude so it sees every platform interface. It installs, over `globalThis.__iwn.workers` (runtime/workers):

- `Worker` (classic and module, `name`, `postMessage(message, transfer | { transfer })`, `terminate()`,
  `onmessage`/`onmessageerror`/`onerror`), resolving URLs against `location` (page) or the worker URL (worker);
  `blob:` URLs are resolved in this global's blob store at construction (a revoked one fires `error`).
- `MessageChannel`, `MessagePort` (`start()`, implicit start by `onmessage`, `close()`, transfer, inert after
  being transferred; unstarted ports are held weakly and closed natively when collected).
- In a worker: `postMessage`, `close`, `name`, `importScripts` (classic only; same-origin, `data:`, this worker's
  `blob:` URLs, synchronous, in order), and `WorkerGlobalScope`/`DedicatedWorkerGlobalScope` on the global's
  prototype chain; `requestIdleCallback` is removed (Window-only).
- The serializer hooks: the platform types that are host objects (every interface constructor on the global at
  install time, plus later ones with a matching own `Symbol.toStringTag`), `hostWrite` (MessagePort, ImageBitmap,
  ImageData, Blob, File, DOMException and the geometry types become descriptors; other platform objects throw
  `DataCloneError`) and `hostRead`.
- `crossOriginIsolated` from the policy (config `workers.crossOriginIsolated`, default true) and the WRK-12 cap of
  `navigator.hardwareConcurrency` (4).
- `globalThis[Symbol.for('iwn.workers')]`: `{ version, scope, info(), stats() }`.

```
npm install
npm run verify          # typecheck + build + tests
```

Tests (`test/workers.test.ts`, 19): each global is a fresh `vm` context with the real core bootstrap, the shipped
glue bundle and this bundle; `test/harness.ts` emulates the native module in JS (the same port semantics as
`PortHub`, a realm per worker, host objects through the hooks). Native behaviour (threads, isolates,
`ValueSerializer`, `SharedArrayBuffer`, wasm, termination) is covered by `runtime/workers/test/device`.
