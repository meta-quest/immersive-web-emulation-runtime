/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// three.js r181 (the renderer IWSDK builds on) on the binding over a real ES 3.2 driver: capability detection,
// its full shader library, render targets, BatchedMesh (WEBGL_multi_draw + gl_DrawID), instancing, textures,
// and the steady-state call profile (GL-PERF-2: no redundant state reaches the driver; GL-21 counts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { realInstall, SKIP_REAL } from './real-gl.ts';
import { readStats, resetStats } from '../host.ts';
import type { Ctx } from '../core.ts';

const inst = SKIP_REAL ? null : realInstall();
const opt = { skip: SKIP_REAL };

function makeCanvas(w: number, h: number): Record<string, unknown> {
  return {
    width: w,
    height: h,
    style: {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
    getContext() {
      return null;
    },
  };
}

function renderer(w = 16, h = 16): { r: THREE.WebGLRenderer; gl: any; errors: string[] } {
  const canvas = makeCanvas(w, h);
  const gl = inst!.createContext(canvas as never, 'webgl2', { antialias: false }) as any;
  const errors: string[] = [];
  const r = new THREE.WebGLRenderer({ canvas: canvas as never, context: gl });
  r.debug.onShaderError = (g: unknown, p: unknown, vs: unknown, fs: unknown) => {
    errors.push(`shader error: ${(gl as any).getProgramInfoLog(p)} ${(gl as any).getShaderInfoLog(vs)} ${(gl as any).getShaderInfoLog(fs)}`);
  };
  r.setSize(w, h, false);
  return { r, gl, errors };
}

function pixel(gl: any, x: number, y: number): number[] {
  const px = new Uint8Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return [...px];
}

test('three: capabilities match a WebGL 2 browser context', opt, () => {
  const { r } = renderer();
  const caps = r.capabilities;
  assert.equal(caps.isWebGL2, true);
  assert.equal(caps.precision, 'highp');
  assert.ok(caps.maxTextures >= 16);
  assert.ok(caps.maxTextureSize >= 4096);
  assert.ok(caps.maxSamples >= 1);
  assert.ok(r.extensions.has('EXT_color_buffer_float'));
});

test('three: basic and standard materials compile and render', opt, () => {
  const { r, gl, errors } = renderer();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0, 0, 1);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  cam.position.z = 1;
  const left = new THREE.Mesh(new THREE.PlaneGeometry(1, 2), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
  left.position.x = -0.5;
  const right = new THREE.Mesh(new THREE.PlaneGeometry(1, 2), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0 }));
  right.position.x = 0.5;
  scene.add(left, right, new THREE.AmbientLight(0xffffff, 1), new THREE.DirectionalLight(0xffffff, 2));
  r.render(scene, cam);
  assert.deepEqual(errors, []);
  assert.equal(gl.getError(), gl.NO_ERROR);
  const lp = pixel(gl, 2, 8);
  assert.ok(lp[0] > 200 && lp[1] < 30 && lp[2] < 30, `left ${lp}`);
  const rp = pixel(gl, 13, 8);
  assert.ok(rp[0] > 40 && rp[1] > 40 && rp[2] > 40, `right is lit ${rp}`);
});

test('three: render target sampled by a second pass, data texture, instancing', opt, () => {
  const { r, gl, errors } = renderer();
  const rt = new THREE.WebGLRenderTarget(8, 8, { type: THREE.HalfFloatType });
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  cam.position.z = 1;
  const s1 = new THREE.Scene();
  s1.background = new THREE.Color(0, 1, 0);
  r.setRenderTarget(rt);
  r.render(s1, cam);
  r.setRenderTarget(null);
  const tex = new THREE.DataTexture(new Uint8Array([255, 0, 255, 255]), 1, 1);
  tex.needsUpdate = true;
  const s2 = new THREE.Scene();
  const a = new THREE.Mesh(new THREE.PlaneGeometry(1, 2), new THREE.MeshBasicMaterial({ map: rt.texture }));
  a.position.x = -0.5;
  const inst2 = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.5, 1), new THREE.MeshBasicMaterial({ map: tex }), 2);
  inst2.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0.25, 0.5, 0));
  inst2.setMatrixAt(1, new THREE.Matrix4().makeTranslation(0.75, -0.5, 0));
  s2.add(a, inst2);
  r.render(s2, cam);
  assert.deepEqual(errors, []);
  assert.equal(gl.getError(), gl.NO_ERROR);
  const g = pixel(gl, 3, 8);
  assert.ok(g[1] > 200 && g[0] < 30, `render target colour ${g}`);
  const m = pixel(gl, 10, 12);
  assert.ok(m[0] > 200 && m[2] > 200 && m[1] < 30, `instanced data texture ${m}`);
});

