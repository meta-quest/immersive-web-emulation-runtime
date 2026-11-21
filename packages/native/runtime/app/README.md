# runtime/app: the Android shell and the template APK (M1)

| path                           | what                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/android_main.cc`          | `ANativeActivity_onCreate` without native_app_glue: callbacks only post lifecycle inputs to the JS thread (PROC-3); reads package/version/debuggable/locale/cache dir and the launch extras over JNI; paints the window black (no 2D content in M1); finishes unhandled input events                                                                                                                                                                                                                                                                                              |
| `src/apk_assets.cc`            | `AssetSource` over `AAssetManager` (uncompressed entries are mapped)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `CMakeLists.txt`               | `libiwernative.so` (exports only `ANativeActivity_onCreate`, 16 KB page-aligned) + `apk-libs.txt` (the `.so` files the APK carries; modules add theirs with `set_property(GLOBAL APPEND PROPERTY IWN_APK_LIBS /abs/lib.so)`)                                                                                                                                                                                                                                                                                                                                                      |
| `template/AndroidManifest.xml` | `android.app.NativeActivity`, `hasCode=false`, `extractNativeLibs=false`, INTERNET (loopback sockets), LAUNCHER (2D panel in M1; the XR module adds the VR category in M3)                                                                                                                                                                                                                                                                                                                                                                                                        |
| `template/build-apk.mjs`       | offline scripted APK build: aapt2 link (manifest only), zip (stored `.so`/binary types), `zipalign -P 16`, apksigner v2+v3 with an openssl debug key in `~/.cache/iwer-native/debug-key`. No Gradle, no Java code                                                                                                                                                                                                                                                                                                                                                                 |
| `hello-js/`                    | the M1 exit-check bundle: modules (relative, root-relative, `_`-folder, `data:`, dynamic, TLA, failures), timers, event loop order, rAF, microtasks, structuredClone, Intl.Segmenter, Wasm SIMD, console, error reporting, lifecycle probes; logs `HELLO-JS PASS n/n` and sets `globalThis.__hello`                                                                                                                                                                                                                                                                               |
| `tools/m1-check.mjs`           | device check from the development machine over forwarded ports: debug endpoint (first-frame-only client), CDP discovery, a DevTools-style session over Node's global WebSocket, pause/resume, heap snapshot, shouting raw handshake; r2: console ignore-list, source-map loading, crypto.random, Origin policy, timer starvation, reload race; r3: pause on uncaught exceptions in timer/rAF/queueMicrotask (and not for caught ones), one report per error, error-event locations, URL fragments in the module map, `Runtime.terminateExecution`, closing a session while paused |

## Build an APK

```bash
export PATH=$HOME/.local/bin:$PATH      # Node 24
ninja -C build/android -j 16 iwernative
node runtime/app/template/build-apk.mjs --libs build/android/apk-libs.txt \
  --out build/apk/hello-js.apk --dist runtime/app/hello-js \
  --package com.iwernative.hellojs --label hello-js --inspector-port 9501 --debug-port 9601
# template (no app assets, placeholder package com.iwernative.template): omit --dist
```

Options: `--prelude file.js` (repeatable; e.g. the web glue bundle), `--config extra.json` (merged into
`assets/iwn/config.json`), `--release` (inspector/debug endpoint off, no `debuggable`), `--no-strip`,
`--version-code`, `--version-name`. The `.so` files are stripped copies; keep the build dir for symbols.

## Run on a headset

```bash
A="adb -s <serial>"
$A install -r hello-js.apk
$A shell am broadcast -a com.oculus.vrpowermanager.prox_close      # a headset nobody wears sleeps otherwise; revert below
$A shell am start -n com.iwernative.hellojs/android.app.NativeActivity     # extras: --ez iwn.inspectBrk true, --es iwn.v8flags "..."
$A logcat -s iwn iwn-js
$A forward tcp:9501 localabstract:com.iwernative.hellojs_devtools_9501 && $A forward tcp:9601 localabstract:com.iwernative.hellojs_devtools_9601   # on this machine's 127.0.0.1
node runtime/app/tools/m1-check.mjs --cdp 9501 --debug 9601
# DevTools: chrome://inspect → Configure → localhost:9501, or devtools://devtools/bundled/inspector.html?ws=127.0.0.1:9501/devtools/page/<id>
$A shell am broadcast -a com.oculus.vrpowermanager.automation_disable; $A forward --remove-all; $A uninstall com.iwernative.hellojs
```

Results on a Quest 3S, 2026-10-20: `HELLO-JS PASS 32/32`,
`M1-CHECK PASS 29/29`; warm start consumed the code cache for every module; a truncated cache was detected and
regenerated; `--inspect-brk` paused on the first statement; an unknown V8 flag logged V8's warning and the app ran;
60 s paused in the debugger: no ANR, the app continued; pause/resume and `__iwn.app.close()` dispatched
blur/visibilitychange/focus and pagehide in order, then `onDestroy`, and a relaunch in the same process re-bound
the ports; an entry that throws logged `entry module https://app.local/main.js failed:` with the stack while
`eval` kept answering; the empty template logged a clear error and kept the debug endpoint up; idle CPU of
`iwn-js` 0.0 % with a 1 s timer; only `127.0.0.1:9501/9601` listening.

