/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { TestHarness } from '@harness/test-harness';
import {
  startSession,
  startSessionRaw,
  cleanup,
  withFrame,
} from '@harness/xr-helpers';

/**
 * §4.2 XRRenderState — defaults, updateRenderState, readonly enforcement
 * 13 tests
 */
export function registerXRRenderStateTests(harness: TestHarness): void {
  // --- Shared-raw: read defaults before baseLayer is set (1 VR entry) ---
  harness.describe('§4.2 XRRenderState (defaults)', () => {
    let session: XRSession;
    let canvas: HTMLCanvasElement;

    harness.beforeAll(async () => {
      const result = await startSessionRaw('immersive-vr');
      session = result.session;
      canvas = result.canvas;
    });

    harness.afterAll(async () => {
      await cleanup(session, canvas);
    });

    // 1. depthNear defaults to 0.1
    harness.it('depthNear defaults to 0.1', async () => {
      harness.assertApprox(session.renderState.depthNear, 0.1, 0.001);
    });

    // 2. depthFar defaults to 1000
    harness.it('depthFar defaults to 1000', async () => {
      harness.assertApprox(session.renderState.depthFar, 1000, 0.001);
    });

    // 3. baseLayer defaults to null
    harness.it('baseLayer defaults to null', async () => {
      harness.assertEqual(
        session.renderState.baseLayer ?? null,
        null,
        'baseLayer should be null before setting',
      );
    });

    // 4. inlineVerticalFieldOfView is null for immersive
    harness.it('inlineVerticalFieldOfView is null for immersive', async () => {
      harness.assertEqual(
        (session.renderState as any).inlineVerticalFieldOfView ?? null,
        null,
        'inlineVerticalFieldOfView should be null for immersive sessions',
      );
    });
  });

  // --- Shared: readonly checks with baseLayer set (1 VR entry) ---
  harness.describe('§4.2 XRRenderState', () => {
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

    // 8. depthNear is readonly
    harness.it('depthNear is readonly', async () => {
      harness.assertReadonly(session.renderState, 'depthNear');
    });

    // 9. depthFar is readonly
    harness.it('depthFar is readonly', async () => {
      harness.assertReadonly(session.renderState, 'depthFar');
    });

    // 10. baseLayer is readonly
    harness.it('baseLayer is readonly', async () => {
      harness.assertReadonly(session.renderState, 'baseLayer');
    });

    // 11. inlineVerticalFieldOfView is readonly
    harness.it('inlineVerticalFieldOfView is readonly', async () => {
      harness.assertReadonly(session.renderState, 'inlineVerticalFieldOfView');
    });

    // 12. depthNear is number type
    harness.it('depthNear is number type', async () => {
      harness.assertType(session.renderState.depthNear, 'number');
    });

    // 13. depthFar is number type
    harness.it('depthFar is number type', async () => {
      harness.assertType(session.renderState.depthFar, 'number');
    });
  });

  // --- Mutations: tests that call updateRenderState (isolated) ---
  harness.describe('§4.2 XRRenderState (mutations)', () => {
    let session: XRSession | null = null;
    let canvas: HTMLCanvasElement | null = null;

    harness.afterEach(async () => {
      await cleanup(session, canvas);
      session = null;
      canvas = null;
    });

    // 5. updateRenderState changes depthNear (deferred one frame)
    harness.it(
      'updateRenderState changes depthNear (deferred one frame)',
      async () => {
        const result = await startSession('immersive-vr');
        session = result.session;
        canvas = result.canvas;

        session.updateRenderState({ depthNear: 0.5 });

        await withFrame(session, () => {
          harness.assertApprox(session!.renderState.depthNear, 0.5, 0.001);
        });
      },
    );

    // 6. updateRenderState changes depthFar (deferred one frame)
    harness.it(
      'updateRenderState changes depthFar (deferred one frame)',
      async () => {
        const result = await startSession('immersive-vr');
        session = result.session;
        canvas = result.canvas;

        session.updateRenderState({ depthFar: 500 });

        await withFrame(session, () => {
          harness.assertApprox(session!.renderState.depthFar, 500, 0.001);
        });
      },
    );

    // 7. updateRenderState sets baseLayer (deferred one frame)
    harness.it(
      'updateRenderState sets baseLayer (deferred one frame)',
      async () => {
        const result = await startSessionRaw('immersive-vr');
        session = result.session;
        canvas = result.canvas;

        const layer = new XRWebGLLayer(session, result.gl);
        session.updateRenderState({ baseLayer: layer });

        await withFrame(session, () => {
          harness.assertEqual(
            session!.renderState.baseLayer,
            layer,
            'baseLayer should be set after one frame',
          );
        });
      },
    );
  });
}
