/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { TestHarness } from '@harness/test-harness';
import { startSession, cleanup } from '@harness/xr-helpers';

/**
 * §6.3 XRBoundedReferenceSpace — boundsGeometry
 * 3 tests
 */
export function registerXRBoundedRefSpaceTests(harness: TestHarness): void {
  harness.describe('§6.3 XRBoundedReferenceSpace', () => {
    let session: XRSession;
    let canvas: HTMLCanvasElement;

    harness.beforeAll(async () => {
      const result = await startSession('immersive-vr', {
        requiredFeatures: ['bounded-floor'],
      });
      session = result.session;
      canvas = result.canvas;
    });

    harness.afterAll(async () => {
      await cleanup(session, canvas);
    });

    // 1. bounded-floor space is requestable
    harness.it('bounded-floor space is requestable', async () => {
      const space = await session.requestReferenceSpace('bounded-floor');
      harness.assert(space != null, 'bounded-floor space should be created');
    });

    // 2. boundsGeometry property [DEVIATION: not implemented]
    harness.it(
      'boundsGeometry property [DEVIATION: not implemented]',
      async () => {
        const space = await session.requestReferenceSpace('bounded-floor');
        harness.skipIf(
          !('boundsGeometry' in space),
          'boundsGeometry not implemented in iwer',
        );
        const bounds = (space as any).boundsGeometry;
        harness.assert(
          Array.isArray(bounds) ||
            (bounds && typeof bounds[Symbol.iterator] === 'function'),
          'boundsGeometry should be iterable',
        );
      },
    );

    // 3. boundsGeometry items are DOMPointReadOnly [DEVIATION: not implemented]
    harness.it(
      'boundsGeometry items are DOMPointReadOnly [DEVIATION: not implemented]',
      async () => {
        const space = await session.requestReferenceSpace('bounded-floor');
        harness.skipIf(
          !('boundsGeometry' in space),
          'boundsGeometry not implemented in iwer',
        );
        const bounds = (space as any).boundsGeometry;
        for (const point of bounds) {
          harness.assertInstanceOf(point, DOMPointReadOnly);
        }
      },
    );
  });
}