test('three: BatchedMesh uses WEBGL_multi_draw with gl_DrawID (GL-25)', opt, () => {
  const { r, gl, errors } = renderer(16, 4);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  cam.position.z = 1;
  const geo = new THREE.PlaneGeometry(0.5, 2);
  const batch = new THREE.BatchedMesh(4, 64, 64, new THREE.MeshBasicMaterial());
  const gid = batch.addGeometry(geo);
  const colors = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00];
  for (let i = 0; i < 4; i++) {
    const id = batch.addInstance(gid);
    batch.setMatrixAt(id, new THREE.Matrix4().makeTranslation(-0.75 + 0.5 * i, 0, 0));
    batch.setColorAt(id, new THREE.Color(colors[i]));
  }
  const scene = new THREE.Scene();
  scene.add(batch);
  resetStats(gl as Ctx);
  r.render(scene, cam);
  assert.deepEqual(errors, []);
  assert.equal(gl.getError(), gl.NO_ERROR);
  const s = readStats(gl as Ctx);
  assert.ok(s.multiDrawSubDraws >= 4, `multi-draw sub-draws: ${s.multiDrawSubDraws}`);
  const expect = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
  for (let i = 0; i < 4; i++) {
    const p = pixel(gl, 2 + 4 * i, 2);
    assert.deepEqual(p.slice(0, 3), expect[i], `instance ${i}`);
  }
});

test('three: steady-state frames send no redundant state to the driver (GL-PERF-2) and no reflection queries (GL-21)', opt, () => {
  const { r, gl, errors } = renderer(32, 32);
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  cam.position.set(0, 0, 5);
  const geos = [new THREE.BoxGeometry(), new THREE.SphereGeometry(0.5, 16, 8), new THREE.TorusGeometry(0.4, 0.1, 8, 16)];
  const mats = [
    new THREE.MeshStandardMaterial({ color: 0x8888ff }),
    new THREE.MeshBasicMaterial({ color: 0xff8800 }),
    new THREE.MeshPhongMaterial({ color: 0x00ff88, transparent: true, opacity: 0.5 }),
  ];
  for (let i = 0; i < 30; i++) {
    const m = new THREE.Mesh(geos[i % 3], mats[i % 3]);
    m.position.set((i % 6) - 2.5, Math.floor(i / 6) - 2, 0);
    scene.add(m);
  }
  scene.add(new THREE.DirectionalLight(0xffffff, 1), new THREE.AmbientLight(0x404040));
  r.render(scene, cam); // first frame: compiles, links, uploads
  const first = readStats(gl as Ctx);
  r.render(scene, cam);
  resetStats(gl as Ctx);
  r.render(scene, cam); // steady state
  const s = readStats(gl as Ctx);
  assert.deepEqual(errors, []);
  assert.equal(s.programInfoCalls, 0);
  assert.equal(s.shaderInfoCalls, 0);
  assert.equal(s.syncQueries, 0, 'no synchronous driver queries in a steady-state frame');
  assert.equal(s.getErrorCalls, 0);
  // three issues ~4 calls per draw in WebGL; the cache drops the redundant ones before they reach native code
  const draws = 30;
  assert.ok(s.nativeCalls / draws < 6, `native calls per draw: ${(s.nativeCalls / draws).toFixed(2)}`);
  console.log(`# three steady frame: ${s.nativeCalls} native calls for ${draws} draws; first frame programInfo=${first.programInfoCalls} shaderInfo=${first.shaderInfoCalls}`);
});
