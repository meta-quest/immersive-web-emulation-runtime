/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Web Audio layer against fake natives: API shape, validation and exceptions (spec IDL), batching
// per task (AUD-10/11), AudioParam value semantics (AUD-5), connections (AUD-4), state machine
// (AUD-1), ended events and node lifetime (AUD-6), decode errors (AUD-8/9).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createWebAudio, installWebAudio } from '../src/index.ts';
import { EventType, NodeType, Op, ParamKind, Prop } from '../src/protocol.ts';
import { commands, FakeNatives, microtask, tick } from './fake-natives.ts';

function setup() {
  const natives = new FakeNatives();
  const logs: string[] = [];
  const api = createWebAudio(natives, { experimental: true, log: (m) => logs.push(m) });
  return { natives, api, logs };
}

const rejectsWith = async (p: Promise<unknown>, name: string) => {
  await assert.rejects(p, (e: Error) => e.name === name);
};

describe('install', () => {
  test('defines globals and webkit alias; absent media/worklet nodes', () => {
    const target: Record<string, unknown> = {};
    installWebAudio(target, new FakeNatives(), { experimental: true });
    for (const n of ['AudioContext', 'OfflineAudioContext', 'AudioBuffer', 'GainNode', 'PannerNode', 'AudioParam',
      'AudioBufferSourceNode', 'BiquadFilterNode', 'AnalyserNode', 'ConvolverNode', 'StereoPannerNode', 'PeriodicWave']) {
      assert.equal(typeof target[n], 'function', n);
    }
    assert.equal(target.webkitAudioContext, target.AudioContext);
    assert.equal((target.AudioContext as { name: string }).name, 'AudioContext');
    for (const n of ['MediaElementAudioSourceNode', 'MediaStreamAudioSourceNode', 'AudioWorkletNode']) {
      assert.equal(target[n], undefined, n);
    }
  });

  test('alpha surface (default): beyond-basic nodes throw NotSupportedError naming the API, OfflineAudioContext is absent', () => {
    const target: Record<string, unknown> = {};
    installWebAudio(target, new FakeNatives());
    for (const n of ['AudioContext', 'AudioBuffer', 'GainNode', 'PannerNode', 'AudioListener', 'AudioBufferSourceNode', 'AudioParam']) {
      assert.equal(typeof target[n], 'function', n);
    }
    assert.equal(target.OfflineAudioContext, undefined);
    assert.equal(target.webkitOfflineAudioContext, undefined);
    assert.equal(target.OfflineAudioCompletionEvent, undefined);
    const Ctx = target.AudioContext as new () => Record<string, (...a: unknown[]) => unknown>;
    const ctx = new Ctx();
    // the basic set works
    ctx.createGain!();
    ctx.createPanner!();
    ctx.createBufferSource!();
    const nodes: [string, string][] = [
      ['OscillatorNode', 'createOscillator'], ['ConstantSourceNode', 'createConstantSource'], ['StereoPannerNode', 'createStereoPanner'],
      ['BiquadFilterNode', 'createBiquadFilter'], ['DelayNode', 'createDelay'], ['AnalyserNode', 'createAnalyser'],
      ['ConvolverNode', 'createConvolver'], ['ChannelSplitterNode', 'createChannelSplitter'], ['ChannelMergerNode', 'createChannelMerger'],
      ['PeriodicWave', 'createPeriodicWave'],
    ];
    for (const [name, factory] of nodes) {
      const cls = target[name] as new (...a: unknown[]) => unknown;
      assert.throws(() => new cls(ctx), (e: Error) => e.name === 'NotSupportedError' && e.message.includes(name), name);
      assert.throws(() => ctx[factory]!([0, 1], [0, 0]), (e: Error) => e.name === 'NotSupportedError' && e.message.includes(name), factory);
    }
    for (const n of ['DynamicsCompressorNode', 'WaveShaperNode', 'IIRFilterNode']) {
      assert.throws(() => new (target[n] as new () => unknown)(), (e: Error) => e.name === 'NotSupportedError', n);
    }
    // a second, experimental install is unaffected by the first one's gate
    const t2: Record<string, unknown> = {};
    installWebAudio(t2, new FakeNatives(), { experimental: true });
    const ctx2 = new (t2.AudioContext as new () => Record<string, () => unknown>)();
    assert.ok(ctx2.createOscillator!());
    assert.equal(typeof t2.OfflineAudioContext, 'function');
  });

  test('AudioBuffer larger than 1 GiB of samples throws NotSupportedError before allocating', () => {
    const api = createWebAudio(new FakeNatives());
    assert.throws(() => new api.AudioBuffer({ length: 1e9, sampleRate: 48000 }), (e: Error) => e.name === 'NotSupportedError');
    assert.throws(() => new api.AudioBuffer({ length: 2 ** 23 + 1, numberOfChannels: 32, sampleRate: 48000 }), (e: Error) => e.name === 'NotSupportedError');
    assert.equal(new api.AudioBuffer({ length: 1000, sampleRate: 48000 }).length, 1000);
  });

  test('rejects a protocol mismatch', () => {
    const n = new FakeNatives();
    (n as { protocolVersion: number }).protocolVersion = 99;
    assert.throws(() => createWebAudio(n, { experimental: true }));
  });

  test('SHOULD nodes not implemented throw NotSupportedError naming the node', () => {
    const { api } = setup();
    const ctx = new api.AudioContext();
    assert.throws(() => new api.DynamicsCompressorNode(ctx), (e: Error) => e.name === 'NotSupportedError' && /DynamicsCompressorNode/.test(e.message));
    assert.throws(() => ctx.createWaveShaper(), (e: Error) => e.name === 'NotSupportedError' && /WaveShaperNode/.test(e.message));
    assert.equal((ctx as unknown as Record<string, unknown>).createMediaElementSource, undefined);
  });
});

