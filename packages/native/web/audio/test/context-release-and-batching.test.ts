/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Regressions: native contexts released (close, collection), more
// state requests than the render side has slots for, a rejected batch not poisoning later ones,
// the polling timer keeping Node alive for promise waits. The module-relaunch case is in
// relaunch.test.ts (it shuts the module down, so it runs in its own process).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { createWebAudio, type WebAudioApi } from '../src/index.ts';
import type { AudioNatives } from '../src/natives.ts';
import { EventType } from '../src/protocol.ts';
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
if (have) {
  natives = (
    createRequire(import.meta.url)(addonPath) as { audio: AudioNatives }
  ).audio;
  api = createWebAudio(natives, {
    experimental: true,
    log: () => {},
    urlOf: () => undefined,
  });
}

const settleAll = async (
  ps: Array<Promise<unknown>>,
  ms: number,
): Promise<{ settled: number; rejected: number }> => {
  let settled = 0;
  let rejected = 0;
  for (const p of ps)
    p.then(
      () => settled++,
      () => (settled++, rejected++),
    );
  const t0 = Date.now();
  while (settled < ps.length && Date.now() - t0 < ms) await sleep(10);
  return { settled, rejected };
};

describe('JS layer (fake natives)', () => {
  test('a batch the native side rejects is not resubmitted with later batches', async () => {
    const n = new FakeNatives();
    const a = createWebAudio(n, { experimental: true });
    const ctx = new a.OfflineAudioContext(1, 4800, 48000);
    const realSubmit = n.submit.bind(n);
    let fail = true;
    const errors: unknown[] = [];
    n.submit = (c, w, count) => {
      if (fail) {
        fail = false;
        throw new TypeError('iwn.audio.submit: malformed control batch');
      }
      return realSubmit(c, w, count);
    };
    const g1 = new a.GainNode(ctx);
    try {
      a.env.hub.core(1)!.flush();
    } catch (e) {
      errors.push(e);
    }
    assert.equal(errors.length, 1);
    const g2 = new a.GainNode(ctx);
    await microtask();
    const batch = n.ctx(1).batches.at(-1)!;
    // Only g2's commands: g1's rejected batch is gone, not resubmitted as a prefix.
    assert.equal(n.ctx(1).batches.length, 1);
    assert.ok(batch.length < 30, `batch has ${batch.length} words`);
    void g1;
    void g2;
  });

  test('curves and periodic waves beyond the native limits throw instead of poisoning the batch', () => {
    const n = new FakeNatives();
    const a = createWebAudio(n, { experimental: true });
    const ctx = new a.OfflineAudioContext(1, 4800, 48000);
    const g = new a.GainNode(ctx);
    assert.throws(
      () => g.gain.setValueCurveAtTime(new Float32Array(10_000_001), 0, 1),
      (e: Error) => e.name === 'NotSupportedError',
    );
    assert.throws(
      () =>
        ctx.createPeriodicWave(
          new Float32Array(1_000_001),
          new Float32Array(1_000_001),
        ),
      (e: Error) => e.name === 'NotSupportedError',
    );
    g.gain.setValueCurveAtTime(new Float32Array(1000), 0, 1); // fine
  });

  test('a cumulative state ack settles every earlier request; requests before a close resolve', async () => {
    const n = new FakeNatives();
    const a = createWebAudio(n, { experimental: true });
    const ctx = new a.AudioContext();
    await microtask();
    const ps = [ctx.suspend(), ctx.resume(), ctx.suspend(), ctx.resume()];
    const closing = ctx.close();
    await microtask();
    // The render side folded everything into one ack for the last request (the close).
    n.emit(EventType.State, 1, 2, 5, null);
    await sleep(20);
    const r = await settleAll([...ps, closing], 500);
    assert.deepEqual(r, { settled: 5, rejected: 0 });
    assert.equal(ctx.state, 'closed');
    assert.equal(
      n.ctx(1).released,
      true,
      'native context released once closed',
    );
  });
});

