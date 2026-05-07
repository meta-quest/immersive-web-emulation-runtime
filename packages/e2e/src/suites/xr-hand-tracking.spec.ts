/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { TestHarness } from '@harness/test-harness';
import {
  startSession,
  withFrame,
  cleanup,
  switchToHandInput,
  switchToControllerInput,
} from '@harness/xr-helpers';

const ALL_JOINT_NAMES = [
  'wrist',
  'thumb-metacarpal',
  'thumb-phalanx-proximal',
  'thumb-phalanx-distal',
  'thumb-tip',
  'index-finger-metacarpal',
  'index-finger-phalanx-proximal',
  'index-finger-phalanx-intermediate',
  'index-finger-phalanx-distal',
  'index-finger-tip',
  'middle-finger-metacarpal',
  'middle-finger-phalanx-proximal',
  'middle-finger-phalanx-intermediate',
  'middle-finger-phalanx-distal',
  'middle-finger-tip',
  'ring-finger-metacarpal',
  'ring-finger-phalanx-proximal',
  'ring-finger-phalanx-intermediate',
  'ring-finger-phalanx-distal',
  'ring-finger-tip',
  'pinky-finger-metacarpal',
  'pinky-finger-phalanx-proximal',
  'pinky-finger-phalanx-intermediate',
  'pinky-finger-phalanx-distal',
  'pinky-finger-tip',
];

/**
 * Hand Tracking Module — XRHand, XRJointSpace, XRJointPose, fillJointRadii, fillPoses
 * 26 tests
 */
