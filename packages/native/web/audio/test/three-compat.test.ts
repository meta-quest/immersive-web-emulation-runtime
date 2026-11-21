/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// three.js audio classes (what IWSDK's AudioSystem uses: AudioListener, PositionalAudio, Audio)
// running unmodified on this Web Audio implementation and the real native engine.
// Needs the host addon and three (IWSDK pins super-three@0.181.0):
//   IWN_THREE_MODULE=/path/to/node_modules/three/build/three.module.js
// Skipped when either is missing.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { installWebAudio } from '../src/index.ts';
import type { AudioNatives } from '../src/natives.ts';

const addonPath = process.env.IWN_AUDIO_ADDON ?? path.join(tmpdir(), 'iwn-audio-host', 'iwn_audio_node.node');
const threePath = process.env.IWN_THREE_MODULE ?? '/tmp/iwn-audio-three-dl/node_modules/three/build/three.module.js';
const skip = !existsSync(addonPath) ? `addon not built: ${addonPath}` : !existsSync(threePath) ? `three not found: ${threePath}` : false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Minimal typing of the three.js surface this test touches.
interface V3 { set(x: number, y: number, z: number): void }
interface Obj { position: V3; add(o: unknown): void; updateMatrixWorld(force?: boolean): void }
interface ThreeAudio extends Obj {
  context: AudioContextLike;
  isPlaying: boolean;
  panner: { positionX: { value: number }; distanceModel: string; refDistance: number; coneOuterGain: number };
  setBuffer(b: unknown): ThreeAudio;
  setLoop(v: boolean): ThreeAudio;
  setVolume(v: number): ThreeAudio;
  setPlaybackRate(v: number): ThreeAudio;
  setRefDistance(v: number): ThreeAudio;
  setRolloffFactor(v: number): ThreeAudio;
  setMaxDistance(v: number): ThreeAudio;
  setDistanceModel(v: string): ThreeAudio;
  setDirectionalCone(a: number, b: number, c: number): ThreeAudio;
  play(delay?: number): ThreeAudio;
  stop(delay?: number): ThreeAudio;
  pause(): ThreeAudio;
  onEnded(): void;
}
interface AudioContextLike {
  sampleRate: number;
  currentTime: number;
  state: string;
  listener: { positionX: { value: number } };
  createBuffer(c: number, l: number, r: number): { getChannelData(c: number): Float32Array };
}

describe('three.js audio on @iwer/native Web Audio', { skip }, () => {
  test('AudioListener + PositionalAudio + Audio play, spatialise and end', async () => {
    const natives = (createRequire(import.meta.url)(addonPath) as { audio: AudioNatives }).audio;
    const g = globalThis as Record<string, unknown>;
    installWebAudio(globalThis, natives);  // the default (alpha) surface: three.js needs only the basic set
    if (!g.window) g.window = globalThis;
    const THREE = (await import(pathToFileURL(threePath).href)) as Record<string, new (...a: unknown[]) => unknown>;

    const listener = new THREE.AudioListener() as Obj & { context: AudioContextLike };
    const camera = new THREE.PerspectiveCamera() as Obj;
    const scene = new THREE.Scene() as Obj;
    camera.add(listener);
    scene.add(camera);
    const ctx = listener.context;
    await sleep(30);
    assert.equal(ctx.state, 'running');

    const buffer = ctx.createBuffer(1, 2400, ctx.sampleRate);
    const d = buffer.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.sin((2 * Math.PI * 440 * i) / ctx.sampleRate);

    const sound = new THREE.PositionalAudio(listener) as ThreeAudio;
    sound.setRefDistance(2).setRolloffFactor(1).setMaxDistance(50).setDistanceModel('linear');
    sound.setDirectionalCone(180, 230, 0.1);
    sound.setBuffer(buffer).setLoop(false).setVolume(0.5);
    const holder = new THREE.Object3D() as Obj;
    holder.position.set(3, 0, 0);
    holder.add(sound);
    scene.add(holder);
    const ended = new Promise<void>((resolve) => {
      const orig = sound.onEnded.bind(sound);
      sound.onEnded = () => {
        orig();
        resolve();
      };
    });
    sound.play();
    scene.updateMatrixWorld(true);
    assert.equal(sound.isPlaying, true);
    assert.equal(sound.panner.distanceModel, 'linear');
    assert.equal(sound.panner.refDistance, 2);
    assert.equal(sound.panner.coneOuterGain, 0.1);
    await Promise.race([ended, sleep(2000).then(() => assert.fail('PositionalAudio never ended'))]);
    assert.equal(sound.isPlaying, false);
    // updateMatrixWorld ramps the panner position to the object's world position.
    await sleep(100);
    scene.updateMatrixWorld(true);
    await sleep(100);
    assert.ok(Math.abs(sound.panner.positionX.value - 3) < 1e-3, `positionX ${sound.panner.positionX.value}`);

    const ambient = new THREE.Audio(listener) as ThreeAudio;
    ambient.setBuffer(buffer).setLoop(true).setPlaybackRate(1.5).play();
    await sleep(80);
    assert.equal(ambient.isPlaying, true);
    ambient.pause();
    ambient.play();
    ambient.stop();
    assert.equal(ambient.isPlaying, false);
  });
});
