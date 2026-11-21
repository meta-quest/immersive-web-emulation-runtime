/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { AudioBuffer } from './buffer.ts';
import { coreOf, type Core } from './core.ts';
import { AudioParam, FLT_MAX, INTERNAL, type ParamSpec } from './param.ts';
import {
  BIQUAD_TYPES,
  CHANNEL_COUNT_MODES,
  CHANNEL_INTERPRETATIONS,
  DESTINATION_ID,
  DISTANCE_MODELS,
  MAX_PERIODIC_WAVE_COEFFICIENTS,
  NodeType,
  Op,
  OSC_TYPES,
  PANNING_MODELS,
  PARAM_COUNT,
  Prop,
} from './protocol.ts';
import {
  domError,
  enumIndex,
  finite,
  HandlerSlot,
  unsignedLong,
} from './util.ts';

const MAX_DETUNE = 1200 * Math.log2(FLT_MAX);
const MAX_BIQUAD_GAIN = 40 * Math.log10(FLT_MAX);

export interface AudioNodeOptions {
  channelCount?: number;
  channelCountMode?: ChannelCountMode;
  channelInterpretation?: ChannelInterpretation;
}
export type ChannelCountMode = 'max' | 'clamped-max' | 'explicit';
export type ChannelInterpretation = 'speakers' | 'discrete';

interface Constraints {
  maxChannelCount?: number;
  countFixed?: boolean;
  modeNoMax?: boolean;
  modeFixed?: boolean;
  interpFixed?: boolean;
  /** Error name when channelCount exceeds maxChannelCount (NotSupportedError or IndexSizeError). */
  countError?: string;
}

interface NodeInit {
  type: number;
  inputs: number;
  outputs: number;
  channelCount: number;
  mode: ChannelCountMode;
  interp: ChannelInterpretation;
  constraints?: Constraints;
  opts?: [number, number, number, number];
  /** Destination: fixed id, no create command, never released. */
  destination?: boolean;
}

/** AudioNode (AUD-4): connection bookkeeping, channel properties, lifetime. */
export class AudioNode extends EventTarget {
  #context: object;
  #core: Core;
  #id: number;
  #slot: number;
  #inputs: number;
  #outputs: number;
  #channelCount: number;
  #mode: ChannelCountMode;
  #interp: ChannelInterpretation;
  #constraints: Constraints;
  // Outgoing connections. Node targets: out * 2^21 + id * 2^5 + input (>= 0); params:
  // -((generation * 64 + out) * 2^16 + slot) - 1 (< 0), where generation counts how often the
  // slot was recycled (a stale key must not match the next param in that slot). Numbers keep
  // connect() allocation-free.
  #connections = new Set<number>();