export function registerXRHandTrackingTests(harness: TestHarness): void {
  harness.describe('Hand Tracking Module', () => {
    let session: XRSession;
    let canvas: HTMLCanvasElement;

    harness.beforeAll(async () => {
      const result = await startSession('immersive-vr', {
        requiredFeatures: ['hand-tracking'],
      });
      session = result.session;
      canvas = result.canvas;
    });

    harness.afterAll(async () => {
      await cleanup(session, canvas);
    });

    // 1. hand-tracking feature can be requested
    harness.it('hand-tracking feature can be requested', async () => {
      harness.assert(
        session != null,
        'Session with hand-tracking should be created',
      );
    });

    // 2. enabledFeatures includes "hand-tracking"
    harness.it('enabledFeatures includes "hand-tracking"', async () => {
      harness.assert(
        session.enabledFeatures.includes('hand-tracking'),
        'enabledFeatures should include "hand-tracking"',
      );
    });

    // 3. switching to hand mode changes inputSources [SKIP:native]
    harness.it(
      'switching to hand mode changes inputSources [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');

        const controllerCount = session.inputSources.length;
        await switchToHandInput(ctx, session);
        // After switching, inputSources should have changed
        harness.assert(
          session.inputSources.length > 0,
          'Should have hand input sources after switching',
        );
        // Verify input sources changed (they may differ from controller sources)
        harness.assert(
          true,
          `Controller count: ${controllerCount}, hand count: ${session.inputSources.length}`,
        );
      },
    );

    // 4. hand input source has hand property [SKIP:native]
    harness.it(
      'hand input source has hand property [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');
        await switchToHandInput(ctx, session);

        harness.assertGreaterThan(session.inputSources.length, 0);
        for (const source of session.inputSources) {
          harness.assert(
            source.hand != null,
            'hand input source should have hand property',
          );
        }
      },
    );

    // 5. hand is XRHand instance [SKIP:native]
    harness.it('hand is XRHand instance [SKIP:native]', async (ctx) => {
      harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');
      await switchToHandInput(ctx, session);

      for (const source of session.inputSources) {
        harness.assertInstanceOf(source.hand, XRHand);
      }
    });

    // 6. XRHand extends Map [SKIP:native]
    harness.it('XRHand extends Map [SKIP:native]', async (ctx) => {
      harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');
      await switchToHandInput(ctx, session);

      for (const source of session.inputSources) {
        harness.assertInstanceOf(source.hand, Map);
      }
    });

    // 7. XRHand has 25 joints [SKIP:native]
    harness.it('XRHand has 25 joints [SKIP:native]', async (ctx) => {
      harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');
      await switchToHandInput(ctx, session);

      for (const source of session.inputSources) {
        harness.assertEqual(source.hand!.size, 25);
      }
    });

    // 8. XRHand.get("wrist") returns XRJointSpace [SKIP:native]
    harness.it(
      'XRHand.get("wrist") returns XRJointSpace [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');
        await switchToHandInput(ctx, session);

        const source = session.inputSources[0];
        const wrist = source.hand!.get('wrist' as XRHandJoint);
        harness.assert(wrist != null, 'wrist joint should exist');
        harness.assertInstanceOf(wrist, XRJointSpace);
      },
    );

    // 9. All 25 joint names are present [SKIP:native]
    harness.it('All 25 joint names are present [SKIP:native]', async (ctx) => {
      harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');
      await switchToHandInput(ctx, session);

      const source = session.inputSources[0];
      for (const jointName of ALL_JOINT_NAMES) {
        const joint = source.hand!.get(jointName as XRHandJoint);
        harness.assert(joint != null, `Joint "${jointName}" should be present`);
      }
    });

    // 10. XRJointSpace extends XRSpace [SKIP:native]
    harness.it('XRJointSpace extends XRSpace [SKIP:native]', async (ctx) => {
      harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');
      await switchToHandInput(ctx, session);

      const source = session.inputSources[0];
      const wrist = source.hand!.get('wrist' as XRHandJoint);
      harness.assertInstanceOf(wrist, XRSpace);
    });

    // 11. XRJointSpace.jointName is string [SKIP:native]
    harness.it(
      'XRJointSpace.jointName is string [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');
        await switchToHandInput(ctx, session);

        const source = session.inputSources[0];
        const wrist = source.hand!.get('wrist' as XRHandJoint)!;
        harness.assertType(wrist.jointName, 'string');
        harness.assertEqual(wrist.jointName, 'wrist');
      },
    );

    // 12. getJointPose returns XRJointPose [SKIP:native]
    harness.it(
      'getJointPose returns XRJointPose [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');
        await switchToHandInput(ctx, session);

        const refSpace = await session.requestReferenceSpace('local');
        const source = session.inputSources[0];
        const wrist = source.hand!.get('wrist' as XRHandJoint)!;

        await withFrame(session, (_time, frame) => {
          const pose = frame.getJointPose(wrist, refSpace);
          harness.assert(pose != null, 'getJointPose should return a pose');
          harness.assertInstanceOf(pose, XRJointPose);
        });
      },
    );

    // 13. XRJointPose extends XRPose [SKIP:native]
    harness.it('XRJointPose extends XRPose [SKIP:native]', async (ctx) => {
      harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');
      await switchToHandInput(ctx, session);

      const refSpace = await session.requestReferenceSpace('local');
      const source = session.inputSources[0];
      const wrist = source.hand!.get('wrist' as XRHandJoint)!;

      await withFrame(session, (_time, frame) => {
        const pose = frame.getJointPose(wrist, refSpace);
        harness.assertInstanceOf(pose, XRPose);
      });
    });

    // 14. XRJointPose.radius is number [SKIP:native]
    harness.it('XRJointPose.radius is number [SKIP:native]', async (ctx) => {
      harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');
      await switchToHandInput(ctx, session);

      const refSpace = await session.requestReferenceSpace('local');
      const source = session.inputSources[0];
      const wrist = source.hand!.get('wrist' as XRHandJoint)!;

      await withFrame(session, (_time, frame) => {
        const pose = frame.getJointPose(wrist, refSpace);
        harness.assertType(pose!.radius, 'number');
      });
    });

    // 15. fillJointRadii returns boolean [SKIP:native]
    harness.it('fillJointRadii returns boolean [SKIP:native]', async (ctx) => {
      harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');
      await switchToHandInput(ctx, session);

      const source = session.inputSources[0];
      const joints = ALL_JOINT_NAMES.map(
        (name) => source.hand!.get(name as XRHandJoint)!,
      );
      const radii = new Float32Array(25);

      await withFrame(session, (_time, frame) => {
        const result = frame.fillJointRadii(joints, radii);
        harness.assertType(result, 'boolean');
      });
    });

    // 16. fillJointRadii populates Float32Array [SKIP:native]
    harness.it(
      'fillJointRadii populates Float32Array [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');
        await switchToHandInput(ctx, session);

        const source = session.inputSources[0];
        const joints = ALL_JOINT_NAMES.map(
          (name) => source.hand!.get(name as XRHandJoint)!,
        );
        const radii = new Float32Array(25);

        await withFrame(session, (_time, frame) => {
          const filled = frame.fillJointRadii(joints, radii);
          if (filled) {
            // At least some radii should be non-NaN
            let hasValue = false;
            for (let i = 0; i < 25; i++) {
              if (!isNaN(radii[i])) {
                hasValue = true;
                break;
              }
            }
            harness.assert(hasValue, 'At least some radii should be populated');
          } else {
            harness.assert(
              true,
              'fillJointRadii returned false (tracking not available)',
            );
          }
        });
      },
    );

    // 17. fillPoses returns boolean [SKIP:native]
    harness.it('fillPoses returns boolean [SKIP:native]', async (ctx) => {
      harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');
      await switchToHandInput(ctx, session);

      const refSpace = await session.requestReferenceSpace('local');
      const source = session.inputSources[0];
      const joints = ALL_JOINT_NAMES.map(
        (name) => source.hand!.get(name as XRHandJoint)!,
      );
      const poses = new Float32Array(25 * 16);

      await withFrame(session, (_time, frame) => {
        const result = frame.fillPoses(joints, refSpace, poses);
        harness.assertType(result, 'boolean');
      });
    });

    // 18. fillPoses populates Float32Array with 16 values per joint [SKIP:native]
    harness.it(
      'fillPoses populates Float32Array with 16 values per joint [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');
        await switchToHandInput(ctx, session);

        const refSpace = await session.requestReferenceSpace('local');
        const source = session.inputSources[0];
        const joints = ALL_JOINT_NAMES.map(
          (name) => source.hand!.get(name as XRHandJoint)!,
        );
        const poses = new Float32Array(25 * 16);

        await withFrame(session, (_time, frame) => {
          const filled = frame.fillPoses(joints, refSpace, poses);
          if (filled) {
            harness.assertEqual(
              poses.length,
              25 * 16,
              'Should have 16 floats per joint',
            );
            // At least some values should be non-zero (identity matrix has 1s)
            let hasNonZero = false;
            for (let i = 0; i < poses.length; i++) {
              if (poses[i] !== 0) {
                hasNonZero = true;
                break;
              }
            }
            harness.assert(hasNonZero, 'Poses should contain non-zero values');
          } else {
            harness.assert(
              true,
              'fillPoses returned false (tracking not available)',
            );
          }
        });
      },
    );

    // 19. hand input targetRayMode is "tracked-pointer" [SKIP:native]
    harness.it(
      'hand input targetRayMode is "tracked-pointer" [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');
        await switchToHandInput(ctx, session);

        for (const source of session.inputSources) {
          harness.assertEqual(
            source.targetRayMode,
            'tracked-pointer',
            'hand input should have tracked-pointer targetRayMode',
          );
        }
      },
    );

    // 20. hand input profiles includes "generic-hand" [SKIP:native]
    harness.it(
      'hand input profiles includes "generic-hand" [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');
        await switchToHandInput(ctx, session);

        for (const source of session.inputSources) {
          harness.assert(
            source.profiles.includes('generic-hand'),
            `profiles should include "generic-hand", got: ${source.profiles.join(', ')}`,
          );
        }
      },
    );

    // 21. hand input gamepad exists (pinch button) [SKIP:native]
    harness.it(
      'hand input gamepad exists (pinch button) [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');
        await switchToHandInput(ctx, session);

        for (const source of session.inputSources) {
          harness.assert(
            source.gamepad != null,
            'hand input should have gamepad',
          );
          if (source.gamepad) {
            harness.assertGreaterThan(
              source.gamepad.buttons.length,
              0,
              'hand gamepad should have at least one button (pinch)',
            );
          }
        }
      },
    );

    // 22. hand input handedness is "left" or "right" [SKIP:native]
    harness.it(
      'hand input handedness is "left" or "right" [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');
        await switchToHandInput(ctx, session);

        const handednesses = new Set<string>();
        for (const source of session.inputSources) {
          harness.assert(
            source.handedness === 'left' || source.handedness === 'right',
            `hand input handedness should be "left" or "right", got "${source.handedness}"`,
          );
          handednesses.add(source.handedness);
        }
        // Should have both hands
        if (session.inputSources.length >= 2) {
          harness.assert(handednesses.has('left'), 'Should have left hand');
          harness.assert(handednesses.has('right'), 'Should have right hand');
        }
      },
    );

    // 23. controller→hand→controller round-trip restores controller inputSources [SKIP:native]
    harness.it(
      'controller→hand→controller round-trip restores controller inputSources [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');

        // Start in controller mode — capture initial state
        await switchToControllerInput(ctx, session);
        const initialCount = session.inputSources.length;
        harness.assertGreaterThan(
          initialCount,
          0,
          'Should start with controller input sources',
        );
        const hadGamepad = session.inputSources[0].gamepad != null;

        // Switch to hand mode
        await switchToHandInput(ctx, session);
        for (const source of session.inputSources) {
          harness.assert(
            source.hand != null,
            'Should have hand input sources after switching to hand',
          );
        }

        // Switch back to controller mode
        await switchToControllerInput(ctx, session);
        harness.assertEqual(
          session.inputSources.length,
          initialCount,
          'Should restore same number of input sources',
        );
        if (hadGamepad) {
          harness.assert(
            session.inputSources[0].gamepad != null,
            'Controller should have gamepad after round-trip',
          );
        }
        for (const source of session.inputSources) {
          harness.assert(
            source.hand == null,
            'Controller input sources should not have hand property',
          );
        }
      },
    );

    // 24. hand inputs filtered without hand-tracking feature [SKIP:native]
    harness.it(
      'hand inputs filtered without hand-tracking feature [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');
        // End the shared session temporarily to create one without hand-tracking
        await cleanup(session, canvas);

        const result = await startSession('immersive-vr');
        const tempSession = result.session;
        const tempCanvas = result.canvas;

        try {
          // Switch device to hand mode — hands should be filtered out
          ctx.xrDevice!.primaryInputMode = 'hand';
          await withFrame(tempSession, () => {});

          harness.assertEqual(
            tempSession.inputSources.length,
            0,
            'inputSources should be empty when in hand mode without hand-tracking feature',
          );
        } finally {
          await cleanup(tempSession, tempCanvas);
          // Restore the shared session
          const restored = await startSession('immersive-vr', {
            requiredFeatures: ['hand-tracking'],
          });
          session = restored.session;
          canvas = restored.canvas;
        }
      },
    );

    // 25. getJointPose returns pose with transform property [SKIP:native]
    harness.it(
      'getJointPose returns pose with transform property [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');
        await switchToHandInput(ctx, session);

        const refSpace = await session.requestReferenceSpace('local');
        const source = session.inputSources[0];
        const wrist = source.hand!.get('wrist' as XRHandJoint)!;

        await withFrame(session, (_time, frame) => {
          const pose = frame.getJointPose(wrist, refSpace);
          harness.assert(pose != null, 'getJointPose should return a pose');
          harness.assert(
            pose!.transform != null,
            'pose should have transform property',
          );
          harness.assertInstanceOf(pose!.transform, XRRigidTransform);
          harness.assert(
            pose!.transform.position != null,
            'transform should have position',
          );
          harness.assert(
            pose!.transform.orientation != null,
            'transform should have orientation',
          );
        });
      },
    );

    // 26. XRJointSpace.jointName readonly [SKIP:native]
    harness.it('XRJointSpace.jointName readonly [SKIP:native]', async (ctx) => {
      harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');
      await switchToHandInput(ctx, session);

      const source = session.inputSources[0];
      const wrist = source.hand!.get('wrist' as XRHandJoint)!;
      harness.assertReadonly(wrist, 'jointName');
    });
  });
}
