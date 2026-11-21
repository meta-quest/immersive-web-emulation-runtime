# 04. Fetch over APK assets, the network allowlist, URLs, blobs and storage

Sources: Fetch Living Standard; URL Living Standard; File API (Blob, File, FileReader, object URLs);
XMLHttpRequest Living Standard; Encoding Standard (TextEncoder/TextDecoder); HTML §11 (Web Storage) and
§8.9 (base64); WebAssembly JS API + Web API (`instantiateStreaming`, `compileStreaming`); Android
`AAssetManager` docs; the showcase app (81 asset reads / 42.8 MB, `_`-prefixed folders, one network
origin: the controller-model CDN).

## Assets

**NET-1 (MUST).** Every file of the app's `dist/` is readable by its same-origin URL
(`https://app.local/<path>`), byte for byte, including files and folders whose names start with `_` or
`.` (aapt drops `_`-prefixed folders by default; the packer must keep them, PKG-4) and non-ASCII names
(percent-decoded path → UTF-8 file name).
*Check:* a fixture dist containing `_app/x.js`, `.well-known/y.json`, `ü.txt`, a 200 MB file; each fetch
returns the exact bytes (SHA-256 compare).

**NET-2 (MUST).** `Content-Type` comes from a fixed extension table covering at least: `.html text/html`,
`.js .mjs text/javascript`, `.css text/css`, `.json application/json`, `.wasm application/wasm`, `.png
image/png`, `.jpg .jpeg image/jpeg`, `.webp image/webp`, `.gif image/gif`, `.svg image/svg+xml`, `.ktx2
image/ktx2`, `.basis application/octet-stream`, `.glb model/gltf-binary`, `.gltf model/gltf+json`, `.bin
application/octet-stream`, `.hdr image/vnd.radiance`, `.exr image/x-exr`, `.mp3 audio/mpeg`, `.ogg
audio/ogg`, `.wav audio/wav`, `.m4a audio/mp4`, `.ttf font/ttf`, `.otf font/otf`, `.woff2 font/woff2`,
`.txt text/plain`; anything else `application/octet-stream`.
*Check:* table-driven test.

**NET-3 (MUST).** Reads of large assets do not copy more than once into the JS heap: the bytes for
`arrayBuffer()` are produced from a memory-mapped or streamed read on a background thread and handed to JS
as one ArrayBuffer; uncompressed storage in the APK is used for big binary types so they can be mapped
(PKG-4).
*Check:* fetching a 100 MB `.glb` peaks RSS at under 1.3× its size above baseline and blocks the main
thread for under 2 ms total (boot timeline).

**NET-4 (MUST).** A missing same-origin asset yields a `Response` with `status` 404, `ok` false (as a
static server would), not a rejected promise; a path outside the dist (`..` after normalisation) is
treated as missing.
*Check:* tests.

## Network and the allowlist

**NET-5 (MUST).** Cross-origin `fetch`, XHR, `Image.src`, module and worker loads go to the network only
when the request's origin (scheme+host+port) matches the app's allowlist; origins may be exact
(`https://cdn.jsdelivr.net`) or a leading-wildcard host (`https://*.example.com`). Everything else fails the
way a CORS/network error fails in a browser (`fetch` rejects with `TypeError`; XHR fires `error`; image
fires `error`) and logs one line per blocked origin per session naming the origin and the config key to
add it to. `http:` is allowed only for loopback and only in debug builds.
*Check:* an allowlisted origin returns 200; a non-listed one rejects with `TypeError` and the log line
appears once though fetched 100 times.

**NET-6 (MUST).** Network requests run off the main thread; TLS certificates are validated against the
device's system trust store, as other Android apps are (a certificate that store rejects fails the request
like a network error); requests honour the method, headers (minus forbidden request headers), body (string,
ArrayBuffer, view, Blob, URLSearchParams, FormData if supported), redirects (`follow`, `error`,
`manual`), `AbortSignal` (aborts reject with `AbortError` DOMException), and a timeout of 60 s per request
(configurable). The response exposes `status`, `statusText`, `headers` (iterable, lower-cased names),
`url` (final URL after redirects), `redirected`, `type` (`cors`/`basic`).
*Check:* tests against a local test server reached through `adb reverse` in a debug build; an `https:`
request to an allowlisted host with a self-signed certificate rejects with `TypeError`.

**NET-7 (MUST).** The allowlist is the only gate; the runtime does not implement CORS headers checks
(the app is packaged and trusted) but documents that difference.
*Check:* documented.

**NET-8 (SHOULD).** `navigator.onLine` reflects connectivity; `online`/`offline` events fire on changes.
*Check:* toggle Wi-Fi on a test device.

## Fetch API surface

