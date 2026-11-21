/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { AudioBuffer, ENV } from './buffer.ts';
import { makeEnv, type Env } from './core.ts';
import {
  AudioContext,
  BaseAudioContext,
  OfflineAudioCompletionEvent,
  OfflineAudioContext,
} from './context.ts';
import type { AudioNatives, WebAudioOptions } from './natives.ts';
import {
  AnalyserNode,
  AudioBufferSourceNode,
  AudioDestinationNode,
  AudioListener,
  AudioNode,
  AudioScheduledSourceNode,
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
  unsupportedNode,
} from './nodes.ts';
import { AudioParam } from './param.ts';
import { PROTOCOL_VERSION } from './protocol.ts';
import { domError } from './util.ts';

export interface WebAudioApi {
  AudioContext: typeof AudioContext;
  OfflineAudioContext: typeof OfflineAudioContext;
  AudioBuffer: typeof AudioBuffer;
  BaseAudioContext: typeof BaseAudioContext;
  AudioNode: typeof AudioNode;
  AudioParam: typeof AudioParam;
  AudioScheduledSourceNode: typeof AudioScheduledSourceNode;
  AudioDestinationNode: typeof AudioDestinationNode;
  AudioListener: typeof AudioListener;
  AudioBufferSourceNode: typeof AudioBufferSourceNode;
  GainNode: typeof GainNode;
  DelayNode: typeof DelayNode;
  OscillatorNode: typeof OscillatorNode;
  ConstantSourceNode: typeof ConstantSourceNode;
  PannerNode: typeof PannerNode;
  StereoPannerNode: typeof StereoPannerNode;
  BiquadFilterNode: typeof BiquadFilterNode;
  AnalyserNode: typeof AnalyserNode;
  ConvolverNode: typeof ConvolverNode;
  ChannelSplitterNode: typeof ChannelSplitterNode;
  ChannelMergerNode: typeof ChannelMergerNode;
  PeriodicWave: typeof PeriodicWave;
  OfflineAudioCompletionEvent: typeof OfflineAudioCompletionEvent;
  DynamicsCompressorNode: new (...args: unknown[]) => never;
  WaveShaperNode: new (...args: unknown[]) => never;
  IIRFilterNode: new (...args: unknown[]) => never;
  /** @internal: the environment (natives, event hub). */
  env: Env;
}

/**
 * Builds the Web Audio API classes over a native audio module. Each call gets its own
 * environment: AudioContext, OfflineAudioContext and AudioBuffer are bound subclasses so that
 * `new AudioContext()` and `new AudioBuffer(...)` reach these natives.
 */
export function createWebAudio(
  natives: AudioNatives,
  options: WebAudioOptions = {},
): WebAudioApi {
  if (natives.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(
      `iwn.audio protocol mismatch: native ${natives.protocolVersion}, JS ${PROTOCOL_VERSION}`,
    );
  }
  const env = makeEnv(natives, options);
  class BoundAudioBuffer extends AudioBuffer {
    static [ENV] = env;
  }
  class BoundAudioContext extends AudioContext {
    static [ENV] = env;
  }
  class BoundOfflineAudioContext extends OfflineAudioContext {
    static [ENV] = env;
  }
  for (const [cls, name] of [
    [BoundAudioBuffer, 'AudioBuffer'],
    [BoundAudioContext, 'AudioContext'],
    [BoundOfflineAudioContext, 'OfflineAudioContext'],
  ] as const) {
    Object.defineProperty(cls, 'name', { value: name });
  }
  env.AudioBuffer = BoundAudioBuffer;
  env.wrapBuffer = (native) => AudioBuffer.adopt(BoundAudioBuffer, native);
  const api: WebAudioApi = {
    AudioContext: BoundAudioContext,
    OfflineAudioContext: BoundOfflineAudioContext,
    AudioBuffer: BoundAudioBuffer,
    BaseAudioContext,
    AudioNode,
    AudioParam,
    AudioScheduledSourceNode,
    AudioDestinationNode,
    AudioListener,
    AudioBufferSourceNode,
    GainNode,
    DelayNode,
    OscillatorNode,
    ConstantSourceNode,
    PannerNode,
    StereoPannerNode,
    BiquadFilterNode,
    AnalyserNode,
    ConvolverNode,
    ChannelSplitterNode,
    ChannelMergerNode,
    PeriodicWave,
    OfflineAudioCompletionEvent,
    DynamicsCompressorNode: unsupportedNode('DynamicsCompressorNode'),
    WaveShaperNode: unsupportedNode('WaveShaperNode'),
    IIRFilterNode: unsupportedNode('IIRFilterNode'),
    env,
  };
  if (options.experimental !== true) gateExperimental(api, BoundAudioContext);
  return api;
}

