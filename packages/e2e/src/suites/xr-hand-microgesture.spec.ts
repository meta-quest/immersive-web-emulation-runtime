/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { TestHarness } from '@harness/test-harness';
import type { TestContext } from '@harness/xr-helpers';
import { startSession, cleanup } from '@harness/xr-helpers';

const GESTURES = [
  'swipe-left',
  'swipe-right',
  'swipe-forward',
  'swipe-backward',
  'tap',
];

/**
 * Hand microgestures — IWER's microgesture command and run_sequence steps
 * against a small app that only reads WebXR: each frame it reads the right
 * hand's gamepad buttons and counts each button's presses (rising edges) and
 * the frames it is down, and it listens for select events.
 * 5 tests
 */
export function registerXRHandMicrogestureTests(harness: TestHarness): void {
  harness.describe('Hand Microgestures (IWER microgesture)', () => {
    let session: XRSession | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let looping = false;
    let error: string | null = null;
    let mapping = '';
    let buttonCount = 0;
    const presses: number[] = Array(10).fill(0);
    const framesDown: number[] = Array(10).fill(0);
    const order: number[] = [];
    const selectEvents: string[] = [];
    const results: any[] = [];
    let sequence: any = null;
    let pressesAfterCommands: number[] = [];

    harness.beforeAll(async (ctx: TestContext) => {
      if (ctx.mode === 'native' || !ctx.xrDevice) return;
      const device = ctx.xrDevice;
      const started = await startSession('immersive-vr', {
        requiredFeatures: ['local-floor', 'hand-tracking'],
      });
      session = started.session;
      canvas = started.canvas;
      for (const type of ['selectstart', 'select', 'selectend']) {
        session.addEventListener(type, () => selectEvents.push(type));
      }
      let previous: boolean[] = [];
      const loop = () => {
        if (!looping) return;
        session!.requestAnimationFrame(loop);
        const source = Array.from(session!.inputSources).find(
          (s) => s.hand && s.handedness === 'right',
        );
        const gamepad = source?.gamepad;
        if (!gamepad) return;
        mapping = gamepad.mapping;
        buttonCount = gamepad.buttons.length;
        const now = gamepad.buttons.map((b) => b.pressed);
        now.forEach((down, i) => {
          if (down) framesDown[i]++;
          if (down && !previous[i]) {
            presses[i]++;
            order.push(i);
          }
        });
        previous = now;
      };
      looping = true;
      session.requestAnimationFrame(loop);

      try {
        await device.remote.dispatch('set_device_state', {});
        await device.remote.dispatch('set_input_mode', { mode: 'hand' });
        // Raised side-on in front of the chest.
        await device.remote.dispatch('set_transform', {
          device: 'hand-right',
          anchor: 'wrist',
          position: { x: 0.12, y: 1.2, z: -0.3 },
          orientation: { fingers: [0, -0.585, -0.811], palm: 'left' },
        });
        for (const gesture of GESTURES) {
          results.push(
            await device.remote.dispatch('microgesture', {
              device: 'hand-right',
              gesture,
            }),
          );
        }
        pressesAfterCommands = [...presses];
        sequence = await device.remote.runSequence({
          device: 'hand-right',
          idleHand: 'keep',
          steps: [
            { label: 'tap', microgesture: 'tap' },
            { label: 'pause', duration: 0.2 },
            { label: 'swipe', microgesture: 'swipe-left' },
          ],
        });
      } catch (e: any) {
        error = e?.message ?? String(e);
      }
    });

    harness.afterAll(async (ctx: TestContext) => {
      looping = false;
      if (ctx.xrDevice) {
        ctx.xrDevice.remote.forceRelease();
        ctx.xrDevice.primaryInputMode = 'controller';
      }
      await cleanup(session, canvas);
    });

    const skipNative = (ctx: TestContext) =>
      harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');

    // 1. The hand gamepad's layout
    harness.it(
      'the hand gamepad is xr-standard with 10 buttons [SKIP:native]',
      (ctx) => {
        skipNative(ctx);
        harness.assert(error === null, `microgestures failed: ${error}`);
        harness.assertEqual(mapping, 'xr-standard');
        harness.assertEqual(buttonCount, 10);
      },
    );

    // 2. One press per command, on its button
    harness.it(
      'each microgesture presses its button once, in order [SKIP:native]',
      (ctx) => {
        skipNative(ctx);
        harness.assertEqual(
          pressesAfterCommands.join(','),
          '0,0,0,0,0,1,1,1,1,1',
        );
        harness.assertEqual(order.slice(0, 5).join(','), '5,6,7,8,9');
        harness.assertEqual(
          results.map((r) => r.button).join(','),
          '5,6,7,8,9',
        );
      },
    );

    // 3. Held long enough to be read
    harness.it(
      'the page sees each press on at least one frame [SKIP:native]',
      (ctx) => {
        skipNative(ctx);
        for (let i = 5; i < 10; i++) {
          harness.assertGreaterThan(framesDown[i], 0);
        }
      },
    );

    // 4. Sequence steps
    harness.it(
      'run_sequence steps make microgestures and report them [SKIP:native]',
      (ctx) => {
        skipNative(ctx);
        harness.assert(
          sequence?.completed === true,
          `not completed: ${sequence?.reason}`,
        );
        harness.assertEqual(
          sequence.events.map((e: { type: string }) => e.type).join(','),
          'tap,swipe-left',
        );
        harness.assertEqual(presses.join(','), '0,0,0,0,0,2,1,1,1,2');
      },
    );

    // 5. No select events
    harness.it('microgestures fire no select events [SKIP:native]', (ctx) => {
      skipNative(ctx);
      harness.assertEqual(selectEvents.length, 0, selectEvents.join());
    });
  });
}
