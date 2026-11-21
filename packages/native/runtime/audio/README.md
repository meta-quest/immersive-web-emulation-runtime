# runtime/audio: Web Audio over Oboe/AAudio

The native half of the runtime's Web Audio API (spec [11-audio.md](../../docs/spec/11-audio.md), AUD-1..13). The JS half is
[`web/audio`](../../web/audio). An app's `AudioContext`, nodes and `decodeAudioData` calls go through the JS
layer, which sends control messages to this module. The module renders the graph on the device's audio
thread.

## Layout

| path | what |
|---|---|
| `src/core.*` | render-quantum buses, refcounted sample storage, the spec's up/down-mix rules |
| `src/param.*` | AudioParam automation timeline (all event types, cancel/hold, the hold rule for exponential ramps) |
| `src/nodes.*` | node DSP: Gain, AudioBufferSource, ConstantSource, Oscillator + PeriodicWave, StereoPanner, Panner (equal-power + HRTF), BiquadFilter, Delay, Analyser, Convolver, ChannelSplitter/Merger, Destination |
| `src/graph.*` | one context's render graph, control batches, garbage hand-back |
| `src/context.*` | realtime and offline contexts, the shared state block, the module registry |
| `src/decode*.cpp`, `src/resampler.*` | decodeAudioData backends, the band-limited resampler, the decoder thread pool |
| `src/output_oboe.cpp` / `src/output_null.cpp` | the device (Oboe on Android) / a host output paced in real time |
| `src/notify.*` | wakes the JS thread through the host's task queue |
| `src/binding_v8.cpp` | `iwn_register_audio`: the `__iwn.audio` natives (contract: `web/audio/src/natives.ts`) |
| `include/iwn/audio.h` | host API: hooks, `setOutputPaused` (AUD-2), `shutdown` (PROC-7), `stats` |
| `host-node/addon.cpp` | the same binding as a Node addon, so the JS layer can be tested against this engine |
| `device-probe/` | headset smoke APK (HL-4 "audio smoke") |
| `test/` | host tests, decode fixtures (`fixtures/make-fixtures.sh`), decoder fuzzer |

## How it works

- **Control messages (AUD-10, AUD-11).** JS writes each graph change as a few numbers into a per-context
  batch and submits it once per task, from a microtask. `Graph::prepare` runs on the JS thread. It builds node
  objects, copies curves, builds wavetables and convolver kernels, and allocates buses. The render thread then
  applies the whole batch at a render-quantum boundary. A test checks that two gains changed in one task
  never render one quantum with only one of them changed. Objects the render thread drops go back to the JS
  thread to be freed. The render thread does not allocate, lock or wait on JS. Every command that can carry
  an object (ConnectParam: a param input bus; SetBuffer: the buffer and a larger output bus) always takes its
  attachment slots, null when nothing is handed over, so `apply()` never guesses which command owns one.
- **No allocation on the render thread.** The vectors the render thread appends to (automation events,
  connection lists) publish their size and capacity (`GrowHint`). While preparing a batch, the JS thread
  counts what the batch adds to each of them. Nodes created by the batch are reserved directly. Live ones get
  larger storage in the batch, which the render thread swaps in before applying it. Growing on the render
  thread is only a fallback, counted in `stats().rtAllocations`; the host test and the device probe check that
  it stays 0 under three.js-style automation, new connections and HRTF. HRTF delay lines are allocated at
  construction.
- **Automation lists stay bounded.** An insert recomputes only the events whose start depends on it (O(1) in
  practice). Repeated `setValueAtTime`/`setTargetAtTime` at one time replace each other (exact). A param holds
  at most 512 pending events; beyond that the newest replaces its neighbour in time
  (`stats().paramEventsMerged`). This matters on a suspended context: `currentTime` is frozen and three.js
  keeps appending 9 listener ramps (and 6 per PositionalAudio) per frame. `setTargetAtTime` counts as
  constant once within float resolution of its target.
