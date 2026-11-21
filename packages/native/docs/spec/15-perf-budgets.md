# 15. Performance and allocation budgets

The release gate (the project's targets, M6). Numbers are proto-showcase-vr at 72 Hz on Quest 3, measured
on 2026-10-19 with V8 10.0 (the baseline column). Test headsets are mostly Quest 3S: every comparison is against
Quest Browser **on the same headset in the same session** (browser, runtime, browser), never across devices
or days. Absolute numbers below are the Quest 3 values that motivated each target; the gate is the
relative rule.

Method: 7 views × 8 s after a 10 s warm-up, the VrApi
line per second, the page hook's XR rAF deltas, `--strip gaze-tracking` on both targets, the same dist
built without emulator injection, release builds only. "Stable" and "headroom" are that method's verdicts.

| ID            | metric                                                      | Quest 3 baseline / Quest Browser | gate                                                                               |
| ------------- | ----------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------- |
| PERF-FPS-1    | FPS min and stale frames over 7 views                       | runtime 72 / 0; browser 72 / 2–6 | FPS min = rate in every view; stale ≤ browser's in the same hold; verdict `stable` |
| PERF-GPU-1    | App GPU avg (VrApi `App`)                                   | 9.93 ms / 10.27–10.36 ms         | ≤ browser's                                                                        |
| PERF-CPUGPU-1 | CPU&GPU per view (VrApi)                                    | 13.8–19.7 ms / 18.8–23.6 ms      | ≤ browser's in the same hold, and ≤ the baseline's range                           |
| PERF-JS-1     | JS time per frame (runtime stats, begin→end of frame)       | 6.15–6.53 ms on V8 10.0          | < 6.15 ms on the same headset (V8 15.5)                                            |
| PERF-LVL-1    | CPU performance level while holding the rate                | baseline 4; browser 2            | ≤ 2 in every second of the sweep (XR-PERF-1)                                       |
| PERF-ALLOC-1  | per-frame JS allocation, runtime + IWER path                | ~0.3–0.8 KB/frame                | ~0: ≤ 64 B/frame averaged over 600 steady-state frames of the null app             |
| PERF-SIZE-1   | runtime overhead per APK                                    | ~12 MB compressed                | ≤ 12 MB (PKG-SIZE-1)                                                               |
| PERF-BOOT-1   | launch to first XR frame                                    | not measured                     | ≤ Quest Browser's page load to first XR frame for the same dist (both warm)        |
| PERF-GL-1     | GL binding cost per frame (V8 sampling profile attribution) | ~1.2 ms                          | ≤ 1.2 ms, lower with V8 15.5                                                       |

## Detailed budgets

**PERF-JS-2 (MUST).** JS frame-time distribution: p99 of runtime JS time per frame ≤ 1.5 × median in
steady state (no periodic spikes from runtime work: GC, code cache, storage, decode completions).
_Check:_ per-frame JS times from the stats ring over a 5-minute idle run.

**PERF-JS-3 (MUST).** Between-frame work budget: tasks and timers drained between frames use at most the
predicted slack minus 1 ms; overflow carries over (LOOP-2).
_Check:_ the stats line's "tasks deferred" counter rises under a synthetic flood while stale stays 0.

**PERF-ALLOC-2 (MUST).** The runtime measures and reports allocation per frame (bytes allocated in the
main isolate's young generation per XR frame, averaged over the stats window) in the stats line and
`stats`. The _null app_ for PERF-ALLOC-1 is a three scene (spinning lit cube, one controller ray, one
Canvas2D label updated once a second, an audio loop) written to allocate nothing per frame itself, run
through IWSDK's render loop if IWSDK itself meets the budget, otherwise raw three; the measurement includes
the WebXR (IWER host) path, input, GL binding, audio and timers.
_Check:_ null app in the headless runner (Node with fake natives) and on device: ≤ 64 B/frame.

**PERF-MEM-1 (MUST).** Heap is steady: main isolate heap used after GC is within ±5 % between minute 1
and minute 10 of an idle showcase run; RSS within ±20 MB.
_Check:_ stats sampled per minute.

**PERF-GC-1 (MUST).** GC work lands after frame submit or in idle time: ≥ 95 % of GC pause time per
minute is counted "after submit" or "idle"; no single pause inside a frame's JS window > 2 ms in steady
state.
_Check:_ stats GC fields over 5 minutes.

**PERF-FIRST-1 (MUST).** No first-sight stall: the first XR frame and the first frame after each view
change do not miss more frames than Quest Browser does for the same transition (stale frames per view's
first second ≤ browser's).
_Check:_ perf sweep per-second VrApi rows: the first second of each view.

**PERF-FIRST-2 (MUST).** First XR frame work (showcase; done naively, that one frame does 112 compiles,
56 links, ~2,960 sync queries and 72 MB of texture upload): shader compiles run in parallel or
before the session (GL-20), program reflection costs ≤ 2 synchronous JS→native queries per program, counted as GL-21 defines
(GL-21), texture
uploads can be issued before the first XR frame (warm-up during the idle presentation at boot, GL-22 cache for programs),
and the first XR frame's JS time is ≤ 3 frame periods.
_Check:_ first-frame profile from the headless runner and the device boot timeline.

**PERF-BOOT-2 (MUST).** Warm launch (code cache and program cache populated) to first XR frame is ≥ 30 %
faster than cold launch (fresh install) for the showcase.
_Check:_ DBG-STATS boot marks for 3 cold and 3 warm launches.

**PERF-AUDIO-1 (MUST).** Audio render callback load ≤ 25 % of its period with all showcase stations
playing; zero xruns in 10 minutes (AUD-10).
_Check:_ audio stats.

**PERF-SWEEP-1 (MUST).** All 23 proto samples boot headlessly with no unexpected misses or errors, then on
device hold their rate with verdict `stable` against Quest Browser on the same headset (M6 exit).
_Check:_ the sweep's table archived per run.

## Reporting

**PERF-REP-1 (MUST).** Every perf claim cites the headset model and OS build fingerprint, the runtime and
V8 versions, the dist hash, the date, and the interleaved browser runs it is compared with. Results are
stored in the shape `tools/perf.mjs` writes (`{summary, results}`, target, tag) so tables can be
regenerated.
_Check:_ review.