**NET-9 (MUST).** `fetch`, `Request`, `Response` (`ok`, `status`, `statusText`, `headers`, `url`, `type`,
`redirected`, `bodyUsed`, `clone()`, `arrayBuffer()`, `bytes()`, `text()`, `json()`, `blob()`,
`formData()` may reject `NotSupportedError`), static `Response.json/error/redirect`, `Headers` (full
spec: case-insensitive, combined values, iteration order), `body` as a `ReadableStream` that yields the
data in one or more chunks (WHATWG Streams: at least `getReader()`, `read()`, `cancel()`, async iteration,
`pipeTo` optional). Reading a used body rejects with `TypeError`.
*Check:* WPT subsets `fetch/api/response/*`, `fetch/api/headers/*` that do not need a server.

**NET-10 (MUST).** `WebAssembly.instantiateStreaming(fetch(url))` and `compileStreaming` work for
same-origin `.wasm` assets (MIME `application/wasm`), compiling off the main thread.
*Check:* hello-js equivalent logs the result of an add(2,3) module; the showcase's MSDF and Havok wasm
paths (when used) load.

**NET-11 (MUST).** `XMLHttpRequest`: `open/send/abort/setRequestHeader/getResponseHeader/
getAllResponseHeaders`, `responseType` '' / `text` / `arraybuffer` / `blob` / `json`, `status`,
`readyState` transitions with `readystatechange`, `onload/onerror/onprogress/onloadend/onabort/ontimeout`,
`timeout`. Synchronous requests (`open(…, false)`): in workers they work; on the main thread they are a
**deliberate deviation** from the XHR standard (which throws `InvalidAccessError` only when `timeout` or
`responseType` is set): every synchronous `open` on the main thread throws `InvalidAccessError`, because a
blocking request would stall the XR frame loop. The deviation is documented on the developer page (PKG-14).
*Check:* three's `FileLoader` fallback path; a runtime test, including a synchronous request that succeeds
in a worker and throws `InvalidAccessError` on the main thread.

**NET-12 (MUST).** `data:` URLs work in `fetch`, `Image.src`, `import`, `importScripts`, and `new Worker`
(base64 and percent-encoded).
*Check:* tests.

## URL, Blob, encoding

**NET-13 (MUST).** `URL` and `URLSearchParams` conform to the URL standard (parser, setters,
`canParse`, `parse`, `searchParams` live binding); `document.baseURI` and `location` derive from the app
URL plus the configured query string.
*Check:* WPT `url/urltestdata.json` run in Node against the runtime's implementation (or V8-provided URL
if a future V8 ships one): ≥ 99 % pass, failures listed.

**NET-14 (MUST).** `Blob` (parts of strings/buffers/views/blobs, `type`, `size`, `slice`, `arrayBuffer`,
`text`, `bytes`, `stream`), `File` (`name`, `lastModified`), `FileReader` (`readAsArrayBuffer`,
`readAsText`, `readAsDataURL`, `readAsBinaryString`, events), `URL.createObjectURL/revokeObjectURL` with
`blob:https://app.local/<uuid>` URLs usable by `fetch`, `Image`, module import, `new Worker`,
`importScripts`; revoked URLs fail.
*Check:* tests; the MSDF generator's `FileReader` path in the showcase.

**NET-15 (MUST).** Object URLs follow the File API's blob URL store: a `blob:` URL created in any global of
the app (main thread or any worker) resolves in every other global of the app until it is revoked, and the
URLs a worker created are revoked when that worker ends.
*Check:* a URL created on the main thread is fetched in a worker and used for `new Worker(url)`; a URL
created in a worker is fetched on the main thread and in a second worker; after the creating worker is
terminated, fetching its URL fails with `TypeError`.

**NET-16 (MUST).** `TextEncoder`, `TextDecoder` (utf-8 with `fatal`, `ignoreBOM`, streaming; utf-16le;
latin1/windows-1252), `TextEncoderStream`/`TextDecoderStream` optional, `atob`/`btoa` with spec errors
(`InvalidCharacterError`).
*Check:* WPT `encoding/` subsets.

## Storage

**NET-STORE-1 (MUST).** `localStorage` (string keys/values, `getItem/setItem/removeItem/clear/key/
length`, property access, 5 MB quota → `QuotaExceededError`) persists across launches in the app's
private storage; `sessionStorage` is in-memory per launch. `storage` events are not required (one
document).
*Check:* boot counter persists across 3 cold starts.

**NET-STORE-2 (MUST).** Persistence writes never run on the main thread inside an XR frame: writes are
coalesced (≤ 250 ms debounce) and flushed on pause and on exit; a crash loses at most the debounce window.
*Check:* 1,000 `setItem` calls in one frame cause no stale frame; force-stop 1 s later keeps the value.

**NET-STORE-3 (SHOULD).** `indexedDB`, `caches`, `navigator.storage.persist` are absent (`typeof
indexedDB === 'undefined'`), and `navigator.storage.estimate()` resolves with sane numbers. If a sample
needs IndexedDB, add it as a requirement then.
*Check:* the 23 proto samples' headless sweep reports no access to the absent globals, or it is listed.

**NET-STORE-4 (MUST).** `crypto.getRandomValues` (CSPRNG, 64 KB limit → `QuotaExceededError`) and
`crypto.randomUUID`. `crypto.subtle` is absent unless a sample needs it.
*Check:* tests.
