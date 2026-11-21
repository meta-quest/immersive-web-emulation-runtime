/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Push delivery: the addon installs host hooks (uv_async) so native posts events as tasks, the
// path the device host uses. No polling timers run (AUD-11: no main-thread time while idle).

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createWebAudio } from '../src/index.ts';
import type { AudioNatives } from '../src/natives.ts';

const addonPath =
  process.env.IWN_AUDIO_ADDON ??
  path.join(tmpdir(), 'iwn-audio-host', 'iwn_audio_node.node');
const have = existsSync(addonPath);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe(
  'push event delivery (host hooks)',
  { skip: !have && `addon not built: ${addonPath}` },
  () => {
    test('state, ended, decode and offline completion arrive without polling', async () => {
      const addon = createRequire(import.meta.url)(addonPath) as {
        audio: AudioNatives;
        enableHooks(): void;
        setPaused(reason: number, paused: boolean): void;
      };
      addon.enableHooks();
      const api = createWebAudio(addon.audio, { experimental: true });
      const ctx = new api.AudioContext();
      await sleep(30);
      assert.equal(api.env.hub.pushMode, true);
      assert.equal(ctx.state, 'running');

      const buf = ctx.createBuffer(1, 480, 48000);
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.connect(ctx.destination);
      const ended = new Promise<void>((r) => (s.onended = () => r()));
      s.start();
      await Promise.race([
        ended,
        sleep(2000).then(() => assert.fail('no ended event')),
      ]);

      const mp3 = readFileSync(
        fileURLToPath(
          new URL(
            '../../../runtime/audio/test/fixtures/mp3-22050-mono-vbr.mp3',
            import.meta.url,
          ),
        ),
      );
      const decoded = await ctx.decodeAudioData(
        mp3.buffer.slice(
          mp3.byteOffset,
          mp3.byteOffset + mp3.byteLength,
        ) as ArrayBuffer,
      );
      assert.equal(decoded.sampleRate, 48000);

      const off = new api.OfflineAudioContext(1, 48000, 48000);
      const osc = off.createOscillator();
      osc.connect(off.destination);
      osc.start();
      const rendered = await off.startRendering();
      assert.equal(rendered.length, 48000);

      // AUD-2: lifecycle pause stops time without a statechange; resume continues.
      let changes = 0;
      ctx.onstatechange = () => changes++;
      addon.setPaused(1, true);
      await sleep(40);
      const t0 = ctx.currentTime;
      await sleep(150);
      assert.ok(ctx.currentTime - t0 < 0.01, 'paused: currentTime holds');
      addon.setPaused(1, false);
      await sleep(150);
      assert.ok(ctx.currentTime - t0 > 0.05, 'resumed');
      assert.equal(changes, 0);
      assert.equal(ctx.state, 'running');
      await ctx.close();
      addon.audio.setEventHandler(null);
    });
  },
);
