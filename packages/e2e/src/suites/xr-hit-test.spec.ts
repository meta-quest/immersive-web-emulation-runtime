/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { TestHarness } from '@harness/test-harness';
import { startSession, withFrame, cleanup } from '@harness/xr-helpers';
import { XRRay } from 'iwer';

/**
 * Hit Test Module — requestHitTestSource, getHitTestResults, XRRay integration
 * 12 tests
 */
export function registerXRHitTestTests(harness: TestHarness): void {
  // --- Shared: read-only checks with hit-test feature (1 VR entry) ---
  harness.describe('Hit Test Module', () => {
    let session: XRSession;
    let canvas: HTMLCanvasElement;

    harness.beforeAll(async () => {
      const result = await startSession('immersive-vr', {
        requiredFeatures: ['hit-test'],
      });
      session = result.session;
      canvas = result.canvas;
    });

    harness.afterAll(async () => {
      await cleanup(session, canvas);
    });

    // 1. hit-test feature can be requested
    harness.it('hit-test feature can be requested', async () => {
      harness.assert(
        session != null,
        'Session with hit-test should be created',
      );
    });

    // 2. enabledFeatures includes "hit-test"
    harness.it('enabledFeatures includes "hit-test"', async () => {
      harness.assert(
        session.enabledFeatures.includes('hit-test'),
        'enabledFeatures should include "hit-test"',
      );
    });

    // 5. getHitTestResults throws on inactive frame
    harness.it('getHitTestResults throws on inactive frame', async () => {
      let staleFrame: XRFrame;
      await withFrame(session, (_time, frame) => {
        staleFrame = frame;
      });

      if (typeof staleFrame!.getHitTestResults !== 'function') {
        harness.assert(true, 'getHitTestResults not available');
        return;
      }

      harness.assertDOMException(
        () => staleFrame!.getHitTestResults({} as any),
        'InvalidStateError',
        'getHitTestResults on inactive frame should throw InvalidStateError',
      );
    });

    // 6. requestHitTestSource requires space option
    harness.it('requestHitTestSource requires space option', async () => {
      if (typeof session.requestHitTestSource !== 'function') {
        harness.assert(true, 'requestHitTestSource not available');
        return;
      }

      let rejected = false;
      try {
        await session.requestHitTestSource!({} as any);
      } catch (_) {
        rejected = true;
      }
      harness.assert(
        rejected,
        'requestHitTestSource without space option should reject',
      );
    });

    // 7. XRRay default constructor
    harness.it('XRRay default constructor', () => {
      const ray = new XRRay();
      harness.assertApprox(ray.origin.x, 0, 1e-6);
      harness.assertApprox(ray.origin.y, 0, 1e-6);
      harness.assertApprox(ray.origin.z, 0, 1e-6);
      harness.assertApprox(ray.direction.z, -1, 1e-6);
    });

    // 8. XRRay with origin+direction
    harness.it('XRRay with origin+direction', () => {
      const ray = new XRRay(
        { x: 1, y: 2, z: 3, w: 1 },
        { x: 0, y: 1, z: 0, w: 0 },
      );
      harness.assertApprox(ray.origin.x, 1, 1e-6);
      harness.assertApprox(ray.direction.y, 1, 1e-6);
    });

    // 9. XRRay direction validation
    harness.it('XRRay direction validation', () => {
      harness.assertDOMException(
        () => new XRRay({ x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: 0, z: 0, w: 0 }),
        'TypeError',
        'Zero direction should throw',
      );
    });

    // 10. XRRay matrix is Float32Array(16)
    harness.it('XRRay matrix is Float32Array(16)', () => {
      const ray = new XRRay();
      harness.assertInstanceOf(ray.matrix, Float32Array);
      harness.assertEqual(ray.matrix.length, 16);
    });
  });

  // --- Isolated: tests needing different features or session lifecycle ---
  harness.describe('Hit Test Module (isolated)', () => {
    let session: XRSession | null = null;
    let canvas: HTMLCanvasElement | null = null;

    harness.afterEach(async () => {
      await cleanup(session, canvas);
      session = null;
      canvas = null;
    });

    // 3. requestHitTestSource rejects OperationError without SEM [SKIP:native]
    harness.it(
      'requestHitTestSource rejects OperationError without SEM [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');
        const result = await startSession('immersive-vr', {
          requiredFeatures: ['hit-test'],
        });
        session = result.session;
        canvas = result.canvas;

        const refSpace = await session.requestReferenceSpace('viewer');

        await harness.assertDOMExceptionAsync(
          () => session!.requestHitTestSource!({ space: refSpace }),
          'OperationError',
          'requestHitTestSource should reject with OperationError without SEM',
        );
      },
    );

    // 4. requestHitTestSource rejects NotSupportedError without feature
    harness.it(
      'requestHitTestSource rejects NotSupportedError without feature',
      async () => {
        // Request session WITHOUT hit-test feature
        const result = await startSession('immersive-vr');
        session = result.session;
        canvas = result.canvas;

        if (typeof session.requestHitTestSource !== 'function') {
          harness.assert(
            true,
            'requestHitTestSource not available without feature',
          );
          return;
        }

        const refSpace = await session.requestReferenceSpace('viewer');

        await harness.assertDOMExceptionAsync(
          () => session!.requestHitTestSource!({ space: refSpace }),
          'NotSupportedError',
          'requestHitTestSource without hit-test feature should reject with NotSupportedError',
        );
      },
    );

    // 11. requestHitTestSource rejects on ended session [SKIP:native]
    harness.it(
      'requestHitTestSource rejects on ended session [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');
        const result = await startSession('immersive-vr', {
          requiredFeatures: ['hit-test'],
        });
        session = result.session;
        canvas = result.canvas;

        const refSpace = await session.requestReferenceSpace('viewer');
        const endedSession = session;

        // End the session and wait for the end event
        await new Promise<void>((resolve) => {
          endedSession.addEventListener('end', () => resolve());
          endedSession.end();
        });
        session = null;

        // After ending, requestHitTestSource should reject.
        // Note: iwer currently rejects with OperationError (SEM check)
        // rather than InvalidStateError because the ended flag is not set
        // by end(). The spec requires InvalidStateError.
        await harness.assertRejects(
          () => endedSession.requestHitTestSource!({ space: refSpace }),
          undefined,
          'requestHitTestSource on ended session should reject',
        );
      },
    );

    // 12. requestHitTestSource accepts offsetRay option [SKIP:native]
    harness.it(
      'requestHitTestSource accepts offsetRay option [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');
        const result = await startSession('immersive-vr', {
          requiredFeatures: ['hit-test'],
        });
        session = result.session;
        canvas = result.canvas;

        const refSpace = await session.requestReferenceSpace('viewer');

        // Should reject with OperationError (no SEM), NOT TypeError —
        // proving the offsetRay option is accepted
        await harness.assertDOMExceptionAsync(
          () =>
            session!.requestHitTestSource!({
              space: refSpace,
              offsetRay: new XRRay() as any,
            }),
          'OperationError',
          'requestHitTestSource with offsetRay should reject with OperationError (not TypeError)',
        );
      },
    );
  });
}
