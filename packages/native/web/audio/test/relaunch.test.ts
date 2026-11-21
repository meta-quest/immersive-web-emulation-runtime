/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// PROC-7 then a relaunch into the same process (Android keeps the process cached and a new
// activity builds a new Runtime): the runtime's shutdown hook shuts the audio module down, then the
// module is registered again and must work. Own file: it shuts the module down for this process.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createWebAudio } from '../src/index.ts';
import type { AudioNatives } from '../src/natives.ts';

const addonPath = process.env.IWN_AUDIO_ADDON ?? path.join(tmpdir(), 'iwn-audio-host', 'iwn_audio_node.node');
const have = existsSync(addonPath);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, sleep(ms).then(() => assert.fail(`${what}: not settled within ${ms} ms`))]);

const mp3 = readFileSync(fileURLToPath(new URL('../../../runtime/audio/test/fixtures/mp3-22050-mono-vbr.mp3', import.meta.url)));
const mp3Bytes = (): ArrayBuffer => mp3.buffer.slice(mp3.byteOffset, mp3.byteOffset + mp3.byteLength) as ArrayBuffer;

async function exercise(natives: AudioNatives, label: string): Promise<void> {
  const api = createWebAudio(natives, { experimental: true, log: () => {} });
  const ctx = new api.AudioContext();
  await sleep(30);
  assert.equal(api.env.hub.pushMode, true, `${label}: push mode`);
  assert.equal(ctx.state, 'running', `${label}: running`);
  const s = ctx.createBufferSource();
  s.buffer = ctx.createBuffer(1, 480, 48000);
  s.connect(ctx.destination);
  const ended = new Promise<void>((r) => (s.onended = () => r()));
  s.start();
  await within(ended, 2000, `${label}: ended`);
  const decoded = await within(ctx.decodeAudioData(mp3Bytes()), 3000, `${label}: decode`);
  assert.equal(decoded.sampleRate, 48000);
  const off = new api.OfflineAudioContext(1, 4800, 48000);
  off.createOscillator().connect(off.destination);
  const rendered = await within(off.startRendering(), 3000, `${label}: offline render`);
  assert.equal(rendered.length, 4800);
  await within(ctx.close(), 2000, `${label}: close`);
}

describe('module relaunch in one process', { skip: !have && `addon not built: ${addonPath}` }, () => {
  test('after the shutdown hook, a new registration works (contexts, events, decodes)', async () => {
    const addon = createRequire(import.meta.url)(addonPath) as {
      audio: AudioNatives;
      enableHooks(): void;
      shutdownForTest(): void;
      register(): AudioNatives;
    };
    addon.enableHooks();
    await exercise(addon.audio, 'launch 1');
    // A context left open at exit, plus a pending decode: shutdown must free/drop both.
    const api1 = createWebAudio(addon.audio, { experimental: true, log: () => {} });
    const open = new api1.AudioContext();
    void open.decodeAudioData(mp3Bytes()).catch(() => {});
    // Let the old page's pending JS (the constructor's state poll) run first: in a real relaunch the
    // old page's JS is gone, here it would take the new context's first event.
    await sleep(0);
    addon.shutdownForTest();
    assert.equal(addon.audio.stats().realtimeContexts, 0, 'shutdown frees contexts');
    assert.throws(() => new api1.AudioContext(), /shut down/);

    // The new runtime: registers the module again (and installs its host hooks).
    const natives2 = addon.register();
    addon.enableHooks();
    await exercise(natives2, 'launch 2');
    const st = natives2.stats();
    assert.equal(st.pendingDecodes, 0);
    natives2.setEventHandler(null);
  });
});
