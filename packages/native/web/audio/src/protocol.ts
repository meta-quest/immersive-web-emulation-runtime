/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Mirror of runtime/audio/src/protocol.h (test/protocol.test.ts keeps the two in sync).

export const PROTOCOL_VERSION = 1;

export const Op = {
  CreateNode: 1,
  Connect: 2,
  ConnectParam: 3,
  Disconnect: 4,
  DisconnectParam: 5,
  ReleaseNode: 6,
  ParamEvent: 7,
  ParamCancel: 8,
  SetProp: 9,
  SetBuffer: 10,
  Start: 11,
  Stop: 12,
  PeriodicWave: 13,
  ContextState: 14,
  ParamRate: 15,
} as const;

/** Fixed argument words per op (protocol.h argCount; ParamEvent/PeriodicWave add trailing values). */
export const ARG_COUNT: Record<number, number> = {
  [Op.CreateNode]: 10,
  [Op.Connect]: 4,
  [Op.ConnectParam]: 3,
  [Op.Disconnect]: 4,
  [Op.DisconnectParam]: 3,
  [Op.ReleaseNode]: 1,
  [Op.ParamEvent]: 7,
  [Op.ParamCancel]: 3,
  [Op.SetProp]: 3,
  [Op.SetBuffer]: 2,
  [Op.Start]: 4,
  [Op.Stop]: 2,
  [Op.PeriodicWave]: 3,
  [Op.ContextState]: 2,
  [Op.ParamRate]: 2,
};

export const NodeType = {
  Destination: 0,
  Gain: 1,
  BufferSource: 2,
  Oscillator: 3,
  ConstantSource: 4,
  StereoPanner: 5,
  Panner: 6,
  Biquad: 7,
  Delay: 8,
  Analyser: 9,
  Convolver: 10,
  Splitter: 11,
  Merger: 12,
} as const;

/** AudioParams per node type, in slot order. */
export const PARAM_COUNT: Record<number, number> = {
  [NodeType.Gain]: 1,
  [NodeType.BufferSource]: 2,
  [NodeType.Oscillator]: 2,
  [NodeType.ConstantSource]: 1,
  [NodeType.StereoPanner]: 1,
  [NodeType.Panner]: 6,
  [NodeType.Biquad]: 4,
  [NodeType.Delay]: 1,
};

export const LISTENER_SLOTS = 9;
export const DESTINATION_ID = 1;
export const FIRST_NODE_ID = 2;
export const NODE_CAPACITY = 32768;
/** Two slots per node at NODE_CAPACITY: AudioBufferSourceNodes (playbackRate, detune) hit the node cap, not this one. */
export const PARAM_CAPACITY = 65536;
/** Native batch limits (graph.cpp walk()): larger commands would make the whole batch malformed. */
export const MAX_CURVE_VALUES = 10_000_000;
export const MAX_PERIODIC_WAVE_COEFFICIENTS = 1_000_000;

export const Prop = {
  ChannelCount: 1,
  ChannelCountMode: 2,
  ChannelInterpretation: 3,
  Loop: 10,
  LoopStart: 11,
  LoopEnd: 12,
  OscType: 20,
  PanningModel: 30,
  DistanceModel: 31,
  RefDistance: 32,
  MaxDistance: 33,
  RolloffFactor: 34,
  ConeInnerAngle: 35,
  ConeOuterAngle: 36,
  ConeOuterGain: 37,
  BiquadType: 40,
  FftSize: 50,
  Smoothing: 51,
  MinDecibels: 52,
  MaxDecibels: 53,
  Normalize: 60,
} as const;

export const ParamKind = {
  SetValue: 0,
  LinearRamp: 1,
  ExpRamp: 2,
  SetTarget: 3,
  SetCurve: 4,
} as const;

export const EventType = {
  Ended: 1,
  State: 2,
  RenderDone: 3,
  DecodeDone: 4,
  DecodeError: 5,
  NodeFreed: 6,
} as const;

export const Shared = {
  Frame: 0,
  State: 1,
  AppliedSeq: 2,
  BaseLatency: 3,
  OutputLatency: 4,
  TsContextTime: 5,
  TsMonotonicMs: 6,
  Xruns: 7,
  Load: 8,
  Paused: 9,
} as const;

export const BIQUAD_TYPES = [
  'lowpass',
  'highpass',
  'bandpass',
  'lowshelf',
  'highshelf',
  'peaking',
  'notch',
  'allpass',
] as const;
export const OSC_TYPES = ['sine', 'square', 'sawtooth', 'triangle', 'custom'] as const;
export const PANNING_MODELS = ['equalpower', 'HRTF'] as const;
export const DISTANCE_MODELS = ['linear', 'inverse', 'exponential'] as const;
export const CHANNEL_COUNT_MODES = ['max', 'clamped-max', 'explicit'] as const;
export const CHANNEL_INTERPRETATIONS = ['speakers', 'discrete'] as const;
