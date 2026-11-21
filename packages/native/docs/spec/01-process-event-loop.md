# 01. Process, threads, lifecycle and the event loop

Scope: what the runtime process does from launch to exit, which thread runs what, and the ordering
guarantees the web bundle sees. Timers and `requestAnimationFrame` outside XR are here too; the XR frame
loop is in [08](08-openxr-session-frame.md).

Sources: HTML Living Standard §8.1 (event loops, tasks, microtasks, "update the rendering"), §8.6
(timers), §8.10 (animation frames); High Resolution Time; Android NDK `NativeActivity` docs; OpenXR 1.1
§10 (session lifecycle).

## Process and threads

**PROC-1 (MUST).** One Android process per app with one activity. Everything the bundle can call
synchronously (JS, WebGL, WebXR, Web Audio control, DOM stand-ins) runs on one thread, the *main JS
thread*, and its effects are observed in call order (a WebGL call made after another sees its effects; a
`readPixels` sees every earlier draw). Which native threads issue the GL and OpenXR calls is the
implementer's choice, within EGL's rule that a context is current on one thread at a time and OpenXR's
frame-function ordering and threading rules; XR-IDLE-1 may need idle frames that do not wait for the JS
thread.
*Check:* the showcase runs 5 minutes with the OpenXR validation layer (debug build) reporting no errors and
no GL errors from the runtime's own calls; the GL-CTS-1 subset passes.

**PROC-2 (MUST).** Off-main-thread work never runs JS on the main isolate. Image decode, audio decode,
network I/O, file reads larger than a threshold, worker isolates, the audio render callback and the
inspector socket run on other threads and hand results to the main thread as tasks.
*Check:* the same debug assertion on every entry into the main isolate.

**PROC-3 (MUST).** The Android UI/lifecycle thread never blocks on the main JS thread for longer than
100 ms (no ANR, no input-dispatch timeout), including while JS is paused in the debugger.
*Check:* pause in DevTools for 60 s; `adb logcat` shows no ANR; resume continues the app.

**PROC-4 (SHOULD).** Every thread the runtime creates has a readable name that says what it does (workers
include their index or name) so tombstones and `simpleperf` output can be read.
*Check:* `adb shell ps -T -p <pid>` lists no unnamed runtime threads.

## Lifecycle

**PROC-5 (MUST).** Launch to bundle: the runtime starts the engine, installs the browser surface, then
loads the app's entry module (see [02](02-modules-code-cache.md)). The entry is evaluated exactly once
per JS start: once per process start, and once more per `location.reload()` (PROC-8).
*Check:* an entry that increments a `localStorage` counter shows +1 per cold start and +1 per reload.

**PROC-6 (MUST).** Pause/resume. When Android pauses the activity (headset removed, system menu, another
immersive app), the runtime keeps the process alive, stops issuing XR frames according to the OpenXR
session state (see XR-LIFE-*), keeps window timers running at a reduced rate or as normal (implementer's
choice, documented), and on resume continues without reloading the bundle.
*Check:* doff and don the headset twice; the app continues at the same frame rate with the same JS state
(`window.__probe` set before doffing is still set).

**PROC-7 (MUST).** Exit. On activity destroy, or when the OpenXR session reaches `EXITING`, the runtime
ends the WebXR session (firing `end`), stops the audio device, joins all worker threads, flushes
`localStorage`, then tears down GL, OpenXR and the engine in an order that cannot crash. A crash during
teardown counts as a failure.
*Check:* 20 launch/exit cycles through `am force-stop` and through the system "quit" button: zero
tombstones, `localStorage` writes from the last frame before exit are present on next launch (quit-button
path only; force-stop may lose up to the flush interval, see NET-STORE-2).

**PROC-8 (MUST).** `location.reload()` restarts the app's JS from scratch (fresh isolate or fresh process,
documented), keeping the activity.
*Check:* call it from the debug endpoint; the boot counter increments and the session can be re-entered.

**PROC-9 (MUST).** Fatal errors are visible. An uncaught exception during entry evaluation, or a failure to
create the GL context or the OpenXR instance, logs a single clearly tagged error line with the message and
stack, and the app stays in a state the debug endpoint can still reach (it does not exit silently).
*Check:* pack an app whose entry throws at top level; logcat shows the error with the module URL and line;
`eval('1+1')` over the debug endpoint still answers.

## Event loop

**LOOP-1 (MUST).** The main JS thread runs an HTML-shaped event loop: one task at a time from task sources
(timers, posted native completions, worker messages, network/asset completions, inspector commands, input
and lifecycle events), a microtask checkpoint after every task and after every callback the runtime
invokes (each rAF callback, each event listener the runtime dispatches, each XR frame callback).
*Check:* a script that logs from a timer, a `Promise.then` inside it and a second timer shows
`timer1, micro1, timer2`; an XR rAF callback that queues a microtask sees it run before the next rAF
callback of the same frame.

