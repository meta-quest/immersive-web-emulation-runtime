# runtime/net: fetch transport, assets, allowlist, experimental WebSocket

Native half of `fetch`/XHR/`WebSocket` and of same-origin asset reads. JS sees it as `globalThis.__iwn.net`
(contract: `binding/net_binding.cc` header comment and `web/net/src/natives.ts`). Spec: NET-1..7, NET-9, NET-11
(`docs/spec/04-fetch-assets-network-storage.md`).

| target | what | where it builds |
|---|---|---|
| `iwn_net_core` | URL subset + origin allowlist (`url.h`), asset paths/MIME/`DirAssetSource` (`assets.h`), byte streams + `PosixConnector` (`stream.h`), HTTP/1.1 client (`http.h`), RFC 6455 client (`websocket.h`); on Android also `AndroidAssetSource` and `JniConnector` | host + Android, no V8 |
| `iwn_net` | the V8 binding, `iwn_register_net` | when V8 headers exist (`iwn_v8` target or `IWN_V8_INCLUDE_DIR`) |
| `iwn_net_core_test`, `iwn_net_bridge` | host tests; the natives contract over stdio for web/net's Node tests | host |

```bash
cmake -S runtime/net -B /tmp/net -G Ninja && ninja -C /tmp/net -j 16 && /tmp/net/iwn_net_core_test   # 32 tests
```

## Transport decision: our HTTP/1.1 + RFC 6455 over the platform's TLS sockets

Options weighed: Android's `android.net.http.HttpEngine` (API 34, Cronet in the platform) via JNI; libcurl +
BoringSSL built from source; our own HTTP/1.1 and WebSocket cores over a byte stream whose TLS comes from the platform
(`javax.net.ssl` / Conscrypt) through JNI. Chosen: the third.

- **One transport for fetch and WebSocket.** HttpEngine has no WebSocket; WebSocket needs a TLS socket anyway.
- **System trust store, network security config, SNI, hostname verification and the system proxy for free.**
  `SSLSocketFactory.getDefault()` is the same TLS stack other Android apps use (NET-6: a certificate the store
  rejects fails like a network error; checked on a Quest 3S: "Trust anchor for certification path not found").
  libcurl + BoringSSL would need the APEX CA directory wired up, would ignore network security config, and would
  make us own TLS CVE patching.
- **Zero added native size** (libcurl + BoringSSL ≈ 1.5-2 MB per APK against the 12 MB budget, PKG-SIZE).
- **No app dex code.** Only boot-classpath classes are called (no Java subclass needed, unlike HttpEngine's
  `UrlRequest.Callback`), so it works with a pure `NativeActivity` template.
- **Host-testable.** The HTTP parser, redirect logic, flow control, gzip and the WebSocket framing run in host tests
  against loopback servers (`PosixConnector`, plain TCP); only the TLS byte stream is device-only.
- Costs, documented: HTTP/1.1 only (no HTTP/2/3, no brotli, no HTTP cache). Fine for an XR app's few cross-origin
  fetches (controller-model CDN, REG-5); revisit if a sample needs many parallel cross-origin requests.

## Behaviour

- Allowlist (NET-5) checked natively on every request and every redirect hop; `http:`/`ws:` only to loopback and
  only in debug builds; `ws(s)` matched against the `http(s)` origin. `*.example.com` matches subdomains only.
- Requests: forbidden request headers dropped, `Accept-Encoding: gzip, deflate` (decoded with zlib), keep-alive pool
  (6 per origin, 30 s idle, stale-connection retry), redirects per Fetch (303/POST→GET, body headers dropped,
  `Authorization` stripped cross-origin, 20 hops, modes follow/error/manual), 60 s timeout for the response head and
  between body reads (configurable), abort from any thread, 1 MB unacknowledged-body window (`httpAck`; gzip output
  is cut into 256 KB pieces that each wait for the window, so decompression is bounded too).
- Timeouts cover every blocking step: connect + proxy tunnel + TLS handshake run under one deadline (a process-wide
  watchdog closes the socket, `watchdog.h`), and `Abort()` cancels a connect or handshake in progress.