describe(
  'real engine (host addon)',
  { skip: !have && `addon not built: ${addonPath}` },
  () => {
    test('closed AudioContexts are released at once; dropped OfflineAudioContexts at collection', async () => {
      const base = natives.stats();
      const rss0 = process.memoryUsage().rss;
      // In helpers, so no context stays reachable from this async frame.
      const renderOnce = async (): Promise<void> => {
        const off = new api.OfflineAudioContext(2, 4800, 48000);
        const osc = off.createOscillator();
        osc.connect(off.destination);
        osc.start();
        await off.startRendering();
      };
      const openAndClose = async (): Promise<void> => {
        const ctx = new api.AudioContext();
        await sleep(5);
        await ctx.close();
      };
      for (let i = 0; i < 40; i++) await renderOnce();
      for (let i = 0; i < 10; i++) await openAndClose();
      assert.equal(
        natives.stats().realtimeContexts,
        base.realtimeContexts,
        'closed contexts released without GC',
      );
      // A never-started offline context, dropped.
      void new api.OfflineAudioContext(1, 128, 48000);
      for (
        let i = 0;
        i < 6 && natives.stats().offlineContexts > base.offlineContexts;
        i++
      ) {
        gc();
        await sleep(20);
      }
      const s = natives.stats();
      const rss1 = process.memoryUsage().rss;
      console.log(
        `    offline ${s.offlineContexts - base.offlineContexts}, realtime ${s.realtimeContexts - base.realtimeContexts}, rss ${(rss0 / 1048576).toFixed(0)} -> ${(rss1 / 1048576).toFixed(0)} MB`,
      );
      assert.equal(s.offlineContexts, base.offlineContexts);
    });

    test('a finished OfflineAudioContext that is still referenced keeps its analyser readable', async () => {
      const off = new api.OfflineAudioContext(1, 4096, 48000);
      const osc = off.createOscillator();
      const an = off.createAnalyser();
      osc.connect(an).connect(off.destination);
      osc.start();
      await off.startRendering();
      gc();
      await sleep(10);
      const d = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(d);
      assert.ok(d.some((v) => Math.abs(v) > 0.5));
    });

    test('more than 16 resume()/suspend() calls in one task all settle', async () => {
      const ctx = new api.AudioContext();
      await sleep(20);
      const r17 = await settleAll(
        Array.from({ length: 17 }, () => ctx.resume()),
        1500,
      );
      assert.deepEqual(r17, { settled: 17, rejected: 0 });
      const r40 = await settleAll(
        Array.from({ length: 40 }, () => ctx.resume()),
        1500,
      );
      assert.deepEqual(r40, { settled: 40, rejected: 0 });
      const alt = await settleAll(
        Array.from({ length: 20 }, (_, i) =>
          i % 2 ? ctx.resume() : ctx.suspend(),
        ),
        1500,
      );
      assert.deepEqual(alt, { settled: 20, rejected: 0 });
      assert.equal(ctx.state, 'running');
      // Requests queued before a close resolve; the close settles too.
      const before = Array.from({ length: 30 }, () => ctx.suspend());
      const closing = ctx.close();
      const r = await settleAll([...before, closing], 1500);
      assert.deepEqual(r, { settled: 31, rejected: 0 });
      assert.equal(ctx.state, 'closed');
    });

    test('polling mode: a promise wait started behind an unref-ed timer keeps Node alive', () => {
      // A source is started (an ended-event wait: the poll timer is unref-ed), then startRendering()
      // is awaited in the same task. Node must not exit before the render settles.
      const dir = mkdtempSync(path.join(tmpdir(), 'iwn-audio-poll-'));
      const script = path.join(dir, 'poll.ts');
      const index = fileURLToPath(new URL('../src/index.ts', import.meta.url));
      writeFileSync(
        script,
        `import { createRequire } from 'node:module';
import { createWebAudio } from ${JSON.stringify(index)};
const natives = createRequire(import.meta.url)(${JSON.stringify(addonPath)}).audio;
const api = createWebAudio(natives, { experimental: true, log: () => {} });
const ctx = new api.OfflineAudioContext(1, 48000 * 4, 48000);
const s = ctx.createConstantSource();
s.connect(ctx.destination);
s.start();
s.onended = () => {};
await new Promise((r) => setTimeout(r, 0));
const b = await ctx.startRendering();
console.log('rendered ' + b.length);
`,
      );
      const out = execFileSync(process.execPath, [script], {
        encoding: 'utf8',
        timeout: 30000,
      });
      assert.match(out, /rendered 192000/);
    });
  },
);