describe('AudioContext state (AUD-1)', () => {
  test('starts suspended, becomes running with statechange, no gesture needed', async () => {
    const { natives, api } = setup();
    const ctx = new api.AudioContext();
    assert.equal(ctx.state, 'suspended');
    assert.equal(ctx.sampleRate, 48000);
    let changes = 0;
    ctx.onstatechange = () => changes++;
    await microtask();
    await microtask();
    assert.equal(ctx.state, 'running');
    assert.equal(changes, 1);
    // currentTime follows rendered frames.
    natives.render(1, 48000);
    assert.equal(ctx.currentTime, 1);
  });

  test('suspend / resume / close resolve on acknowledgement; closed rejects', async () => {
    const { natives, api } = setup();
    const ctx = new api.AudioContext();
    await tick();
    const s = ctx.suspend();
    await microtask();
    natives.render(1, 128);
    await tick();
    await tick();
    await s;
    assert.equal(ctx.state, 'suspended');
    const r = ctx.resume();
    await microtask();
    natives.render(1, 128);
    await new Promise((res) => setTimeout(res, 20));
    await r;
    assert.equal(ctx.state, 'running');
    const c = ctx.close();
    await microtask();
    natives.render(1, 0);
    await new Promise((res) => setTimeout(res, 20));
    await c;
    assert.equal(ctx.state, 'closed');
    await rejectsWith(ctx.resume(), 'InvalidStateError');
    await rejectsWith(ctx.close(), 'InvalidStateError');
  });

  test('sampleRate option is validated and passed to natives', () => {
    const { api } = setup();
    assert.throws(() => new api.AudioContext({ sampleRate: 100 }), (e: Error) => e.name === 'NotSupportedError');
    const ctx = new api.AudioContext({ sampleRate: 44100 });
    assert.equal(ctx.sampleRate, 44100);
    assert.throws(() => new api.AudioContext({ latencyHint: 'bogus' as 'playback' }), TypeError);
  });
});