- Requests run on a thread pool (max 32 threads, idle threads exit after 30 s); at most 6 requests per origin run at
  once, the rest wait in a queue without a thread. A burst of requests starts in parallel: each request that can
  start wakes its own idle thread (a wake-up counts until a thread takes it) or gets a new one. Unread bodies do not
  pin slots forever: web/net cancels a body that is garbage-collected before it was read.
- Bare-LF line endings are accepted in responses (RFC 9112 §2.2); `Location` values are percent-encoded before use.
- `FetchBlocking()` runs a request to completion on the calling thread (synchronous XHR in workers, NET-11; the
  binding installs `httpSync`/`readAssetSync` only on isolates the core does not own).
- Responses: header names lower-cased, `Set-Cookie` dropped (no cookie jar), final URL + redirected flag.
- WebSocket (**experimental, not in the alpha surface**: the binding installs `wsConnect/wsSend/wsClose`, and
  web/net the `WebSocket` global, only with `IwnNetOptions::experimental_websocket`, i.e. `"network":
  {"experimentalWebSocket": true}` in `assets/iwn/config.json`): handshake checks (101, Upgrade/Connection tokens in any case, accept key, no unoffered
  extension/subprotocol), masking, fragmentation, UTF-8 validation, ping→pong, close codes, 5 s closing handshake,
  64 MB message cap, `Origin: <app origin>`, connect/handshake timeout.
- Assets (NET-1..4): URL path → percent-decoded relative path (`..`, encoded `/`, NUL → 404); `_`/`.` names and
  UTF-8 names work; files ≥ 64 KB are mapped `MAP_PRIVATE` (copy-on-write, so JS may write into the ArrayBuffer)
  from the APK fd when stored uncompressed, and handed to JS as the ArrayBuffer's backing store (no copy, NET-3).

## Integration with the runtime core

The binding works with the core `Runtime` when linked with `iwn_core` (`IWN_HAVE_CORE_RUNTIME`): completions go
through `Runtime::post_task`, callbacks through `call_function`, and with no explicit `iwn_net_configure()` it
configures itself from the runtime: assets via the core `AssetSource` under `config.appRoot` (entries ≥ 64 KB that
the APK stores uncompressed are mapped copy-on-write straight from base.apk through a central-directory index,
`zip_index.h`, so NET-3 holds on this path too; smaller or compressed entries are copied once), the origin from the
config, the `"network"` section of `assets/iwn/config.json` (`{"allow": [...], "debug": bool, "timeoutMs": n,
"userAgent": s, "experimentalWebSocket": bool}`, written by the packer from `native.network.allow`), and the JavaVM
from `JNI_GetCreatedJavaVMs` (libnativehelper, API 31+).
Isolates the core does not own (workers) use `iwn::BindLoopHooks(isolate, &hooks)` (`include/iwn/loop_hooks*.h`)
before `iwn_register_net`. Lifecycle: registering again for a new context of the same isolate (reload) ends the old
context's requests and sockets; `iwn_net_dispose_isolate()` before disposing a worker isolate;
`iwn_net_abort_all()` only at process exit (never on pause: PROC-6). See `include/iwn/net/module.h`.

## Device test

`test/device/` builds a test APK (NativeActivity + V8 + the shipped preludes; `build-apk.sh`) and
`host-servers.mjs` provides the loopback/self-signed/WebSocket servers for `adb reverse`. Revision 2 run
2026-10-20 on a Quest 3S four times from a cleared install, launches
separated by force-stop: all 25 checks green each time, including assets byte-exact (32 MB mapped glb, SHA-256,
fetch <= 1 ms), public HTTPS (google 204, jsdelivr), self-signed rejection, loopback http in debug, ws and public wss
echo (the devtest opts in to the experimental WebSocket), a TLS handshake to a silent peer timing out at the
configured 8 s, 16 hung handshakes aborted in ~300 ms with the next request served, wss close-while-connecting
(error + 1006 in ~300 ms), synchronous XHR on the worker path, localStorage 1->4 and IndexedDB/Cache persistence
across launches, and a same-process reload (new context, natives registered again) that sees this session's
localStorage, keeps removed keys removed, fetches and writes IndexedDB.
