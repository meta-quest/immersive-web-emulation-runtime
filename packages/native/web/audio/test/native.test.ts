/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The Web Audio layer against the real native engine, loaded into Node through the host addon
// (runtime/audio/host-node; `npm run build:addon`). Polling event delivery (no host hooks).
// Skipped when the addon is not built.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { createWebAudio, type WebAudioApi } from '../src/index.ts';
import type { AudioNatives } from '../src/natives.ts';

const addonPath = process.env.IWN_AUDIO_ADDON ?? path.join(tmpdir(), 'iwn-audio-host', 'iwn_audio_node.node');
const have = existsSync(addonPath);
const fixtures = fileURLToPath(new URL('../../../runtime/audio/test/fixtures/', import.meta.url));
const logs: string[] = [];
const urls = new WeakMap<ArrayBuffer, string>();
let api: WebAudioApi;
let natives: AudioNatives;
if (have) {
  const addon = createRequire(import.meta.url)(addonPath) as { audio: AudioNatives };
  natives = addon.audio;
  api = createWebAudio(natives, { experimental: true, log: (m) => logs.push(m), urlOf: (b) => urls.get(b) });
}

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TAU = 2 * Math.PI;

function fixture(name: string): ArrayBuffer {
  const b = readFileSync(path.join(fixtures, name));
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  urls.set(ab, `fixtures/${name}`);
  return ab;
}

