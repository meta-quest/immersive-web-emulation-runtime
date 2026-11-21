# 11. Web Audio over the device audio stack

Sources: Web Audio API 1.0 (W3C Recommendation) and the 1.1 editor's draft (render quantum, AudioParam
automation algorithms, BiquadFilter formulas, DynamicsCompressor, PannerNode equal-power and distance
models, channel up/down-mixing), `decodeAudioData` semantics; MP3 (ISO/IEC 11172-3), Ogg Vorbis, WAV
(RIFF PCM/IEEE float), AAC/M4A (optional); Android AAudio and Oboe docs; IWSDK's audio loading (it
retries a failed load every frame); the showcase's own source and dist (positional sound stations; it calls
`createPanner`, `createGain`, `createBufferSource`, `decodeAudioData` and `setTargetAtTime`, and ships
MP3 cues).

Scope rule ("the node set IWSDK uses"): what IWSDK packages, the IWSDK examples or the
showcase use is MUST; other Web Audio features are SHOULD and are promoted when the 23-sample sweep or a
real app needs them.

## Context

**AUD-1 (MUST).** `AudioContext` (options `latencyHint`, `sampleRate`: honoured by resampling or rejected
with `NotSupportedError`, documented), `state` (`suspended` | `running` | `closed`), `resume/suspend/close`
(promises, `statechange`), `currentTime` advancing from rendered frames (not wall time; monotonic),
`sampleRate` (the device's, 48 kHz on Quest), `baseLatency`/`outputLatency`, `destination`
(`maxChannelCount` 2), `listener`, `getOutputTimestamp()`. No user activation is required: a context may
start `running` immediately or start `suspended` and `resume()` always succeeds (decide to match what apps
expect from Quest Browser after a gesture; record the choice).
_Check:_ `new AudioContext()` then `resume()` → `running`; `currentTime` advances by ~1.0 per second of
wall time and never goes backwards.

**AUD-2 (MUST).** The context suspends output when the app is paused (PROC-6) and when the XR session is
`hidden`, resuming on return, without changing the JS-visible `state` unless the app called
`suspend()`; `currentTime` does not advance while output is paused.
_Check:_ doff/don: audio stops and resumes; the app sees no `statechange`.

**AUD-3 (SHOULD).** `OfflineAudioContext(channels, length, sampleRate)` and the options-object form;
`startRendering()` renders on a background thread and resolves with an `AudioBuffer` (and fires
`complete`); calling it twice rejects with `InvalidStateError`. Offline output equals what the realtime
graph would produce for the same graph and schedule. (No IWSDK package, example or the showcase uses it
today; it is also the easiest way to run AUD-5/AUD-6 golden tests, so implementing it early is useful.)
_Check:_ render a fixed graph offline and compare against golden samples within 1e-4 (float).

## Nodes and parameters

**AUD-4 (MUST).** `AudioNode` basics: `connect(node, out, in)` returns the destination, `connect(param,
out)`, all `disconnect` forms, fan-in summing, `numberOfInputs/Outputs`, `channelCount`,
`channelCountMode`, `channelInterpretation` with the spec's speaker up/down-mix rules; constructors `new
XNode(ctx, options)` and the `ctx.createX()` factories.
_Check:_ spec-derived tests for mixing (mono→stereo, stereo→mono).

**AUD-5 (MUST).** `AudioParam`: `value` (getter returns the current computed value; setter is
`setValueAtTime(v, currentTime)`), `defaultValue`, `minValue`, `maxValue` (nominal range clamping),
`automationRate`, `setValueAtTime`, `linearRampToValueAtTime`, `exponentialRampToValueAtTime` (a target of 0
throws `RangeError`; when the previous value and the target have opposite signs or the previous value is
0, the value holds until the end time, as the spec says), `setTargetAtTime`, `setValueCurveAtTime`, `cancelScheduledValues`,
`cancelAndHoldAtTime`, with the spec's event-list algorithm; a-rate params computed per sample, k-rate per
quantum.
_Check:_ compare the automation output of a schedule set against values computed by the spec formulas
(or recorded from Chrome) within 1e-5.

**AUD-6 (MUST for the first group, SHOULD for the rest).** MUST (used by IWSDK or the showcase):
`GainNode`; `AudioBufferSourceNode` (`buffer` settable once, `loop`, `loopStart/End`, `playbackRate` and
`detune` with interpolation, `start(when, offset, duration)`, `stop(when)`, `ended` event / `onended`
once, `start` twice throws `InvalidStateError`, `stop` without a buffer does not crash); `PannerNode`
(`panningModel` `equalpower` and `HRTF` accepted — HRTF may render as equal-power unless a real HRTF is
implemented, documented — distance models `linear`/`inverse`/`exponential`, `refDistance`,
`maxDistance`, `rolloffFactor`, cone parameters, position/orientation params and `setPosition/
setOrientation`); `AudioListener` (position/forward/up params and `setPosition/setOrientation`).
SHOULD, each promoted when a sample needs it: `OscillatorNode` (sine, square, sawtooth, triangle, custom
`PeriodicWave`), `BiquadFilterNode` (all eight filter types, coefficients as the Web Audio spec defines them,
`getFrequencyResponse`), `DynamicsCompressorNode`, `StereoPannerNode`, `ConstantSourceNode`,
`ChannelSplitterNode`/`ChannelMergerNode`, `DelayNode`, `ConvolverNode`, `WaveShaperNode`,
`AnalyserNode`. Until a SHOULD node exists, its factory and constructor throw a `NotSupportedError`
naming the node. `MediaElementAudioSourceNode`, `MediaStream*` and `AudioWorklet` are absent
(documented).
_Check:_ per-node golden tests against spec formulas or Chrome output; the showcase's sound stations play
with correct panning when walking around them (human check).

**AUD-7 (MUST).** `AudioBuffer`: constructor and `createBuffer`, `getChannelData` returns the same
`Float32Array` each call (aliasing the buffer's memory), `copyToChannel/copyFromChannel`, `length`,
`duration`, `sampleRate`, `numberOfChannels`; limits per spec (`NotSupportedError`).
_Check:_ tests.

## Decode

**AUD-8 (MUST).** `decodeAudioData(arrayBuffer[, success, error])`: promise and callback forms; detaches
the input buffer as browsers do; decodes MP3 (MPEG-1/2 Layer III, CBR/VBR, ID3 skipped, encoder delay/
padding trimmed when tagged), Ogg Vorbis, WAV (integer PCM and IEEE-float sample formats, any channel count the RIFF header declares),
FLAC (SHOULD), AAC/M4A (SHOULD); resamples to the context's rate with a quality resampler; runs off the
main thread; rejects with `EncodingError` DOMException on undecodable data without crashing. The decoded
buffer is fully written before the promise resolves.
_Check:_ a decode test set (each format, mono/stereo, 22.05/44.1/48 kHz) compared with a reference decoder
(e.g. ffmpeg) by SNR ≥ 60 dB after alignment; fuzzed inputs for 1 CPU-hour without crash.

**AUD-9 (MUST).** Decode failures are reported once per URL in the log with the reason, so an app that
retries a failed load every frame (IWSDK does) shows up immediately.
_Check:_ a garbage `.mp3` produces one clear log line and an `EncodingError`.

## Real-time behaviour

**AUD-10 (MUST).** Stereo output at the device rate, rendered in the Web Audio spec's 128-frame render
quanta whatever the device's burst size, with latency per AUD-13. Output never glitches because of the
main JS thread, GC, allocation or logging: audio rendering never waits on them. Graph changes made by JS in
one task take effect together at a render-quantum boundary, never partway through one (the Web Audio
spec's control-message model).
_Check:_ no xruns (as reported by the platform audio API) over a 10-minute showcase run with all sound
stations playing, while a synthetic main-thread load forces major GCs every second; a test that changes
two gains in one task never renders a quantum with only one of them changed.

**AUD-11 (MUST).** Main-thread cost: a node property write or automation call costs < 5 µs of main-thread
time; when the app changes nothing in the graph, audio adds no main-thread time per frame; scheduling 100
one-shot voices in one frame costs < 1 ms of main-thread time.
_Check:_ micro-benchmark on device.

**AUD-12 (MUST).** Device routing changes (headphones plugged, Bluetooth) and stream disconnects restart
the stream transparently.
_Check:_ plug/unplug headphones during playback.

**AUD-13 (SHOULD).** Output latency (`outputLatency` + `baseLatency`) ≤ 40 ms on Quest 3.
_Check:_ reported values; loopback measurement once.
