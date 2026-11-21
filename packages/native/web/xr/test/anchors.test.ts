/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Spatial anchors through the shipped XR prelude (XR-ANCHOR-1) against fake anchor natives that honour
// xr_anchors_binding.cc's contract: numbered requests finished at a later frame, a pose buffer of 8 floats per slot.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createHarness } from './harness.ts';
import type { Harness } from './harness.ts';

const XR = 'navigator.xr';
const STRIDE = 8;

interface FakeResult {
  request: number;
  ok: boolean;
  anchor?: number;
  uuid?: string;
  error?: string;
}

/** Anchor natives: requests are answered when the test calls finish(); poses live in a shared buffer. */
function fakeAnchors(h: Harness) {
  const poses = new Float32Array(64 * STRIDE);
  const calls: unknown[][] = [];
  const queue: Array<() => FakeResult> = [];
  let results: FakeResult[] = [];
  const stored = new Map<string, number[]>();
  let request = 0;
  let nextSlot = 0;
  const natives = {
    anchorPoses: () => poses.buffer,
    anchorCreate: (...pose: number[]) => {
      calls.push(['create', ...pose]);
      const r = ++request;
      queue.push(() => {
        const slot = nextSlot++;
        poses.set([1, ...pose], slot * STRIDE);
        return { request: r, ok: true, anchor: slot | (1 << 8) };
      });
      return r;
    },
    anchorPersist: (anchor: number) => {
      calls.push(['persist', anchor]);
      const r = ++request;
      queue.push(() => {
        const uuid = `00000000-0000-4000-8000-00000000000${anchor & 0xff}`;
        stored.set(uuid, Array.from(poses.subarray((anchor & 0xff) * STRIDE + 1, (anchor & 0xff) * STRIDE + 8)));
        return { request: r, ok: true, anchor, uuid };
      });
      return r;
    },
    anchorRestore: (uuid: string) => {
      calls.push(['restore', uuid]);
      const r = ++request;
      queue.push(() => {
        const pose = stored.get(uuid);
        if (!pose) return { request: r, ok: false, error: `no persisted anchor with UUID ${uuid}` };
        const slot = nextSlot++;
        poses.set([0, ...pose], slot * STRIDE);  // not located yet
        return { request: r, ok: true, anchor: slot | (1 << 8) };
      });
      return r;
    },
    anchorErase: (uuid: string) => {
      calls.push(['erase', uuid]);
      const r = ++request;
      queue.push(() => {
        const ok = stored.delete(uuid);
        return ok ? { request: r, ok } : { request: r, ok, error: `no persisted anchor with UUID ${uuid}` };
      });
      return r;
    },
    anchorDestroy: (anchor: number) => {
      calls.push(['destroy', anchor]);
      poses[(anchor & 0xff) * STRIDE] = 0;
    },
    anchorResults: () => {
      if (results.length === 0) return undefined;
      const out = results;
      results = [];
      return out;
    },
    anchorStats: () => ({ supported: true }),
  };
  Object.assign(h.g.__iwn.xr, natives);
  return {
    poses,
    calls,
    stored,
    /** The native side finishes every request made so far (delivered at the next frame). */
    finish() {
      results.push(...queue.splice(0).map((f) => f()));
    },
  };
}

/** web/storage's runtime entries (__iwnRuntimeStorage), in memory. */
function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string | null) => void (v === null ? m.delete(k) : m.set(k, String(v))),
    map: m,
  };
}

async function anchorSession(h: Harness) {
  h.g.__gl = h.gl;
  h.run(`globalThis.__session = null; ${XR}.requestSession('immersive-vr', { requiredFeatures: ['anchors'], optionalFeatures: ['layers', 'local-floor'] })
    .then((s) => { globalThis.__session = s; }, (e) => { globalThis.__error = e; });`);
  await h.settle();
  assert.ok(h.run('globalThis.__session'), String(h.run('globalThis.__error')));
  h.run(`
    globalThis.__binding = new XRWebGLBinding(__session, __gl);
    __session.updateRenderState({ layers: [__binding.createProjectionLayer({ textureType: 'texture-array' })] });
    __session.requestReferenceSpace('local-floor').then((s) => { globalThis.__floor = s; });
  `);
  await h.settle();
}

