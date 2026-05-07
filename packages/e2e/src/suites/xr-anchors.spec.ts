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
  clearPersistentAnchors,
} from '@harness/xr-helpers';

/**
 * Anchors Module — createAnchor, XRAnchor, trackedAnchors, persistent handles
 * 20 tests
 */
export function registerXRAnchorsTests(harness: TestHarness): void {
  harness.describe('Anchors Module', () => {
    let session: XRSession;
    let canvas: HTMLCanvasElement;

    harness.beforeAll(async () => {
      const result = await startSession('immersive-vr', {
        requiredFeatures: ['anchors'],
      });
      session = result.session;
      canvas = result.canvas;
    });

    harness.afterAll(async () => {
      await cleanup(session, canvas);
      clearPersistentAnchors();
    });

    // 1. anchors feature can be requested
    harness.it('anchors feature can be requested', async () => {
      harness.assert(session != null, 'Session with anchors should be created');
    });

    // 2. enabledFeatures includes "anchors"
    harness.it('enabledFeatures includes "anchors"', async () => {
      harness.assert(
        session.enabledFeatures.includes('anchors'),
        'enabledFeatures should include "anchors"',
      );
    });

    // 3. createAnchor returns promise [SKIP:native]
    harness.it('createAnchor returns promise [SKIP:native]', async (ctx) => {
      harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');

      const refSpace = await session.requestReferenceSpace('local');
      let anchorPromise: Promise<XRAnchor> | undefined;

      await withFrame(session, (_time, frame) => {
        anchorPromise = frame.createAnchor!(new XRRigidTransform(), refSpace);
      });

      harness.assert(
        anchorPromise != null,
        'createAnchor should return a value',
      );
      harness.assertType(
        (anchorPromise as any).then,
        'function',
        'createAnchor should return a thenable',
      );

      // Advance frame to resolve the anchor promise
      await withFrame(session, () => {});
      const anchor = await anchorPromise!;
      anchor.delete();
    });

    // 4. created anchor has anchorSpace property [SKIP:native]
    harness.it(
      'created anchor has anchorSpace property [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');

        const refSpace = await session.requestReferenceSpace('local');
        let anchorPromise: Promise<XRAnchor>;

        await withFrame(session, (_time, frame) => {
          anchorPromise = frame.createAnchor!(new XRRigidTransform(), refSpace);
        });
        await withFrame(session, () => {});
        const anchor = await anchorPromise!;

        harness.assertProperty(anchor, 'anchorSpace');
        harness.assert(
          anchor.anchorSpace != null,
          'anchorSpace should not be null',
        );
        anchor.delete();
      },
    );

    // 5. anchorSpace is XRSpace [SKIP:native]
    harness.it('anchorSpace is XRSpace [SKIP:native]', async (ctx) => {
      harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');

      const refSpace = await session.requestReferenceSpace('local');
      let anchorPromise: Promise<XRAnchor>;

      await withFrame(session, (_time, frame) => {
        anchorPromise = frame.createAnchor!(new XRRigidTransform(), refSpace);
      });
      await withFrame(session, () => {});
      const anchor = await anchorPromise!;

      harness.assertInstanceOf(anchor.anchorSpace, XRSpace);
      anchor.delete();
    });

    // 6. anchor.delete() removes from trackedAnchors [SKIP:native]
    harness.it(
      'anchor.delete() removes from trackedAnchors [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');

        const refSpace = await session.requestReferenceSpace('local');
        let anchorPromise: Promise<XRAnchor>;

        await withFrame(session, (_time, frame) => {
          anchorPromise = frame.createAnchor!(new XRRigidTransform(), refSpace);
        });
        await withFrame(session, () => {});
        const anchor = await anchorPromise!;

        // Verify anchor is tracked
        await withFrame(session, (_time, frame) => {
          harness.assert(
            frame.trackedAnchors!.has(anchor),
            'anchor should be in trackedAnchors before delete',
          );
        });

        anchor.delete();

        // After delete, anchor should be removed
        await withFrame(session, (_time, frame) => {
          harness.assert(
            !frame.trackedAnchors!.has(anchor),
            'anchor should not be in trackedAnchors after delete',
          );
        });
      },
    );

    // 7. anchorSpace throws after delete [SKIP:native]
    harness.it('anchorSpace throws after delete [SKIP:native]', async (ctx) => {
      harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');

      const refSpace = await session.requestReferenceSpace('local');
      let anchorPromise: Promise<XRAnchor>;

      await withFrame(session, (_time, frame) => {
        anchorPromise = frame.createAnchor!(new XRRigidTransform(), refSpace);
      });
      await withFrame(session, () => {});
      const anchor = await anchorPromise!;

      anchor.delete();

      harness.assertDOMException(
        () => {
          const _space = anchor.anchorSpace;
        },
        'InvalidStateError',
        'Accessing anchorSpace after delete should throw InvalidStateError',
      );
    });

    // 8. delete() is idempotent [SKIP:native]
    harness.it('delete() is idempotent [SKIP:native]', async (ctx) => {
      harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');

      const refSpace = await session.requestReferenceSpace('local');
      let anchorPromise: Promise<XRAnchor>;

      await withFrame(session, (_time, frame) => {
        anchorPromise = frame.createAnchor!(new XRRigidTransform(), refSpace);
      });
      await withFrame(session, () => {});
      const anchor = await anchorPromise!;

      // Calling delete multiple times should not throw
      anchor.delete();
      anchor.delete();
      anchor.delete();
      harness.assert(true, 'Calling delete() multiple times should not throw');
    });

    // 9. trackedAnchors is Set-like [SKIP:native]
    harness.it('trackedAnchors is Set-like [SKIP:native]', async (ctx) => {
      harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');

      await withFrame(session, (_time, frame) => {
        const anchors = frame.trackedAnchors!;
        harness.assertType(anchors.has, 'function');
        harness.assertType(anchors.forEach, 'function');
        harness.assertType(anchors[Symbol.iterator], 'function');
        harness.assertProperty(anchors, 'size');
      });
    });

    // 10. trackedAnchors contains created anchor [SKIP:native]
    harness.it(
      'trackedAnchors contains created anchor [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');

        const refSpace = await session.requestReferenceSpace('local');
        let anchorPromise: Promise<XRAnchor>;

        await withFrame(session, (_time, frame) => {
          anchorPromise = frame.createAnchor!(new XRRigidTransform(), refSpace);
        });
        await withFrame(session, () => {});
        const anchor = await anchorPromise!;

        await withFrame(session, (_time, frame) => {
          harness.assert(
            frame.trackedAnchors!.has(anchor),
            'trackedAnchors should contain the created anchor',
          );
        });
        anchor.delete();
      },
    );

    // 11. requestPersistentHandle returns string UUID [SKIP:native]
    harness.it(
      'requestPersistentHandle returns string UUID [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');

        const refSpace = await session.requestReferenceSpace('local');
        let anchorPromise: Promise<XRAnchor>;

        await withFrame(session, (_time, frame) => {
          anchorPromise = frame.createAnchor!(new XRRigidTransform(), refSpace);
        });
        await withFrame(session, () => {});
        const anchor = await anchorPromise!;

        const handle = await anchor.requestPersistentHandle!();
        harness.assertType(handle, 'string');
        harness.assertGreaterThan(handle.length, 0);
        anchor.delete();
      },
    );

    // 12. requestPersistentHandle rejects after delete [SKIP:native]
    harness.it(
      'requestPersistentHandle rejects after delete [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');

        const refSpace = await session.requestReferenceSpace('local');
        let anchorPromise: Promise<XRAnchor>;

        await withFrame(session, (_time, frame) => {
          anchorPromise = frame.createAnchor!(new XRRigidTransform(), refSpace);
        });
        await withFrame(session, () => {});
        const anchor = await anchorPromise!;

        anchor.delete();

        await harness.assertDOMExceptionAsync(
          () => anchor.requestPersistentHandle!(),
          'InvalidStateError',
          'requestPersistentHandle after delete should reject with InvalidStateError',
        );
      },
    );

    // 13. createAnchor rejects on inactive frame [SKIP:native]
    harness.it(
      'createAnchor rejects on inactive frame [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');

        const refSpace = await session.requestReferenceSpace('local');
        let staleFrame: XRFrame;

        await withFrame(session, (_time, frame) => {
          staleFrame = frame;
        });

        await harness.assertDOMExceptionAsync(
          () => staleFrame.createAnchor!(new XRRigidTransform(), refSpace),
          'InvalidStateError',
          'createAnchor on inactive frame should reject with InvalidStateError',
        );
      },
    );

    // 14. trackedAnchors throws on inactive frame
    harness.it('trackedAnchors throws on inactive frame', async () => {
      let staleFrame: XRFrame;
      await withFrame(session, (_time, frame) => {
        staleFrame = frame;
      });

      harness.assertDOMException(
        () => {
          const _anchors = staleFrame!.trackedAnchors;
        },
        'InvalidStateError',
        'trackedAnchors on inactive frame should throw InvalidStateError',
      );
    });

    // 15. multiple anchors coexist in trackedAnchors [SKIP:native]
    harness.it(
      'multiple anchors coexist in trackedAnchors [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');

        const refSpace = await session.requestReferenceSpace('local');
        let anchorPromise1: Promise<XRAnchor>;
        let anchorPromise2: Promise<XRAnchor>;

        await withFrame(session, (_time, frame) => {
          anchorPromise1 = frame.createAnchor!(
            new XRRigidTransform(),
            refSpace,
          );
        });
        await withFrame(session, () => {});
        const anchor1 = await anchorPromise1!;

        await withFrame(session, (_time, frame) => {
          anchorPromise2 = frame.createAnchor!(
            new XRRigidTransform(),
            refSpace,
          );
        });
        await withFrame(session, () => {});
        const anchor2 = await anchorPromise2!;

        await withFrame(session, (_time, frame) => {
          harness.assertGreaterThan(
            frame.trackedAnchors!.size,
            1,
            'trackedAnchors should contain at least 2 anchors',
          );
          harness.assert(
            frame.trackedAnchors!.has(anchor1),
            'trackedAnchors should contain anchor1',
          );
          harness.assert(
            frame.trackedAnchors!.has(anchor2),
            'trackedAnchors should contain anchor2',
          );
        });
        anchor1.delete();
        anchor2.delete();
      },
    );

    // 16. anchor pose obtainable via getPose(anchorSpace, refSpace) [SKIP:native]
    harness.it(
      'anchor pose obtainable via getPose(anchorSpace, refSpace) [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');

        const refSpace = await session.requestReferenceSpace('local');
        let anchorPromise: Promise<XRAnchor>;

        await withFrame(session, (_time, frame) => {
          anchorPromise = frame.createAnchor!(new XRRigidTransform(), refSpace);
        });
        await withFrame(session, () => {});
        const anchor = await anchorPromise!;

        await withFrame(session, (_time, frame) => {
          const pose = frame.getPose(anchor.anchorSpace, refSpace);
          harness.assert(
            pose != null,
            'getPose with anchorSpace should return non-null XRPose',
          );
          harness.assertInstanceOf(pose, XRPose);
        });
        anchor.delete();
      },
    );

    // 17. createAnchor with non-identity pose [SKIP:native]
    harness.it(
      'createAnchor with non-identity pose [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');

        const refSpace = await session.requestReferenceSpace('local');
        const pose = new XRRigidTransform({ x: 1, y: 2, z: 3, w: 1 });
        let anchorPromise: Promise<XRAnchor>;

        await withFrame(session, (_time, frame) => {
          anchorPromise = frame.createAnchor!(pose, refSpace);
        });
        await withFrame(session, () => {});
        const anchor = await anchorPromise!;

        harness.assert(
          anchor != null,
          'Anchor created with non-identity pose should resolve',
        );
        harness.assert(
          anchor.anchorSpace != null,
          'Anchor should have anchorSpace',
        );
        anchor.delete();
      },
    );

    // 18. session.persistentAnchors returns array [SKIP:native]
    harness.it(
      'session.persistentAnchors returns array [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');
        clearPersistentAnchors();
        // End shared session to create a fresh one
        await cleanup(session, canvas);

        const result = await startSession('immersive-vr', {
          requiredFeatures: ['anchors'],
        });
        const tempSession = result.session;
        const tempCanvas = result.canvas;

        try {
          const persistentAnchors = await (tempSession as any)
            .persistentAnchors;
          harness.assertArray(
            persistentAnchors,
            'persistentAnchors should return an array',
          );
          harness.assertEqual(
            persistentAnchors.length,
            0,
            'persistentAnchors should be empty initially',
          );
        } finally {
          await cleanup(tempSession, tempCanvas);
          // Restore shared session
          const restored = await startSession('immersive-vr', {
            requiredFeatures: ['anchors'],
          });
          session = restored.session;
          canvas = restored.canvas;
        }
      },
    );

    // 19. persist→restore round-trip [SKIP:native]
    harness.it('persist→restore round-trip [SKIP:native]', async (ctx) => {
      harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');
      clearPersistentAnchors();
      // End shared session for multi-session test
      await cleanup(session, canvas);

      try {
        // First session: create and persist an anchor
        let result = await startSession('immersive-vr', {
          requiredFeatures: ['anchors'],
        });
        let tempSession = result.session;
        let tempCanvas = result.canvas;

        const refSpace = await tempSession.requestReferenceSpace('local');
        let anchorPromise: Promise<XRAnchor>;

        await withFrame(tempSession, (_time, frame) => {
          anchorPromise = frame.createAnchor!(new XRRigidTransform(), refSpace);
        });
        await withFrame(tempSession, () => {});
        const anchor = await anchorPromise!;

        const uuid = await anchor.requestPersistentHandle!();
        harness.assertType(uuid, 'string');
        harness.assertGreaterThan(uuid.length, 0);

        // End the first session
        await cleanup(tempSession, tempCanvas);

        // Second session: restore the anchor
        result = await startSession('immersive-vr', {
          requiredFeatures: ['anchors'],
        });
        tempSession = result.session;
        tempCanvas = result.canvas;

        const restoredAnchor = await (
          tempSession as any
        ).restorePersistentAnchor(uuid);
        await withFrame(tempSession, () => {});

        harness.assert(
          restoredAnchor != null,
          'Restored anchor should not be null',
        );
        harness.assert(
          restoredAnchor.anchorSpace != null,
          'Restored anchor should have anchorSpace',
        );

        await cleanup(tempSession, tempCanvas);
      } finally {
        // Restore shared session
        const restored = await startSession('immersive-vr', {
          requiredFeatures: ['anchors'],
        });
        session = restored.session;
        canvas = restored.canvas;
      }
    });

    // 20. deletePersistentAnchor rejects for unknown UUID [SKIP:native]
    harness.it(
      'deletePersistentAnchor rejects for unknown UUID [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');

        await harness.assertDOMExceptionAsync(
          () =>
            (session as any).deletePersistentAnchor('non-existent-uuid-12345'),
          'InvalidStateError',
          'deletePersistentAnchor with unknown UUID should reject with InvalidStateError',
        );
      },
    );
  });
}