describe('batching (AUD-10, AUD-11)', () => {
  test('all graph changes of one task go in one submit', async () => {
    const { natives, api } = setup();
    const ctx = new api.AudioContext();
    await tick();
    const before = natives.submits;
    const g1 = ctx.createGain();
    const g2 = ctx.createGain();
    g1.connect(ctx.destination);
    g2.connect(ctx.destination);
    g1.gain.value = 0.5;
    g2.gain.value = 0.5;
    assert.equal(natives.submits, before, 'nothing is sent synchronously');
    await microtask();
    assert.equal(natives.submits, before + 1);
    const cmds = commands(natives.ctx().batches.at(-1)!);
    assert.deepEqual(cmds.map((c) => c[0]), [Op.CreateNode, Op.CreateNode, Op.Connect, Op.Connect, Op.ParamEvent, Op.ParamEvent]);
  });

  test('a task that changes nothing submits nothing', async () => {
    const { natives, api } = setup();
    const ctx = new api.AudioContext();
    await tick();
    const before = natives.submits;
    void ctx.currentTime;
    void ctx.state;
    await tick();
    assert.equal(natives.submits, before);
  });

  test('100 one-shot voices per frame stay cheap', async () => {
    const { api } = setup();
    const ctx = new api.AudioContext();
    const buf = ctx.createBuffer(1, 4800, 48000);
    const panner = ctx.createPanner();
    panner.connect(ctx.destination);
    await tick();
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.connect(panner);
      s.start();
    }
    const dt = performance.now() - t0;
    assert.ok(dt < 20, `100 voices took ${dt.toFixed(2)} ms`);  // device budget 1 ms (AUD-11); host CI is noisy
  });
});

describe('AudioParam (AUD-5)', () => {
  test('defaults, ranges, value getter while in flight and after apply', async () => {
    const { natives, api } = setup();
    const ctx = new api.AudioContext();
    await tick();
    const osc = ctx.createOscillator();
    assert.equal(osc.frequency.defaultValue, 440);
    assert.equal(osc.frequency.maxValue, 24000);
    assert.equal(osc.frequency.minValue, -24000);
    assert.equal(osc.frequency.value, 440);
    osc.frequency.value = 1000;
    assert.equal(osc.frequency.value, 1000);
    await microtask();
    const slot = commands(natives.ctx().batches.at(-1)!)[0][3];
    natives.ctx().params[slot] = 999;  // render thread computed a value
    assert.equal(osc.frequency.value, 1000, 'still in flight');
    natives.render(1, 128);
    assert.equal(osc.frequency.value, 999, 'applied: reads the rendered value');
    osc.frequency.value = 1e9;
    assert.equal(osc.frequency.value, 24000, 'clamped to the nominal range');
  });

  test('automation calls validate arguments per spec', () => {
    const { api } = setup();
    const ctx = new api.AudioContext();
    const g = ctx.createGain().gain;
    assert.throws(() => g.setValueAtTime(1, -1), RangeError);
    assert.throws(() => g.setValueAtTime(NaN, 1), TypeError);
    assert.throws(() => g.exponentialRampToValueAtTime(0, 1), RangeError);
    assert.throws(() => g.setTargetAtTime(1, 0, -1), RangeError);
    assert.throws(() => g.setValueCurveAtTime([1], 0, 1), (e: Error) => e.name === 'InvalidStateError');
    assert.throws(() => g.setValueCurveAtTime([1, 2], 0, 0), RangeError);
    assert.throws(() => g.cancelScheduledValues(-1), RangeError);
    assert.equal(g.setValueAtTime(1, 0), g, 'methods chain');
  });

  test('setValueCurveAtTime overlap rules', () => {
    const { api } = setup();
    const ctx = new api.AudioContext();
    const g = ctx.createGain().gain;
    g.setValueCurveAtTime([0, 1, 0], 1, 1);
    assert.throws(() => g.setValueAtTime(1, 1.5), (e: Error) => e.name === 'NotSupportedError');
    assert.throws(() => g.setValueCurveAtTime([0, 1], 1.5, 1), (e: Error) => e.name === 'NotSupportedError');
    g.setValueAtTime(1, 2);  // at the curve end: allowed
    g.cancelScheduledValues(0);
    g.setValueAtTime(1, 1.5);  // curve removed
  });

  test('events carry kind, time, value, insert time; past times clamp to currentTime', async () => {
    const { natives, api } = setup();
    const ctx = new api.AudioContext();
    await tick();
    natives.render(1, 48000);
    const g = ctx.createGain().gain;
    g.setTargetAtTime(0.5, 0.25, 0.1);
    g.linearRampToValueAtTime(1, 3);
    g.setValueCurveAtTime(new Float32Array([1, 2, 3]), 4, 2);
    g.cancelAndHoldAtTime(5);
    await microtask();
    const cmds = commands(natives.ctx().batches.at(-1)!).slice(1);
    assert.deepEqual(cmds[0], [Op.ParamEvent, cmds[0][1], ParamKind.SetTarget, 1, 0.5, 0.1, 1, 0]);
    assert.deepEqual(cmds[1].slice(2, 5), [ParamKind.LinearRamp, 3, 1]);
    assert.deepEqual(cmds[2].slice(2), [ParamKind.SetCurve, 4, 0, 2, 1, 3, 1, 2, 3]);
    assert.deepEqual(cmds[3].slice(0, 1).concat(cmds[3].slice(2)), [Op.ParamCancel, 5, 1]);
  });

  test('automationRate: fixed for AudioBufferSourceNode params', () => {
    const { api } = setup();
    const ctx = new api.AudioContext();
    const s = ctx.createBufferSource();
    assert.equal(s.playbackRate.automationRate, 'k-rate');
    assert.throws(() => (s.playbackRate.automationRate = 'a-rate'), (e: Error) => e.name === 'InvalidStateError');
    const g = ctx.createGain();
    g.gain.automationRate = 'k-rate';
    assert.equal(g.gain.automationRate, 'k-rate');
  });

  test('AudioParam has no public constructor', () => {
    const { api } = setup();
    assert.throws(() => new (api.AudioParam as unknown as new () => unknown)(), TypeError);
  });
});

