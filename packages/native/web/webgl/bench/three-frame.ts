/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Frame-level binding cost (PERF-GL-1 shape): a three.js scene of ~150 draws (the showcase's per-frame draw
// count) with mixed materials, textures, a moving camera and moving objects; reports CPU ms per
// renderer.render() and native calls per frame. The binding share is render() time minus three's own JS,
// which the "null natives" variant isolates (same JS, natives that do nothing).

import * as THREE from 'three';
import type { WebGLInstall } from '../install.ts';
import { readStats, resetStats } from '../host.ts';
import type { Ctx } from '../core.ts';

export interface FrameResult {
  label: string;
  msPerFrame: number;
  nativeCallsPerFrame: number;
  draws: number;
}

const now = (): number =>
  (globalThis as { performance?: { now(): number } }).performance?.now() ??
  Date.now();

export function runThreeFrame(
  inst: WebGLInstall,
  label: string,
  frames = 300,
): FrameResult {
  const canvas = {
    width: 256,
    height: 256,
    style: {},
    addEventListener() {},
    removeEventListener() {},
  };
  const gl = inst.createContext(canvas as never, 'webgl2', {
    antialias: false,
  }) as unknown as Ctx;
  const r = new THREE.WebGLRenderer({
    canvas: canvas as never,
    context: gl as never,
  });
  r.setSize(256, 256, false);
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(70, 1, 0.1, 100);
  const tex = new THREE.DataTexture(
    new Uint8Array(64 * 64 * 4).fill(200),
    64,
    64,
  );
  tex.needsUpdate = true;
  const geos = [
    new THREE.BoxGeometry(0.3, 0.3, 0.3),
    new THREE.SphereGeometry(0.2, 12, 8),
    new THREE.CylinderGeometry(0.1, 0.1, 0.4, 10),
  ];
  const mats = [
    new THREE.MeshStandardMaterial({ color: 0x8899ff, roughness: 0.6 }),
    new THREE.MeshStandardMaterial({ map: tex }),
    new THREE.MeshBasicMaterial({ color: 0xff8800 }),
    new THREE.MeshPhongMaterial({ color: 0x00ff88 }),
    new THREE.MeshLambertMaterial({
      color: 0xffffff,
      map: tex,
      transparent: true,
      opacity: 0.8,
    }),
  ];
  const meshes: THREE.Mesh[] = [];
  for (let i = 0; i < 150; i++) {
    const m = new THREE.Mesh(geos[i % geos.length], mats[i % mats.length]);
    m.position.set(
      ((i % 15) - 7) * 0.5,
      (Math.floor(i / 15) - 5) * 0.5,
      -6 - (i % 3),
    );
    scene.add(m);
    meshes.push(m);
  }
  scene.add(
    new THREE.DirectionalLight(0xffffff, 1.5),
    new THREE.AmbientLight(0x404040),
  );
  const step = (f: number): void => {
    cam.position.x = Math.sin(f * 0.01) * 0.5;
    cam.lookAt(0, 0, -6);
    for (let i = 0; i < meshes.length; i += 3) meshes[i].rotation.y = f * 0.02;
    r.render(scene, cam);
  };
  for (let f = 0; f < 60; f++) step(f); // warm-up: compiles, uploads, JIT
  resetStats(gl);
  const t0 = now();
  for (let f = 0; f < frames; f++) step(60 + f);
  const ms = (now() - t0) / frames;
  const s = readStats(gl);
  return {
    label,
    msPerFrame: ms,
    nativeCallsPerFrame: s.nativeCalls / frames,
    draws: r.info.render.calls,
  };
}

export function formatFrame(x: FrameResult): string {
  return `GLFRAME ${x.label} ${x.msPerFrame.toFixed(3)} ms/frame, ${x.nativeCallsPerFrame.toFixed(1)} native calls/frame, ${x.draws} draws`;
}