/** Interfaces outside the alpha's basic Web Audio set, and the BaseAudioContext factories that make them. */
const EXPERIMENTAL_NODES = [
  ['OscillatorNode', 'createOscillator'],
  ['ConstantSourceNode', 'createConstantSource'],
  ['StereoPannerNode', 'createStereoPanner'],
  ['BiquadFilterNode', 'createBiquadFilter'],
  ['DelayNode', 'createDelay'],
  ['AnalyserNode', 'createAnalyser'],
  ['ConvolverNode', 'createConvolver'],
  ['ChannelSplitterNode', 'createChannelSplitter'],
  ['ChannelMergerNode', 'createChannelMerger'],
  ['PeriodicWave', 'createPeriodicWave'],
] as const;

/** Exported for the docs and tests: the names `experimental: false` turns into NotSupportedError stubs. */
export const EXPERIMENTAL_INTERFACES: readonly string[] = [
  ...EXPERIMENTAL_NODES.map(([n]) => n),
  'OfflineAudioContext',
  'OfflineAudioCompletionEvent',
];

/**
 * The alpha surface (the alpha scope of 2026-10-20): beyond-basic interfaces become NotSupportedError stubs
 * (the unsupportedNode pattern), their factories on AudioContext throw NotSupportedError naming the
 * interface, and OfflineAudioContext / OfflineAudioCompletionEvent are stubs too (installWebAudio leaves
 * them off the global, so `typeof OfflineAudioContext === 'undefined'`).
 */
function gateExperimental(
  api: WebAudioApi,
  contextClass: { prototype: object },
): void {
  const stubs = api as unknown as Record<string, unknown>;
  for (const [name, factory] of EXPERIMENTAL_NODES) {
    stubs[name] = unsupportedNode(name);
    const method = {
      [factory](): never {
        throw domError(
          'NotSupportedError',
          `${name} (${factory}) is not supported in this @iwer/native alpha`,
        );
      },
    }[factory]!;
    Object.defineProperty(contextClass.prototype, factory, {
      value: method,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
  stubs.OfflineAudioContext = unsupportedNode('OfflineAudioContext');
  stubs.OfflineAudioCompletionEvent = unsupportedNode(
    'OfflineAudioCompletionEvent',
  );
}

/**
 * Installs the Web Audio globals on `target` (normally `globalThis`), plus `webkitAudioContext`.
 * Absent by design (AUD-6): MediaElementAudioSourceNode, MediaStream* nodes,
 * AudioWorklet, ScriptProcessorNode.
 */
export function installWebAudio(
  target: object,
  natives: AudioNatives,
  options: WebAudioOptions = {},
): WebAudioApi {
  const api = createWebAudio(natives, options);
  const define = (name: string, value: unknown) =>
    Object.defineProperty(target, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  const experimental = options.experimental === true;
  for (const [name, value] of Object.entries(api)) {
    if (name === 'env') continue;
    // Outside the alpha, OfflineAudioContext is absent (feature-detectable) rather than a throwing stub.
    if (
      !experimental &&
      (name === 'OfflineAudioContext' || name === 'OfflineAudioCompletionEvent')
    )
      continue;
    define(name, value);
  }
  define('webkitAudioContext', api.AudioContext);
  if (experimental)
    define('webkitOfflineAudioContext', api.OfflineAudioContext);
  followPageVisibility(target, natives, api);
  return api;
}

/** Pause reason used for page visibility (iwn::audio::kPauseHost). */
const PAUSE_PAGE_HIDDEN = 4;

/**
 * AUD-2: device output pauses while the page is hidden. The runtime core folds both the activity
 * lifecycle (PROC-6) and the OpenXR session's hidden state into document.visibilityState, so one
 * listener covers both. JS-visible context state does not change; currentTime stops.
 */
function followPageVisibility(
  target: object,
  natives: AudioNatives,
  api: WebAudioApi,
): void {
  type Doc = {
    visibilityState?: string;
    addEventListener?: (t: string, f: () => void) => void;
  };
  let attached = false;
  const attach = (): boolean => {
    if (attached) return true;
    const doc = (target as { document?: Doc }).document;
    if (!doc || typeof doc.addEventListener !== 'function') return false;
    attached = true;
    const apply = () =>
      natives.setOutputPaused(
        PAUSE_PAGE_HIDDEN,
        doc.visibilityState === 'hidden',
      );
    doc.addEventListener('visibilitychange', apply);
    if (doc.visibilityState === 'hidden') apply();
    return true;
  };
  // The document stand-in may come from a prelude that runs after this one: retry when the first
  // AudioContext is created.
  if (!attach()) api.env.onFirstContext = attach;
}