describe('native engine through the Web Audio API', { skip: !have && `addon not built: ${addonPath}` }, () => {
  test('offline: oscillator through a gain ramp matches the formulas (AUD-3, AUD-5)', async () => {
    const ctx = new api.OfflineAudioContext(1, 4800, 48000);
    const osc = new api.OscillatorNode(ctx, { frequency: 1000 });
    const g = new api.GainNode(ctx, { gain: 0 });
    g.gain.linearRampToValueAtTime(1, 0.1);
    osc.connect(g).connect(ctx.destination);
    osc.start();
    const buf = await ctx.startRendering();
    assert.equal(buf.length, 4800);
    const d = buf.getChannelData(0);
    let maxErr = 0;
    for (let n = 0; n < 4800; n++) {
      const expected = Math.sin((TAU * 1000 * n) / 48000) * (n / 4800);
      maxErr = Math.max(maxErr, Math.abs(d[n] - expected));
    }
    assert.ok(maxErr < 1e-4, `max error ${maxErr}`);
  });

  test('offline: buffer source offset/rate, equal-power panner, distance (AUD-6)', async () => {
    const ctx = new api.OfflineAudioContext({ numberOfChannels: 2, length: 1024, sampleRate: 48000 });
    const b = ctx.createBuffer(1, 2000, 48000);
    const data = new Float32Array(2000).map((_, i) => i / 2000);
    b.copyToChannel(data, 0);
    const src = new api.AudioBufferSourceNode(ctx, { buffer: b, playbackRate: 0.5 });
    const p = new api.PannerNode(ctx, { positionX: 2, refDistance: 1 });  // right, inverse distance 2 -> 0.5
    src.connect(p).connect(ctx.destination);
    src.start(0, 100 / 48000);
    const out = await ctx.startRendering();
    const L = out.getChannelData(0);
    const R = out.getChannelData(1);
    assert.ok(Math.abs(L[10]) < 1e-6);
    assert.ok(Math.abs(R[10] - 0.5 * (100 + 5) / 2000) < 1e-5, `R[10]=${R[10]}`);
  });

  test('offline: analyser sees the rendered tone', async () => {
    const ctx = new api.OfflineAudioContext(1, 8192, 48000);
    const osc = new api.OscillatorNode(ctx, { frequency: (64 * 48000) / 2048 });
    const an = new api.AnalyserNode(ctx, { smoothingTimeConstant: 0 });
    osc.connect(an).connect(ctx.destination);
    osc.start();
    await ctx.startRendering();
    const f = new Float32Array(an.frequencyBinCount);
    an.getFloatFrequencyData(f);
    let best = 0;
    for (let k = 1; k < f.length; k++) if (f[k] > f[best]) best = k;
    assert.equal(best, 64);
    const bytes = new Uint8Array(256);
    an.getByteFrequencyData(bytes);
    assert.equal(bytes[64], 255);
    const td = new Uint8Array(2048);
    an.getByteTimeDomainData(td);
    assert.ok(Math.max(...td) >= 250 && Math.min(...td) <= 5);
  });

  test('decodeAudioData: mp3, ogg vorbis and wav decode and resample to the context rate (AUD-8)', async () => {
    const ctx = new api.OfflineAudioContext(2, 128, 48000);
    for (const [name, ch, dur] of [
      ['mp3-44100-stereo-cbr.mp3', 2, 1],
      ['mp3-22050-mono-vbr.mp3', 1, 1],
      ['vorbis-44100-stereo.ogg', 2, 1],
      ['wav-22050-mono-s16.wav', 1, 0.25],
    ] as const) {
      const data = fixture(name);
      const buf = await ctx.decodeAudioData(data);
      assert.equal(data.byteLength, 0, 'input detached');
      assert.equal(buf.sampleRate, 48000, name);
      assert.equal(buf.numberOfChannels, ch, name);
      assert.ok(Math.abs(buf.duration - dur) < 0.06, `${name}: ${buf.duration}`);
      let peak = 0;
      for (const v of buf.getChannelData(0)) peak = Math.max(peak, Math.abs(v));
      assert.ok(peak > 0.4 && peak < 0.6, `${name}: peak ${peak}`);
    }
  });

  test('decodeAudioData: garbage rejects with EncodingError, logged once per URL (AUD-9)', async () => {
    const ctx = new api.OfflineAudioContext(1, 128, 48000);
    const before = logs.length;
    for (let i = 0; i < 3; i++) {
      let cbErr: unknown = null;
      await assert.rejects(
        ctx.decodeAudioData(fixture('html-404.mp3'), null, (e) => (cbErr = e)),
        (e: Error) => e.name === 'EncodingError',
      );
      assert.equal((cbErr as Error).name, 'EncodingError');
    }
    assert.equal(logs.length - before, 1);
    assert.match(logs.at(-1)!, /fixtures\/html-404\.mp3/);
  });

  test('realtime: running without a gesture, currentTime follows rendered audio, suspend/resume/close (AUD-1)', async () => {
    const ctx = new api.AudioContext();
    const states: string[] = [];
    ctx.onstatechange = () => states.push(ctx.state);
    await sleep(50);
    assert.equal(ctx.state, 'running');
    assert.ok(ctx.baseLatency > 0 && ctx.outputLatency > 0);
    const t0 = ctx.currentTime;
    const w0 = performance.now();
    await sleep(300);
    const advanced = ctx.currentTime - t0;
    const wall = (performance.now() - w0) / 1000;
    assert.ok(Math.abs(advanced - wall) < 0.06, `advanced ${advanced} vs wall ${wall}`);
    const ts = ctx.getOutputTimestamp();
    assert.ok(ts.contextTime <= ctx.currentTime + 1e-9);
    assert.ok(Math.abs(ts.performanceTime - performance.now()) < 200);
    await ctx.suspend();
    assert.equal(ctx.state, 'suspended');
    const t1 = ctx.currentTime;
    await sleep(100);
    assert.ok(ctx.currentTime - t1 < 0.01);
    await ctx.resume();
    await sleep(100);
    assert.ok(ctx.currentTime - t1 > 0.05);
    await ctx.close();
    assert.equal(ctx.state, 'closed');
    assert.deepEqual(states, ['running', 'suspended', 'running', 'closed']);
  });

  test('realtime: ended fires; finished nodes are freed after GC', async () => {
    const ctx = new api.AudioContext();
    await sleep(20);
    const buf = ctx.createBuffer(1, 480, 48000);
    const base = natives.stats().liveNodes;
    const done: Promise<void>[] = [];
    for (let i = 0; i < 200; i++) {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      const g = ctx.createGain();
      s.connect(g).connect(ctx.destination);
      done.push(new Promise((r) => (s.onended = () => r())));
      s.start(ctx.currentTime + 0.01);
    }
    await Promise.race([Promise.all(done), sleep(3000).then(() => assert.fail('ended events missing'))]);
    assert.ok(natives.stats().liveNodes >= base + 400);
    done.length = 0;
    for (let i = 0; i < 10 && natives.stats().liveNodes > base + 10; i++) {
      gc();
      await sleep(50);
    }
    assert.ok(natives.stats().liveNodes <= base + 10, `live nodes ${natives.stats().liveNodes}, base ${base}`);
    await ctx.close();
  });

  test('main-thread cost of control calls (AUD-11, host numbers)', async () => {
    const ctx = new api.AudioContext();
    await sleep(20);
    const g = ctx.createGain();
    g.connect(ctx.destination);
    const N = 20000;
    let t0 = performance.now();
    for (let i = 0; i < N; i++) g.gain.value = (i % 100) / 100;
    const perWrite = ((performance.now() - t0) * 1000) / N;
    await sleep(0);
    const buf = ctx.createBuffer(1, 4800, 48000);
    const p = ctx.createPanner();
    p.connect(ctx.destination);
    await sleep(0);
    t0 = performance.now();
    for (let i = 0; i < 100; i++) {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.connect(p);
      s.start();
    }
    await Promise.resolve();
    const voices = performance.now() - t0;
    console.log(`    param write ${perWrite.toFixed(3)} us; 100 voices ${voices.toFixed(3)} ms (incl. submit)`);
    assert.ok(perWrite < 5, `param write ${perWrite} us`);
    assert.ok(voices < 5, `100 voices ${voices} ms`);
    await ctx.close();
  });
});
