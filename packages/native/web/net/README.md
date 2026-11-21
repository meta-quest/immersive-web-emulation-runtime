# web/net: fetch, Headers/Request/Response, XMLHttpRequest, experimental WebSocket

The network globals for the native runtime, over `globalThis.__iwn.net` (runtime/net). Built as one IIFE prelude,
`dist/net.min.js` (~105 KB min / 29 KB gzip, of which ~60 KB is the Streams polyfill), evaluated after the glue and
before the app, in the window and in every worker.

```
npm install
npm run verify       # typecheck + build + tests (pretest builds runtime/net's iwn_net_bridge into .bridge-build/)
```

61 tests: Headers/Request/Response in Node; fetch (assets, network, redirects, abort, timeouts, gzip, flow
control, unread bodies released on GC), WebSocket and XHR (async, and sync in a worker) **against the real C++
core** through `iwn_net_bridge` (stdio) and Node loopback servers; the minified bundle in a bare `vm` context after
the glue bundle.

## What it installs

`fetch`, `Headers`, `Request`, `Response`, `XMLHttpRequest`, `XMLHttpRequestUpload`, the WHATWG Streams classes when `ReadableStream` is missing (web-streams-polyfill), and
`navigator.onLine` (always `true`: NET-8 is a SHOULD with no connectivity native yet). Internals for other runtime JS
at `globalThis[Symbol.for('iwn.net')]`: `fetch`, `makeResponse` (Cache API), `blockedOrigins()` (debug endpoint
`stats`, headless runner report).

**WebSocket is not part of the alpha.** `WebSocket` and `CloseEvent` are installed only when the native module
exposes its WebSocket transport, which it does only with `"network": {"experimentalWebSocket": true}` in
`assets/iwn/config.json` (`IwnNetOptions::experimental_websocket`). By default `typeof WebSocket === 'undefined'`, so
apps can feature-detect it. The RFC 6455 client itself is implemented and tested, but it is not in the supported
surface for the 2026-10-23 alpha.

## Routing

| URL | handled by |
|---|---|
| app origin (`https://app.local/...`) | the packaged dist via `readAsset` (NET-1..4): 200 with `Content-Type` from the NET-2 table, 404 response for missing files and paths outside the dist, 405 for methods other than GET/HEAD; the body is the native ArrayBuffer (no copy) |
| `data:` | Fetch's data: URL processor (NET-12) |
| `blob:` | the glue's blob URL store (`blobUrls.resolve`, NET-14/15); GET only |
| other `http(s):` | the native HTTP client, only for origins in `native.network.allow` (NET-5); otherwise `TypeError` and one log line per origin naming the config key |

## Documented differences from a browser (NET-7, NET-11)

- **No CORS.** The allowlist is the only gate; response headers are not filtered by CORS rules and no preflight is
  sent. Network responses report `type: 'cors'`, assets `'basic'`.
- **Credentials and cookies.** There is no cookie jar: `credentials: 'include'` sends no cookies, `Cookie` cannot be
  set (forbidden header), `Set-Cookie` is dropped from responses. `Authorization` set by the app is sent (and stripped
  on cross-origin redirects, as Fetch requires). URLs with `user:pass@` are rejected.
- **No HTTP cache**; `cache` modes are stored but do not change the request.
- **HTTP/1.1 only** (see runtime/net/README.md).
- **Synchronous XHR** (`open(..., false)`) works in workers (NET-11: a blocking native request, `httpSync` /
  `readAssetSync`, installed only on worker isolates). On the main thread it throws `InvalidAccessError`, because a
  blocking request would stall the XR loop.
- **Unread bodies.** A response body that becomes unreachable before it is read to the end is cancelled when it is
  garbage-collected (`FinalizationRegistry`), freeing its connection. At most 6 requests per origin run at once
  (the rest queue), as in browsers.
- Header names/values and status text are byte strings (latin1), as in Fetch. `request.url` keeps its fragment; the
  fragment is never sent.
- `formData()` parses `application/x-www-form-urlencoded`; multipart parsing rejects `NotSupportedError` (allowed by
  NET-9). `FormData` request bodies are serialised when the global exists.
- Request bodies are read fully before sending (no streaming upload).

## Open

- WPT subsets `fetch/api/{response,headers}` are covered by hand-written cases, not by running WPT files.