describe('AudioNode (AUD-4)', () => {
  test('connect returns destination, validates indices and contexts', () => {
    const { api } = setup();
    const ctx = new api.AudioContext();
    const other = new api.AudioContext();
    const g = ctx.createGain();
    const d = ctx.createDelay();
    assert.equal(g.connect(d), d);
    assert.equal(g.connect(d.delayTime), undefined);
    assert.throws(() => g.connect(d, 1), (e: Error) => e.name === 'IndexSizeError');
    assert.throws(() => g.connect(d, 0, 3), (e: Error) => e.name === 'IndexSizeError');
    assert.throws(() => g.connect(other.createGain()), (e: Error) => e.name === 'InvalidAccessError');
    assert.throws(() => g.connect({} as never), TypeError);
  });

  test('disconnect forms and errors', async () => {
    const { natives, api } = setup();
    const ctx = new api.AudioContext();
    await tick();
    const src = ctx.createConstantSource();
    const a = ctx.createGain();
    const b = ctx.createGain();
    src.connect(a);
    src.connect(b);
    src.connect(a.gain);
    assert.throws(() => src.disconnect(ctx.destination), (e: Error) => e.name === 'InvalidAccessError');
    src.disconnect(b);
    src.disconnect(a.gain);
    assert.throws(() => src.disconnect(a.gain), (e: Error) => e.name === 'InvalidAccessError');
    assert.throws(() => src.disconnect(1), (e: Error) => e.name === 'IndexSizeError');
    src.disconnect(0);
    src.disconnect();
    await microtask();
    const ops = natives.allCommands().filter((c) => c[0] === Op.Disconnect || c[0] === Op.DisconnectParam);
    assert.equal(ops.length, 4);
  });

  test('channel properties and per-node constraints', () => {
    const { api } = setup();
    const ctx = new api.AudioContext();
    const g = ctx.createGain();
    assert.equal(g.channelCount, 2);
    assert.equal(g.channelCountMode, 'max');
    g.channelCountMode = 'bogus' as 'max';
    assert.equal(g.channelCountMode, 'max', 'invalid enum assignment ignored');
    assert.throws(() => (g.channelCount = 0), (e: Error) => e.name === 'NotSupportedError');
    const p = ctx.createPanner();
    assert.throws(() => (p.channelCount = 3), (e: Error) => e.name === 'NotSupportedError');
    assert.throws(() => (p.channelCountMode = 'max'), (e: Error) => e.name === 'NotSupportedError');
    const sp = ctx.createChannelSplitter(4);
    assert.equal(sp.numberOfOutputs, 4);
    assert.throws(() => (sp.channelCount = 2), (e: Error) => e.name === 'InvalidStateError');
    assert.throws(() => (sp.channelInterpretation = 'speakers'), (e: Error) => e.name === 'InvalidStateError');
    assert.throws(() => (ctx.destination.channelCount = 3), (e: Error) => e.name === 'IndexSizeError');
    assert.equal(ctx.destination.maxChannelCount, 2);
    assert.throws(() => new api.GainNode({} as never), TypeError);
  });

  test('constructor options are applied in the create command', async () => {
    const { natives, api } = setup();
    const ctx = new api.AudioContext();
    await tick();
    const g = new api.GainNode(ctx, { gain: 0.25, channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'discrete' });
    assert.equal(g.gain.value, 0.25);
    await microtask();
    const cmds = commands(natives.ctx().batches.at(-1)!);
    assert.deepEqual(cmds[0].slice(2, 7), [NodeType.Gain, cmds[0][3], 1, 2, 1]);
    assert.deepEqual(cmds[1].slice(2, 5), [ParamKind.SetValue, 0, 0.25]);
  });
});

