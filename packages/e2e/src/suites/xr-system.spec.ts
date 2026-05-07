/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { TestHarness } from '@harness/test-harness';
import { startSession, cleanup } from '@harness/xr-helpers';

/**
 * §3 XRSystem — navigator.xr, isSessionSupported, requestSession
 * 11 tests
 */
export function registerXRSystemTests(harness: TestHarness): void {
  harness.describe('§3 XRSystem', () => {
    let session: XRSession | null = null;
    let canvas: HTMLCanvasElement | null = null;

    harness.afterEach(async () => {
      await cleanup(session, canvas);
      session = null;
      canvas = null;
    });

    // 1. navigator.xr is XRSystem instance
    harness.it('navigator.xr is XRSystem instance', () => {
      harness.assert(navigator.xr != null, 'navigator.xr should be defined');
      harness.assertInstanceOf(navigator.xr, XRSystem);
    });

    // 2. isSessionSupported("inline") → true
    harness.it('isSessionSupported("inline") → true', async () => {
      const supported = await navigator.xr!.isSessionSupported('inline');
      harness.assertEqual(supported, true);
    });

    // 3. isSessionSupported("immersive-vr") → true
    harness.it('isSessionSupported("immersive-vr") → true', async () => {
      const supported = await navigator.xr!.isSessionSupported('immersive-vr');
      harness.assertEqual(supported, true);
    });

    // 4. isSessionSupported("immersive-ar") → true
    harness.it('isSessionSupported("immersive-ar") → true', async () => {
      const supported = await navigator.xr!.isSessionSupported('immersive-ar');
      harness.assertEqual(supported, true);
    });

    // 5. isSessionSupported returns boolean
    harness.it('isSessionSupported returns boolean', async () => {
      const supported = await navigator.xr!.isSessionSupported('inline');
      harness.assertType(supported, 'boolean');
    });

    // 6. requestSession("inline") → XRSession
    harness.it('requestSession("inline") → XRSession', async () => {
      const result = await startSession('inline');
      session = result.session;
      canvas = result.canvas;
      harness.assertInstanceOf(session, XRSession);
    });

    // 7. requestSession("immersive-vr") → XRSession
    harness.it('requestSession("immersive-vr") → XRSession', async () => {
      const result = await startSession('immersive-vr');
      session = result.session;
      canvas = result.canvas;
      harness.assertInstanceOf(session, XRSession);
    });

    // 8. requestSession rejects NotSupportedError for invalid mode
    harness.it(
      'requestSession rejects NotSupportedError for invalid mode',
      async () => {
        await harness.assertRejects(
          () => navigator.xr!.requestSession('invalid-mode' as XRSessionMode),
          undefined,
          'Should reject invalid session mode',
        );
      },
    );

    // 9. requestSession rejects InvalidStateError if session active
    harness.it(
      'requestSession rejects InvalidStateError if session active',
      async () => {
        const result = await startSession('immersive-vr');
        session = result.session;
        canvas = result.canvas;

        // Requesting another immersive session while one is active should reject
        await harness.assertRejects(
          () => navigator.xr!.requestSession('immersive-vr'),
          undefined,
          'Should reject when immersive session already active',
        );
      },
    );

    // 10. XRSystem extends EventTarget
    harness.it('XRSystem extends EventTarget', () => {
      harness.assertInstanceOf(navigator.xr!, EventTarget);
      harness.assertType(navigator.xr!.addEventListener, 'function');
      harness.assertType(navigator.xr!.removeEventListener, 'function');
      harness.assertType(navigator.xr!.dispatchEvent, 'function');
    });

    // 11. ondevicechange: skipIf not present [DEVIATION: not implemented]
    harness.it('ondevicechange [DEVIATION: not implemented]', () => {
      harness.skipIf(
        !('ondevicechange' in navigator.xr!),
        'ondevicechange not implemented in iwer',
      );
      harness.assertProperty(navigator.xr!, 'ondevicechange');
    });
  });
}
