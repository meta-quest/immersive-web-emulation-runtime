/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Regressions: AudioParam lifetime and value semantics, closed
// contexts, automation overlap rules, per-frame allocation, decode-failure logging. Fake natives
// where the JS layer alone decides; the real engine (host addon) where the native side matters.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { createWebAudio, type WebAudioApi } from '../src/index.ts';
import type { AudioNatives } from '../src/natives.ts';
import { Op } from '../src/protocol.ts';
import { FakeNatives, microtask } from './fake-natives.ts';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const addonPath =
  process.env.IWN_AUDIO_ADDON ??
  path.join(tmpdir(), 'iwn-audio-host', 'iwn_audio_node.node');
const have = existsSync(addonPath);
let api: WebAudioApi;
let natives: AudioNatives;
const logs: string[] = [];
if (have) {
  natives = (
    createRequire(import.meta.url)(addonPath) as { audio: AudioNatives }
  ).audio;
  api = createWebAudio(natives, {
    experimental: true,
    log: (m) => logs.push(m),
    urlOf: () => undefined,
  });
}

describe('JS layer (fake natives)', () => {
  test('setValueCurveAtTime: an event exactly at T is allowed, events in [T, T + D) are not', async () => {
    const n = new FakeNatives();
    const a = createWebAudio(n, { experimental: true });
    const ctx = new a.OfflineAudioContext(1, 4800, 48000);
    const g = new a.GainNode(ctx);
    g.gain.value = 0.5; // an event at currentTime (0)
    g.gain.setValueCurveAtTime([0, 1], 0, 0.1); // spec: allowed
    assert.throws(
      () => g.gain.setValueAtTime(1, 0),
      (e: Error) => e.name === 'NotSupportedError',
    );
    assert.throws(
      () => g.gain.linearRampToValueAtTime(1, 0.05),
      (e: Error) => e.name === 'NotSupportedError',
    );
    g.gain.setValueAtTime(1, 0.1); // at T + D: allowed
    const h = new a.GainNode(ctx);
    h.gain.setValueAtTime(1, 0.05);
    assert.throws(
      () => h.gain.setValueCurveAtTime([0, 1], 0, 0.1),
      (e: Error) => e.name === 'NotSupportedError',
    );
  });

  test('graph changes after close() are dropped; resume/suspend after close() reject', async () => {
    const n = new FakeNatives();
    const a = createWebAudio(n, { experimental: true });
    const ctx = new a.AudioContext();
    await microtask();
    const closing = ctx.close();
    const before = n.submits;
    for (let i = 0; i < 100; i++)
      ctx.listener.positionX.linearRampToValueAtTime(i, ctx.currentTime + 0.01);
    ctx.createGain().connect(ctx.destination);
    await microtask();
    assert.equal(n.submits, before, 'nothing submitted after close()');
    await assert.rejects(
      ctx.resume(),
      (e: Error) => e.name === 'InvalidStateError',
    );
    await assert.rejects(
      ctx.suspend(),
      (e: Error) => e.name === 'InvalidStateError',
    );
    n.render(1, 128);
    n.emit(...(n.poll() ?? []));
    await closing;
    assert.equal(ctx.state, 'closed');
  });

  test('connect(param) after the param slot was recycled is not mistaken for an old connection', async () => {
    const n = new FakeNatives();
    const a = createWebAudio(n, { experimental: true });
    const ctx = new a.OfflineAudioContext(1, 128, 48000);
    const src = new a.ConstantSourceNode(ctx);
    let g: InstanceType<typeof a.GainNode> | null = new a.GainNode(ctx);
    src.connect(g.gain);
    await microtask();
    const slot0 = n.allCommands().find((c) => c[0] === Op.ConnectParam)![3];
    // The gain is collected natively and its slot recycled (NodeFreed for its id).
    const gid = n
      .allCommands()
      .filter((c) => c[0] === Op.CreateNode)
      .at(-1)![1];
    g = null;
    a.env.hub.core(1)!.freed(gid);
    const g2 = new a.GainNode(ctx);
    await microtask();
    const created = n
      .allCommands()
      .filter((c) => c[0] === Op.CreateNode)
      .at(-1)!;
    assert.equal(created[3], slot0, 'slot reused');
    src.connect(g2.gain);
    await microtask();
    const connects = n.allCommands().filter((c) => c[0] === Op.ConnectParam);
    assert.equal(connects.length, 2, 'second connect was sent');
  });
});