- **Shared memory.** JS reads `currentTime`, the render-side state, the latencies and every AudioParam's computed
  value from native memory, a `Float64Array` and a `Float32Array`, without calling native code. `param.value`
  returns the value the app just assigned until a render quantum has computed it (in flight, or a suspended or
  paused context). An `AudioParam` keeps its node alive, so a kept param can never drive a node that later
  reuses its slot; connection keys carry a per-slot generation for the same reason. After `close()` (and after
  an offline render) the JS layer drops graph changes instead of queueing them natively. Automation calls
  write straight into the batch's `Float64Array` (no rest arrays, no closures per task).
- **Rendering.** The engine renders 128-frame quanta. A FIFO adapts them to the device burst (192 frames on
  Quest 3S). The graph is pulled from every live node, so an analyser or source that does not reach the
  destination still runs and still ends. Silent buses cost no work, and nodes with tails go silent again after
  them: HRTF panners two quanta after their input stops, Delay once its whole line holds zeros, Convolver after
  `partitions + 1` silent quanta.
- **Cycles.** A DelayNode that can reach itself (found by a search on the render thread after topology changes)
  renders in two halves, as the spec describes: its output comes from the delay line before its inputs are
  pulled (delay clamped to at least one quantum), and its input is written after the rest of the graph rendered.
  Echoes land exactly at the delay time. The Convolver uses non-uniform partitions (128 / 1024 / 4096-frame
  levels covering IR frames [0, 2048), [2048, 8192) and [8192, end); no added latency), so a 4 s stereo IR costs about as much per quantum as a 1 s one. A cycle without a DelayNode is detected when a node is re-entered while
  its inputs are pulled; every node of that cycle outputs silence (spec).
- **Equal-power panning under automation.** With every listener and panner param ramped (three.js does that
  each frame), the spec's per-sample azimuth/distance/cone is evaluated at every 16th sample and in the middle of
  each segment, and the panning matrix is interpolated in between. A segment whose midpoint deviates by more
  than 1e-5 (a kink: distance crossing `refDistance`, a cone edge, azimuth folding) is computed per sample. Host
  test: within 3e-7 of per-sample evaluation for a source passing at 4 and 40 m/s.
- **Lifetime.** JS node objects are tracked with a `FinalizationRegistry`. A released node is removed once it can
  no longer be heard: a source that has ended or never started, or a node with no inputs. The render side
  then frees its id and param slots for reuse. A started source stays alive until it ends, so its `onended`
  still fires.
- **Events (PROC-2).** Ended sources, state acknowledgements, decode results and offline completions are queued
  for the JS thread. With host hooks (`setHostHooks`), the notifier thread posts one task per burst. The
  runtime core build installs these hooks automatically through `iwn::Runtime::post_task`. Without hooks, the
  JS layer polls, and only while it is waiting for something.
- **Lifecycle (AUD-2).** `iwn::audio::setOutputPaused(reason, paused)` pauses device output for every realtime
  context. `currentTime` stops and the JS-visible `state` does not change. The JS layer calls it from
  `document`'s `visibilitychange`. The core folds both the activity lifecycle and the OpenXR hidden state into
  `visibilitychange`. While output is paused no render callback runs, so the JS thread applies queued batches
  and answers state requests itself (under a try-lock the render callback also takes): `close()`/`resume()`
  resolve, queues stay bounded, and nothing piles up for the first callback after resuming.
- **Device changes (AUD-12).** A disconnect or route change closes the Oboe stream. A reopener thread opens a
  new stream at the context's original rate (Oboe resamples if the new route's native rate differs, so pitch
  and `currentTime` stay right) and starts it if output is wanted, retrying with backoff (50 ms up to 2 s)
  while no device is available. A failed `requestStart` (a stream disconnected while paused) also reopens.
  `baseLatency`/`outputLatency` follow the new stream. While no stream is up, the reopener thread services
  control batches and state requests in place of the render callback, so `close()`/`resume()` settle and
  nothing piles up. Oboe's error callbacks live in a shared object the streams hold (shared_ptr callback API),
  so a disconnect racing a reload or exit cannot touch a freed output.
