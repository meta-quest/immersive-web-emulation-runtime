/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The native audio module as JS sees it (`globalThis.__iwn.audio`, installed by
 * `iwn_register_audio` in runtime/audio/src/binding_v8.cpp). The Node addon built from the same
 * binding (runtime/audio/host-node) exposes the identical object for host tests.
 */
export interface AudioNatives {
  readonly protocolVersion: number;
  /**
   * kind 0 = realtime (sampleRate 0 = device rate), 1 = offline.
   * Returns [contextId, sampleRate, shared state (Float64Array), param values (Float32Array)].
   * Both arrays alias native memory that the render thread updates.
   */
  createContext(
    kind: 0 | 1,
    sampleRate: number,
    channels: number,
    length: number,
    latencyHint: number,
  ): [number, number, Float64Array, Float32Array];
  releaseContext(id: number): void;
  /** Queues one control batch; returns its sequence number (1, 2, ...). Throws on a malformed batch. */
  submit(ctx: number, words: Float64Array, count: number): number;
  startRendering(ctx: number): boolean;
  /** Returns [bufferId, ...channelData] (Float32Arrays alias native memory). */
  createBuffer(
    channels: number,
    length: number,
    sampleRate: number,
  ): [number, ...Float32Array[]];
  /** Returns [bufferId, channels, length, sampleRate, ...channelData], or null if unknown. */
  takeBuffer(
    id: number,
  ): [number, number, number, number, ...Float32Array[]] | null;
  releaseBuffer(id: number): void;
  /** Detaches `data` and decodes it on a worker thread; completion arrives as an event. */
  decode(
    ctx: number,
    data: ArrayBuffer,
    requestId: number,
    targetRate: number,
  ): void;
  /** Flat event list [type, ctx, a, b, message | null, ...], or undefined when none. */
  poll(): Array<number | string | null> | undefined;
  /** True when native will post events as tasks (host hooks present); false means JS must poll. */
  setEventHandler(
    fn: ((events: Array<number | string | null>) => void) | null,
  ): boolean;
  pendingWork(): boolean;
  analyserTime(
    ctx: number,
    node: number,
    out: Float32Array | Uint8Array,
    fftSize: number,
  ): void;
  analyserFreq(
    ctx: number,
    node: number,
    out: Float32Array | Uint8Array,
    fftSize: number,
    smoothing: number,
    minDb: number,
    maxDb: number,
    frame: number,
  ): void;
  biquadResponse(
    type: number,
    sampleRate: number,
    frequency: number,
    detune: number,
    q: number,
    gain: number,
    freqs: Float32Array,
    mag: Float32Array,
    phase: Float32Array,
  ): void;
  /** [contextTime, CLOCK_MONOTONIC ms] of the frame being presented, or null. */
  outputTimestamp(ctx: number): [number, number] | null;
  /** CLOCK_MONOTONIC in ms (to convert output timestamps to performance.now()). */
  nowMs(): number;
  stats(): AudioStats;
  setOutputPaused(reasonMask: number, paused: boolean): void;
}

export interface AudioStats {
  realtimeContexts: number;
  offlineContexts: number;
  xruns: number;
  renderLoad: number;
  liveNodes: number;
  liveBuffers: number;
  pendingDecodes: number;
  pausedReasons: number;
  /** Render-thread vector growths (fallback path; 0 in steady state, AUD-10). */
  rtAllocations?: number;
  /** Automation events folded into a neighbour because a param's list hit its cap. */
  paramEventsMerged?: number;
}

export interface WebAudioOptions {
  /** Logger for runtime diagnostics (decode failures, AUD-9). Default: console.warn. */
  log?: (message: string) => void;
  /** Resolves a fetched ArrayBuffer to its URL for AUD-9 logging (the fetch layer can provide it). */
  urlOf?: (data: ArrayBuffer) => string | undefined;
  /** performance.now() source (default globalThis.performance.now). */
  now?: () => number;
  /**
   * Web Audio beyond the alpha's basic set (the alpha scope of 2026-10-20): OscillatorNode, ConstantSourceNode,
   * StereoPannerNode, BiquadFilterNode, DelayNode, AnalyserNode, ConvolverNode, ChannelSplitter/MergerNode,
   * PeriodicWave and OfflineAudioContext, and their factories. Off by default: the constructors and
   * factories throw NotSupportedError naming the API, and OfflineAudioContext is absent. The prelude turns
   * it on from the runtime config ("glue": {"audio": {"experimental": true}}).
   */
  experimental?: boolean;
}
