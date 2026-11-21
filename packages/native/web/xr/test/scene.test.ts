/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The room as planes, meshes and hit-test results (XR-AR-2), through the shipped prelude against fake scene natives
// that honour runtime/xr xr_scene.h: entity geometry in the entity's space (a 2D boundary in its x-y plane, normal
// +z), poses in a table of 8 floats per slot.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SceneData } from '../src/natives.ts';
import { createHarness } from './harness.ts';

type Harness = ReturnType<typeof createHarness>;

const XR = 'navigator.xr';
const S = Math.SQRT1_2;

// Entity spaces as Quest reports them: a floor's +Z points up (a turn of -90 degrees about X), a wall's +Z faces
// into the room, a table's volume sits upright.
const UP = [-S, 0, 0, S];
const IDENTITY = [0, 0, 0, 1];

function room(version = 1): SceneData {
  return {
    version,
    entities: [
      { id: 'f'.repeat(32), slot: 0, labels: 'FLOOR', polygon: new Float32Array([-2, -2, 2, -2, 2, 2, -2, 2]) },
      {
        id: 'a'.repeat(32),
        slot: 1,
        labels: 'TABLE',
        polygon: new Float32Array([-0.5, -0.3, 0.5, -0.3, 0.5, 0.3, -0.5, 0.3]),
        box: new Float32Array([-0.5, -0.3, -0.75, 1, 0.6, 0.75]),
      },
      {
        id: 'b'.repeat(32),
        slot: 2,
        labels: 'GLOBAL_MESH',
        vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        indices: new Uint32Array([0, 1, 2]),
      },
      { id: 'c'.repeat(32), slot: 3, labels: 'WALL_FACE,OTHER', polygon: new Float32Array([-2, 0, 2, 0, 2, 2.5, -2, 2.5]) },
    ],
  };
}

function pose(h: Harness, slot: number, position: number[], orientation: number[], located = true): void {
  h.scenePoses.set([...position, ...orientation, located ? 1 : 0], slot * 8);
}

async function start(h: Harness, init: string): Promise<void> {
  h.g.__gl = h.gl;
  h.run(`globalThis.__session = null; ${XR}.requestSession('immersive-ar', ${init}).then((s) => { globalThis.__session = s; }, (e) => { globalThis.__error = e; });`);
  await h.settle();
  assert.ok(h.run('globalThis.__session'), `session: ${h.run('String(globalThis.__error)')}`);
  h.run(`
    globalThis.__binding = new XRWebGLBinding(__session, __gl);
    __session.updateRenderState({ layers: [__binding.createProjectionLayer({ textureType: 'texture-array' })] });
    __session.requestReferenceSpace('local-floor').then((s) => { globalThis.__floor = s; });
    __session.requestReferenceSpace('viewer').then((s) => { globalThis.__viewer = s; });
  `);
  await h.settle();
}

/** One frame; `read` runs in the page's XR callback and its result is returned. */
function frameWith<T>(h: Harness, read: string): T {
  h.run(`globalThis.__seen = undefined; __session.requestAnimationFrame((t, frame) => { globalThis.__seen = (${read})(frame); });`);
  h.frame();
  return h.run<T>('globalThis.__seen');
}

const AR_INFO = { passthrough: true, immersiveAr: true, planeDetection: true, meshDetection: true, hitTest: true };
/** USE_SCENE granted (XR-PERM-1 asks for it before the session gets the scene features). */
const GRANTED = { 'com.oculus.permission.USE_SCENE': true };

test('XR-AR-2: plane-detection, mesh-detection and hit-test are granted only when the runtime reads the room', async () => {
  const h = createHarness({ info: AR_INFO, scene: true, permissions: GRANTED });
  await start(h, "{ requiredFeatures: ['plane-detection', 'mesh-detection', 'hit-test'], optionalFeatures: ['layers', 'local-floor'] }");
  const enabled = [...h.run<string[]>('__session.enabledFeatures')];
  for (const f of ['plane-detection', 'mesh-detection', 'hit-test']) assert.ok(enabled.includes(f), f);
  // the query starts with the session, before the first frame
  assert.ok(h.calls.some((c) => c[0] === 'sceneData'));

  // the capability without the natives (an older runtime), or the natives without the capability: not granted
  for (const opts of [{ info: AR_INFO, permissions: GRANTED }, { info: { passthrough: true, immersiveAr: true }, scene: true, permissions: GRANTED }]) {
    const other = createHarness(opts);
    other.run(`${XR}.requestSession('immersive-ar', { requiredFeatures: ['hit-test'] }).catch((e) => { globalThis.__e = e.name; })`);
    await other.settle();
    assert.equal(other.run('__e'), 'NotSupportedError');
  }
});