/** One frame whose XR callback runs `body` (frame in scope as `frame`). */
async function frame(h: Harness, body = '') {
  h.run(`__session.requestAnimationFrame((t, frame) => { ${body} });`);
  h.frame();
  await h.settle();
}

test('XR-ANCHOR-1: anchors is granted only when the runtime reports spatial anchors', async () => {
  const none = createHarness();
  none.run(`${XR}.requestSession('immersive-vr', { requiredFeatures: ['anchors'] }).catch((e) => { globalThis.__e = e.name; })`);
  await none.settle();
  assert.equal(none.run('__e'), 'NotSupportedError');

  const h = createHarness({ info: { anchors: true, persistentAnchors: true } });
  fakeAnchors(h);
  await anchorSession(h);
  assert.ok(h.run<string[]>('__session.enabledFeatures').includes('anchors'));
});

test('XR-ANCHOR-1: createAnchor reaches the native side in the base space; the anchor follows the native pose buffer', async () => {
  const h = createHarness({ info: { anchors: true, persistentAnchors: true } });
  const fake = fakeAnchors(h);
  await anchorSession(h);
  await frame(h, `
    frame.createAnchor(new XRRigidTransform({ x: 0.5, y: 0, z: -1 }, { x: 0, y: 0.7071068, z: 0, w: 0.7071068 }), __floor)
      .then((a) => { globalThis.__anchor = a; }, (e) => { globalThis.__err = e.name + ': ' + e.message; });
  `);
  const create = fake.calls.find((c) => c[0] === 'create')!;
  // in the base space (the stage): local-floor is the LOCAL origin (the harness puts it at 0.3, 1.5, -0.2) on the floor
  assert.deepEqual(create.slice(1, 4).map((v) => Math.round((v as number) * 1e4) / 1e4), [0.8, 0, -1.2]);
  assert.ok(Math.abs((create[5] as number) - 0.7071068) < 1e-5);
  fake.finish();
  await frame(h);  // results collected; IWER hands the anchor over in the next frame
  await frame(h, `globalThis.__tracked = frame.trackedAnchors.size;`);
  assert.equal(h.run('globalThis.__err'), undefined);
  assert.ok(h.run('globalThis.__anchor'));
  assert.equal(h.run('__tracked'), 1);

  await frame(h, `globalThis.__p = frame.getPose(__anchor.anchorSpace, __floor)?.transform.position;`);
  assert.equal(h.run('Math.round(__p.x * 1000) / 1000'), 0.5);
  assert.equal(h.run('Math.round(__p.z * 1000) / 1000'), -1);

  // tracking lost: no pose; delete: the native anchor is destroyed
  fake.poses[0] = 0;
  await frame(h, `globalThis.__p = frame.getPose(__anchor.anchorSpace, __floor);`);
  assert.equal(h.run('__p'), null);
  h.run('__anchor.delete()');
  assert.deepEqual(fake.calls.at(-1), ['destroy', 1 << 8]);
  assert.equal(h.run('JSON.stringify(__iwnXR.anchorStats())'), '{"supported":true}');
});

