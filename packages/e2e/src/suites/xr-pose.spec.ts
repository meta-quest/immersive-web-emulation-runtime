/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { TestHarness } from '@harness/test-harness';
import { startSession, withFrame, cleanup } from '@harness/xr-helpers';

/**
 * §9 XRPose / XRViewerPose — transform, emulatedPosition, views, frozen array
 * 13 tests
 */
export function registerXRPoseTests(harness: TestHarness): void {
  harness.describe('§9 XRPose / XRViewerPose', () => {
    let session: XRSession;
    let canvas: HTMLCanvasElement;

    harness.beforeAll(async () => {
      const result = await startSession('immersive-vr');
      session = result.session;
      canvas = result.canvas;
    });

    harness.afterAll(async () => {
      await cleanup(session, canvas);
    });

    // 1. XRPose.transform is XRRigidTransform
    harness.it('XRPose.transform is XRRigidTransform', async () => {
      const refSpace = await session.requestReferenceSpace('local');
      const viewerSpace = await session.requestReferenceSpace('viewer');

      await withFrame(session, (_time, frame) => {
        const pose = frame.getPose(viewerSpace, refSpace);
        harness.assert(pose != null, 'Pose should exist');
        harness.assertInstanceOf(pose!.transform, XRRigidTransform);
      });
    });

    // 2. XRPose.emulatedPosition is boolean
    harness.it('XRPose.emulatedPosition is boolean', async () => {
      const refSpace = await session.requestReferenceSpace('local');
      const viewerSpace = await session.requestReferenceSpace('viewer');

      await withFrame(session, (_time, frame) => {
        const pose = frame.getPose(viewerSpace, refSpace);
        harness.assertType(pose!.emulatedPosition, 'boolean');
      });
    });

    // 3. XRPose.linearVelocity is undefined (iwer)
    harness.it('XRPose.linearVelocity is undefined (iwer)', async () => {
      const refSpace = await session.requestReferenceSpace('local');
      const viewerSpace = await session.requestReferenceSpace('viewer');

      await withFrame(session, (_time, frame) => {
        const pose = frame.getPose(viewerSpace, refSpace);
        harness.assert(
          pose!.linearVelocity === undefined || pose!.linearVelocity === null,
          'linearVelocity should be undefined or null',
        );
      });
    });

    // 4. XRPose.angularVelocity is undefined (iwer)
    harness.it('XRPose.angularVelocity is undefined (iwer)', async () => {
      const refSpace = await session.requestReferenceSpace('local');
      const viewerSpace = await session.requestReferenceSpace('viewer');

      await withFrame(session, (_time, frame) => {
        const pose = frame.getPose(viewerSpace, refSpace);
        harness.assert(
          pose!.angularVelocity === undefined || pose!.angularVelocity === null,
          'angularVelocity should be undefined or null',
        );
      });
    });

    // 5. XRPose.transform readonly
    harness.it('XRPose.transform readonly', async () => {
      const refSpace = await session.requestReferenceSpace('local');
      const viewerSpace = await session.requestReferenceSpace('viewer');

      await withFrame(session, (_time, frame) => {
        const pose = frame.getPose(viewerSpace, refSpace)!;
        harness.assertReadonly(pose, 'transform');
      });
    });

    // 6. XRPose.emulatedPosition readonly
    harness.it('XRPose.emulatedPosition readonly', async () => {
      const refSpace = await session.requestReferenceSpace('local');
      const viewerSpace = await session.requestReferenceSpace('viewer');

      await withFrame(session, (_time, frame) => {
        const pose = frame.getPose(viewerSpace, refSpace)!;
        harness.assertReadonly(pose, 'emulatedPosition');
      });
    });

    // 7. XRViewerPose extends XRPose
    harness.it('XRViewerPose extends XRPose', async () => {
      const refSpace = await session.requestReferenceSpace('local');

      await withFrame(session, (_time, frame) => {
        const pose = frame.getViewerPose(refSpace)!;
        harness.assertInstanceOf(pose, XRViewerPose);
        harness.assertInstanceOf(pose, XRPose);
      });
    });

    // 8. views is array
    harness.it('views is array', async () => {
      const refSpace = await session.requestReferenceSpace('local');

      await withFrame(session, (_time, frame) => {
        const pose = frame.getViewerPose(refSpace)!;
        harness.assert(Array.isArray(pose.views), 'views should be array-like');
      });
    });

    // 9. views is frozen
    harness.it('views is frozen', async () => {
      const refSpace = await session.requestReferenceSpace('local');

      await withFrame(session, (_time, frame) => {
        const pose = frame.getViewerPose(refSpace)!;
        harness.assertFrozen(pose.views);
      });
    });

    // 10. views contains XRView instances
    harness.it('views contains XRView instances', async () => {
      const refSpace = await session.requestReferenceSpace('local');

      await withFrame(session, (_time, frame) => {
        const pose = frame.getViewerPose(refSpace)!;
        for (const view of pose.views) {
          harness.assertInstanceOf(view, XRView);
        }
      });
    });

    // 11. views length = 2 for immersive-vr
    harness.it('views length = 2 for immersive-vr', async () => {
      const refSpace = await session.requestReferenceSpace('local');

      await withFrame(session, (_time, frame) => {
        const pose = frame.getViewerPose(refSpace)!;
        harness.assertEqual(pose.views.length, 2, 'Should have 2 views');
      });
    });

    // 12. XRViewerPose.transform is XRRigidTransform
    harness.it('XRViewerPose.transform is XRRigidTransform', async () => {
      const refSpace = await session.requestReferenceSpace('local');

      await withFrame(session, (_time, frame) => {
        const pose = frame.getViewerPose(refSpace)!;
        harness.assertInstanceOf(pose.transform, XRRigidTransform);
      });
    });

    // 13. views readonly
    harness.it('views readonly', async () => {
      const refSpace = await session.requestReferenceSpace('local');

      await withFrame(session, (_time, frame) => {
        const pose = frame.getViewerPose(refSpace)!;
        harness.assertReadonly(pose, 'views');
      });
    });
  });
}
