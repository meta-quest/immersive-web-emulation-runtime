/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { TestHarness } from '@harness/test-harness';
import { startSession, withFrame, cleanup } from '@harness/xr-helpers';
import { XRPlane } from 'iwer';

/**
 * Plane Detection Module — detectedPlanes, XRPlane shape
 * 12 tests
 */
export function registerXRPlanesTests(harness: TestHarness): void {
  harness.describe('Plane Detection Module', () => {
    let session: XRSession;
    let canvas: HTMLCanvasElement;

    harness.beforeAll(async () => {
      const result = await startSession('immersive-vr', {
        requiredFeatures: ['plane-detection'],
      });
      session = result.session;
      canvas = result.canvas;
    });

    harness.afterAll(async () => {
      await cleanup(session, canvas);
    });

    // 1. plane-detection feature can be requested
    harness.it('plane-detection feature can be requested', async () => {
      harness.assert(
        session != null,
        'Session with plane-detection should be created',
      );
    });

    // 2. enabledFeatures includes "plane-detection"
    harness.it('enabledFeatures includes "plane-detection"', async () => {
      harness.assert(
        session.enabledFeatures.includes('plane-detection'),
        'enabledFeatures should include "plane-detection"',
      );
    });

    // 3. detectedPlanes is accessible inside frame
    harness.it('detectedPlanes is accessible inside frame', async () => {
      await withFrame(session, (_time, frame) => {
        harness.assert(
          frame.detectedPlanes != null,
          'detectedPlanes should be accessible inside active frame',
        );
      });
    });

    // 4. detectedPlanes is Set-like
    harness.it('detectedPlanes is Set-like', async () => {
      await withFrame(session, (_time, frame) => {
        const planes = frame.detectedPlanes;
        harness.assertType(planes.has, 'function');
        harness.assertType(planes.forEach, 'function');
        harness.assertType(planes[Symbol.iterator], 'function');
        harness.assertProperty(planes, 'size');
      });
    });

    // 5. detectedPlanes is empty without SEM [SKIP:native]
    harness.it(
      'detectedPlanes is empty without SEM [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');

        await withFrame(session, (_time, frame) => {
          harness.assertEqual(
            frame.detectedPlanes.size,
            0,
            'detectedPlanes should be empty without SEM',
          );
        });
      },
    );

    // 6. detectedPlanes throws on inactive frame
    harness.it('detectedPlanes throws on inactive frame', async () => {
      let staleFrame: XRFrame;
      await withFrame(session, (_time, frame) => {
        staleFrame = frame;
      });

      harness.assertDOMException(
        () => {
          const _planes = staleFrame!.detectedPlanes;
        },
        'InvalidStateError',
        'detectedPlanes on inactive frame should throw InvalidStateError',
      );
    });

    // 7. XRPlane has planeSpace property
    harness.it('XRPlane has planeSpace property', () => {
      harness.assertProperty(XRPlane.prototype, 'planeSpace');
    });

    // 8. XRPlane has polygon property
    harness.it('XRPlane has polygon property', () => {
      harness.assertProperty(XRPlane.prototype, 'polygon');
    });

    // 9. XRPlane has orientation property
    harness.it('XRPlane has orientation property', () => {
      harness.assertProperty(XRPlane.prototype, 'orientation');
    });

    // 10. XRPlane has lastChangedTime property
    harness.it('XRPlane has lastChangedTime property', () => {
      harness.assertProperty(XRPlane.prototype, 'lastChangedTime');
    });

    // 11. XRPlane has semanticLabel property
    harness.it('XRPlane has semanticLabel property', () => {
      harness.assertProperty(XRPlane.prototype, 'semanticLabel');
    });

    // 12. detectedPlanes accessible without plane-detection feature (empty set) [SKIP:native]
    harness.it(
      'detectedPlanes accessible without plane-detection feature (empty set) [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');
        // End shared session to create one without plane-detection
        await cleanup(session, canvas);

        const result = await startSession('immersive-vr');
        const tempSession = result.session;
        const tempCanvas = result.canvas;

        try {
          await withFrame(tempSession, (_time, frame) => {
            const planes = frame.detectedPlanes;
            harness.assert(
              planes != null,
              'detectedPlanes should be accessible without feature',
            );
            harness.assertEqual(
              planes.size,
              0,
              'detectedPlanes should be empty without plane-detection feature',
            );
          });
        } finally {
          await cleanup(tempSession, tempCanvas);
          // Restore shared session
          const restored = await startSession('immersive-vr', {
            requiredFeatures: ['plane-detection'],
          });
          session = restored.session;
          canvas = restored.canvas;
        }
      },
    );
  });
}