describe('nodes (AUD-6)', () => {
  test('scheduled source start/stop rules and ended event', async () => {
    const { natives, api } = setup();
    const ctx = new api.AudioContext();
    await tick();
    const s = ctx.createBufferSource();
    assert.throws(() => s.stop(), (e: Error) => e.name === 'InvalidStateError');
    assert.throws(() => s.start(-1), RangeError);
    let ended = 0;
    s.onended = () => ended++;
    s.addEventListener('ended', () => ended++);
    s.start(0, 0.5);
    assert.throws(() => s.start(), (e: Error) => e.name === 'InvalidStateError');
    s.stop(1);
    await microtask();
    const id = commands(natives.ctx().batches.at(-1)!)[0][1];
    natives.emit(EventType.Ended, 1, id, 0, null);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(ended, 2);
  });

  test('AudioBufferSourceNode.buffer may be set once', () => {
    const { api } = setup();
    const ctx = new api.AudioContext();
    const b = ctx.createBuffer(1, 10, 48000);
    const s = new api.AudioBufferSourceNode(ctx, { buffer: b, loop: true, loopStart: 0.1, loopEnd: 0.2 });
    assert.equal(s.buffer, b);
    assert.equal(s.loop, true);
    assert.throws(() => (s.buffer = ctx.createBuffer(1, 10, 48000)), (e: Error) => e.name === 'InvalidStateError');
    s.buffer = null;
    assert.throws(() => s.start(0, -1), RangeError);
  });

  test('panner attributes validate; setPosition sets params', () => {
    const { api } = setup();
    const ctx = new api.AudioContext();
    const p = ctx.createPanner();
    assert.equal(p.panningModel, 'equalpower');
    assert.equal(p.distanceModel, 'inverse');
    p.panningModel = 'HRTF';
    assert.equal(p.panningModel, 'HRTF');
    assert.throws(() => (p.refDistance = -1), RangeError);
    assert.throws(() => (p.maxDistance = 0), RangeError);
    assert.throws(() => (p.rolloffFactor = -1), RangeError);
    assert.throws(() => (p.coneOuterGain = 2), (e: Error) => e.name === 'InvalidStateError');
    p.setPosition(1, 2, 3);
    assert.deepEqual([p.positionX.value, p.positionY.value, p.positionZ.value], [1, 2, 3]);
    p.setOrientation(0, 0, -1);
    assert.equal(p.orientationZ.value, -1);
    ctx.listener.setPosition(4, 5, 6);
    ctx.listener.setOrientation(0, 0, -1, 0, 1, 0);
    assert.equal(ctx.listener.positionZ.value, 6);
    assert.equal(ctx.listener.upY.value, 1);
  });

  test('biquad, analyser, delay, convolver, oscillator validation', () => {
    const { api } = setup();
    const ctx = new api.AudioContext();
    const bq = ctx.createBiquadFilter();
    bq.type = 'highpass';
    bq.type = 'nope' as 'lowpass';
    assert.equal(bq.type, 'highpass');
    const f = new Float32Array([100, 200]);
    assert.throws(() => bq.getFrequencyResponse(f, new Float32Array(1), new Float32Array(2)), (e: Error) => e.name === 'InvalidAccessError');
    const mag = new Float32Array(2);
    bq.getFrequencyResponse(f, mag, new Float32Array(2));
    assert.deepEqual(Array.from(mag), [1, 1]);
    const an = ctx.createAnalyser();
    assert.equal(an.frequencyBinCount, 1024);
    assert.throws(() => (an.fftSize = 1000), (e: Error) => e.name === 'IndexSizeError');
    assert.throws(() => (an.minDecibels = -10), (e: Error) => e.name === 'IndexSizeError');
    assert.throws(() => (an.smoothingTimeConstant = 2), (e: Error) => e.name === 'IndexSizeError');
    assert.throws(() => ctx.createDelay(0), (e: Error) => e.name === 'NotSupportedError');
    assert.throws(() => ctx.createDelay(200), (e: Error) => e.name === 'NotSupportedError');
    const conv = ctx.createConvolver();
    assert.throws(() => (conv.buffer = ctx.createBuffer(3, 10, 48000)), (e: Error) => e.name === 'NotSupportedError');
    assert.throws(() => (conv.buffer = ctx.createBuffer(2, 10, 44100)), (e: Error) => e.name === 'NotSupportedError');
    conv.buffer = ctx.createBuffer(2, 10, 48000);
    const osc = ctx.createOscillator();
    assert.throws(() => (osc.type = 'custom'), (e: Error) => e.name === 'InvalidStateError');
    osc.setPeriodicWave(ctx.createPeriodicWave(new Float32Array([0, 1]), new Float32Array([0, 0])));
    assert.equal(osc.type, 'custom');
    assert.throws(() => ctx.createPeriodicWave([0, 1], [0]), (e: Error) => e.name === 'IndexSizeError');
    assert.throws(() => new api.OscillatorNode(ctx, { type: 'custom' }), (e: Error) => e.name === 'InvalidStateError');
  });

  test('property writes become SetProp commands', async () => {
    const { natives, api } = setup();
    const ctx = new api.AudioContext();
    await tick();
    const p = ctx.createPanner();
    p.distanceModel = 'linear';
    p.panningModel = 'HRTF';
    await microtask();
    const props = natives.allCommands().filter((c) => c[0] === Op.SetProp).map((c) => [c[2], c[3]]);
    assert.deepEqual(props, [[Prop.DistanceModel, 0], [Prop.PanningModel, 1]]);
  });
});