test('XR-AR-2: entities become planes (2D boundary) and meshes (box, room mesh) with WebXR labels, posed every frame', async () => {
  const h = createHarness({ info: AR_INFO, scene: true, permissions: GRANTED });
  h.sceneData = room();
  pose(h, 0, [0, 0, 0], UP);
  pose(h, 1, [0.4, 0.75, -1], UP);
  pose(h, 2, [0, 0, 0], IDENTITY);
  pose(h, 3, [0, 0, -2], IDENTITY, false);  // the wall is not located yet
  await start(h, "{ requiredFeatures: ['plane-detection', 'mesh-detection'], optionalFeatures: ['layers', 'local-floor'] }");
  const seen = frameWith<any>(
    h,
    `(frame) => ({
      planes: [...frame.detectedPlanes].map((p) => {
        const m = frame.getPose(p.planeSpace, __floor).transform.matrix;
        return { label: p.semanticLabel, orientation: p.orientation, y: m[13], up: m[5], polygon: p.polygon.map((q) => [q.x, q.y, q.z]) };
      }),
      meshes: [...frame.detectedMeshes].map((m) => ({ label: m.semanticLabel, vertices: m.vertices.length, indices: m.indices.length })),
    })`,
  );
  const byLabel = Object.fromEntries(seen.planes.map((p: any) => [p.label, p]));
  assert.deepEqual(Object.keys(byLabel).sort(), ['floor', 'table']);
  assert.equal(byLabel.floor.orientation, 'horizontal');
  assert.ok(Math.abs(byLabel.floor.up - 1) < 1e-5, 'plane +Y is up');
  assert.ok(Math.abs(byLabel.table.y - 0.75) < 1e-5);
  // the boundary's (x, y) becomes (x, 0, -y) in plane space
  assert.deepEqual([...byLabel.floor.polygon[1]], [2, 0, 2]);
  const meshes = Object.fromEntries(seen.meshes.map((m: any) => [m.label, m]));
  assert.deepEqual({ ...meshes.table }, { label: 'table', vertices: 24, indices: 36 });  // the box: 8 corners, 12 triangles
  assert.deepEqual({ ...meshes['global mesh'] }, { label: 'global mesh', vertices: 9, indices: 3 });

  // located now: the wall appears, vertical; the runtime's first label WebXR knows is used
  pose(h, 3, [0, 0, -2], IDENTITY, true);
  const wall = frameWith<any>(
    h,
    `(frame) => [...frame.detectedPlanes].filter((p) => p.semanticLabel === 'wall').map((p) => p.orientation)`,
  );
  assert.deepEqual([...wall], ['vertical']);
  const status = h.run<any>('__iwnXR.scene()');
  assert.equal(status.phase, 'ready');
  assert.equal(status.adapter.entities, 4);
  assert.equal(status.adapter.planes, 3);
});

test('XR-AR-2: geometry is read once per version; planes keep their identity; a new outline is a change; gone is gone', async () => {
  const h = createHarness({ info: AR_INFO, scene: true, permissions: GRANTED });
  h.sceneData = room();
  for (let slot = 0; slot < 4; slot++) pose(h, slot, [0, 0, 0], UP);
  await start(h, "{ requiredFeatures: ['plane-detection'], optionalFeatures: ['layers', 'local-floor'] }");
  h.run(`globalThis.__planes = () => new Map([...__lastFrame.detectedPlanes].map((p) => [p.semanticLabel, p]));`);
  const read = `(frame) => { globalThis.__lastFrame = frame; const m = __planes(); return { floor: m.get('floor'), changed: m.get('floor').lastChangedTime, count: m.size }; }`;
  const first = frameWith<any>(h, read);
  const second = frameWith<any>(h, read);
  assert.equal(first.floor, second.floor);
  assert.equal(first.count, 3);
  const asked = h.calls.filter((c) => c[0] === 'sceneData').map((c) => c[1]);
  assert.equal(asked.at(-1), 1, 'later frames ask with the version they hold');

  const next = room(2);
  next.entities[0].polygon = new Float32Array([-3, -3, 3, -3, 3, 3, -3, 3]);
  next.entities.splice(1, 1);  // the table went away
  h.sceneData = next;
  const third = frameWith<any>(h, read);
  assert.equal(third.floor, first.floor, 'same plane object');
  assert.ok(third.changed > first.changed, 'its outline changed');
  assert.equal(third.count, 2);
});

