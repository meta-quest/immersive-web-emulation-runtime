// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
//
// Control-message protocol between the JS Web Audio layer (web/audio/src/protocol.ts mirrors this
// file; test/protocol_sync.test.mjs checks the two agree) and the native graph.
//
// JS encodes the graph changes it makes during one task as a flat list of doubles and submits it
// once (one JS->native call per task). The native side turns each submission into one batch that
// the render thread applies whole at a render-quantum boundary (Web Audio "control messages").
#pragma once

#include <cstdint>

namespace iwn::audio::proto {

constexpr int kVersion = 1;

// Opcodes. Each command is [op, args...]; the argument count is fixed per op except where noted.
enum Op : int {
  kCreateNode = 1,      // id, type, paramSlotBase, channelCount, mode, interp, opt0, opt1, opt2, opt3
  kConnect = 2,         // srcId, output, dstId, input
  kConnectParam = 3,    // srcId, output, paramSlot
  kDisconnect = 4,      // srcId, output(-1 any), dstId(-1 any), input(-1 any)
  kDisconnectParam = 5, // srcId, output(-1 any), paramSlot
  kReleaseNode = 6,     // id                (the JS object was garbage collected)
  kParamEvent = 7,      // slot, kind, time, value, timeConstantOrDuration, insertTime, n, v[n]
  kParamCancel = 8,     // slot, time, hold(0|1)
  kSetProp = 9,         // nodeId, prop, value
  kSetBuffer = 10,      // nodeId, bufferId (0 = null)
  kStart = 11,          // nodeId, when, offset, duration (-1 = none)
  kStop = 12,           // nodeId, when
  kPeriodicWave = 13,   // nodeId, disableNormalization, n, real[n], imag[n]
  kContextState = 14,   // desired (0 suspend, 1 resume, 2 close), requestId
  kParamRate = 15,      // slot, aRate(0|1)
};

constexpr int argCount(int op) {
  switch (op) {
    case kCreateNode: return 10;
    case kConnect: return 4;
    case kConnectParam: return 3;
    case kDisconnect: return 4;
    case kDisconnectParam: return 3;
    case kReleaseNode: return 1;
    case kParamEvent: return 7;  // + n
    case kParamCancel: return 3;
    case kSetProp: return 3;
    case kSetBuffer: return 2;
    case kStart: return 4;
    case kStop: return 2;
    case kPeriodicWave: return 3;  // + 2n
    case kContextState: return 2;
    case kParamRate: return 2;
    default: return -1;
  }
}

// Node types (kCreateNode type).
enum NodeType : int {
  kDestination = 0,
  kGain = 1,
  kBufferSource = 2,
  kOscillator = 3,
  kConstantSource = 4,
  kStereoPanner = 5,
  kPanner = 6,
  kBiquad = 7,
  kDelay = 8,
  kAnalyser = 9,
  kConvolver = 10,
  kSplitter = 11,
  kMerger = 12,
  kNodeTypeCount = 13,
};

// Number of AudioParams per node type, in slot order (see paramSpec in graph.cpp / nodes.ts).
constexpr int paramCount(int type) {
  switch (type) {
    case kGain: return 1;          // gain
    case kBufferSource: return 2;  // playbackRate, detune
    case kOscillator: return 2;    // frequency, detune
    case kConstantSource: return 1;// offset
    case kStereoPanner: return 1;  // pan
    case kPanner: return 6;        // positionX/Y/Z, orientationX/Y/Z
    case kBiquad: return 4;        // frequency, detune, Q, gain
    case kDelay: return 1;         // delayTime
    default: return 0;
  }
}

// Listener params use the first 9 slots of every context.
constexpr int kListenerSlots = 9;  // positionX/Y/Z, forwardX/Y/Z, upX/Y/Z

// Properties (kSetProp).
enum Prop : int {
  kPropChannelCount = 1,
  kPropChannelCountMode = 2,
  kPropChannelInterpretation = 3,
  kPropLoop = 10,
  kPropLoopStart = 11,
  kPropLoopEnd = 12,
  kPropOscType = 20,          // 0 sine, 1 square, 2 sawtooth, 3 triangle, 4 custom
  kPropPanningModel = 30,     // 0 equalpower, 1 HRTF
  kPropDistanceModel = 31,    // 0 linear, 1 inverse, 2 exponential
  kPropRefDistance = 32,
  kPropMaxDistance = 33,
  kPropRolloffFactor = 34,
  kPropConeInnerAngle = 35,
  kPropConeOuterAngle = 36,
  kPropConeOuterGain = 37,
  kPropBiquadType = 40,       // 0 lowpass .. 7 allpass (see BiquadType)
  kPropFftSize = 50,
  kPropSmoothing = 51,
  kPropMinDecibels = 52,
  kPropMaxDecibels = 53,
  kPropNormalize = 60,
};

enum BiquadType : int {
  kLowpass = 0, kHighpass = 1, kBandpass = 2, kLowshelf = 3,
  kHighshelf = 4, kPeaking = 5, kNotch = 6, kAllpass = 7,
};

// Events (render/decoder threads -> main thread).
enum EventType : int {
  kEvEnded = 1,         // ctx, nodeId
  kEvState = 2,         // ctx, state (0 suspended, 1 running, 2 closed), requestId
  kEvRenderDone = 3,    // ctx, bufferId
  kEvDecodeDone = 4,    // ctx, requestId, bufferId
  kEvDecodeError = 5,   // ctx, requestId, (message via the string slot)
  kEvNodeFreed = 6,     // ctx, nodeId (render side removed the node; JS may reuse the id and slots)
};

// Layout of the per-context shared state (Float64Array visible to JS, written by native).
enum SharedSlot : int {
  kSharedFrame = 0,         // frames rendered (currentTime = frame / sampleRate)
  kSharedState = 1,         // 0 suspended, 1 running, 2 closed (render-side)
  kSharedAppliedSeq = 2,    // sequence number of the last applied batch
  kSharedBaseLatency = 3,   // seconds
  kSharedOutputLatency = 4, // seconds
  kSharedTsContextTime = 5, // getOutputTimestamp().contextTime
  kSharedTsMonotonicMs = 6, // CLOCK_MONOTONIC ms at which that context time is presented
  kSharedXruns = 7,
  kSharedLoad = 8,          // render time / callback period (smoothed)
  kSharedPaused = 9,        // output paused by lifecycle (AUD-2), not JS-visible state
  kSharedCount = 16,
};

}  // namespace iwn::audio::proto