- **Exit (PROC-7).** The core's shutdown hook drops the binding's V8 handles while the isolate is still alive,
  then calls `iwn::audio::shutdown()`. It stops every device, ends offline renders and joins the decoder and
  notifier threads. A new runtime in the same cached process (Android relaunch) re-arms the module
  (`rearmAfterShutdown`): device-checked with 10 relaunches in one process. On `location.reload()` (PROC-8), the
  contexts of the previous page are destroyed, its registered buffers are released, and decodes it started are
  dropped instead of resolving the new page's requests. If the core drops a posted drain task (page replaced
  before it ran), the notifier re-posts after 1 s instead of stalling event delivery.
- **Context release.** `close()` releases the native context at once (the JS object stays usable for reads); an
  `OfflineAudioContext` is released when it is collected, so a kept one still reads its analysers.
- **Bounded requests.** State requests (`resume`/`suspend`/`close`) are acknowledged cumulatively, so any number
  in one task settles (16 slots on the render side). Curves over 1e7 values and periodic waves over the native
  limit throw `NotSupportedError`; a batch the native side still rejects is dropped, not resubmitted.
- **Event queue (render -> JS, 4096 entries).** Nothing is dropped when it is full: an `ended` that does not fit
  is retried every quantum (the source is not collected before it is delivered), and node collection, which
  posts `NodeFreed`, waits for room. The offline render thread waits for the JS thread instead of racing ahead.

## Decisions and documented deviations

- **Autoplay (spec open question 7).** No user activation is needed. A new `AudioContext` reports `suspended`,
  starts rendering at once and moves to `running` with a `statechange`. `resume()` always succeeds unless the
  context is closed. IWSDK calls `resume()` when an XR session starts and `suspend()` when it ends. Both work.
- **`sampleRate` option.** It is honoured. The stream is opened at that rate and Oboe resamples
  (`SampleRateConversionQuality::Medium`). Without the option, the device rate is used: 48 kHz on Quest.
- **HRTF.** `panningModel = 'HRTF'` renders a spherical-head structural model (Brown & Duda 1998): a per-ear
  interaural delay and a one-pole/one-zero head-shadow filter. It has no elevation cues, and no measured HRIR
  set ships. Equal-power follows the spec formulas exactly.
- **Channel cap.** At most 8 channels flow between nodes (AudioBuffers hold up to 32). An offline destination
  with more than 8 channels renders the first 8. Sources, panners and mergers get smaller buses, which grow
  when a buffer with more channels is assigned.
- **Nodes.** The alpha surface (the alpha scope of 2026-10-20) is the basic set: AudioContext lifecycle,
  AudioBufferSourceNode, GainNode, PannerNode + AudioListener, AudioBuffer and decodeAudioData. The engine also
  implements Oscillator, ConstantSource, StereoPanner, BiquadFilter, Delay, Analyser, Convolver,
  ChannelSplitter/Merger, PeriodicWave and OfflineAudioContext, but they are off by default: their constructors
  and `create*()` factories throw `NotSupportedError` naming the interface, and `OfflineAudioContext` /
  `webkitOfflineAudioContext` are absent. The runtime config turns them on (`assets/iwn/config.json`:
  `"glue": {"audio": {"experimental": true}}`, read by the prelude from `__iwn.config`;
  `createWebAudio(natives, { experimental: true })` in tests). The device probe and the JS tests turn them on.
  DynamicsCompressor, WaveShaper and IIRFilter always throw `NotSupportedError` naming the node.
  MediaElement/MediaStream nodes, AudioWorklet and ScriptProcessor are absent.
- **AudioBufferSourceNode** starts on the first frame at or after `when`, with no sub-sample start offset, and
  interpolates linearly. Released nodes with tails (Delay, Biquad, Convolver) are removed once they have no
  inputs, so their tail is cut.
- **AudioParam automation.** `cancelScheduledValues` keeps the value the param had when nothing earlier remains
  (as browsers do with a value set through `.value`). `setValueCurveAtTime` accepts an event exactly at its
  start time and rejects events strictly inside it; other events are rejected anywhere in `[T, T + D)`. More
  than 512 pending events on one param are merged (see above).