describe(
  'real engine (host addon)',
  { skip: !have && `addon not built: ${addonPath}` },
  () => {
    test('an AudioParam kept without its node keeps the node (no write into a recycled slot)', async () => {
      const ctx = new api.AudioContext();
      await sleep(20);
      let kept: InstanceType<WebAudioApi['AudioParam']> | null = null;
      let weak: WeakRef<object>;
      (() => {
        const g = ctx.createGain();
        g.connect(ctx.destination);
        kept = g.gain;
        weak = new WeakRef(g);
      })();
      for (let i = 0; i < 5; i++) {
        gc();
        await sleep(20);
      }
      assert.ok(weak!.deref(), 'node alive while its param is reachable');
      const others = Array.from({ length: 50 }, () => ctx.createGain());
      kept!.value = 0.125;
      await sleep(50);
      for (const o of others) assert.equal(o.gain.value, 1);
      kept = null;
      // (No deref() between the collections: a deref keeps its target alive for the current job.)
      for (let i = 0; i < 10; i++) {
        gc();
        await sleep(20);
      }
      assert.equal(
        weak!.deref(),
        undefined,
        'both collected once the param is dropped',
      );
      await ctx.close();
    });

    test('after close(), per-frame automation queues nothing natively', async () => {
      const ctx = new api.AudioContext();
      await sleep(20);
      await ctx.close();
      for (let f = 0; f < 2000; f++) {
        const t = ctx.currentTime + 1 / 72;
        ctx.listener.positionX.linearRampToValueAtTime(f, t);
        ctx.listener.positionY.linearRampToValueAtTime(f, t);
        ctx.listener.positionZ.linearRampToValueAtTime(f, t);
        await microtask();
      }
      assert.equal(natives.pendingWork(), false);
    });

    test('value read-back on a suspended context returns the assigned value', async () => {
      const ctx = new api.AudioContext();
      await sleep(20);
      const g = ctx.createGain();
      g.connect(ctx.destination);
      await ctx.suspend();
      g.gain.value = 0.25;
      await sleep(100);
      assert.equal(g.gain.value, 0.25);
      const n = new api.GainNode(ctx, { gain: 0.5 });
      await sleep(50);
      assert.equal(n.gain.value, 0.5);
      await ctx.resume();
      await sleep(50);
      assert.equal(g.gain.value, 0.25);
      await ctx.close();
    });

    test('cancelScheduledValues keeps the value set through .value', async () => {
      const ctx = new api.OfflineAudioContext(1, 256, 48000);
      const c = new api.ConstantSourceNode(ctx);
      c.connect(ctx.destination);
      c.start();
      c.offset.value = 0.3;
      c.offset.cancelScheduledValues(0);
      const buf = await ctx.startRendering();
      assert.ok(Math.abs(buf.getChannelData(0)[100] - 0.3) < 1e-7);
    });

    test('decode failure without a URL logs the byte count', async () => {
      const ctx = new api.OfflineAudioContext(1, 128, 48000);
      const junk = new Uint8Array(333).fill(7).buffer;
      await assert.rejects(
        ctx.decodeAudioData(junk),
        (e: Error) => e.name === 'EncodingError',
      );
      assert.match(logs.at(-1)!, /<333 bytes, url unknown>/);
    });

    test('three.js-style listener ramps allocate no JS memory in the Web Audio layer', async () => {
      // 9 listener ramps per frame (three.js AudioListener). Measured against a baseline that does
      // the same per-frame microtask the layer needs for its one submit per task, with constant
      // arguments (a caller passing fresh doubles to any non-inlined function boxes them itself).
      const ctx = new api.AudioContext();
      await sleep(20);
      const l = ctx.listener;
      const ps = [
        l.positionX,
        l.positionY,
        l.positionZ,
        l.forwardX,
        l.forwardY,
        l.forwardZ,
        l.upX,
        l.upY,
        l.upZ,
      ];
      const frames = 4000;
      const noop = () => {};
      const loop = async (ramps: boolean) => {
        for (let f = 0; f < frames; f++) {
          if (ramps)
            for (let i = 0; i < 9; i++) ps[i].linearRampToValueAtTime(0.5, 1);
          else queueMicrotask(noop);
          await microtask();
        }
      };
      const measure = async (ramps: boolean): Promise<number> => {
        await loop(ramps); // warm up (JIT)
        gc();
        const h0 = process.memoryUsage().heapUsed;
        await loop(ramps);
        return (process.memoryUsage().heapUsed - h0) / frames;
      };
      const base = await measure(false);
      const withRamps = await measure(true);
      console.log(
        `    JS heap per frame: ${base.toFixed(0)} B baseline, ${withRamps.toFixed(0)} B with 9 listener ramps`,
      );
      assert.ok(
        withRamps - base < 64,
        `${withRamps - base} B per frame for 9 ramps`,
      );
      await ctx.close();
    });
  },
);
