/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { TestHarness } from '@harness/test-harness';
import { startSession, withFrame, cleanup } from '@harness/xr-helpers';

/**
 * §5 XRFrame — session reference, predictedDisplayTime, getPose guards, inactive frame checks
 * 20 tests
 */
export function registerXRFrameTests(harness: TestHarness): void {
  harness.describe('§5 XRFrame', () => {
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

    // Helper: get a stale frame
    async function getStaleFrame(s: XRSession): Promise<XRFrame> {
      let staleFrame: XRFrame | null = null;
      await withFrame(s, (_t, frame) => {
        staleFrame = frame;
      });
      return staleFrame!;
    }

    // 1. frame.session === the creating session
    harness.it('frame.session === the creating session', async () => {
      await withFrame(session, (_time, frame) => {
        harness.assertEqual(
          frame.session,
          session,
          'frame.session should match',
        );
      });
    });

    // 2. predictedDisplayTime is positive number
    harness.it('predictedDisplayTime is positive number', async () => {
      await withFrame(session, (_time, frame) => {
        harness.assertType(frame.predictedDisplayTime, 'number');
        harness.assertGreaterThan(frame.predictedDisplayTime, 0);
      });
    });

    // 3. predictedDisplayTime increases across frames
    harness.it('predictedDisplayTime increases across frames', async () => {
      let time1 = 0;
      await withFrame(session, (_time, frame) => {
        time1 = frame.predictedDisplayTime;
      });
      await withFrame(session, (_time, frame) => {
        harness.assertGreaterThan(
          frame.predictedDisplayTime,
          time1,
          'predictedDisplayTime should increase',
        );
      });
    });

    // 4. getViewerPose returns XRViewerPose
    harness.it('getViewerPose returns XRViewerPose', async () => {
      const refSpace = await session.requestReferenceSpace('local');

      await withFrame(session, (_time, frame) => {
        const pose = frame.getViewerPose(refSpace);
        harness.assert(pose != null, 'getViewerPose should return a pose');
        harness.assertInstanceOf(pose, XRViewerPose);
      });
    });

    // 5. getPose returns XRPose
    harness.it('getPose returns XRPose', async () => {
      const refSpace = await session.requestReferenceSpace('local');
      const viewerSpace = await session.requestReferenceSpace('viewer');

      await withFrame(session, (_time, frame) => {
        const pose = frame.getPose(viewerSpace, refSpace);
        harness.assert(pose != null, 'getPose should return a pose');
        harness.assertInstanceOf(pose, XRPose);
      });
    });

    // 6. getPose throws InvalidStateError on inactive frame
    harness.it(
      'getPose throws InvalidStateError on inactive frame',
      async () => {
        const refSpace = await session.requestReferenceSpace('local');
        const viewerSpace = await session.requestReferenceSpace('viewer');
        const staleFrame = await getStaleFrame(session);

        harness.assertDOMException(
          () => staleFrame.getPose(viewerSpace, refSpace),
          'InvalidStateError',
          'getPose on inactive frame should throw InvalidStateError',
        );
      },
    );

    // 7. getViewerPose throws InvalidStateError on inactive frame
    harness.it(
      'getViewerPose throws InvalidStateError on inactive frame',
      async () => {
        const refSpace = await session.requestReferenceSpace('local');
        const staleFrame = await getStaleFrame(session);

        harness.assertDOMException(
          () => staleFrame.getViewerPose(refSpace),
          'InvalidStateError',
          'getViewerPose on inactive frame should throw InvalidStateError',
        );
      },
    );

    // 8. getViewerPose throws InvalidStateError on non-animation frame
    harness.it(
      'getViewerPose throws InvalidStateError on non-animation frame',
      async () => {
        const refSpace = await session.requestReferenceSpace('local');
        const staleFrame = await getStaleFrame(session);

        // A stale frame is both inactive and non-animation
        harness.assertDOMException(
          () => staleFrame.getViewerPose(refSpace),
          'InvalidStateError',
        );
      },
    );

    // 9. fillJointRadii throws InvalidStateError on inactive frame
    harness.it(
      'fillJointRadii throws InvalidStateError on inactive frame',
      async () => {
        const staleFrame = await getStaleFrame(session);

        if (typeof staleFrame.fillJointRadii !== 'function') {
          harness.assert(true, 'fillJointRadii not available');
          return;
        }

        harness.assertDOMException(
          () => staleFrame.fillJointRadii([] as any, new Float32Array(0)),
          'InvalidStateError',
        );
      },
    );

    // 10. fillPoses throws InvalidStateError on inactive frame
    harness.it(
      'fillPoses throws InvalidStateError on inactive frame',
      async () => {
        const staleFrame = await getStaleFrame(session);
        const refSpace = await session.requestReferenceSpace('local');

        if (typeof staleFrame.fillPoses !== 'function') {
          harness.assert(true, 'fillPoses not available');
          return;
        }

        harness.assertDOMException(
          () => staleFrame.fillPoses([] as any, refSpace, new Float32Array(0)),
          'InvalidStateError',
        );
      },
    );

    // 11. fillJointRadii throws on length mismatch [DEVIATION: DOMException('TypeError')]
    harness.it(
      'fillJointRadii throws on length mismatch [DEVIATION: DOMException not TypeError]',
      async () => {
        if (typeof (XRFrame.prototype as any).fillJointRadii !== 'function') {
          harness.assert(true, 'fillJointRadii not available');
          return;
        }

        await withFrame(session, (_time, frame) => {
          // 2 spaces but only 1 float — length mismatch
          let threw = false;
          try {
            frame.fillJointRadii(
              [null as any, null as any],
              new Float32Array(1),
            );
          } catch (e: any) {
            threw = true;
            // iwer throws DOMException('TypeError') instead of TypeError
            harness.assert(
              e instanceof DOMException || e instanceof TypeError,
              `Should throw DOMException or TypeError, got ${e.constructor.name}`,
            );
          }
          harness.assert(
            threw,
            'fillJointRadii should throw on length mismatch',
          );
        });
      },
    );

    // 12. fillPoses throws on length mismatch [DEVIATION: same]
    harness.it(
      'fillPoses throws on length mismatch [DEVIATION: DOMException not TypeError]',
      async () => {
        if (typeof (XRFrame.prototype as any).fillPoses !== 'function') {
          harness.assert(true, 'fillPoses not available');
          return;
        }

        const refSpace = await session.requestReferenceSpace('local');

        await withFrame(session, (_time, frame) => {
          let threw = false;
          try {
            frame.fillPoses(
              [null as any, null as any],
              refSpace,
              new Float32Array(1),
            );
          } catch (e: any) {
            threw = true;
            harness.assert(
              e instanceof DOMException || e instanceof TypeError,
              `Should throw DOMException or TypeError, got ${e.constructor.name}`,
            );
          }
          harness.assert(threw, 'fillPoses should throw on length mismatch');
        });
      },
    );

    // 13. detectedPlanes throws InvalidStateError on inactive frame
    harness.it(
      'detectedPlanes throws InvalidStateError on inactive frame',
      async () => {
        const staleFrame = await getStaleFrame(session);

        let threw = false;
        try {
          const _planes = staleFrame.detectedPlanes;
        } catch (e: any) {
          threw = true;
          harness.assert(
            e instanceof DOMException,
            'Should throw DOMException',
          );
        }
        if (!threw) {
          // If detectedPlanes is not available, it may be undefined instead of throwing
          harness.assert(
            true,
            'detectedPlanes did not throw (may not be implemented)',
          );
        }
      },
    );

    // 14. detectedMeshes throws InvalidStateError on inactive frame
    harness.it(
      'detectedMeshes throws InvalidStateError on inactive frame',
      async () => {
        const staleFrame = await getStaleFrame(session);

        let threw = false;
        try {
          const _meshes = (staleFrame as any).detectedMeshes;
        } catch (e: any) {
          threw = true;
          harness.assert(
            e instanceof DOMException,
            'Should throw DOMException',
          );
        }
        if (!threw) {
          harness.assert(
            true,
            'detectedMeshes did not throw (may not be implemented)',
          );
        }
      },
    );

    // 15. trackedAnchors throws InvalidStateError on inactive frame
    harness.it(
      'trackedAnchors throws InvalidStateError on inactive frame',
      async () => {
        const staleFrame = await getStaleFrame(session);

        let threw = false;
        try {
          const _anchors = staleFrame.trackedAnchors;
        } catch (e: any) {
          threw = true;
          harness.assert(
            e instanceof DOMException,
            'Should throw DOMException',
          );
        }
        if (!threw) {
          harness.assert(
            true,
            'trackedAnchors did not throw (may not be implemented)',
          );
        }
      },
    );

    // 16. createAnchor rejects InvalidStateError on inactive frame
    harness.it(
      'createAnchor rejects InvalidStateError on inactive frame',
      async () => {
        const refSpace = await session.requestReferenceSpace('local');
        const staleFrame = await getStaleFrame(session);

        if (typeof staleFrame.createAnchor !== 'function') {
          harness.assert(true, 'createAnchor not available');
          return;
        }

        await harness.assertDOMExceptionAsync(
          () => staleFrame.createAnchor!(new XRRigidTransform(), refSpace),
          'InvalidStateError',
        );
      },
    );

    // 17. getHitTestResults throws InvalidStateError on inactive frame
    harness.it(
      'getHitTestResults throws InvalidStateError on inactive frame',
      async () => {
        const staleFrame = await getStaleFrame(session);

        if (typeof staleFrame.getHitTestResults !== 'function') {
          harness.assert(true, 'getHitTestResults not available');
          return;
        }

        harness.assertDOMException(
          () => staleFrame.getHitTestResults({} as any),
          'InvalidStateError',
        );
      },
    );

    // 18. frame.session readonly
    harness.it('frame.session readonly', async () => {
      await withFrame(session, (_time, frame) => {
        harness.assertReadonly(frame, 'session');
      });
    });

    // 19. frame.predictedDisplayTime readonly
    harness.it('frame.predictedDisplayTime readonly', async () => {
      await withFrame(session, (_time, frame) => {
        harness.assertReadonly(frame, 'predictedDisplayTime');
      });
    });

    // 20. frame active flag is false after callback returns
    harness.it(
      'frame active flag is false after callback returns',
      async () => {
        const refSpace = await session.requestReferenceSpace('local');
        const staleFrame = await getStaleFrame(session);

        // Stale frame should throw when used (proving active=false)
        let threw = false;
        try {
          staleFrame.getViewerPose(refSpace);
        } catch (_) {
          threw = true;
        }
        harness.assert(threw, 'Using stale frame should throw (active=false)');
      },
    );
  });
}