test('XR-AR-2: hit test without plane detection hits the room: nearest first, +Y along the normal', async () => {
  const h = createHarness({ info: AR_INFO, scene: true, permissions: GRANTED });
  h.sceneData = room();
  pose(h, 0, [0, 0, 0], UP);
  pose(h, 1, [0, 0.75, -1], UP);
  pose(h, 2, [5, 0, 5], IDENTITY);
  pose(h, 3, [0, 0, -3], IDENTITY);
  await start(h, "{ requiredFeatures: ['hit-test'], optionalFeatures: ['layers', 'local-floor'] }");
  h.run(`
    const ray = () => new XRRay({ x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: -1, z: -1, w: 0 });
    __session.requestHitTestSource({ space: __viewer, offsetRay: ray(), entityTypes: ['plane', 'mesh'] })
      .then((s) => { globalThis.__source = s; }, (e) => { globalThis.__error = e; });
    __session.requestHitTestSource({ space: __viewer, offsetRay: ray() }).then((s) => { globalThis.__default = s; });
  `);
  await h.settle();
  assert.ok(h.run('globalThis.__source'), String(h.run('globalThis.__error')));
  const read = (source: string) =>
    `(frame) => frame.getHitTestResults(${source}).map((r) => { const m = r.getPose(__floor).transform.matrix; return [m[13], m[14], m[5]]; })`;
  const hits = frameWith<any>(h, read('__source'));
  // from the viewer (y 1.6, z 0) 45 degrees down: the table top (y 0.75, its outline spans z -1.3..-0.7) at z -0.85,
  // as a plane and as the top of the table's box, then the floor at z -1.6 (local-floor's origin is LOCAL's x/z,
  // z -0.2, so +0.2 there); the wall is below the floor's line by then
  assert.equal(hits.length, 3, JSON.stringify(hits));
  for (const hit of hits.slice(0, 2)) {
    assert.ok(Math.abs(hit[0] - 0.75) < 1e-4 && Math.abs(hit[1] + 0.65) < 1e-4, JSON.stringify(hits));
  }
  assert.ok(Math.abs(hits[2][0]) < 1e-4 && Math.abs(hits[2][1] + 1.4) < 1e-4, JSON.stringify(hits));
  for (const hit of hits) assert.ok(Math.abs(hit[2] - 1) < 1e-5);
  // without entityTypes, as Quest Browser: the global mesh alone (out of this ray's way: nothing), never the boxes
  assert.deepEqual([...frameWith<any>(h, read('__default'))], []);
  // a room without a global mesh: the planes (WebXR's default), the table top and the floor
  const next = room(2);
  next.entities.splice(2, 1);
  h.sceneData = next;
  const planes = frameWith<any>(h, read('__default'));
  assert.equal(planes.length, 2, JSON.stringify(planes));
  assert.ok(Math.abs(planes[0][0] - 0.75) < 1e-4 && Math.abs(planes[1][0]) < 1e-4, JSON.stringify(planes));
});

test('XR-AR-2: a static room rewrites no transform: no orientation is derived again per frame', async () => {
  const h = createHarness({ info: AR_INFO, scene: true, permissions: GRANTED });
  const entities = [];
  for (let i = 0; i < 20; i++) {
    entities.push({ id: i.toString(16).padStart(32, '0'), slot: i, labels: 'FLOOR', polygon: new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]) });
    pose(h, i, [i, 0, 0], UP);
  }
  h.sceneData = { version: 1, entities };
  await start(h, "{ requiredFeatures: ['plane-detection'], optionalFeatures: ['layers', 'local-floor'] }");
  h.run(`
    const Base = globalThis.DOMPointReadOnly;
    globalThis.__points = 0;
    globalThis.DOMPointReadOnly = class extends Base { constructor(...a) { super(...a); globalThis.__points++; } };
    const loop = () => __session.requestAnimationFrame(loop); loop();
  `);
  for (let i = 0; i < 3; i++) h.frame();
  h.run('globalThis.__points = 0');
  h.frame();
  h.frame();
  assert.equal(h.run('globalThis.__points'), 0, 'no point allocated for unchanged planes');
  // a plane that moves is rewritten
  pose(h, 5, [5, 0.1, 0], UP);
  const y = frameWith<any>(h, `(frame) => [...frame.detectedPlanes].map((p) => frame.getPose(p.planeSpace, __floor).transform.matrix[13]).sort().at(-1)`);
  assert.ok(Math.abs(y - 0.1) < 1e-5, String(y));
});

test('XR-AR-2: an empty room (no Space Setup) gives no planes, no meshes, no hits, and no errors', async () => {
  const h = createHarness({ info: AR_INFO, scene: true, permissions: GRANTED });
  h.sceneData = { version: 1, entities: [] };
  await start(h, "{ requiredFeatures: ['plane-detection', 'mesh-detection', 'hit-test'], optionalFeatures: ['layers', 'local-floor'] }");
  h.run(`__session.requestHitTestSource({ space: __viewer }).then((s) => { globalThis.__source = s; });`);
  await h.settle();
  const seen = frameWith<any>(
    h,
    `(frame) => [frame.detectedPlanes.size, frame.detectedMeshes.size, frame.getHitTestResults(__source).length]`,
  );
  assert.deepEqual([...seen], [0, 0, 0]);
  assert.deepEqual(h.reported, []);
});