Revision 2 (another Quest 3S on the same OS build, 2026-10-20): `HELLO-JS PASS 32/32`, `M1-CHECK
PASS 37/37`. The new checks cover four fixes:

- Console links skip the ignore-listed bootstrap: the first unlisted frame is the app's `appTimer`.
- `Network.loadNetworkResource` + `IO.read` serve dist files; a missing file reports 404.
- `__iwn.crypto.random` works, and an `Origin: https://evil.example` upgrade gets 403.
- With a 60 ms `setInterval(0)` plus a 6 ms rAF loop running, debug evals answered in 132-151 ms. Before the fix
  they got no reply.

A reload racing a request also passed. A 1.5 s `onpagehide` ran during the reload; the request answered, and so did
three later evals and a fresh CDP `Runtime.evaluate`. The generation went 0 -> 1, and hello-js passed 32/32 again
in the new page.

Manual checks on the same run:

- Hidden page (proximity sleep): window rAF stopped (1 callback in 1 s) and timers kept their rate (9 ticks of
  100 ms). The page was back at 61 rAF/s once visible.
- `__iwn.app.close()` while paused in the debugger logged "exit requested while paused in the debugger: resuming",
  then blur, visibilitychange and pagehide, `runtime stopped` and `onDestroy`. A relaunch in the same process bound
  9501/9601 at once.
- entry-throws logged one entry: `entry module https://app.local/main.js failed: Uncaught Error: ...` with the stack.
- 8 close/relaunch cycles in one process all passed 32/32, with an empty crash buffer and no ANR.

Revision 3 (a third Quest 3S on the same OS build, 2026-10-20): `HELLO-JS PASS
32/32`, `M1-CHECK PASS 43/43`. The six new checks:

- With `Debugger.setPauseOnExceptions {state: "uncaught"}`, DevTools pauses (reason `exception`) in a timer, rAF and
  `queueMicrotask` callback at the throwing function. A caught error inside a timer does not pause. The three
  uncaught errors raised `errors.uncaught` by exactly 3.
- `onerror` gets `iwn-debug:///eval` plus line and column for rAF, `queueMicrotask` and `reportError` errors.
- `import("/lib/lazy.js#a")` and `#b` are two module records, and `import.meta.url` keeps the fragment.
- `Runtime.terminateExecution` stopped a 6 s runaway `Runtime.evaluate` after 479 ms.
- Closing a second session while it held the page paused resumed the app.

Manual checks on the same run:

- Same-process relaunch while the old page spun in `while(true)`: the new page booted at once (32/32 0.7 s after
  `onCreate`). Its server bound 9501/9601 3.1 s later, right after the old instance's quit watchdog, and answered.
- Relaunch during an `--inspect-brk` wait: the old instance left 117 ms after `onDestroy` without running the page
  or tripping the watchdog.
- `config.v8Flags "--jitless --no-maglev ..."` in a debug build, and `--es iwn.v8flags --jitless`: WebAssembly
  stayed available and a 5e7-iteration loop took 93-102 ms. That speed suggests the JIT was on, but no build without
  the re-assertion was run as a control. A release build logged `config.v8Flags ignored in a non-debuggable build`.
- A bad prelude, an inline syntax error, a throwing classic script and a classic syntax error were each logged
  once. 6 close/relaunch cycles passed 32/32 with an empty crash buffer.
- Code-cache key hash: 0.94 ms for 7 MiB (SHA-256: 55 ms).

Revision 5 (a fourth Quest 3S on the same OS build, 2026-10-20): `HELLO-JS PASS
32/32`, `M1-CHECK PASS 45/45`. The new checks: 50 concurrent `import()` calls of one URL share one off-thread read
(1 read, 49 joined, a shared dependency read and evaluated once), `__iwn.core.invokeCallback` pauses on uncaught
exceptions and runs no checkpoint with JS on the stack, and `__iwn.core.runMicrotasks` is gone.
Probe APK (3.3 MB `big/big.js`):

- `Promise.all` over 300 `import("/big/big.js")`: 1 read, 299 joined, VmHWM 147 MB -> 218 MB (revision 3: 1.27 GB
  and 300 reads).
- 40 imports of `big.js?leak=i` followed by `__iwn.app.close()` in the same eval, then a same-process relaunch:
  RSS 138 MB before, 139 MB after the relaunch (revision 3: 291 MB). Empty crash buffer.
