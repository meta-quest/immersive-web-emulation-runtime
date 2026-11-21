/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// XRF-2's check: a record written by the native writer (runtime/xr FrameRecord + write_hand_input, Linux build:
// iwn_xr_record_dump) handed to IWER's runHostFrame as the XRHostFrame gives the expected XRView matrices, the
// OpenXR asymmetric-FOV projection, the predicted display time and the input state. Expected values are computed
// here from the poses record_dump_main.cc writes, independently of IWER's math.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { RECORD_BYTES } from '../src/layout.gen.ts';
import { createHarness } from './harness.ts';

const tool =
  process.env.IWN_XR_RECORD_DUMP ??
  join(import.meta.dirname, '../../../build/host/xr/iwn_xr_record_dump');

function quatMatrix(qx: number, qy: number, qz: number, qw: number): number[] {
  // column-major rotation of a unit quaternion
  return [
    1 - 2 * (qy * qy + qz * qz),
    2 * (qx * qy + qw * qz),
    2 * (qx * qz - qw * qy),
    0,
    2 * (qx * qy - qw * qz),
    1 - 2 * (qx * qx + qz * qz),
    2 * (qy * qz + qw * qx),
    0,
    2 * (qx * qz + qw * qy),
    2 * (qy * qz - qw * qx),
    1 - 2 * (qx * qx + qy * qy),
    0,
    0,
    0,
    0,
    1,
  ];
}

function frustum(
  l: number,
  r: number,
  u: number,
  d: number,
  near: number,
  far: number,
): number[] {
  // OpenGL frustum from the four OpenXR angles (tangents at unit distance), clip z in [-1, 1]
  const left = Math.tan(l),
    right = Math.tan(r),
    up = Math.tan(u),
    down = Math.tan(d);
  const m = new Array(16).fill(0);
  m[0] = 2 / (right - left);
  m[5] = 2 / (up - down);
  m[8] = (right + left) / (right - left);
  m[9] = (up + down) / (up - down);
  m[10] = -(far + near) / (far - near);
  m[11] = -1;
  m[14] = -(2 * far * near) / (far - near);
  return m;
}

function close(
  actual: ArrayLike<number>,
  expected: number[],
  eps: number,
  what: string,
): void {
  for (let i = 0; i < expected.length; i++) {
    assert.ok(
      Math.abs(actual[i] - expected[i]) <= eps,
      `${what}[${i}]: ${actual[i]} vs ${expected[i]}`,
    );
  }
}

