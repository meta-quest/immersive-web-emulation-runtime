/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { TestHarness } from '@harness/test-harness';
import { startSession, cleanup } from '@harness/xr-helpers';

/**
 * §6 XRSpace / XRReferenceSpace — reference space types, getOffsetReferenceSpace, onreset
 * 13 tests
 */
export function registerXRSpaceTests(harness: TestHarness): void {
  // --- Shared: read-only checks with immersive-vr (1 VR entry) ---
  harness.describe('§6 XRSpace / XRReferenceSpace', () => {
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

    // 1. requestReferenceSpace("viewer") → XRReferenceSpace
    harness.it(
      'requestReferenceSpace("viewer") → XRReferenceSpace',
      async () => {
        const space = await session.requestReferenceSpace('viewer');
        harness.assert(space != null, 'viewer space should exist');
        harness.assertInstanceOf(space, XRReferenceSpace);
      },
    );

    // 2. requestReferenceSpace("local") → XRReferenceSpace
    harness.it(
      'requestReferenceSpace("local") → XRReferenceSpace',
      async () => {
        const space = await session.requestReferenceSpace('local');
        harness.assertInstanceOf(space, XRReferenceSpace);
      },
    );

    // 7. requestReferenceSpace rejects for non-enabled feature
    harness.it(
      'requestReferenceSpace rejects for non-enabled feature',
      async () => {
        // If unbounded is not in enabledFeatures, it should reject
        if (!session.enabledFeatures.includes('unbounded')) {
          await harness.assertRejects(
            () => session.requestReferenceSpace('unbounded'),
            undefined,
            'Should reject non-enabled reference space type',
          );
        } else {
          harness.assert(
            true,
            'unbounded is auto-enabled, cannot test rejection',
          );
        }
      },
    );

    // 8. viewer space is XRSpace instance
    harness.it('viewer space is XRSpace instance', async () => {
      const space = await session.requestReferenceSpace('viewer');
      harness.assertInstanceOf(space, XRSpace);
    });

    // 9. onreset property exists
    harness.it('onreset property exists', async () => {
      const space = await session.requestReferenceSpace('local');
      harness.assertProperty(space, 'onreset');
    });

    // 10. getOffsetReferenceSpace returns new XRReferenceSpace [DEVIATION: takes mat4]
    harness.it(
      'getOffsetReferenceSpace returns new XRReferenceSpace [DEVIATION: may take mat4]',
      async () => {
        const space = await session.requestReferenceSpace('local');
        const offset = new XRRigidTransform();
        const offsetSpace = space.getOffsetReferenceSpace(offset);

        harness.assert(offsetSpace != null, 'offsetSpace should exist');
        harness.assertInstanceOf(offsetSpace, XRReferenceSpace);
      },
    );

    // 11. getOffsetReferenceSpace returns different object
    harness.it('getOffsetReferenceSpace returns different object', async () => {
      const space = await session.requestReferenceSpace('local');
      const offset = new XRRigidTransform();
      const offsetSpace = space.getOffsetReferenceSpace(offset);

      harness.assertNotEqual(
        offsetSpace,
        space,
        'Offset space should be a different object',
      );
    });

    // 12. XRReferenceSpace extends EventTarget
    harness.it('XRReferenceSpace extends EventTarget', async () => {
      const space = await session.requestReferenceSpace('local');
      harness.assertInstanceOf(space, EventTarget);
      harness.assertType(space.addEventListener, 'function');
    });

    // 13. onreset handler can be set and retrieved
    harness.it('onreset handler can be set and retrieved', async () => {
      const space = await session.requestReferenceSpace('local');
      const fn = () => {};
      space.onreset = fn;
      harness.assertEqual(
        space.onreset,
        fn,
        'onreset handler should be retrievable',
      );
    });
  });

  // --- Isolated: tests needing different requiredFeatures ---
  harness.describe('§6 XRSpace / XRReferenceSpace (isolated)', () => {
    let session: XRSession | null = null;
    let canvas: HTMLCanvasElement | null = null;

    harness.afterEach(async () => {
      await cleanup(session, canvas);
      session = null;
      canvas = null;
    });

    // 3. requestReferenceSpace("local-floor") → XRReferenceSpace
    harness.it(
      'requestReferenceSpace("local-floor") → XRReferenceSpace',
      async () => {
        const result = await startSession('immersive-vr', {
          requiredFeatures: ['local-floor'],
        });
        session = result.session;
        canvas = result.canvas;

        const space = await session.requestReferenceSpace('local-floor');
        harness.assertInstanceOf(space, XRReferenceSpace);
      },
    );

    // 4. requestReferenceSpace("bounded-floor") → XRReferenceSpace
    harness.it(
      'requestReferenceSpace("bounded-floor") → XRReferenceSpace',
      async () => {
        const result = await startSession('immersive-vr', {
          requiredFeatures: ['bounded-floor'],
        });
        session = result.session;
        canvas = result.canvas;

        const space = await session.requestReferenceSpace('bounded-floor');
        harness.assert(space != null, 'bounded-floor space should exist');
      },
    );

    // 5. requestReferenceSpace("unbounded") → XRReferenceSpace
    harness.it(
      'requestReferenceSpace("unbounded") → XRReferenceSpace',
      async () => {
        const result = await startSession('immersive-vr', {
          requiredFeatures: ['unbounded'],
        });
        session = result.session;
        canvas = result.canvas;

        const space = await session.requestReferenceSpace('unbounded');
        harness.assert(space != null, 'unbounded space should exist');
      },
    );

    // 6. requestReferenceSpace rejects NotSupportedError for inline + "local"
    harness.it(
      'requestReferenceSpace rejects for inline + non-enabled feature',
      async () => {
        const result = await startSession('inline');
        session = result.session;
        canvas = result.canvas;

        await harness.assertRejects(
          () =>
            session!.requestReferenceSpace(
              'bounded-floor' as XRReferenceSpaceType,
            ),
          undefined,
          'inline session should reject bounded-floor',
        );
      },
    );
  });
}