- **DelayNode memory.** Stereo delay lines are allocated and made resident at creation; channels 3-8 are
  zero pages that only become resident if a >2-channel input uses them (`createDelay(179)`: 66 MB resident,
  was 275 MB).
- **Panner corner cases** follow the spec: linear distance with `refDistance == maxDistance` gives
  `1 - rolloffFactor`; a listener whose forward and up vectors are parallel gives azimuth = elevation = 0.
  Start/stop times too large for a frame index never play/never stop.
- **OfflineAudioContext.** `suspend(time)` rejects with `NotSupportedError`.
- **Decoding (AUD-8).** The module decodes MP3 (dr_mp3), Ogg Vorbis (libvorbisfile) and WAV (own parser: PCM
  8/16/24/32, float 32/64, A-law, mu-law, EXTENSIBLE). On Android, AAC/M4A, FLAC and Ogg Opus go through
  AMediaExtractor/AMediaCodec. The bytes are passed in an in-memory file (memfd, via the raw syscall so the
  API 29 template builds), because the callback data source stopped reading after ~20 KB on Horizon OS. AAC loudness normalisation and DRC are turned off, and the
  encoder delay and padding from the container are trimmed. The result is resampled to the context rate
  (Kaiser-windowed sinc, ≥ 105 dB SNR on a sine; common rate pairs such as 44.1 -> 48 kHz use an exact
  polyphase bank). Limits: WAV sample rates below 1 kHz, more than 64x
  upsampling and results above 1 GiB of samples are rejected with `EncodingError` (a 2 KB WAV claiming 1 Hz
  used to decode into 183 MB).
- **AUD-9.** Failures are logged once per URL. The URL comes from `options.urlOf` or
  `globalThis.__iwnResourceUrls` (a `WeakMap<ArrayBuffer, string>` the fetch layer can fill). three's
  `AudioLoader` passes a copy (`buffer.slice(0)`), so the URL is unknown there. The line then shows the byte
  count (read before the buffer is detached) and the first bytes, once per distinct content.

## Build and test

```
# host: core + tests + fuzzer (+ the Node addon for web/audio)
cmake -S runtime/audio -B /tmp/iwn-audio-host -G Ninja && ninja -C /tmp/iwn-audio-host -j 16
/tmp/iwn-audio-host/iwn_audio_tests               # 79 tests; decode SNR vs ffmpeg when ffmpeg is on PATH
(cd web/audio && npm run build:addon && npm test)

# sanitizers + decoder fuzzing (AUD-8: 1 CPU-hour = 4 processes x 900 s)
cmake -S runtime/audio -B /tmp/iwn-audio-asan -G Ninja -DIWN_AUDIO_SANITIZE=ON \
  -DCMAKE_C_COMPILER=/usr/local/bin/clang.par -DCMAKE_CXX_COMPILER=/usr/local/bin/clang++.par
/tmp/iwn-audio-asan/iwn_audio_fuzz 900 <seed> test/fixtures/*.{mp3,ogg,wav,m4a,flac}

# Android: part of runtime/ (runtime/CMakeLists.txt picks up iwn_audio); NDK 30 (libv8android.so needs its libc++)
# device smoke: node device-probe/build-probe.mjs --libs <android build>/apk-libs.txt --out probe.apk
#               [--long 600] (AUD-10 10-minute run) [--route-test 40] (AUD-12 only)
#               install, launch, then logcat -s iwn-js | grep AUDIO-PROBE (results repeat as SUMMARY lines)
```

Third-party sources: Ogg Vorbis (`IWN_LIBOGG_DIR`, `IWN_LIBVORBIS_DIR`), dr_mp3 (`IWN_DR_LIBS_DIR`) and Oboe
(`IWN_OBOE_DIR`), by default the upstream trees `libogg/`, `libvorbis/`, `dr_libs/` and `oboe/` under
`IWN_THIRD_PARTY_DIR`. See `../../THIRD_PARTY.md`.