**LOOP-2 (MUST).** No task starvation inside XR: while an XR session runs, tasks are drained between
`xrEndFrame` and the next `xrWaitFrame` return, bounded so that frame submission is never delayed by
queued work (a task queue over its per-frame budget carries over to the next gap; budget in
[15](15-perf-budgets.md), PERF-JS-3).
*Check:* post 10,000 trivial tasks from a worker in one burst during XR; no frame is missed (VrApi
`Stale` stays 0 over that second) and all tasks run within 2 s.

**LOOP-3 (MUST).** The loop never busy-waits: between frames and tasks it sleeps (inside `xrWaitFrame`,
or until the next due timer or posted task). CPU use of an app in the idle presentation with no rAF
callbacks and no timers is under 2 % of one core.
*Check:* `top -H -p <pid>` with an idle test app launched in explicit-grant mode and never granted
(XR-LIFE-2), so it holds an offer and XR-LIFE-7 does not close it.

**LOOP-4 (MUST).** Unhandled promise rejections are reported: logged with the rejection value and stack
and dispatched to `window` as `unhandledrejection` (cancelable; `preventDefault()` suppresses the log);
a later handler fires `rejectionhandled`. Uncaught exceptions in tasks fire `window.onerror` / `error`
events with `message`, `filename`, `lineno`, `colno`, `error`, then are logged.
*Check:* runtime tests for each case; on device a rejected fetch with no handler appears once in logcat.

**LOOP-5 (MUST).** Re-entrancy: nothing the runtime does while JS is on the stack runs another task or
another rAF callback (e.g. a debug-endpoint `eval` that awaits a promise keeps frames and tasks flowing
from the outer loop, never by nesting a loop inside a native call made by JS).
*Check:* an `eval` that awaits `new Promise(r => setTimeout(r, 2000))` during XR returns after ~2 s while
the frame counter advances by ~2 × rate, and no task runs twice.

## Timers (HTML §8.6)

**TMR-1 (MUST).** `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval` with HTML semantics:
positive integer ids unique per global, extra arguments passed to the callback, a string handler is
evaluated as script (log a warning once), `this` is the global, clearing an unknown id is a no-op, the
same id space for both kinds.
*Check:* a timer conformance test ported from WPT `html/webappapis/timers/` (argument passing, ordering of
equal delays, clear inside callback, nested clamping).

**TMR-2 (MUST).** Nesting clamp: after nesting level 5, delays below 4 ms are raised to 4 ms. Equal-delay
timers fire in creation order. A timer never fires early relative to `performance.now()`.
*Check:* WPT-derived test.

**TMR-3 (MUST).** `queueMicrotask`, `requestIdleCallback`/`cancelIdleCallback` (deadline from the time to
the next frame or 50 ms outside XR; `timeRemaining()` never negative), `structuredClone`.
*Check:* runtime tests.

**TMR-4 (MUST).** `performance.now()` is monotonic with at least 0.1 ms resolution (finer is allowed:
no cross-origin isolation concerns apply in a packaged app, but document the value), `performance.timeOrigin`
is the Unix-epoch time of the process's JS clock zero, `performance.mark/measure/getEntriesByName/
clearMarks/clearMeasures` exist (minimal, no observers required). The XR frame time passed to callbacks
uses the same clock (XR-LOOP-5).
*Check:* 10,000 consecutive calls are non-decreasing; window rAF `time` is ≤ `performance.now()` at
callback entry and within one frame period of it; XR rAF `time` meets XR-LOOP-5's check.

**TMR-5 (MUST).** Window `requestAnimationFrame`/`cancelAnimationFrame` run with the callback list
snapshotted per frame (a callback requested while a frame's callbacks are running waits for the following frame) and one shared timestamp per frame
(the frame's start on the `performance.now()` clock, never a future time such as the XR predicted display
time; XRF-B-2). Rate: while the OpenXR session is running, one
round per `xrWaitFrame` at the display rate, both in the idle presentation (XR-IDLE-2) and during a WebXR
session, where they run after the session's callbacks (XR-LOOP-1, XRF-B-2). Before the OpenXR session
runs (early boot) and in the headless runner, a 60 Hz timer drives them. There is no 2D panel mode
(XR-IDLE).
*Check:* runtime tests for snapshot semantics; on device, window rAF count per second equals the display
rate both before entering XR and during a session, and in both states every window rAF `time` is ≤
`performance.now()` at callback entry (TMR-4).
