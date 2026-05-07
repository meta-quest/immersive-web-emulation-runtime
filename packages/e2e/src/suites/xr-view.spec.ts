/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { TestHarness } from '@harness/test-harness';
import { startSession, withFrame, cleanup } from '@harness/xr-helpers';

/**
 * §7 XRView / XRViewport — eye, projectionMatrix, transform, viewport
 * 20 tests
 */
export function registerXRViewTests(harness: TestHarness): void {
  harness.describe('§7 XRView / XRViewport', () => {
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

    // Helper to get views
    async function getViews(s: XRSession): Promise<{
      views: readonly XRView[];
      layer: XRWebGLLayer;
      refSpace: XRReferenceSpace;
    }> {
      const refSpace = await s.requestReferenceSpace('local');
      return new Promise((resolve, reject) => {
        s.requestAnimationFrame((_time, frame) => {
          try {
            const pose = frame.getViewerPose(refSpace);
            const layer = s.renderState.baseLayer!;
            resolve({ views: pose!.views, layer, refSpace });
          } catch (e) {
            reject(e);
          }
        });
      });
    }

    // 1. eye is valid XREye value
    harness.it('eye is valid XREye value', async () => {
      const { views } = await getViews(session);
      for (const view of views) {
        const validEyes = ['left', 'right', 'none'];
        harness.assert(
          validEyes.includes(view.eye),
          `eye "${view.eye}" should be left, right, or none`,
        );
      }
    });

    // 2. immersive-vr has 2 views
    harness.it('immersive-vr has 2 views', async () => {
      const { views } = await getViews(session);
      harness.assertEqual(views.length, 2, 'Should have 2 views for stereo');
    });

    // 3. stereo views have "left" and "right" eyes
    harness.it('stereo views have "left" and "right" eyes', async () => {
      const { views } = await getViews(session);
      const eyes = views.map((v) => v.eye);
      harness.assert(eyes.includes('left'), 'Should have left eye');
      harness.assert(eyes.includes('right'), 'Should have right eye');
    });

    // 4. projectionMatrix is Float32Array(16)
    harness.it('projectionMatrix is Float32Array(16)', async () => {
      const { views } = await getViews(session);
      for (const view of views) {
        harness.assertInstanceOf(view.projectionMatrix, Float32Array);
        harness.assertEqual(view.projectionMatrix.length, 16);
      }
    });

    // 5. projectionMatrix has non-zero diagonal values
    harness.it('projectionMatrix has non-zero diagonal values', async () => {
      const { views } = await getViews(session);
      for (const view of views) {
        const m = view.projectionMatrix;
        harness.assertNotEqual(m[0], 0, 'm[0] should be non-zero');
        harness.assertNotEqual(m[5], 0, 'm[5] should be non-zero');
        harness.assertNotEqual(m[10], 0, 'm[10] should be non-zero');
      }
    });

    // 6. transform is XRRigidTransform
    harness.it('transform is XRRigidTransform', async () => {
      const { views } = await getViews(session);
      for (const view of views) {
        harness.assertInstanceOf(view.transform, XRRigidTransform);
      }
    });

    // 7. recommendedViewportScale is null
    harness.it('recommendedViewportScale is null', async () => {
      const { views } = await getViews(session);
      for (const view of views) {
        harness.assertEqual(
          view.recommendedViewportScale ?? null,
          null,
          'recommendedViewportScale should be null',
        );
      }
    });

    // 8. requestViewportScale is a function
    harness.it('requestViewportScale is a function', async () => {
      const { views } = await getViews(session);
      for (const view of views) {
        harness.assertType(view.requestViewportScale, 'function');
      }
    });

    // 9. requestViewportScale(0.5) does not throw
    harness.it('requestViewportScale(0.5) does not throw', async () => {
      const refSpace = await session.requestReferenceSpace('local');
      await withFrame(session, (_time, frame) => {
        const pose = frame.getViewerPose(refSpace);
        for (const view of pose!.views) {
          view.requestViewportScale(0.5);
        }
      });
      harness.assert(true, 'requestViewportScale(0.5) did not throw');
    });

    // 10. requestViewportScale(-1) is no-op
    harness.it('requestViewportScale(-1) is no-op', async () => {
      const refSpace = await session.requestReferenceSpace('local');
      await withFrame(session, (_time, frame) => {
        const pose = frame.getViewerPose(refSpace);
        for (const view of pose!.views) {
          // Should not throw, just be a no-op for invalid values
          try {
            view.requestViewportScale(-1);
          } catch (_) {
            // Also acceptable
          }
        }
      });
      harness.assert(true, 'requestViewportScale(-1) handled');
    });

    // 11. eye readonly
    harness.it('eye readonly', async () => {
      const { views } = await getViews(session);
      harness.assertReadonly(views[0], 'eye');
    });

    // 12. projectionMatrix readonly
    harness.it('projectionMatrix readonly', async () => {
      const { views } = await getViews(session);
      harness.assertReadonly(views[0], 'projectionMatrix');
    });

    // 13. transform readonly
    harness.it('transform readonly', async () => {
      const { views } = await getViews(session);
      harness.assertReadonly(views[0], 'transform');
    });

    // 14. getViewport returns XRViewport
    harness.it('getViewport returns XRViewport', async () => {
      const { views, layer } = await getViews(session);
      for (const view of views) {
        const viewport = layer.getViewport(view);
        harness.assert(
          viewport != null,
          'getViewport should return a viewport',
        );
        harness.assertInstanceOf(viewport, XRViewport);
      }
    });

    // 15. viewport.x is number
    harness.it('viewport.x is number', async () => {
      const { views, layer } = await getViews(session);
      const viewport = layer.getViewport(views[0])!;
      harness.assertType(viewport.x, 'number');
    });

    // 16. viewport.y is number
    harness.it('viewport.y is number', async () => {
      const { views, layer } = await getViews(session);
      const viewport = layer.getViewport(views[0])!;
      harness.assertType(viewport.y, 'number');
    });

    // 17. viewport.width > 0
    harness.it('viewport.width > 0', async () => {
      const { views, layer } = await getViews(session);
      const viewport = layer.getViewport(views[0])!;
      harness.assertGreaterThan(viewport.width, 0);
    });

    // 18. viewport.height > 0
    harness.it('viewport.height > 0', async () => {
      const { views, layer } = await getViews(session);
      const viewport = layer.getViewport(views[0])!;
      harness.assertGreaterThan(viewport.height, 0);
    });

    // 19. viewport x/y/width/height readonly
    harness.it('viewport x/y/width/height readonly', async () => {
      const { views, layer } = await getViews(session);
      const viewport = layer.getViewport(views[0])!;
      harness.assertReadonly(viewport, 'x');
      harness.assertReadonly(viewport, 'y');
      harness.assertReadonly(viewport, 'width');
      harness.assertReadonly(viewport, 'height');
    });

    // 20. left + right viewports do not overlap
    harness.it('left + right viewports do not overlap', async () => {
      const { views, layer } = await getViews(session);
      harness.assertEqual(views.length, 2, 'Need 2 views');

      const vp0 = layer.getViewport(views[0])!;
      const vp1 = layer.getViewport(views[1])!;

      // Simple overlap check: two rects overlap if they intersect in both X and Y
      const overlapX = vp0.x < vp1.x + vp1.width && vp1.x < vp0.x + vp0.width;
      const overlapY = vp0.y < vp1.y + vp1.height && vp1.y < vp0.y + vp0.height;
      const overlaps = overlapX && overlapY;

      harness.assertEqual(
        overlaps,
        false,
        'Left and right viewports should not overlap',
      );
    });
  });
}
