/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { TestHarness } from '@harness/test-harness';
import { startSession, cleanup } from '@harness/xr-helpers';

/**
 * §10 XRInputSource / XRInputSourceArray — handedness, targetRayMode, profiles, gamepad
 * 20 tests
 */
export function registerXRInputSourceTests(harness: TestHarness): void {
  // --- Shared: read-only checks with immersive-vr (1 VR entry) ---
  harness.describe('§10 XRInputSource / XRInputSourceArray', () => {
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

    // 1. inputSources has length property
    harness.it('inputSources has length property', async () => {
      harness.assertProperty(session.inputSources, 'length');
      harness.assertType(session.inputSources.length, 'number');
    });

    // 2. inputSources is iterable (for-of count = length)
    harness.it('inputSources is iterable (for-of count = length)', async () => {
      let count = 0;
      for (const _source of session.inputSources) {
        count++;
      }
      harness.assertEqual(count, session.inputSources.length);
    });

    // 3. immersive-vr has input sources [SKIP:native]
    harness.it('immersive-vr has input sources [SKIP:native]', async (ctx) => {
      harness.skipIf(ctx.mode === 'native', 'Device-specific input sources');
      harness.assertGreaterThan(session.inputSources.length, 0);
    });

    // 4. handedness is valid enum
    harness.it('handedness is valid enum', async () => {
      const validValues = ['none', 'left', 'right'];
      for (const source of session.inputSources) {
        harness.assert(
          validValues.includes(source.handedness),
          `handedness "${source.handedness}" should be none, left, or right`,
        );
      }
    });

    // 5. targetRayMode is valid enum
    harness.it('targetRayMode is valid enum', async () => {
      const validModes = [
        'gaze',
        'tracked-pointer',
        'screen',
        'transient-pointer',
      ];
      for (const source of session.inputSources) {
        harness.assert(
          validModes.includes(source.targetRayMode),
          `targetRayMode "${source.targetRayMode}" should be valid`,
        );
      }
    });

    // 6. targetRayMode is "tracked-pointer" for controllers [SKIP:native]
    harness.it(
      'targetRayMode is "tracked-pointer" for controllers [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Device-specific');

        for (const source of session.inputSources) {
          harness.assertEqual(
            source.targetRayMode,
            'tracked-pointer',
            'iwer controllers should be tracked-pointer',
          );
        }
      },
    );

    // 7. targetRaySpace is XRSpace
    harness.it('targetRaySpace is XRSpace', async () => {
      for (const source of session.inputSources) {
        harness.assert(
          source.targetRaySpace != null,
          'targetRaySpace should exist',
        );
        harness.assertInstanceOf(source.targetRaySpace, XRSpace);
      }
    });

    // 8. gripSpace is XRSpace when present
    harness.it('gripSpace is XRSpace when present', async () => {
      for (const source of session.inputSources) {
        if (source.gripSpace != null) {
          harness.assertInstanceOf(source.gripSpace, XRSpace);
        }
      }
    });

    // 9. profiles is array of strings
    harness.it('profiles is array of strings', async () => {
      for (const source of session.inputSources) {
        harness.assert(
          Array.isArray(source.profiles),
          'profiles should be array',
        );
        for (const profile of source.profiles) {
          harness.assertType(profile, 'string');
        }
      }
    });

    // 10. profiles non-empty for controllers [SKIP:native]
    harness.it(
      'profiles non-empty for controllers [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Device-specific profiles');

        for (const source of session.inputSources) {
          harness.assertGreaterThan(source.profiles.length, 0);
        }
      },
    );

    // 11. gamepad exists for tracked-pointer
    harness.it('gamepad exists for tracked-pointer', async () => {
      for (const source of session.inputSources) {
        if (source.targetRayMode === 'tracked-pointer') {
          harness.assert(
            source.gamepad != null,
            'tracked-pointer should have gamepad',
          );
        }
      }
    });

    // 12. gamepad.mapping is "xr-standard"
    harness.it('gamepad.mapping is "xr-standard"', async () => {
      for (const source of session.inputSources) {
        if (source.gamepad) {
          harness.assertEqual(
            source.gamepad.mapping,
            'xr-standard',
            'gamepad mapping should be xr-standard',
          );
        }
      }
    });

    // 13. gamepad.buttons is array
    harness.it('gamepad.buttons is array', async () => {
      for (const source of session.inputSources) {
        if (source.gamepad) {
          harness.assert(
            Array.isArray(source.gamepad.buttons) ||
              source.gamepad.buttons.length >= 0,
            'gamepad.buttons should be array-like',
          );
        }
      }
    });

    // 14. gamepad.axes is array
    harness.it('gamepad.axes is array', async () => {
      for (const source of session.inputSources) {
        if (source.gamepad) {
          harness.assert(
            Array.isArray(source.gamepad.axes) ||
              source.gamepad.axes.length >= 0,
            'gamepad.axes should be array-like',
          );
        }
      }
    });

    // 15. hand is undefined for controller mode [SKIP:native]
    harness.it(
      'hand is undefined for controller mode [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Device-specific hand tracking');

        for (const source of session.inputSources) {
          harness.assert(
            source.hand === null || source.hand === undefined,
            'hand should be null/undefined for controller mode',
          );
        }
      },
    );

    // 16. handedness readonly
    harness.it('handedness readonly', async () => {
      if (session.inputSources.length > 0) {
        harness.assertReadonly(session.inputSources[0], 'handedness');
      } else {
        harness.assert(true, 'No input sources to test');
      }
    });

    // 17. targetRayMode readonly
    harness.it('targetRayMode readonly', async () => {
      if (session.inputSources.length > 0) {
        harness.assertReadonly(session.inputSources[0], 'targetRayMode');
      } else {
        harness.assert(true, 'No input sources to test');
      }
    });

    // 18. targetRaySpace readonly
    harness.it('targetRaySpace readonly', async () => {
      if (session.inputSources.length > 0) {
        harness.assertReadonly(session.inputSources[0], 'targetRaySpace');
      } else {
        harness.assert(true, 'No input sources to test');
      }
    });

    // 19. profiles readonly
    harness.it('profiles readonly', async () => {
      if (session.inputSources.length > 0) {
        harness.assertReadonly(session.inputSources[0], 'profiles');
      } else {
        harness.assert(true, 'No input sources to test');
      }
    });
  });

  // --- Isolated: inline session test ---
  harness.describe('§10 XRInputSource (inline)', () => {
    let session: XRSession | null = null;
    let canvas: HTMLCanvasElement | null = null;

    harness.afterEach(async () => {
      await cleanup(session, canvas);
      session = null;
      canvas = null;
    });

    // 20. inline session inputSources is empty
    harness.it('inline session inputSources is empty', async () => {
      const result = await startSession('inline');
      session = result.session;
      canvas = result.canvas;
      harness.assertEqual(
        session.inputSources.length,
        0,
        'inline should have no input sources',
      );
    });
  });
}
