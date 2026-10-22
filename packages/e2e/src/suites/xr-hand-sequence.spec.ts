/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { TestHarness } from '@harness/test-harness';
import type { TestContext } from '@harness/xr-helpers';
import { startSession, cleanup } from '@harness/xr-helpers';

type V3 = [number, number, number];
type Box = { min: V3; max: V3 };

/** The plan's scene: a button, a piece with a knob on top, a tray. */
const BOXES: Record<string, Box> = {
  button: { min: [-0.04, 0.95, -0.54], max: [0.04, 0.99, -0.46] },
  piece: { min: [-0.2225, 0.94, -0.4225], max: [-0.1775, 1.0, -0.3775] },
  tray: { min: [0.125, 0.936, -0.455], max: [0.275, 0.956, -0.305] },
};

const SCENARIO = {
  device: 'hand-right',
  steps: [
    { label: 'press', target: 'button', press: {} },
    {
      label: 'grab',
      target: 'piece',
      approach: { distance: 0.06 },
      pinch: { value: 1, at: 'arrival' },
    },
    {
      label: 'carry',
      target: 'tray',
      depart: { distance: 0.08 },
      approach: { distance: 0.06 },
    },
    { label: 'release', pinch: 0, duration: 0.15 },
    {
      label: 'thumbs up',
      position: { relativeTo: 'head', x: 0.12, y: -0.35, z: -0.35 },
      anchor: 'wrist',
      orientation: { fingers: 'forward', thumb: 'up' },
      poseId: 'thumbs-up',
    },
    { label: 'hold', duration: 0.3 },
  ],
};

const xyz = (a: V3) => ({ x: a[0], y: a[1], z: a[2] });
const center = (box: Box) => box.min.map((m, i) => (m + box.max[i]) / 2) as V3;
const distanceToBox = (p: V3, box: Box) =>
  Math.hypot(...p.map((v, i) => Math.max(box.min[i] - v, 0, v - box.max[i])));

/**
 * Hand sequences — IWER's run_sequence drives the plan's scenario against a
 * small app that only reads WebXR: a 2 cm touch pointer on the index tip
 * (no hysteresis, click = down then up within 800 ms), a piece that follows
 * the pinch point between selectstart and selectend, and a thumbs-up check
 * on the joints.
 * 6 tests
 */
