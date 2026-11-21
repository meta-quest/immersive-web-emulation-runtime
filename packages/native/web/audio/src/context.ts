/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { AudioBuffer, ENV } from './buffer.ts';
import { bindContext, Core, type CoreOwner, type Env } from './core.ts';
import {
  AnalyserNode,
  AudioBufferSourceNode,
  AudioDestinationNode,
  AudioListener,
  BiquadFilterNode,
  ChannelMergerNode,
  ChannelSplitterNode,
  ConstantSourceNode,
  ConvolverNode,
  DelayNode,
  GainNode,
  OscillatorNode,
  PannerNode,
  PeriodicWave,
  StereoPannerNode,
  type PeriodicWaveOptions,
} from './nodes.ts';
import { INTERNAL } from './param.ts';
import { Op, Shared } from './protocol.ts';
import { domError, HandlerSlot, reportError } from './util.ts';

export type AudioContextState = 'suspended' | 'running' | 'closed';
const STATES: AudioContextState[] = ['suspended', 'running', 'closed'];

type DecodeSuccess = ((buffer: AudioBuffer) => void) | null | undefined;
type DecodeError = ((error: DOMException) => void) | null | undefined;

// AUD-9: one log line per URL (or per content when the URL is unknown).
const loggedDecodeFailures = new Set<string>();

function contentKey(data: ArrayBuffer): string {
  const v = new Uint8Array(data, 0, Math.min(16, data.byteLength));
  let h = `${data.byteLength}:`;
  for (const b of v) h += b.toString(16).padStart(2, '0');
  return h;
}

// A context collected before it was closed or finished rendering (e.g. an OfflineAudioContext
// that never started). The held value must not reference the Core: it would keep it alive.
const contextRegistry = new FinalizationRegistry<{ env: Env; id: number }>((held) => {
  const ref = held.env.hub.cores.get(held.id);
  if (ref && ref.deref() === undefined) held.env.hub.cores.delete(held.id);
  try {
    held.env.natives.releaseContext(held.id);
  } catch {
    // already gone
  }
});

/** BaseAudioContext: factories, decodeAudioData, state, listener, destination. */
export class BaseAudioContext extends EventTarget implements CoreOwner {
  #env: Env;
  #core: Core;
  #state: AudioContextState = 'suspended';
  #destination: AudioDestinationNode;
  #listener: AudioListener;
  #onstatechange: HandlerSlot;
  #requests = new Map<number, { resolve: () => void; reject: (e: unknown) => void; desired: number }>();
  #nextRequest = 1;
  /** Id of the first close request acknowledged (0: none). */
  #closeRequestId = 0;

  constructor(token: symbol, env: Env, core: Core, destinationChannels: number, maxChannels: number) {
    if (token !== INTERNAL) throw new TypeError('Illegal constructor');
    super();
    this.#env = env;
    this.#core = core;
    core.owner = this;
    bindContext(this, core);
    env.hub.register(core);
    this.#destination = new AudioDestinationNode(INTERNAL, this, destinationChannels, maxChannels, core.offline);
    this.#listener = new AudioListener(INTERNAL, core);
    this.#onstatechange = new HandlerSlot(this, 'statechange');
    contextRegistry.register(this, { env, id: core.id }, this);
  }

  /** @internal */
  protected get _core(): Core {
    return this.#core;
  }
  /** @internal */
  protected get _env(): Env {
    return this.#env;
  }

  get sampleRate(): number {
    return this.#core.sampleRate;
  }
  get currentTime(): number {
    return this.#core.currentTime;
  }
  get destination(): AudioDestinationNode {
    return this.#destination;
  }
  get listener(): AudioListener {
    return this.#listener;
  }
  get state(): AudioContextState {
    return this.#state;
  }
  get onstatechange(): ((ev: Event) => unknown) | null {
    return this.#onstatechange.get();
  }
  set onstatechange(v: ((ev: Event) => unknown) | null) {
    this.#onstatechange.set(v);
  }

  /** @internal: the native context can never render again; free it now (not at collection). */
  protected _release(): void {
    contextRegistry.unregister(this);
    this.#env.hub.releaseCore(this.#core);
  }