test('XR-ANCHOR-1: persistent anchors: requestPersistentHandle, persistentAnchors (kept in the runtime storage), restore and delete by UUID', async () => {
  const h = createHarness({ info: { anchors: true, persistentAnchors: true } });
  const storage = memoryStorage();
  h.g.__iwnRuntimeStorage = storage;
  const page = memoryStorage();
  h.g.localStorage = page;
  const fake = fakeAnchors(h);
  await anchorSession(h);
  await frame(h, `frame.createAnchor(new XRRigidTransform({ x: 1, y: 1.2, z: -2 }), __floor).then((a) => { globalThis.__anchor = a; });`);
  fake.finish();
  await frame(h);
  await frame(h);
  h.run(`__anchor.requestPersistentHandle().then((u) => { globalThis.__uuid = u; })`);
  fake.finish();
  await frame(h);
  const uuid = h.run<string>('__uuid');
  assert.match(uuid, /^[0-9a-f-]{36}$/);
  assert.deepEqual([...h.run<string[]>('__session.persistentAnchors')], [uuid]);
  assert.deepEqual(JSON.parse(storage.map.get('persistent-anchors')!), [uuid]);
  assert.equal(page.map.size, 0, "nothing in the page's localStorage, which it may clear");

  // a new session (relaunch): the anchor is restored by UUID and has no pose until the native side locates it
  h.run('__session.end()');
  await h.settle();
  assert.ok(fake.calls.some((c) => c[0] === 'destroy'));
  await anchorSession(h);
  assert.deepEqual([...h.run<string[]>('__session.persistentAnchors')], [uuid]);
  h.run(`__session.restorePersistentAnchor('${uuid}').then((a) => { globalThis.__restored = a; }, (e) => { globalThis.__rerr = e.name; })`);
  fake.finish();
  await frame(h);  // the result is collected
  await frame(h);  // IWER hands the anchor over
  await frame(h, `globalThis.__p = frame.getPose(__restored.anchorSpace, __floor);`);
  assert.ok(h.run('globalThis.__restored'), String(h.run('globalThis.__rerr')));
  assert.equal(h.run('__p'), null);
  fake.poses[1 * STRIDE] = 1;
  await frame(h, `globalThis.__p = frame.getPose(__restored.anchorSpace, __floor).transform.position;`);
  assert.equal(h.run('Math.round(__p.y * 1000) / 1000'), 1.2);

  // an unknown UUID: InvalidStateError; delete erases and forgets it
  h.run(`__session.restorePersistentAnchor('11111111-2222-3333-4444-555555555555').catch((e) => { globalThis.__unknown = e.name + ': ' + e.message; })`);
  fake.finish();
  await frame(h);
  assert.match(String(h.run('__unknown')), /^InvalidStateError: no persisted anchor/);
  h.run(`__session.deletePersistentAnchor('${uuid}').then(() => { globalThis.__deleted = true; })`);
  fake.finish();
  await frame(h);
  assert.equal(h.run('__deleted'), true);
  assert.deepEqual([...h.run<string[]>('__session.persistentAnchors')], []);
  assert.equal(fake.stored.size, 0);
});

test('XR-ANCHOR-1: a delete of an anchor the system lacks forgets it; UUIDs compare in lower case', async () => {
  const h = createHarness({ info: { anchors: true, persistentAnchors: true } });
  const storage = memoryStorage();
  h.g.__iwnRuntimeStorage = storage;
  const fake = fakeAnchors(h);
  const gone = '00000000-0000-4000-8000-0000000000aa';
  const kept = '00000000-0000-4000-8000-0000000000bb';
  storage.map.set('persistent-anchors', JSON.stringify([gone, kept]));
  fake.stored.set(kept, [0, 0, 0, 0, 0, 0, 1]);
  await anchorSession(h);
  assert.deepEqual([...h.run<string[]>('__session.persistentAnchors')], [gone, kept]);
  // erased elsewhere (or the app's data was cleared): the native side has none, the list drops it
  h.run(`__session.deletePersistentAnchor('${gone}').catch((e) => { globalThis.__gone = e.name; })`);
  fake.finish();
  await frame(h);
  assert.equal(h.run('__gone'), 'InvalidStateError');
  assert.deepEqual([...h.run<string[]>('__session.persistentAnchors')], [kept]);
  // an upper-case UUID erases and forgets the same anchor
  h.run(`__session.deletePersistentAnchor('${kept.toUpperCase()}').then(() => { globalThis.__kept = true; })`);
  fake.finish();
  await frame(h);
  assert.equal(h.run('__kept'), true);
  assert.deepEqual(fake.calls.filter((c) => c[0] === 'erase').map((c) => c[1]), [gone, kept]);
  assert.deepEqual([...h.run<string[]>('__session.persistentAnchors')], []);
});