  constructor(
    token: symbol,
    context: object,
    init: NodeInit,
    options: AudioNodeOptions | undefined,
  ) {
    if (token !== INTERNAL) throw new TypeError('Illegal constructor');
    super();
    const core = coreOf(context);
    this.#context = context;
    this.#core = core;
    this.#inputs = init.inputs;
    this.#outputs = init.outputs;
    this.#constraints = init.constraints ?? {};
    this.#channelCount = init.channelCount;
    this.#mode = init.mode;
    this.#interp = init.interp;
    if (options) {
      if (options.channelCount !== undefined)
        this.#checkCount(options.channelCount);
      if (options.channelCountMode !== undefined)
        this.#checkMode(options.channelCountMode);
      if (options.channelInterpretation !== undefined)
        this.#checkInterp(options.channelInterpretation);
    }
    if (init.destination) {
      this.#id = DESTINATION_ID;
      this.#slot = 0;
      return;
    }
    this.#id = core.allocNode(PARAM_COUNT[init.type] ?? 0);
    this.#slot = core.allocatedSlot;
    const o = init.opts ?? [0, 0, 0, 0];
    core.cmd(
      Op.CreateNode,
      this.#id,
      init.type,
      this.#slot,
      this.#channelCount,
      CHANNEL_COUNT_MODES.indexOf(this.#mode),
      CHANNEL_INTERPRETATIONS.indexOf(this.#interp),
      o[0],
      o[1],
      o[2],
      o[3],
    );
    core.trackNode(this, this.#id);
  }

  /** @internal */
  static idOf(n: AudioNode): number {
    return n.#id;
  }
  /** @internal */
  static coreOfNode(n: AudioNode): Core {
    return n.#core;
  }
  /** @internal: param slot `i` of this node. */
  protected _param(i: number, spec: ParamSpec, initial?: number): AudioParam {
    return new AudioParam(
      INTERNAL,
      this.#core,
      this.#slot + i,
      spec,
      initial,
      this,
    );
  }
  /** @internal */
  protected _cmd(
    op: number,
    a?: number,
    b?: number,
    c?: number,
    d?: number,
  ): void {
    this.#core.cmd(op, a, b, c, d);
  }
  /** @internal */
  protected _prop(prop: number, v: number): void {
    this.#core.cmd(Op.SetProp, this.#id, prop, v);
  }
  /** @internal */
  protected get _core(): Core {
    return this.#core;
  }
  /** @internal */
  protected get _id(): number {
    return this.#id;
  }

  get context(): object {
    return this.#context;
  }
  get numberOfInputs(): number {
    return this.#inputs;
  }
  get numberOfOutputs(): number {
    return this.#outputs;
  }

  get channelCount(): number {
    return this.#channelCount;
  }
  set channelCount(v: number) {
    if (this.#checkCount(v)) this._prop(Prop.ChannelCount, this.#channelCount);
  }
  get channelCountMode(): ChannelCountMode {
    return this.#mode;
  }
  set channelCountMode(v: ChannelCountMode) {
    if (this.#checkMode(v))
      this._prop(
        Prop.ChannelCountMode,
        CHANNEL_COUNT_MODES.indexOf(this.#mode),
      );
  }
  get channelInterpretation(): ChannelInterpretation {
    return this.#interp;
  }
  set channelInterpretation(v: ChannelInterpretation) {
    if (this.#checkInterp(v))
      this._prop(
        Prop.ChannelInterpretation,
        CHANNEL_INTERPRETATIONS.indexOf(this.#interp),
      );
  }

  #checkCount(v: unknown): boolean {
    const n = unsignedLong(v, 'channelCount');
    const c = this.#constraints;
    if (c.countFixed) {
      if (n !== this.#channelCount)
        throw domError(
          'InvalidStateError',
          'channelCount cannot be changed on this node',
        );
      return false;
    }
    if (n === 0 || n > 32)
      throw domError(
        'NotSupportedError',
        `channelCount ${n} is outside [1, 32]`,
      );
    if (c.maxChannelCount !== undefined && n > c.maxChannelCount) {
      throw domError(
        c.countError ?? 'NotSupportedError',
        `channelCount ${n} exceeds ${c.maxChannelCount} for this node`,
      );
    }
    if (n === this.#channelCount) return false;
    this.#channelCount = n;
    return true;
  }
  #checkMode(v: unknown): boolean {
    const i = enumIndex(CHANNEL_COUNT_MODES, v);
    if (i < 0) return false;
    const m = CHANNEL_COUNT_MODES[i];
    const c = this.#constraints;
    if (c.modeFixed && m !== this.#mode)
      throw domError(
        'InvalidStateError',
        'channelCountMode cannot be changed on this node',
      );
    if (c.modeNoMax && m === 'max')
      throw domError(
        'NotSupportedError',
        "channelCountMode 'max' is not allowed on this node",
      );
    if (m === this.#mode) return false;
    this.#mode = m;
    return true;
  }
  #checkInterp(v: unknown): boolean {
    const i = enumIndex(CHANNEL_INTERPRETATIONS, v);
    if (i < 0) return false;
    const m = CHANNEL_INTERPRETATIONS[i];
    if (this.#constraints.interpFixed && m !== this.#interp) {
      throw domError(
        'InvalidStateError',
        'channelInterpretation cannot be changed on this node',
      );
    }
    if (m === this.#interp) return false;
    this.#interp = m;
    return true;
  }

  connect(destination: AudioNode, output?: number, input?: number): AudioNode;
  connect(destination: AudioParam, output?: number): void;
  connect(
    destination: AudioNode | AudioParam,
    output = 0,
    input = 0,
  ): AudioNode | void {
    const out = unsignedLong(output, 'output');
    if (destination instanceof AudioNode) {
      const inp = unsignedLong(input, 'input');
      if (destination.#core !== this.#core)
        throw domError(
          'InvalidAccessError',
          'cannot connect nodes of different contexts',
        );
      if (out >= this.#outputs)
        throw domError('IndexSizeError', `output ${out} out of range`);
      if (inp >= destination.#inputs)
        throw domError('IndexSizeError', `input ${inp} out of range`);
      const key = out * 2097152 + destination.#id * 32 + inp;
      if (!this.#connections.has(key)) {
        this.#connections.add(key);
        this.#core.cmd(Op.Connect, this.#id, out, destination.#id, inp);
      }
      return destination;
    }
    if (destination instanceof AudioParam) {
      if (AudioParam.coreOf(destination) !== this.#core) {
        throw domError(
          'InvalidAccessError',
          'cannot connect to an AudioParam of a different context',
        );
      }
      if (out >= this.#outputs)
        throw domError('IndexSizeError', `output ${out} out of range`);
      const slot = AudioParam.slotOf(destination);
      const key = paramKey(out, slot, this.#core.slotGeneration[slot]);
      if (!this.#connections.has(key)) {
        this.#connections.add(key);
        this.#core.cmd(Op.ConnectParam, this.#id, out, slot);
      }
      return;
    }
    throw new TypeError(
      'connect: destination must be an AudioNode or AudioParam',
    );
  }

  disconnect(
    destinationOrOutput?: AudioNode | AudioParam | number,
    output?: number,
    input?: number,
  ): void {
    const conns = this.#connections;
    if (destinationOrOutput === undefined) {
      conns.clear();
      this.#core.cmd(Op.Disconnect, this.#id, -1, -1, -1);
      return;
    }
    if (typeof destinationOrOutput === 'number') {
      const out = unsignedLong(destinationOrOutput, 'output');
      if (out >= this.#outputs)
        throw domError('IndexSizeError', `output ${out} out of range`);
      for (const k of [...conns]) if (keyOutput(k) === out) conns.delete(k);
      this.#core.cmd(Op.Disconnect, this.#id, out, -1, -1);
      return;
    }
    const out = output === undefined ? -1 : unsignedLong(output, 'output');
    if (out >= this.#outputs)
      throw domError('IndexSizeError', `output ${out} out of range`);
    if (destinationOrOutput instanceof AudioNode) {
      const d = destinationOrOutput;
      const inp = input === undefined ? -1 : unsignedLong(input, 'input');
      if (inp >= d.#inputs)
        throw domError('IndexSizeError', `input ${inp} out of range`);
      let found = false;
      for (const k of [...conns]) {
        if (k < 0 || ((k >> 5) & 0xffff) !== d.#id) continue;
        if (out >= 0 && keyOutput(k) !== out) continue;
        if (inp >= 0 && (k & 31) !== inp) continue;
        conns.delete(k);
        found = true;
      }
      if (!found)
        throw domError(
          'InvalidAccessError',
          'disconnect: not connected to that destination',
        );
      this.#core.cmd(Op.Disconnect, this.#id, out, d.#id, inp);
      return;
    }
    if (destinationOrOutput instanceof AudioParam) {
      const slot = AudioParam.slotOf(destinationOrOutput);
      const gen = this.#core.slotGeneration[slot];
      let found = false;
      for (const k of [...conns]) {
        if (
          k >= 0 ||
          (-k - 1) % 65536 !== slot ||
          Math.floor((-k - 1) / 4194304) !== gen
        )
          continue;
        if (out >= 0 && keyOutput(k) !== out) continue;
        conns.delete(k);
        found = true;
      }
      if (!found)
        throw domError(
          'InvalidAccessError',
          'disconnect: not connected to that AudioParam',
        );
      this.#core.cmd(Op.DisconnectParam, this.#id, out, slot);
      return;
    }
    throw new TypeError('disconnect: invalid argument');
  }
}

function paramKey(out: number, slot: number, generation: number): number {
  return -((generation * 64 + out) * 65536 + slot) - 1;
}

function keyOutput(k: number): number {
  return k >= 0 ? Math.floor(k / 2097152) : Math.floor((-k - 1) / 65536) % 64;
}

// ---- destination ------------------------------------------------------------------------------

export class AudioDestinationNode extends AudioNode {
  #max: number;
  constructor(
    token: symbol,
    context: object,
    channels: number,
    maxChannels: number,
    offline: boolean,
  ) {
    super(
      token,
      context,
      {
        type: NodeType.Destination,
        inputs: 1,
        outputs: 0,
        channelCount: channels,
        mode: 'explicit',
        interp: 'speakers',
        destination: true,
        constraints: offline
          ? { countFixed: true, modeFixed: true }
          : { maxChannelCount: maxChannels, countError: 'IndexSizeError' },
      },
      undefined,
    );
    this.#max = maxChannels;
  }
  get maxChannelCount(): number {
    return this.#max;
  }
}

// ---- simple processing nodes ------------------------------------------------------------------

export interface GainOptions extends AudioNodeOptions {
  gain?: number;
}

export class GainNode extends AudioNode {
  readonly gain: AudioParam;
  constructor(context: object, options: GainOptions = {}) {
    super(
      INTERNAL,
      context,
      {
        type: NodeType.Gain,
        inputs: 1,
        outputs: 1,
        channelCount: 2,
        mode: 'max',
        interp: 'speakers',
      },
      options,
    );
    this.gain = this._param(
      0,
      {
        defaultValue: 1,
        minValue: -FLT_MAX,
        maxValue: FLT_MAX,
        automationRate: 'a-rate',
      },
      options.gain,
    );
  }
}

export interface DelayOptions extends AudioNodeOptions {
  maxDelayTime?: number;
  delayTime?: number;
}

export class DelayNode extends AudioNode {
  readonly delayTime: AudioParam;
  constructor(context: object, options: DelayOptions = {}) {
    const max =
      options.maxDelayTime === undefined
        ? 1
        : finite(options.maxDelayTime, 'maxDelayTime');
    if (!(max > 0 && max < 180))
      throw domError(
        'NotSupportedError',
        `maxDelayTime ${max} is outside (0, 180)`,
      );
    super(
      INTERNAL,
      context,
      {
        type: NodeType.Delay,
        inputs: 1,
        outputs: 1,
        channelCount: 2,
        mode: 'max',
        interp: 'speakers',
        opts: [max, 0, 0, 0],
      },
      options,
    );
    this.delayTime = this._param(
      0,
      { defaultValue: 0, minValue: 0, maxValue: max, automationRate: 'a-rate' },
      options.delayTime,
    );
  }
}

export interface StereoPannerOptions extends AudioNodeOptions {
  pan?: number;
}

const PANNER_CONSTRAINTS: Constraints = { maxChannelCount: 2, modeNoMax: true };

export class StereoPannerNode extends AudioNode {
  readonly pan: AudioParam;
  constructor(context: object, options: StereoPannerOptions = {}) {
    super(
      INTERNAL,
      context,
      {
        type: NodeType.StereoPanner,
        inputs: 1,
        outputs: 1,
        channelCount: 2,
        mode: 'clamped-max',
        interp: 'speakers',
        constraints: PANNER_CONSTRAINTS,
      },
      options,
    );
    this.pan = this._param(
      0,
      { defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'a-rate' },
      options.pan,
    );
  }
}

export interface BiquadFilterOptions extends AudioNodeOptions {
  type?: BiquadFilterType;
  Q?: number;
  detune?: number;
  frequency?: number;
  gain?: number;
}
export type BiquadFilterType = (typeof BIQUAD_TYPES)[number];

export class BiquadFilterNode extends AudioNode {
  readonly frequency: AudioParam;
  readonly detune: AudioParam;
  readonly Q: AudioParam;
  readonly gain: AudioParam;
  #type: BiquadFilterType = 'lowpass';
  constructor(context: object, options: BiquadFilterOptions = {}) {
    super(
      INTERNAL,
      context,
      {
        type: NodeType.Biquad,
        inputs: 1,
        outputs: 1,
        channelCount: 2,
        mode: 'max',
        interp: 'speakers',
      },
      options,
    );
    const nyq = this._core.sampleRate / 2;
    this.frequency = this._param(
      0,
      {
        defaultValue: 350,
        minValue: 0,
        maxValue: nyq,
        automationRate: 'a-rate',
      },
      options.frequency,
    );
    this.detune = this._param(
      1,
      {
        defaultValue: 0,
        minValue: -MAX_DETUNE,
        maxValue: MAX_DETUNE,
        automationRate: 'a-rate',
      },
      options.detune,
    );
    this.Q = this._param(
      2,
      {
        defaultValue: 1,
        minValue: -FLT_MAX,
        maxValue: FLT_MAX,
        automationRate: 'a-rate',
      },
      options.Q,
    );
    this.gain = this._param(
      3,
      {
        defaultValue: 0,
        minValue: -FLT_MAX,
        maxValue: MAX_BIQUAD_GAIN,
        automationRate: 'a-rate',
      },
      options.gain,
    );
    if (options.type !== undefined) {
      if (enumIndex(BIQUAD_TYPES, options.type) < 0)
        throw new TypeError(`invalid BiquadFilterType '${options.type}'`);
      this.type = options.type;
    }
  }
  get type(): BiquadFilterType {
    return this.#type;
  }
  set type(v: BiquadFilterType) {
    const i = enumIndex(BIQUAD_TYPES, v);
    if (i < 0 || BIQUAD_TYPES[i] === this.#type) return;
    this.#type = BIQUAD_TYPES[i];
    this._prop(Prop.BiquadType, i);
  }
  getFrequencyResponse(
    frequencyHz: Float32Array,
    magResponse: Float32Array,
    phaseResponse: Float32Array,
  ): void {
    if (
      !(frequencyHz instanceof Float32Array) ||
      !(magResponse instanceof Float32Array) ||
      !(phaseResponse instanceof Float32Array)
    ) {
      throw new TypeError(
        'getFrequencyResponse: arguments must be Float32Arrays',
      );
    }
    if (
      magResponse.length !== frequencyHz.length ||
      phaseResponse.length !== frequencyHz.length
    ) {
      throw domError(
        'InvalidAccessError',
        'getFrequencyResponse: array lengths differ',
      );
    }
    this._core.env.natives.biquadResponse(
      BIQUAD_TYPES.indexOf(this.#type),
      this._core.sampleRate,
      this.frequency.value,
      this.detune.value,
      this.Q.value,
      this.gain.value,
      frequencyHz,
      magResponse,
      phaseResponse,
    );
  }
}

export interface ChannelSplitterOptions extends AudioNodeOptions {
  numberOfOutputs?: number;
}

export class ChannelSplitterNode extends AudioNode {
  constructor(context: object, options: ChannelSplitterOptions = {}) {
    const n =
      options.numberOfOutputs === undefined
        ? 6
        : unsignedLong(options.numberOfOutputs, 'numberOfOutputs');
    if (n < 1 || n > 32)
      throw domError(
        'IndexSizeError',
        `numberOfOutputs ${n} is outside [1, 32]`,
      );
    super(
      INTERNAL,
      context,
      {
        type: NodeType.Splitter,
        inputs: 1,
        outputs: n,
        channelCount: n,
        mode: 'explicit',
        interp: 'discrete',
        constraints: { countFixed: true, modeFixed: true, interpFixed: true },
        opts: [n, 0, 0, 0],
      },
      options,
    );
  }
}

export interface ChannelMergerOptions extends AudioNodeOptions {
  numberOfInputs?: number;
}

export class ChannelMergerNode extends AudioNode {
  constructor(context: object, options: ChannelMergerOptions = {}) {
    const n =
      options.numberOfInputs === undefined
        ? 6
        : unsignedLong(options.numberOfInputs, 'numberOfInputs');
    if (n < 1 || n > 32)
      throw domError(
        'IndexSizeError',
        `numberOfInputs ${n} is outside [1, 32]`,
      );
    super(
      INTERNAL,
      context,
      {
        type: NodeType.Merger,
        inputs: n,
        outputs: 1,
        channelCount: 1,
        mode: 'explicit',
        interp: 'speakers',
        constraints: { countFixed: true, modeFixed: true },
        opts: [n, 0, 0, 0],
      },
      options,
    );
  }
}

// ---- spatialisation -----------------------------------------------------------------------------

export type PanningModelType = (typeof PANNING_MODELS)[number];
export type DistanceModelType = (typeof DISTANCE_MODELS)[number];

export interface PannerOptions extends AudioNodeOptions {
  panningModel?: PanningModelType;
  distanceModel?: DistanceModelType;
  positionX?: number;
  positionY?: number;
  positionZ?: number;
  orientationX?: number;
  orientationY?: number;
  orientationZ?: number;
  refDistance?: number;
  maxDistance?: number;
  rolloffFactor?: number;
  coneInnerAngle?: number;
  coneOuterAngle?: number;
  coneOuterGain?: number;
}

const POS: ParamSpec = {
  defaultValue: 0,
  minValue: -FLT_MAX,
  maxValue: FLT_MAX,
  automationRate: 'a-rate',
};

/**
 * PannerNode. panningModel 'HRTF' renders with a spherical-head model (interaural delay +
 * head-shadow filter per ear, Brown & Duda 1998); no measured HRIR set ships with the runtime.
 */
export class PannerNode extends AudioNode {
  readonly positionX: AudioParam;
  readonly positionY: AudioParam;
  readonly positionZ: AudioParam;
  readonly orientationX: AudioParam;
  readonly orientationY: AudioParam;
  readonly orientationZ: AudioParam;
  #panningModel: PanningModelType = 'equalpower';
  #distanceModel: DistanceModelType = 'inverse';
  #refDistance = 1;
  #maxDistance = 10000;
  #rolloffFactor = 1;
  #coneInnerAngle = 360;
  #coneOuterAngle = 360;
  #coneOuterGain = 0;

  constructor(context: object, options: PannerOptions = {}) {
    super(
      INTERNAL,
      context,
      {
        type: NodeType.Panner,
        inputs: 1,
        outputs: 1,
        channelCount: 2,
        mode: 'clamped-max',
        interp: 'speakers',
        constraints: PANNER_CONSTRAINTS,
      },
      options,
    );
    this.positionX = this._param(0, POS, options.positionX);
    this.positionY = this._param(1, POS, options.positionY);
    this.positionZ = this._param(2, POS, options.positionZ);
    this.orientationX = this._param(
      3,
      { ...POS, defaultValue: 1 },
      options.orientationX,
    );
    this.orientationY = this._param(4, POS, options.orientationY);
    this.orientationZ = this._param(5, POS, options.orientationZ);
    if (options.panningModel !== undefined) {
      if (enumIndex(PANNING_MODELS, options.panningModel) < 0)
        throw new TypeError(
          `invalid PanningModelType '${options.panningModel}'`,
        );
      this.panningModel = options.panningModel;
    }
    if (options.distanceModel !== undefined) {
      if (enumIndex(DISTANCE_MODELS, options.distanceModel) < 0)
        throw new TypeError(
          `invalid DistanceModelType '${options.distanceModel}'`,
        );
      this.distanceModel = options.distanceModel;
    }
    if (options.refDistance !== undefined)
      this.refDistance = options.refDistance;
    if (options.maxDistance !== undefined)
      this.maxDistance = options.maxDistance;
    if (options.rolloffFactor !== undefined)
      this.rolloffFactor = options.rolloffFactor;
    if (options.coneInnerAngle !== undefined)
      this.coneInnerAngle = options.coneInnerAngle;
    if (options.coneOuterAngle !== undefined)
      this.coneOuterAngle = options.coneOuterAngle;
    if (options.coneOuterGain !== undefined)
      this.coneOuterGain = options.coneOuterGain;
  }

  get panningModel(): PanningModelType {
    return this.#panningModel;
  }
  set panningModel(v: PanningModelType) {
    const i = enumIndex(PANNING_MODELS, v);
    if (i < 0 || PANNING_MODELS[i] === this.#panningModel) return;
    this.#panningModel = PANNING_MODELS[i];
    this._prop(Prop.PanningModel, i);
  }
  get distanceModel(): DistanceModelType {
    return this.#distanceModel;
  }
  set distanceModel(v: DistanceModelType) {
    const i = enumIndex(DISTANCE_MODELS, v);
    if (i < 0 || DISTANCE_MODELS[i] === this.#distanceModel) return;
    this.#distanceModel = DISTANCE_MODELS[i];
    this._prop(Prop.DistanceModel, i);
  }
  get refDistance(): number {
    return this.#refDistance;
  }
  set refDistance(v: number) {
    const x = finite(v, 'refDistance');
    if (x < 0) throw new RangeError('refDistance must be >= 0');
    this.#refDistance = x;
    this._prop(Prop.RefDistance, x);
  }
  get maxDistance(): number {
    return this.#maxDistance;
  }
  set maxDistance(v: number) {
    const x = finite(v, 'maxDistance');
    if (x <= 0) throw new RangeError('maxDistance must be > 0');
    this.#maxDistance = x;
    this._prop(Prop.MaxDistance, x);
  }
  get rolloffFactor(): number {
    return this.#rolloffFactor;
  }
  set rolloffFactor(v: number) {
    const x = finite(v, 'rolloffFactor');
    if (x < 0) throw new RangeError('rolloffFactor must be >= 0');
    this.#rolloffFactor = x;
    this._prop(Prop.RolloffFactor, x);
  }
  get coneInnerAngle(): number {
    return this.#coneInnerAngle;
  }
  set coneInnerAngle(v: number) {
    this.#coneInnerAngle = finite(v, 'coneInnerAngle');
    this._prop(Prop.ConeInnerAngle, this.#coneInnerAngle);
  }
  get coneOuterAngle(): number {
    return this.#coneOuterAngle;
  }
  set coneOuterAngle(v: number) {
    this.#coneOuterAngle = finite(v, 'coneOuterAngle');
    this._prop(Prop.ConeOuterAngle, this.#coneOuterAngle);
  }
  get coneOuterGain(): number {
    return this.#coneOuterGain;
  }
  set coneOuterGain(v: number) {
    const x = finite(v, 'coneOuterGain');
    if (x < 0 || x > 1)
      throw domError('InvalidStateError', 'coneOuterGain must be in [0, 1]');
    this.#coneOuterGain = x;
    this._prop(Prop.ConeOuterGain, x);
  }
  setPosition(x: number, y: number, z: number): void {
    this.positionX.value = x;
    this.positionY.value = y;
    this.positionZ.value = z;
  }
  setOrientation(x: number, y: number, z: number): void {
    this.orientationX.value = x;
    this.orientationY.value = y;
    this.orientationZ.value = z;
  }
}

/** AudioListener: the context's 9 listener params (slots 0..8). */
export class AudioListener {
  readonly positionX: AudioParam;
  readonly positionY: AudioParam;
  readonly positionZ: AudioParam;
  readonly forwardX: AudioParam;
  readonly forwardY: AudioParam;
  readonly forwardZ: AudioParam;
  readonly upX: AudioParam;
  readonly upY: AudioParam;
  readonly upZ: AudioParam;
  constructor(token: symbol, core: Core) {
    if (token !== INTERNAL) throw new TypeError('Illegal constructor');
    const p = (slot: number, def: number) => {
      const param = new AudioParam(
        INTERNAL,
        core,
        slot,
        { ...POS, defaultValue: def },
        undefined,
        this,
      );
      return param;
    };
    this.positionX = p(0, 0);
    this.positionY = p(1, 0);
    this.positionZ = p(2, 0);
    this.forwardX = p(3, 0);
    this.forwardY = p(4, 0);
    this.forwardZ = p(5, -1);
    this.upX = p(6, 0);
    this.upY = p(7, 1);
    this.upZ = p(8, 0);
  }
  setPosition(x: number, y: number, z: number): void {
    this.positionX.value = x;
    this.positionY.value = y;
    this.positionZ.value = z;
  }
  setOrientation(
    x: number,
    y: number,
    z: number,
    xUp: number,
    yUp: number,
    zUp: number,
  ): void {
    this.forwardX.value = x;
    this.forwardY.value = y;
    this.forwardZ.value = z;
    this.upX.value = xUp;
    this.upY.value = yUp;
    this.upZ.value = zUp;
  }
}

// ---- analysis / convolution -----------------------------------------------------------------------

export interface AnalyserOptions extends AudioNodeOptions {
  fftSize?: number;
  maxDecibels?: number;
  minDecibels?: number;
  smoothingTimeConstant?: number;
}

export class AnalyserNode extends AudioNode {
  #fftSize = 2048;
  #minDb = -100;
  #maxDb = -30;
  #smoothing = 0.8;
  constructor(context: object, options: AnalyserOptions = {}) {
    super(
      INTERNAL,
      context,
      {
        type: NodeType.Analyser,
        inputs: 1,
        outputs: 1,
        channelCount: 2,
        mode: 'max',
        interp: 'speakers',
      },
      options,
    );
    if (options.fftSize !== undefined) this.fftSize = options.fftSize;
    const min = options.minDecibels ?? -100;
    const max = options.maxDecibels ?? -30;
    if (!(min < max))
      throw domError(
        'IndexSizeError',
        'minDecibels must be less than maxDecibels',
      );
    this.#minDb = finite(min, 'minDecibels');
    this.#maxDb = finite(max, 'maxDecibels');
    if (options.smoothingTimeConstant !== undefined)
      this.smoothingTimeConstant = options.smoothingTimeConstant;
  }
  get fftSize(): number {
    return this.#fftSize;
  }
  set fftSize(v: number) {
    const n = unsignedLong(v, 'fftSize');
    if (n < 32 || n > 32768 || (n & (n - 1)) !== 0) {
      throw domError(
        'IndexSizeError',
        `fftSize ${v} must be a power of two in [32, 32768]`,
      );
    }
    this.#fftSize = n;
  }
  get frequencyBinCount(): number {
    return this.#fftSize / 2;
  }
  get minDecibels(): number {
    return this.#minDb;
  }
  set minDecibels(v: number) {
    const x = finite(v, 'minDecibels');
    if (x >= this.#maxDb)
      throw domError(
        'IndexSizeError',
        'minDecibels must be less than maxDecibels',
      );
    this.#minDb = x;
  }
  get maxDecibels(): number {
    return this.#maxDb;
  }
  set maxDecibels(v: number) {
    const x = finite(v, 'maxDecibels');
    if (x <= this.#minDb)
      throw domError(
        'IndexSizeError',
        'maxDecibels must be greater than minDecibels',
      );
    this.#maxDb = x;
  }
  get smoothingTimeConstant(): number {
    return this.#smoothing;
  }
  set smoothingTimeConstant(v: number) {
    const x = finite(v, 'smoothingTimeConstant');
    if (x < 0 || x > 1)
      throw domError(
        'IndexSizeError',
        'smoothingTimeConstant must be in [0, 1]',
      );
    this.#smoothing = x;
  }
  getFloatFrequencyData(array: Float32Array): void {
    if (!(array instanceof Float32Array))
      throw new TypeError('expected a Float32Array');
    this.#freq(array);
  }
  getByteFrequencyData(array: Uint8Array): void {
    if (!(array instanceof Uint8Array))
      throw new TypeError('expected a Uint8Array');
    this.#freq(array);
  }
  getFloatTimeDomainData(array: Float32Array): void {
    if (!(array instanceof Float32Array))
      throw new TypeError('expected a Float32Array');
    this._core.env.natives.analyserTime(
      this._core.id,
      this._id,
      array,
      this.#fftSize,
    );
  }
  getByteTimeDomainData(array: Uint8Array): void {
    if (!(array instanceof Uint8Array))
      throw new TypeError('expected a Uint8Array');
    this._core.env.natives.analyserTime(
      this._core.id,
      this._id,
      array,
      this.#fftSize,
    );
  }
  #freq(array: Float32Array | Uint8Array): void {
    const c = this._core;
    c.env.natives.analyserFreq(
      c.id,
      this._id,
      array,
      this.#fftSize,
      this.#smoothing,
      this.#minDb,
      this.#maxDb,
      c.frame,
    );
  }
}

export interface ConvolverOptions extends AudioNodeOptions {
  buffer?: AudioBuffer | null;
  disableNormalization?: boolean;
}

export class ConvolverNode extends AudioNode {
  #buffer: AudioBuffer | null = null;
  #normalize = true;
  constructor(context: object, options: ConvolverOptions = {}) {
    super(
      INTERNAL,
      context,
      {
        type: NodeType.Convolver,
        inputs: 1,
        outputs: 1,
        channelCount: 2,
        mode: 'clamped-max',
        interp: 'speakers',
        constraints: PANNER_CONSTRAINTS,
      },
      options,
    );
    if (options.disableNormalization) this.normalize = false;
    if (options.buffer) this.buffer = options.buffer;
  }
  get normalize(): boolean {
    return this.#normalize;
  }
  set normalize(v: boolean) {
    this.#normalize = Boolean(v);
    this._prop(Prop.Normalize, this.#normalize ? 1 : 0);
  }
  get buffer(): AudioBuffer | null {
    return this.#buffer;
  }
  set buffer(b: AudioBuffer | null) {
    if (b !== null && !(b instanceof AudioBuffer))
      throw new TypeError('buffer must be an AudioBuffer or null');
    if (b) {
      const ch = b.numberOfChannels;
      if (ch !== 1 && ch !== 2 && ch !== 4)
        throw domError(
          'NotSupportedError',
          'ConvolverNode buffer must have 1, 2 or 4 channels',
        );
      if (b.sampleRate !== this._core.sampleRate) {
        throw domError(
          'NotSupportedError',
          'ConvolverNode buffer sampleRate must match the context',
        );
      }
    }
    this.#buffer = b;
    this._prop(Prop.Normalize, this.#normalize ? 1 : 0);
    this._cmd(Op.SetBuffer, this._id, b ? AudioBuffer.idOf(b) : 0);
  }
}

// ---- sources ------------------------------------------------------------------------------------

/** AudioScheduledSourceNode: start/stop/ended (AUD-6). */
export class AudioScheduledSourceNode extends AudioNode {
  #started = false;
  #onended: HandlerSlot | null = null;
  get onended(): ((ev: Event) => unknown) | null {
    return this.#onended ? this.#onended.get() : null;
  }
  set onended(v: ((ev: Event) => unknown) | null) {
    if (!this.#onended) this.#onended = new HandlerSlot(this, 'ended');
    this.#onended.set(v);
  }
  /** @internal */
  protected _start(when: number, offset: number, duration: number): void {
    if (this.#started)
      throw domError('InvalidStateError', 'start() may only be called once');
    const w = finite(when, 'when');
    if (w < 0) throw new RangeError('when must be >= 0');
    this.#started = true;
    this._core.playing.set(this._id, this);
    this._core.env.hub.kick();
    this._cmd(Op.Start, this._id, w, offset, duration);
  }
  start(when = 0): void {
    this._start(when, 0, -1);
  }
  stop(when = 0): void {
    if (!this.#started)
      throw domError('InvalidStateError', 'stop() called before start()');
    const w = finite(when, 'when');
    if (w < 0) throw new RangeError('when must be >= 0');
    this._cmd(Op.Stop, this._id, w);
  }
  /** @internal */
  dispatchEnded(): void {
    this.dispatchEvent(new Event('ended'));
  }
}

export interface AudioBufferSourceOptions extends AudioNodeOptions {
  buffer?: AudioBuffer | null;
  detune?: number;
  loop?: boolean;
  loopEnd?: number;
  loopStart?: number;
  playbackRate?: number;
}

const ABSN_RATE: ParamSpec = {
  defaultValue: 1,
  minValue: -FLT_MAX,
  maxValue: FLT_MAX,
  automationRate: 'k-rate',
  fixedRate: true,
};
const ABSN_DETUNE: ParamSpec = { ...ABSN_RATE, defaultValue: 0 };

const ABSN_INIT: NodeInit = {
  type: NodeType.BufferSource,
  inputs: 0,
  outputs: 1,
  channelCount: 2,
  mode: 'max',
  interp: 'speakers',
};

export class AudioBufferSourceNode extends AudioScheduledSourceNode {
  // Created on first access: most one-shot voices never touch them (AUD-11).
  #playbackRate: AudioParam | null = null;
  #detune: AudioParam | null = null;
  #buffer: AudioBuffer | null = null;
  #bufferSet = false;
  #loop = false;
  #loopStart = 0;
  #loopEnd = 0;
  constructor(context: object, options?: AudioBufferSourceOptions) {
    super(INTERNAL, context, ABSN_INIT, options);
    if (!options) return; // createBufferSource(): no options object to read (AUD-11 hot path)
    if (options.playbackRate !== undefined)
      this.#playbackRate = this._param(0, ABSN_RATE, options.playbackRate);
    if (options.detune !== undefined)
      this.#detune = this._param(1, ABSN_DETUNE, options.detune);
    if (options.buffer) this.buffer = options.buffer;
    if (options.loop !== undefined) this.loop = options.loop;
    if (options.loopStart !== undefined) this.loopStart = options.loopStart;
    if (options.loopEnd !== undefined) this.loopEnd = options.loopEnd;
  }
  get playbackRate(): AudioParam {
    return (this.#playbackRate ??= this._param(0, ABSN_RATE));
  }
  get detune(): AudioParam {
    return (this.#detune ??= this._param(1, ABSN_DETUNE));
  }
  get buffer(): AudioBuffer | null {
    return this.#buffer;
  }
  set buffer(b: AudioBuffer | null) {
    if (b !== null && !(b instanceof AudioBuffer))
      throw new TypeError('buffer must be an AudioBuffer or null');
    if (b && this.#bufferSet)
      throw domError(
        'InvalidStateError',
        'AudioBufferSourceNode.buffer can only be set once',
      );
    if (b) this.#bufferSet = true;
    this.#buffer = b;
    this._cmd(Op.SetBuffer, this._id, b ? AudioBuffer.idOf(b) : 0);
  }
  get loop(): boolean {
    return this.#loop;
  }
  set loop(v: boolean) {
    this.#loop = Boolean(v);
    this._prop(Prop.Loop, this.#loop ? 1 : 0);
  }
  get loopStart(): number {
    return this.#loopStart;
  }
  set loopStart(v: number) {
    this.#loopStart = finite(v, 'loopStart');
    this._prop(Prop.LoopStart, this.#loopStart);
  }
  get loopEnd(): number {
    return this.#loopEnd;
  }
  set loopEnd(v: number) {
    this.#loopEnd = finite(v, 'loopEnd');
    this._prop(Prop.LoopEnd, this.#loopEnd);
  }
  override start(when = 0, offset?: number, duration?: number): void {
    let off = 0;
    let dur = -1;
    if (offset !== undefined) {
      off = finite(offset, 'offset');
      if (off < 0) throw new RangeError('offset must be >= 0');
    }
    if (duration !== undefined) {
      dur = finite(duration, 'duration');
      if (dur < 0) throw new RangeError('duration must be >= 0');
    }
    this._start(when, off, dur);
  }
}

export interface ConstantSourceOptions {
  offset?: number;
}

export class ConstantSourceNode extends AudioScheduledSourceNode {
  readonly offset: AudioParam;
  constructor(context: object, options: ConstantSourceOptions = {}) {
    super(
      INTERNAL,
      context,
      {
        type: NodeType.ConstantSource,
        inputs: 0,
        outputs: 1,
        channelCount: 2,
        mode: 'max',
        interp: 'speakers',
      },
      undefined,
    );
    this.offset = this._param(
      0,
      {
        defaultValue: 1,
        minValue: -FLT_MAX,
        maxValue: FLT_MAX,
        automationRate: 'a-rate',
      },
      options.offset,
    );
  }
}

export interface PeriodicWaveOptions {
  real?: ArrayLike<number> | Iterable<number>;
  imag?: ArrayLike<number> | Iterable<number>;
  disableNormalization?: boolean;
}

export class PeriodicWave {
  readonly _real: Float32Array;
  readonly _imag: Float32Array;
  readonly _normalize: boolean;
  constructor(context: object, options: PeriodicWaveOptions = {}) {
    coreOf(context);
    let real =
      options.real !== undefined
        ? Float32Array.from(options.real as ArrayLike<number>)
        : null;
    let imag =
      options.imag !== undefined
        ? Float32Array.from(options.imag as ArrayLike<number>)
        : null;
    if (real && imag && real.length !== imag.length)
      throw domError(
        'IndexSizeError',
        'real and imag must have the same length',
      );
    if (!real && !imag) {
      real = new Float32Array(2);
      imag = new Float32Array([0, 1]);
    }
    if (!real) real = new Float32Array(imag!.length);
    if (!imag) imag = new Float32Array(real.length);
    if (real.length < 2)
      throw domError(
        'IndexSizeError',
        'real and imag need at least 2 elements',
      );
    if (real.length > MAX_PERIODIC_WAVE_COEFFICIENTS) {
      throw domError(
        'NotSupportedError',
        `PeriodicWave: more than ${MAX_PERIODIC_WAVE_COEFFICIENTS} coefficients are not supported by this runtime`,
      );
    }
    this._real = real;
    this._imag = imag;
    this._normalize = !options.disableNormalization;
  }
}

export type OscillatorType = (typeof OSC_TYPES)[number];

export interface OscillatorOptions extends AudioNodeOptions {
  type?: OscillatorType;
  frequency?: number;
  detune?: number;
  periodicWave?: PeriodicWave;
}

export class OscillatorNode extends AudioScheduledSourceNode {
  readonly frequency: AudioParam;
  readonly detune: AudioParam;
  #type: OscillatorType = 'sine';
  constructor(context: object, options: OscillatorOptions = {}) {
    super(
      INTERNAL,
      context,
      {
        type: NodeType.Oscillator,
        inputs: 0,
        outputs: 1,
        channelCount: 2,
        mode: 'max',
        interp: 'speakers',
      },
      options,
    );
    const nyq = this._core.sampleRate / 2;
    this.frequency = this._param(
      0,
      {
        defaultValue: 440,
        minValue: -nyq,
        maxValue: nyq,
        automationRate: 'a-rate',
      },
      options.frequency,
    );
    this.detune = this._param(
      1,
      {
        defaultValue: 0,
        minValue: -MAX_DETUNE,
        maxValue: MAX_DETUNE,
        automationRate: 'a-rate',
      },
      options.detune,
    );
    if (options.type === 'custom' && !options.periodicWave) {
      throw domError(
        'InvalidStateError',
        "type 'custom' requires a periodicWave",
      );
    }
    if (options.periodicWave) this.setPeriodicWave(options.periodicWave);
    else if (options.type !== undefined) {
      if (enumIndex(OSC_TYPES, options.type) < 0)
        throw new TypeError(`invalid OscillatorType '${options.type}'`);
      this.type = options.type;
    }
  }
  get type(): OscillatorType {
    return this.#type;
  }
  set type(v: OscillatorType) {
    const i = enumIndex(OSC_TYPES, v);
    if (i < 0) return;
    if (OSC_TYPES[i] === 'custom')
      throw domError(
        'InvalidStateError',
        "set type 'custom' through setPeriodicWave()",
      );
    this.#type = OSC_TYPES[i];
    this._prop(Prop.OscType, i);
  }
  setPeriodicWave(wave: PeriodicWave): void {
    if (!(wave instanceof PeriodicWave))
      throw new TypeError('expected a PeriodicWave');
    this.#type = 'custom';
    this._core.cmdWithValues(
      [Op.PeriodicWave, this._id, wave._normalize ? 0 : 1, wave._real.length],
      wave._real,
      wave._imag,
    );
  }
}

// ---- not implemented (spec SHOULD; AUD-6) --------------------------------------------------------

export function unsupportedNode(
  name: string,
): new (...args: unknown[]) => never {
  const cls = class {
    constructor() {
      throw domError(
        'NotSupportedError',
        `${name} is not supported by this runtime`,
      );
    }
  };
  Object.defineProperty(cls, 'name', { value: name });
  return cls as unknown as new (...args: unknown[]) => never;
}
