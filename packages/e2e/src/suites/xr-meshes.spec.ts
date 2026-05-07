/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { TestHarness } from '@harness/test-harness';
import { startSession, withFrame, cleanup } from '@harness/xr-helpers';
import { XRMesh } from 'iwer';

/**
 * Mesh Detection Module — detectedMeshes, XRMesh shape
 * 12 tests
 */
export function registerXRMeshesTests(harness: TestHarness): void {
  harness.describe('Mesh Detection Module', () => {
    let session: XRSession;
    let canvas: HTMLCanvasElement;

    harness.beforeAll(async () => {
      const result = await startSession('immersive-vr', {
        requiredFeatures: ['mesh-detection'],
      });
      session = result.session;
      canvas = result.canvas;
    });

    harness.afterAll(async () => {
      await cleanup(session, canvas);
    });

    // 1. mesh-detection feature can be requested
    harness.it('mesh-detection feature can be requested', async () => {
      harness.assert(
        session != null,
        'Session with mesh-detection should be created',
      );
    });

    // 2. enabledFeatures includes "mesh-detection"
    harness.it('enabledFeatures includes "mesh-detection"', async () => {
      harness.assert(
        session.enabledFeatures.includes('mesh-detection'),
        'enabledFeatures should include "mesh-detection"',
      );
    });

    // 3. detectedMeshes is accessible inside frame
    harness.it('detectedMeshes is accessible inside frame', async () => {
      await withFrame(session, (_time, frame) => {
        harness.assert(
          (frame as any).detectedMeshes != null,
          'detectedMeshes should be accessible inside active frame',
        );
      });
    });

    // 4. detectedMeshes is Set-like
    harness.it('detectedMeshes is Set-like', async () => {
      await withFrame(session, (_time, frame) => {
        const meshes = (frame as any).detectedMeshes;
        harness.assertType(meshes.has, 'function');
        harness.assertType(meshes.forEach, 'function');
        harness.assertType(meshes[Symbol.iterator], 'function');
        harness.assertProperty(meshes, 'size');
      });
    });

    // 5. detectedMeshes is empty without SEM [SKIP:native]
    harness.it(
      'detectedMeshes is empty without SEM [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');

        await withFrame(session, (_time, frame) => {
          harness.assertEqual(
            (frame as any).detectedMeshes.size,
            0,
            'detectedMeshes should be empty without SEM',
          );
        });
      },
    );

    // 6. detectedMeshes throws on inactive frame
    harness.it('detectedMeshes throws on inactive frame', async () => {
      let staleFrame: XRFrame;
      await withFrame(session, (_time, frame) => {
        staleFrame = frame;
      });

      harness.assertDOMException(
        () => {
          const _meshes = (staleFrame! as any).detectedMeshes;
        },
        'InvalidStateError',
        'detectedMeshes on inactive frame should throw InvalidStateError',
      );
    });

    // 7. XRMesh has meshSpace property
    harness.it('XRMesh has meshSpace property', () => {
      harness.assertProperty(XRMesh.prototype, 'meshSpace');
    });

    // 8. XRMesh has vertices property
    harness.it('XRMesh has vertices property', () => {
      harness.assertProperty(XRMesh.prototype, 'vertices');
    });

    // 9. XRMesh has indices property
    harness.it('XRMesh has indices property', () => {
      harness.assertProperty(XRMesh.prototype, 'indices');
    });

    // 10. XRMesh has lastChangedTime property
    harness.it('XRMesh has lastChangedTime property', () => {
      harness.assertProperty(XRMesh.prototype, 'lastChangedTime');
    });

    // 11. XRMesh has semanticLabel property
    harness.it('XRMesh has semanticLabel property', () => {
      harness.assertProperty(XRMesh.prototype, 'semanticLabel');
    });

    // 12. detectedMeshes accessible without mesh-detection feature (empty set) [SKIP:native]
    harness.it(
      'detectedMeshes accessible without mesh-detection feature (empty set) [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');
        // End shared session to create one without mesh-detection
        await cleanup(session, canvas);

        const result = await startSession('immersive-vr');
        const tempSession = result.session;
        const tempCanvas = result.canvas;

        try {
          await withFrame(tempSession, (_time, frame) => {
            const meshes = (frame as any).detectedMeshes;
            harness.assert(
              meshes != null,
              'detectedMeshes should be accessible without feature',
            );
            harness.assertEqual(
              meshes.size,
              0,
              'detectedMeshes should be empty without mesh-detection feature',
            );
          });
        } finally {
          await cleanup(tempSession, tempCanvas);
          // Restore shared session
          const restored = await startSession('immersive-vr', {
            requiredFeatures: ['mesh-detection'],
          });
          session = restored.session;
          canvas = restored.canvas;
        }
      },
    );
  });
}