describe('AudioBuffer (AUD-7)', () => {
  test('constructor, limits, aliasing getChannelData, copy methods', () => {
    const { api } = setup();
    assert.throws(() => new api.AudioBuffer({ length: 0, sampleRate: 48000 }), (e: Error) => e.name === 'NotSupportedError');
    assert.throws(() => new api.AudioBuffer({ length: 10, sampleRate: 100 }), (e: Error) => e.name === 'NotSupportedError');
    assert.throws(() => new api.AudioBuffer({ numberOfChannels: 33, length: 10, sampleRate: 48000 }), (e: Error) => e.name === 'NotSupportedError');
    const b = new api.AudioBuffer({ numberOfChannels: 2, length: 4, sampleRate: 8000 });
    assert.equal(b.duration, 0.0005);
    assert.equal(b.getChannelData(0), b.getChannelData(0));
    assert.throws(() => b.getChannelData(2), (e: Error) => e.name === 'IndexSizeError');
    b.copyToChannel(new Float32Array([1, 2, 3, 4, 5]), 1, 1);
    assert.deepEqual(Array.from(b.getChannelData(1)), [0, 1, 2, 3]);
    const out = new Float32Array(2);
    b.copyFromChannel(out, 1, 2);
    assert.deepEqual(Array.from(out), [2, 3]);
    assert.ok(b instanceof api.AudioBuffer);
  });
});