export function registerXRHandSequenceTests(harness: TestHarness): void {
  harness.describe('Hand Sequences (IWER run_sequence)', () => {
    let session: XRSession | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let looping = false;
    let result: any = null;
    let error: string | null = null;
    const selectEvents: string[] = [];
    const touch = { downs: 0, ups: 0, clicks: 0, down: false, since: 0 };
    let piece: V3 = center(BOXES.piece);
    let grabbedDuringCarry = false;
    let joints: Record<string, V3> = {};

    harness.beforeAll(async (ctx: TestContext) => {
      if (ctx.mode === 'native' || !ctx.xrDevice) return;
      const device = ctx.xrDevice;
      const started = await startSession('immersive-vr', {
        requiredFeatures: ['local-floor', 'hand-tracking'],
      });
      session = started.session;
      canvas = started.canvas;
      const space = await session.requestReferenceSpace('local-floor');

      let held: V3 | null = null; // piece minus pinch point while held
      const pinchPoint = () =>
        joints['thumb-tip'] && joints['index-finger-tip']
          ? (joints['thumb-tip'].map(
              (v, i) => (v + joints['index-finger-tip'][i]) / 2,
            ) as V3)
          : null;
      session.addEventListener('selectstart', (event) => {
        selectEvents.push('selectstart');
        const at = pinchPoint();
        const knob: V3 = [piece[0], BOXES.piece.max[1], piece[2]];
        if (
          (event as XRInputSourceEvent).inputSource.handedness === 'right' &&
          at &&
          Math.hypot(...at.map((v, i) => v - knob[i])) < 0.03
        ) {
          held = piece.map((v, i) => v - at[i]) as V3;
        }
      });
      session.addEventListener('select', () => selectEvents.push('select'));
      session.addEventListener('selectend', () => {
        selectEvents.push('selectend');
        held = null;
      });

      const loop = (_time: number, frame: XRFrame) => {
        if (!looping) return;
        session!.requestAnimationFrame(loop);
        const source = Array.from(session!.inputSources).find(
          (s) => s.hand && s.handedness === 'right',
        );
        if (!source?.hand) return;
        joints = {};
        for (const name of [
          'wrist',
          'thumb-tip',
          'index-finger-tip',
          'middle-finger-tip',
          'ring-finger-tip',
          'pinky-finger-tip',
        ]) {
          const pose = frame.getJointPose!(
            source.hand.get(name as XRHandJoint)!,
            space,
          );
          if (pose) {
            const p = pose.transform.position;
            joints[name] = [p.x, p.y, p.z];
          }
        }
        const tip = joints['index-finger-tip'];
        if (tip) {
          const down = distanceToBox(tip, BOXES.button) <= 0.02;
          if (down && !touch.down) {
            touch.downs++;
            touch.since = performance.now();
          }
          if (!down && touch.down) {
            touch.ups++;
            if (performance.now() - touch.since <= 800) touch.clicks++;
          }
          touch.down = down;
        }
        const at = pinchPoint();
        if (held && at) {
          piece = at.map((v, i) => v + held![i]) as V3;
          if (piece[0] > -0.05) grabbedDuringCarry = true;
        }
      };
      looping = true;
      session.requestAnimationFrame(loop);

      device.remote.setTargetResolver({
        resolve(target) {
          const name = typeof target === 'string' ? target : target.name;
          const box = BOXES[name];
          if (!box) return null;
          const c = center(box);
          return {
            name,
            position: xyz([c[0], box.max[1], c[2]]),
            normal: { x: 0, y: 1, z: 0 },
            box: { min: xyz(box.min), max: xyz(box.max) },
          };
        },
        list: () =>
          Object.entries(BOXES).map(([name, box]) => ({
            name,
            position: xyz(center(box)),
            size: xyz(box.max.map((m, i) => m - box.min[i]) as V3),
          })),
      });
      try {
        await device.remote.dispatch('set_device_state', {});
        await device.remote.dispatch('set_input_mode', { mode: 'hand' });
        result = await device.remote.runSequence(SCENARIO as any);
      } catch (e: any) {
        error = e?.message ?? String(e);
      }
    });

    harness.afterAll(async (ctx: TestContext) => {
      looping = false;
      if (ctx.xrDevice) {
        ctx.xrDevice.remote.setTargetResolver(null);
        ctx.xrDevice.remote.forceRelease();
        ctx.xrDevice.primaryInputMode = 'controller';
      }
      await cleanup(session, canvas);
    });

    const skipNative = (ctx: TestContext) =>
      harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');

    // 1. The whole scenario runs
    harness.it('runs the scenario to completion [SKIP:native]', (ctx) => {
      skipNative(ctx);
      harness.assert(error === null, `run_sequence failed: ${error}`);
      harness.assert(
        result?.completed === true,
        `not completed: ${result?.reason}`,
      );
      harness.assertEqual(
        result.steps.map((s: { label: string }) => s.label).join(','),
        'press,grab,carry,release,thumbs up,hold',
      );
    });

    // 2. One click on the button
    harness.it(
      'the 2 cm touch pointer clicks the button exactly once [SKIP:native]',
      (ctx) => {
        skipNative(ctx);
        harness.assertEqual(touch.downs, 1, `touch downs: ${touch.downs}`);
        harness.assertEqual(touch.ups, 1, `touch ups: ${touch.ups}`);
        harness.assertEqual(
          touch.clicks,
          1,
          `clicks within 800 ms: ${touch.clicks}`,
        );
      },
    );

    // 3. Select events in spec order, as the result reports them
    harness.it(
      'the session sees one select, which the result reports [SKIP:native]',
      (ctx) => {
        skipNative(ctx);
        harness.assertEqual(
          selectEvents.join(','),
          'selectstart,select,selectend',
        );
        harness.assertEqual(
          result.events.map((e: { type: string }) => e.type).join(','),
          selectEvents.join(','),
        );
      },
    );

    // 4. The piece is carried to the tray
    harness.it(
      'the piece is picked up, carried and set down on the tray [SKIP:native]',
      (ctx) => {
        skipNative(ctx);
        harness.assert(
          grabbedDuringCarry,
          'the piece never left with the hand',
        );
        const tray = BOXES.tray;
        harness.assert(
          piece[0] > tray.min[0] && piece[0] < tray.max[0],
          `piece x ${piece[0].toFixed(3)} off the tray`,
        );
        harness.assert(
          piece[2] > tray.min[2] && piece[2] < tray.max[2],
          `piece z ${piece[2].toFixed(3)} off the tray`,
        );
        // The piece's base (3 cm below its centre) rests on the tray floor.
        const base = piece[1] - 0.03;
        harness.assertApprox(
          base,
          tray.max[1],
          0.015,
          `piece base at ${base.toFixed(3)}`,
        );
      },
    );

    // 5. The hand ends in a thumbs up
    harness.it('the hand ends in a thumbs up [SKIP:native]', (ctx) => {
      skipNative(ctx);
      const thumb = joints['thumb-tip'];
      harness.assert(!!thumb, 'no thumb tip pose');
      for (const finger of [
        'index-finger-tip',
        'middle-finger-tip',
        'ring-finger-tip',
        'pinky-finger-tip',
      ]) {
        harness.assertGreaterThan(thumb[1], joints[finger][1] + 0.02);
      }
      harness.assertGreaterThan(thumb[1], joints.wrist[1] + 0.04);
    });

    // 6. Nothing left behind
    harness.it(
      'reports no warnings and leaves the pinch open [SKIP:native]',
      (ctx) => {
        skipNative(ctx);
        harness.assertEqual(result.warnings.length, 0, result.warnings.join());
        harness.assertEqual(result.pinchValue, 0, `pinch ${result.pinchValue}`);
      },
    );
  });
}