  /** @internal */
  protected _setState(s: AudioContextState): void {
    if (s === this.#state) return;
    this.#state = s;
    if (s === 'closed') {
      this.#env.hub.strong.delete(this);
      this.#core.playing.clear();
      this.#core.dead = true;
    }
    this.dispatchEvent(new Event('statechange'));
  }

  /** @internal: asks the render thread for a state change; resolves when it acknowledges. */
  protected _requestState(desired: number): Promise<void> {
    const id = this.#nextRequest++;
    return new Promise<void>((resolve, reject) => {
      this.#requests.set(id, { resolve, reject, desired });
      this.#core.pendingState++;
      this.#core.cmd(Op.ContextState, desired, id);
      this.#env.hub.kick();
    });
  }

  /**
   * @internal CoreOwner. Acknowledgements are cumulative: the render side handles requests in
   * order and may fold many of them into one ack (more than it can queue), so an ack for request
   * `requestId` settles every request up to it. Each settles as if handled alone: a close is final,
   * so resume()/suspend() requested after a close reject.
   */
  onState(state: number, requestId: number): void {
    const s = STATES[state] ?? 'suspended';
    this._setState(s);
    for (const [id, req] of this.#requests) {
      if (id > requestId) break;
      this.#requests.delete(id);
      this.#core.pendingState = Math.max(0, this.#core.pendingState - 1);
      if (req.desired === 2) this.#closeRequestId ||= id;
      if (req.desired !== 2 && this.#closeRequestId !== 0) {
        req.reject(domError('InvalidStateError', 'the context is closed'));
      } else {
        req.resolve();
      }
    }
    // Closed and acknowledged: the render side will never run again.
    if (s === 'closed' && !this.#core.offline && this.#requests.size === 0) this._release();
  }

  /** @internal CoreOwner */
  onRenderDone(_bufferId: number): void {}

  createGain(): GainNode {
    return new GainNode(this);
  }
  createDelay(maxDelayTime = 1): DelayNode {
    return new DelayNode(this, { maxDelayTime });
  }
  createBufferSource(): AudioBufferSourceNode {
    return new AudioBufferSourceNode(this);
  }
  createConstantSource(): ConstantSourceNode {
    return new ConstantSourceNode(this);
  }
  createOscillator(): OscillatorNode {
    return new OscillatorNode(this);
  }
  createPanner(): PannerNode {
    return new PannerNode(this);
  }
  createStereoPanner(): StereoPannerNode {
    return new StereoPannerNode(this);
  }
  createBiquadFilter(): BiquadFilterNode {
    return new BiquadFilterNode(this);
  }
  createAnalyser(): AnalyserNode {
    return new AnalyserNode(this);
  }
  createConvolver(): ConvolverNode {
    return new ConvolverNode(this);
  }
  createChannelSplitter(numberOfOutputs = 6): ChannelSplitterNode {
    return new ChannelSplitterNode(this, { numberOfOutputs });
  }
  createChannelMerger(numberOfInputs = 6): ChannelMergerNode {
    return new ChannelMergerNode(this, { numberOfInputs });
  }
  createPeriodicWave(real: ArrayLike<number>, imag: ArrayLike<number>, constraints: { disableNormalization?: boolean } = {}): PeriodicWave {
    const opts: PeriodicWaveOptions = { real, imag, disableNormalization: constraints.disableNormalization };
    if (real.length !== imag.length) throw domError('IndexSizeError', 'real and imag must have the same length');
    return new PeriodicWave(this, opts);
  }
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBuffer {
    return new this.#env.AudioBuffer({ numberOfChannels, length, sampleRate }) as AudioBuffer;
  }
  createDynamicsCompressor(): never {
    throw domError('NotSupportedError', 'DynamicsCompressorNode is not supported by this runtime');
  }
  createWaveShaper(): never {
    throw domError('NotSupportedError', 'WaveShaperNode is not supported by this runtime');
  }
  createIIRFilter(): never {
    throw domError('NotSupportedError', 'IIRFilterNode is not supported by this runtime');
  }
  createScriptProcessor(): never {
    throw domError('NotSupportedError', 'ScriptProcessorNode is not supported by this runtime');
  }

  /**
   * decodeAudioData (AUD-8): detaches the input, decodes off the main thread (MP3, Ogg Vorbis,
   * WAV; AAC/M4A, FLAC, Opus through the platform decoders on device), resamples to the context
   * rate. Failures reject with EncodingError and are logged once per URL (AUD-9).
   */
  decodeAudioData(audioData: ArrayBuffer, successCallback?: DecodeSuccess, errorCallback?: DecodeError): Promise<AudioBuffer> {
    const env = this.#env;
    const fail = (e: DOMException): Promise<AudioBuffer> => {
      if (typeof errorCallback === 'function') queueMicrotask(() => errorCallback(e));
      return Promise.reject(e);
    };
    if (!(audioData instanceof ArrayBuffer)) {
      return fail(new TypeError('decodeAudioData: argument must be an ArrayBuffer') as unknown as DOMException);
    }
    if ((audioData as ArrayBuffer & { detached?: boolean }).detached) {
      return fail(domError('DataCloneError', 'decodeAudioData: the ArrayBuffer is detached'));
    }
    const url = env.urlOf(audioData);
    const key = url ?? contentKey(audioData);
    const byteLength = audioData.byteLength; // natives.decode detaches the buffer
    const requestId = env.hub.nextRequest++;
    const core = this.#core;
    return new Promise<AudioBuffer>((resolve, reject) => {
      env.hub.decodes.set(requestId, {
        resolve: (bufferId: number) => {
          const native = env.natives.takeBuffer(bufferId);
          if (!native) {
            reject(domError('EncodingError', 'decoded buffer disappeared'));
            return;
          }
          const buffer = env.wrapBuffer(native) as AudioBuffer;
          if (typeof successCallback === 'function') {
            try {
              successCallback(buffer);
            } catch (e) {
              reportError(e);
            }
          }
          resolve(buffer);
        },
        reject: (message: string) => {
          if (!loggedDecodeFailures.has(key)) {
            loggedDecodeFailures.add(key);
            env.log(`[iwn.audio] decodeAudioData failed for ${url ?? `<${byteLength} bytes, url unknown>`}: ${message}`);
          }
          const err = domError('EncodingError', `Unable to decode audio data: ${message}`);
          if (typeof errorCallback === 'function') {
            try {
              errorCallback(err);
            } catch (e) {
              reportError(e);
            }
          }
          reject(err);
        },
      });
      try {
        env.natives.decode(core.id, audioData, requestId, core.sampleRate);
      } catch (e) {
        env.hub.decodes.delete(requestId);
        reject(e);
        return;
      }
      env.hub.kick();
    });
  }
}

export interface AudioContextOptions {
  latencyHint?: 'interactive' | 'balanced' | 'playback' | number;
  sampleRate?: number;
}

/**
 * AudioContext (AUD-1). Decision on autoplay (spec open question 7): no user activation is
 * needed. A new context reports `suspended`, starts rendering at once and moves to `running` with
 * a `statechange` event; `resume()` always succeeds unless the context is closed.
 */
export class AudioContext extends BaseAudioContext {
  #offsetMs: number;
  constructor(options: AudioContextOptions = {}) {
    const env = (new.target as unknown as { [ENV]?: Env })[ENV];
    if (!env) throw new TypeError('Illegal constructor');
    let rate = 0;
    if (options.sampleRate !== undefined) {
      rate = Number(options.sampleRate);
      if (!(rate >= 3000 && rate <= 768000)) {
        throw domError('NotSupportedError', `sampleRate ${options.sampleRate} is outside [3000, 768000]`);
      }
    }
    let hint = 0;
    const lh = options.latencyHint;
    if (lh === 'playback' || (typeof lh === 'number' && lh >= 0.1)) hint = 1;
    else if (lh !== undefined && lh !== 'interactive' && lh !== 'balanced' && typeof lh !== 'number') {
      throw new TypeError(`invalid latencyHint '${String(lh)}'`);
    }
    if (env.onFirstContext) {
      const first = env.onFirstContext;
      env.onFirstContext = undefined;
      first();
    }
    const created = env.natives.createContext(0, rate, 2, 0, hint);
    const core = new Core(env, created, false);
    super(INTERNAL, env, core, 2, 2);
    env.hub.strong.add(this);
    this.#offsetMs = env.natives.nowMs() - env.now();
    // The initial 'running' state event is queued natively; deliver it after this task.
    queueMicrotask(() => env.hub.poll());
  }

  get baseLatency(): number {
    return this._core.shared[Shared.BaseLatency];
  }
  get outputLatency(): number {
    return this._core.shared[Shared.OutputLatency];
  }
  getOutputTimestamp(): { contextTime: number; performanceTime: number } {
    const ts = this._env.natives.outputTimestamp(this._core.id);
    if (!ts) return { contextTime: this.currentTime, performanceTime: this._env.now() };
    return { contextTime: ts[0], performanceTime: ts[1] - this.#offsetMs };
  }
  // close() moves the control-thread state to closed at once (spec), so a resume()/suspend()/
  // close() made while the close is still being acknowledged rejects too.
  resume(): Promise<void> {
    if (this.state === 'closed' || this._core.dead) return Promise.reject(domError('InvalidStateError', 'the context is closed'));
    return this._requestState(1);
  }
  suspend(): Promise<void> {
    if (this.state === 'closed' || this._core.dead) return Promise.reject(domError('InvalidStateError', 'the context is closed'));
    return this._requestState(0);
  }
  close(): Promise<void> {
    if (this.state === 'closed' || this._core.dead) return Promise.reject(domError('InvalidStateError', 'the context is already closed'));
    const done = this._requestState(2);
    // Hand the close request over now; later graph changes have no effect and must not queue
    // natively (nothing consumes them once the render side closed).
    this._core.flush();
    this._core.dead = true;
    return done;
  }
}

export interface OfflineAudioContextOptions {
  numberOfChannels?: number;
  length: number;
  sampleRate: number;
}

export class OfflineAudioCompletionEvent extends Event {
  readonly renderedBuffer: AudioBuffer;
  constructor(type: string, init: { renderedBuffer: AudioBuffer }) {
    super(type);
    this.renderedBuffer = init.renderedBuffer;
  }
}

/** OfflineAudioContext (AUD-3): renders on a background thread. */
export class OfflineAudioContext extends BaseAudioContext {
  #length: number;
  #started = false;
  #resolve: ((b: AudioBuffer) => void) | null = null;
  #oncomplete: HandlerSlot;

  constructor(contextOptionsOrChannels: OfflineAudioContextOptions | number, length?: number, sampleRate?: number) {
    const env = (new.target as unknown as { [ENV]?: Env })[ENV];
    if (!env) throw new TypeError('Illegal constructor');
    let o: OfflineAudioContextOptions;
    if (typeof contextOptionsOrChannels === 'object' && contextOptionsOrChannels !== null) o = contextOptionsOrChannels;
    else o = { numberOfChannels: Number(contextOptionsOrChannels), length: Number(length), sampleRate: Number(sampleRate) };
    const ch = o.numberOfChannels === undefined ? 1 : Math.trunc(Number(o.numberOfChannels));
    const len = Math.trunc(Number(o.length));
    const sr = Number(o.sampleRate);
    if (!(ch >= 1 && ch <= 32)) throw domError('NotSupportedError', `numberOfChannels ${o.numberOfChannels} is outside [1, 32]`);
    if (!(len >= 1)) throw domError('NotSupportedError', 'length must be at least 1');
    if (!(sr >= 3000 && sr <= 768000)) throw domError('NotSupportedError', `sampleRate ${o.sampleRate} is outside [3000, 768000]`);
    let created: [number, number, Float64Array, Float32Array];
    try {
      created = env.natives.createContext(1, sr, ch, len, 0);
    } catch (e) {
      throw domError('NotSupportedError', (e as Error).message);
    }
    const core = new Core(env, created, true);
    super(INTERNAL, env, core, ch, ch);
    this.#length = len;
    this.#oncomplete = new HandlerSlot(this, 'complete');
  }

  get length(): number {
    return this.#length;
  }
  get oncomplete(): ((ev: Event) => unknown) | null {
    return this.#oncomplete.get();
  }
  set oncomplete(v: ((ev: Event) => unknown) | null) {
    this.#oncomplete.set(v);
  }

  startRendering(): Promise<AudioBuffer> {
    if (this.#started) return Promise.reject(domError('InvalidStateError', 'startRendering() was already called'));
    this.#started = true;
    const core = this._core;
    const env = this._env;
    core.flush();
    return new Promise<AudioBuffer>((resolve, reject) => {
      if (!env.natives.startRendering(core.id)) {
        reject(domError('NotSupportedError', 'could not allocate the rendered buffer'));
        return;
      }
      this.#resolve = resolve;
      core.rendering = true;
      env.hub.strong.add(this);
      this._setState('running');
      env.hub.kick();
    });
  }

  resume(): Promise<void> {
    if (!this.#started) return Promise.reject(domError('InvalidStateError', 'rendering has not started'));
    return Promise.resolve();
  }
  suspend(_suspendTime?: number): Promise<void> {
    return Promise.reject(domError('NotSupportedError', 'OfflineAudioContext.suspend() is not supported by this runtime'));
  }

  /** @internal CoreOwner */
  override onRenderDone(bufferId: number): void {
    const env = this._env;
    const native = env.natives.takeBuffer(bufferId);
    // The native context stays until this context is collected (analysers can still be read);
    // nothing holds it strongly any more.
    env.hub.strong.delete(this);
    this._core.dead = true; // the offline render thread is gone
    if (!native) return;
    const buffer = env.wrapBuffer(native) as AudioBuffer;
    this._setState('closed');
    const resolve = this.#resolve;
    this.#resolve = null;
    this.dispatchEvent(new OfflineAudioCompletionEvent('complete', { renderedBuffer: buffer }));
    resolve?.(buffer);
  }
}