test(
  'XRF-2: a natively written record gives the expected views, projections, time and input in IWER',
  {
    skip:
      !existsSync(tool) &&
      `build ${tool} (runtime host build, target iwn_xr_record_dump)`,
  },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iwn-xr-record-'));
    const file = join(dir, 'record.bin');
    try {
      execFileSync(tool, [file]);
      const bytes = readFileSync(file);
      assert.equal(bytes.length, RECORD_BYTES);

      const h = createHarness();
      h.g.__gl = h.gl;
      h.run(
        `navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['layers', 'hand-tracking', 'bounded-floor', 'local'] }).then((s) => { globalThis.__session = s; })`,
      );
      await h.settle();
      h.run(`
      globalThis.__binding = new XRWebGLBinding(__session, __gl);
      globalThis.__layer = __binding.createProjectionLayer({ textureType: 'texture-array' });
      __session.updateRenderState({ layers: [__layer] });
      Promise.all([__session.requestReferenceSpace('bounded-floor'), __session.requestReferenceSpace('local')])
        .then(([stage, local]) => { globalThis.__stage = stage; globalThis.__local = local; });
    `);
      await h.settle();
      h.record.u8.set(bytes);
      h.run(`
      globalThis.__out = {};
      const cb = (t, frame) => {
        const pose = frame.getViewerPose(__stage);
        __out.time = t;
        __out.predicted = frame.predictedDisplayTime;
        __out.views = pose.views.map((v) => ({ eye: v.eye, m: [...v.transform.matrix], p: [...v.projectionMatrix] }));
        __out.local = [...frame.getViewerPose(__local).transform.matrix];
        const sources = [...__session.inputSources];
        const left = sources.find((s) => s.handedness === 'left');
        const right = sources.find((s) => s.handedness === 'right');
        __out.left = left && {
          ray: [...frame.getPose(left.targetRaySpace, __stage).transform.matrix],
          trigger: left.gamepad.buttons[0].value,
          pressed: left.gamepad.buttons[0].pressed,
          axes: [...left.gamepad.axes],
        };
        __out.right = right && {
          hand: !!right.hand,
          wrist: right.hand && [...frame.getJointPose(right.hand.get('wrist'), __stage).transform.matrix],
          pinch: right.gamepad.buttons[0].pressed,
        };
      };
      __session.requestAnimationFrame(cb);
    `);
      h.handler()!(1); // first frame: sources appear
      h.run(
        `__session.requestAnimationFrame((t, f) => {}); __session.requestAnimationFrame(() => {});`,
      );
      h.run(`
      __session.requestAnimationFrame((t, frame) => {
        const sources = [...__session.inputSources];
        const left = sources.find((s) => s.handedness === 'left');
        const right = sources.find((s) => s.handedness === 'right');
        __out.left2 = left && { trigger: left.gamepad.buttons[0].value, pressed: left.gamepad.buttons[0].pressed, axes: [...left.gamepad.axes], ray: [...frame.getPose(left.targetRaySpace, __stage).transform.matrix] };
        __out.right2 = right && { hand: !!right.hand, wrist: right.hand && [...frame.getJointPose(right.hand.get('wrist'), __stage).transform.matrix], pinch: right.gamepad.buttons[0].pressed };
      });
    `);
      h.handler()!(1);
      const out = h.run<any>('__out');

      // time (XR-LOOP-5)
      assert.equal(out.predicted, 123456.789);
      assert.equal(out.time, 123456.789);
      // views: positions and the 30 degree yaw, in the stage (base) space
      const c = Math.cos(Math.PI / 6),
        s = Math.sin(Math.PI / 6);
      const half = Math.PI / 12;
      const rot = quatMatrix(0, Math.sin(half), 0, Math.cos(half));
      const eyes = [
        [-0.032 * c, 1.6, 0.032 * s],
        [0.032 * c, 1.6, -0.032 * s],
      ];
      assert.equal(out.views.length, 2);
      for (let i = 0; i < 2; i++) {
        const expected = rot.slice();
        expected[12] = eyes[i][0];
        expected[13] = eyes[i][1];
        expected[14] = eyes[i][2];
        close(out.views[i].m, expected, 1e-5, `view ${i} transform`);
      }
      assert.equal(out.views[0].eye, 'left');
      assert.equal(out.views[1].eye, 'right');
      // projections from the OpenXR angles with the default depthNear/depthFar (0.1, 1000)
      close(
        out.views[0].p,
        frustum(-0.9425, 0.6981, 0.8029, -0.9076, 0.1, 1000),
        1e-4,
        'left projection',
      );
      close(
        out.views[1].p,
        frustum(-0.6981, 0.9425, 0.8029, -0.9076, 0.1, 1000),
        1e-4,
        'right projection',
      );
      // local space: the LOCAL origin the record carries (0.25, 1.55, -0.4) shifts the viewer
      assert.ok(
        Math.abs(out.local[12] - (0 - 0.25)) < 1e-5 &&
          Math.abs(out.local[13] - (1.6 - 1.55)) < 1e-5,
      );

      // input (XRF-IN-1): left Touch Plus controller, right tracked hand
      assert.ok(out.left2, 'left controller listed');
      close(
        out.left2.ray.slice(12, 15),
        [-0.2, 1.3, -0.35],
        1e-6,
        'left target ray',
      );
      assert.ok(Math.abs(out.left2.trigger - 0.75) < 1e-6);
      assert.equal(out.left2.pressed, true);
      close(
        out.left2.axes,
        [0, 0, -0.5, -0.5],
        1e-6,
        'left axes (WebXR +y toward the user)',
      );
      assert.ok(out.right2 && out.right2.hand, 'right hand listed');
      close(
        out.right2.wrist.slice(12, 15),
        [0.205, 1.2, -0.3],
        1e-5,
        'wrist = OpenXR joint 1',
      );
      assert.equal(out.right2.pinch, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
