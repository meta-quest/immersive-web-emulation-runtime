/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// On-device suite for the WebGL binding: the same test files the host runs (test/*.test.ts, bundled with
// node:test / assert / real-gl shims, see device/build.mjs), then gl-bench. Output goes to logcat through
// console ("GLDEV ..." lines), and to globalThis.__glDevice for the debug endpoint.
import { cases } from './shims/node-test.ts';
import '../test/idl.test.ts';
import '../test/state-cache.test.ts';
import '../test/real.test.ts';
import '../test/three.test.ts';
import '../test/image-handle.test.ts';
import '../test/regressions.test.ts';
import { realInstall } from './shims/real-gl.ts';
import { runGlBench, formatBench, type BenchResult } from '../bench/gl-bench.ts';
import * as THREE from 'three';
import { runThreeFrame, formatFrame } from '../bench/three-frame.ts';
import { installWebGL } from '../install.ts';
import { createFakeNatives } from '../test/fake-natives.ts';

interface Outcome {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  ms: number;
  detail: string;
}

const now = (): number => (globalThis as { performance?: { now(): number } }).performance?.now() ?? Date.now();

/** GL-22: compile + link a fixed set of three.js programs; a warm launch (driver blob cache) should be much faster. */
function compileTiming(): number {
  const inst = realInstall();
  if (!inst) return -1;
  const canvas = { width: 8, height: 8, style: {}, addEventListener() {}, removeEventListener() {} };
  const gl = inst.createContext(canvas, 'webgl2', { antialias: false }) as unknown as { finish(): void };
  const r = new THREE.WebGLRenderer({ canvas: canvas as never, context: gl as never });
  const scene = new THREE.Scene();
  scene.add(new THREE.DirectionalLight(0xffffff, 1), new THREE.PointLight(0xffffff, 1), new THREE.AmbientLight(0x202020));
  const geo = new THREE.BoxGeometry();
  const mats: THREE.Material[] = [
    new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial({ map: new THREE.DataTexture(new Uint8Array(4), 1, 1) }),
    new THREE.MeshPhysicalMaterial({ clearcoat: 1 }), new THREE.MeshPhongMaterial(), new THREE.MeshLambertMaterial(),
    new THREE.MeshToonMaterial(), new THREE.MeshBasicMaterial(), new THREE.MeshNormalMaterial(),
    new THREE.MeshMatcapMaterial(), new THREE.MeshDepthMaterial(), new THREE.PointsMaterial(), new THREE.LineBasicMaterial(),
  ];
  mats.forEach((m, i) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.x = i;
    scene.add(mesh);
  });
  const cam = new THREE.PerspectiveCamera();
  const t0 = now();
  r.compile(scene, cam);
  r.render(scene, cam); // forces every link status
  gl.finish();
  return now() - t0;
}

declare const __BENCH_ONLY__: boolean;

async function main(): Promise<void> {
  const out: Outcome[] = [];
  if (__BENCH_ONLY__) {
    const inst = realInstall();
    if (inst) {
      console.log(formatFrame(runThreeFrame(inst, 'device')));
      console.log(formatFrame(runThreeFrame(installWebGL({}, createFakeNatives().natives), 'device-null-natives')));
      console.log(formatFrame(runThreeFrame(inst, 'device-again')));
      for (const line of formatBench(runGlBench(inst), 'device-benchonly').split('\n')) console.log(line);
    }
    console.log('GLDEV DONE');
    return;
  }
  const inst0 = realInstall();
  if (inst0) {
    const probe = inst0.createContext({ width: 1, height: 1 }, 'webgl2') as unknown as Record<string, (...a: unknown[]) => unknown> & { _info: { renderer: string; version: string; vendor: string; extensions: string[] } };
    console.log(`GLDEV driver: ${probe._info.vendor} | ${probe._info.renderer} | ${probe._info.version}`);
    console.log(`GLDEV driver extensions: ${probe._info.extensions.join(' ')}`);
    console.log(`GLDEV webgl2 extensions: ${(probe.getSupportedExtensions() as string[]).join(' ')}`);
  }
  const compileMs = compileTiming();
  console.log(`GLDEV compile12 ${compileMs.toFixed(1)} ms (three.js: 12 materials, GL-22 cold/warm)`);
  console.log(`GLDEV start: ${cases.length} cases`);
  for (const c of cases) {
    if (c.skip) {
      out.push({ name: c.name, status: 'skip', ms: 0, detail: c.skip });
      console.log(`GLDEV SKIP ${c.name}: ${c.skip}`);
      continue;
    }
    const t0 = now();
    try {
      await c.fn();
      out.push({ name: c.name, status: 'pass', ms: now() - t0, detail: '' });
      console.log(`GLDEV PASS ${c.name} (${(now() - t0).toFixed(1)} ms)`);
    } catch (e) {
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      out.push({ name: c.name, status: 'fail', ms: now() - t0, detail });
      console.log(`GLDEV FAIL ${c.name}: ${detail}`);
    }
  }
  const pass = out.filter((o) => o.status === 'pass').length;
  const fail = out.filter((o) => o.status === 'fail').length;
  console.log(`GLDEV SUMMARY pass=${pass} fail=${fail} skip=${out.length - pass - fail}`);
  let bench: BenchResult[] = [];
  const inst = realInstall();
  if (inst) {
    try {
      console.log(formatFrame(runThreeFrame(inst, 'device')));
      bench = runGlBench(inst);
      for (const line of formatBench(bench, 'device').split('\n')) console.log(line);
    } catch (e) {
      console.log(`GLDEV bench failed: ${String(e)}`);
    }
  }
  (globalThis as Record<string, unknown>).__glDevice = { done: true, results: out, bench };
  console.log('GLDEV DONE');
}

main().catch((e) => console.log(`GLDEV crashed: ${String(e)}`));
