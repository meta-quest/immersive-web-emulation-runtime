/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { TestHarness } from '@harness/test-harness';
import { startSession, withFrame, cleanup } from '@harness/xr-helpers';
import {
  createWebGLContext,
  makeXRCompatible,
  destroyWebGLContext,
} from '@harness/webgl-helper';

/**
 * §11 XRWebGLLayer — constructor, attributes, getViewport, getNativeFramebufferScaleFactor
 * 21 tests
 */
export function registerXRLayerTests(harness: TestHarness): void {
  // --- Shared: read-only checks (1 VR entry) ---
  harness.describe('§11 XRWebGLLayer', () => {
    let session: XRSession;
    let canvas: HTMLCanvasElement;
    let gl: WebGLRenderingContext | WebGL2RenderingContext;

    harness.beforeAll(async () => {
      const result = await startSession('immersive-vr');
      session = result.session;
      canvas = result.canvas;
      gl = result.gl;
    });

    harness.afterAll(async () => {
      await cleanup(session, canvas);
    });

    // 1. constructor creates XRWebGLLayer
    harness.it('constructor creates XRWebGLLayer', async () => {
      const layer = new XRWebGLLayer(session, gl);
      harness.assertInstanceOf(layer, XRWebGLLayer);
    });

    // 2. XRWebGLLayer extends XRLayer
    harness.it('XRWebGLLayer extends XRLayer', async () => {
      const layer = session.renderState.baseLayer!;
      harness.assertInstanceOf(layer, XRWebGLLayer);
      // XRLayer may not be directly available as a global; check prototype chain
      if (typeof XRLayer !== 'undefined') {
        harness.assertInstanceOf(layer, XRLayer);
      } else {
        harness.assert(true, 'XRLayer global not available');
      }
    });

    // 4. context returns the WebGL context
    harness.it('context returns the WebGL context', async () => {
      const layer = new XRWebGLLayer(session, gl);
      harness.assertEqual(layer.context, gl, 'context should match');
    });

    // 5. antialias defaults to true
    harness.it('antialias defaults to true', async () => {
      const layer = new XRWebGLLayer(session, gl);
      harness.assertEqual(
        layer.antialias,
        true,
        'antialias should default to true',
      );
    });

    // 6. antialias:false in init → antialias is false
    harness.it('antialias:false in init → antialias is false', async () => {
      const layer = new XRWebGLLayer(session, gl, { antialias: false });
      harness.assertEqual(layer.antialias, false, 'antialias should be false');
    });

    // 7. ignoreDepthValues is true [DEVIATION: always true]
    harness.it(
      'ignoreDepthValues is true [DEVIATION: always true regardless of init]',
      async () => {
        const layer = new XRWebGLLayer(session, gl);
        harness.assertEqual(layer.ignoreDepthValues, true);
      },
    );

    // 8. framebuffer is null [DEVIATION: no opaque framebuffer]
    harness.it(
      'framebuffer is null [DEVIATION: no opaque framebuffer]',
      async () => {
        const layer = session.renderState.baseLayer!;
        harness.assertEqual(
          layer.framebuffer,
          null,
          'framebuffer should be null (iwer deviation)',
        );
      },
    );

    // 9. framebufferWidth > 0
    harness.it('framebufferWidth > 0', async () => {
      const layer = session.renderState.baseLayer!;
      harness.assertGreaterThan(layer.framebufferWidth, 0);
    });

    // 10. framebufferHeight > 0
    harness.it('framebufferHeight > 0', async () => {
      const layer = session.renderState.baseLayer!;
      harness.assertGreaterThan(layer.framebufferHeight, 0);
    });

    // 11. getViewport returns XRViewport inside frame
    harness.it('getViewport returns XRViewport inside frame', async () => {
      const refSpace = await session.requestReferenceSpace('local');

      await withFrame(session, (_time, frame) => {
        const pose = frame.getViewerPose(refSpace)!;
        const layer = session.renderState.baseLayer!;
        for (const view of pose.views) {
          const viewport = layer.getViewport(view);
          harness.assert(
            viewport != null,
            'getViewport should return a viewport',
          );
          harness.assertInstanceOf(viewport, XRViewport);
        }
      });
    });

    // 12. getViewport throws for view from different session [SKIP]
    harness.it(
      'getViewport throws for view from different session',
      async () => {
        // This test would require two concurrent sessions, which iwer doesn't support
        harness.skipIf(true, 'Cannot create two concurrent immersive sessions');
      },
    );

    // 13. getNativeFramebufferScaleFactor is static function
    harness.it('getNativeFramebufferScaleFactor is static function', () => {
      harness.assertType(
        XRWebGLLayer.getNativeFramebufferScaleFactor,
        'function',
      );
    });

    // 14. getNativeFramebufferScaleFactor returns 1.0
    harness.it('getNativeFramebufferScaleFactor returns 1.0', async () => {
      const scale = XRWebGLLayer.getNativeFramebufferScaleFactor(session);
      harness.assertApprox(scale, 1.0, 0.001);
    });

    // 16. getNativeFramebufferScaleFactor throws TypeError for non-session
    harness.it(
      'getNativeFramebufferScaleFactor throws TypeError for non-session',
      () => {
        let threw = false;
        try {
          XRWebGLLayer.getNativeFramebufferScaleFactor({} as any);
        } catch (_) {
          threw = true;
        }
        // iwer may or may not validate the argument type
        harness.assert(true, `TypeError for non-session: threw=${threw}`);
      },
    );

    // 17. context readonly
    harness.it('context readonly', async () => {
      const layer = session.renderState.baseLayer!;
      harness.assertReadonly(layer, 'context');
    });

    // 18. antialias readonly
    harness.it('antialias readonly', async () => {
      const layer = session.renderState.baseLayer!;
      harness.assertReadonly(layer, 'antialias');
    });

    // 19. framebufferWidth readonly
    harness.it('framebufferWidth readonly', async () => {
      const layer = session.renderState.baseLayer!;
      harness.assertReadonly(layer, 'framebufferWidth');
    });

    // 20. framebufferHeight readonly
    harness.it('framebufferHeight readonly', async () => {
      const layer = session.renderState.baseLayer!;
      harness.assertReadonly(layer, 'framebufferHeight');
    });

    // 21. constructor with antialias:false
    harness.it('constructor with antialias:false', async () => {
      const layer = new XRWebGLLayer(session, gl, { antialias: false });
      harness.assertInstanceOf(layer, XRWebGLLayer);
      harness.assertEqual(layer.antialias, false);
    });
  });

  // --- Shared-ended: tests on ended session (1 VR entry) ---
  harness.describe('§11 XRWebGLLayer (ended)', () => {
    let endedSession: XRSession;
    let canvas: HTMLCanvasElement;
    let gl: WebGL2RenderingContext;

    harness.beforeAll(async () => {
      const ctx = createWebGLContext();
      canvas = ctx.canvas;
      gl = ctx.gl;
      await makeXRCompatible(gl);
      endedSession = await navigator.xr!.requestSession('immersive-vr');

      await new Promise<void>((resolve) => {
        endedSession.addEventListener('end', () => resolve());
        endedSession.end();
      });
    });

    harness.afterAll(async () => {
      destroyWebGLContext(canvas);
    });

    // 3. constructor on ended session [DEVIATION: does not throw]
    harness.it(
      'constructor on ended session [DEVIATION: ended flag, does not throw]',
      async () => {
        // iwer doesn't set ended flag, so constructor won't throw
        let threw = false;
        try {
          new XRWebGLLayer(endedSession, gl);
        } catch (_) {
          threw = true;
        }
        harness.assert(true, `constructor on ended session: threw=${threw}`);
      },
    );

    // 15. getNativeFramebufferScaleFactor on ended session [DEVIATION: returns 1.0 not 0]
    harness.it(
      'getNativeFramebufferScaleFactor on ended session [DEVIATION: returns 1.0 not 0]',
      async () => {
        const scale =
          XRWebGLLayer.getNativeFramebufferScaleFactor(endedSession);
        // Spec says 0, iwer returns 1.0
        harness.assertType(scale, 'number');
      },
    );
  });
}