describe('decodeAudioData (AUD-8, AUD-9)', () => {
  test('success: promise and callback, input detached', async () => {
    const { natives, api } = setup();
    const ctx = new api.AudioContext();
    await tick();
    const data = new Uint8Array([1, 2, 3]).buffer;
    let cb: unknown = null;
    const p = ctx.decodeAudioData(data, (b) => (cb = b));
    assert.equal(data.byteLength, 0, 'detached');
    const req = natives.decodes[0];
    assert.equal(req.targetRate, 48000);
    const [bid] = natives.createBuffer(1, 100, 48000);
    natives.emit(EventType.DecodeDone, 1, req.requestId, bid, 'mp3');
    const buf = await p;
    assert.equal(buf.length, 100);
    assert.equal(cb, buf);
    assert.ok(buf instanceof api.AudioBuffer);
  });

  test('failure: EncodingError, one log line per URL', async () => {
    const { natives, api, logs } = setup();
    const ctx = new api.AudioContext();
    await tick();
    const urls = new WeakMap<object, string>();
    (globalThis as { __iwnResourceUrls?: WeakMap<object, string> }).__iwnResourceUrls = urls;
    try {
      for (let i = 0; i < 3; i++) {
        const data = new Uint8Array([60, 104, 116, 109, 108]).buffer;
        urls.set(data, 'assets/sfx/broken.mp3');
        let errCb: DOMException | null = null;
        const p = ctx.decodeAudioData(data, null, (e) => (errCb = e));
        const req = natives.decodes.at(-1)!;
        natives.emit(EventType.DecodeError, 1, req.requestId, 0, 'unrecognized audio format');
        await rejectsWith(p, 'EncodingError');
        assert.equal((errCb as DOMException | null)?.name, 'EncodingError');
      }
    } finally {
      delete (globalThis as { __iwnResourceUrls?: unknown }).__iwnResourceUrls;
    }
    assert.equal(logs.length, 1);
    assert.match(logs[0], /assets\/sfx\/broken\.mp3.*unrecognized audio format/);
  });

  test('argument errors', async () => {
    const { api } = setup();
    const ctx = new api.AudioContext();
    await assert.rejects(ctx.decodeAudioData('x' as never), TypeError);
    const ab = new ArrayBuffer(4);
    (ab as ArrayBuffer & { transfer(): ArrayBuffer }).transfer();
    await rejectsWith(ctx.decodeAudioData(ab), 'DataCloneError');
  });
});

describe('OfflineAudioContext (AUD-3)', () => {
  test('constructor forms, startRendering once, complete event', async () => {
    const { natives, api } = setup();
    assert.throws(() => new api.OfflineAudioContext(0, 10, 48000), (e: Error) => e.name === 'NotSupportedError');
    const ctx = new api.OfflineAudioContext({ numberOfChannels: 2, length: 256, sampleRate: 44100 });
    assert.equal(ctx.length, 256);
    assert.equal(ctx.sampleRate, 44100);
    assert.equal(ctx.state, 'suspended');
    let completed: unknown = null;
    ctx.oncomplete = (e) => (completed = (e as unknown as { renderedBuffer: unknown }).renderedBuffer);
    const p = ctx.startRendering();
    assert.equal(ctx.state, 'running');
    await rejectsWith(ctx.startRendering(), 'InvalidStateError');
    const [bid] = natives.createBuffer(2, 256, 44100);
    natives.emit(EventType.RenderDone, ctx === null ? 0 : 1, bid, 0, null);
    await new Promise((r) => setTimeout(r, 30));
    const buf = await p;
    assert.equal(buf.length, 256);
    assert.equal(completed, buf);
    assert.equal(ctx.state, 'closed');
  });
});

describe('node lifetime', () => {
  test('ids and param slots are reused after the render side frees them', async () => {
    const { natives, api } = setup();
    const ctx = new api.AudioContext();
    await tick();
    const core = api.env.hub.core(1)!;
    const a = core.allocNode(1);
    const aSlot = core.allocatedSlot;
    core.release(a);
    natives.emit(EventType.NodeFreed, 1, a, 0, null);
    await new Promise((r) => setTimeout(r, 30));
    const b = core.allocNode(1);
    assert.equal(b, a);
    assert.equal(core.allocatedSlot, aSlot);
    void ctx;
  });
});

describe('page visibility (AUD-2)', () => {
  test('visibilitychange pauses and resumes device output without a state change', () => {
    const natives = new FakeNatives();
    const calls: Array<[number, boolean]> = [];
    natives.setOutputPaused = (reason: number, paused: boolean) => {
      calls.push([reason, paused]);
    };
    const doc = new EventTarget() as EventTarget & { visibilityState: string };
    doc.visibilityState = 'visible';
    installWebAudio({ document: doc }, natives);
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    assert.deepEqual(calls, [[4, true], [4, false]]);
  });
});

describe('page visibility, late document', () => {
  test('a document defined after install is followed from the first AudioContext', () => {
    const natives = new FakeNatives();
    const calls: Array<[number, boolean]> = [];
    natives.setOutputPaused = (reason: number, paused: boolean) => {
      calls.push([reason, paused]);
    };
    const target: Record<string, unknown> = {};
    installWebAudio(target, natives, { experimental: true });
    const doc = new EventTarget() as EventTarget & { visibilityState: string };
    doc.visibilityState = 'visible';
    target.document = doc;
    new (target.AudioContext as new () => unknown)();
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    assert.deepEqual(calls, [[4, true]]);
  });
});
