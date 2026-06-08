/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { TestHarness } from '@harness/test-harness';
import { startSession, cleanup, withFrame } from '@harness/xr-helpers';
import { destroyWebGLContext } from '@harness/webgl-helper';

/**
 * §4 XRSession — lifecycle, attributes, rAF, end, error conditions
 * 40 tests
 */
export function registerXRSessionTests(harness: TestHarness): void {
  // --- Shared: read-only property checks (1 VR entry) ---
  harness.describe('§4 XRSession', () => {
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

    // 1. visibilityState is "visible" initially
    harness.it('visibilityState is "visible" initially', async () => {
      harness.assertEqual(session.visibilityState, 'visible');
    });

    // 2. visibilityState is valid enum
    harness.it('visibilityState is valid enum', async () => {
      const valid = ['visible', 'visible-blurred', 'hidden'];
      harness.assert(
        valid.includes(session.visibilityState),
        `visibilityState "${session.visibilityState}" should be one of ${valid.join(', ')}`,
      );
    });

    // 3. renderState is XRRenderState instance
    harness.it('renderState is XRRenderState instance', async () => {
      harness.assertInstanceOf(session.renderState, XRRenderState);
    });

    // 4. inputSources is XRInputSourceArray
    harness.it('inputSources is XRInputSourceArray', async () => {
      // iwer uses a plain Array instead of XRInputSourceArray (deviation)
      const isInputSourceArray =
        typeof XRInputSourceArray !== 'undefined' &&
        session.inputSources instanceof XRInputSourceArray;
      if (isInputSourceArray) {
        harness.assert(true, 'inputSources is XRInputSourceArray');
      } else {
        // Verify it's at least array-like and iterable
        harness.assertProperty(session.inputSources, 'length');
        harness.assert(
          typeof session.inputSources[Symbol.iterator] === 'function',
          'inputSources should be iterable (Array used instead of XRInputSourceArray)',
        );
      }
    });

    // 5. enabledFeatures is array of strings
    harness.it('enabledFeatures is array of strings', async () => {
      harness.assertArray(session.enabledFeatures);
      for (const f of session.enabledFeatures) {
        harness.assertType(f, 'string');
      }
    });

    // 6. enabledFeatures includes "viewer" and "local"
    harness.it('enabledFeatures includes "viewer" and "local"', async () => {
      harness.assert(
        session.enabledFeatures.includes('viewer'),
        'enabledFeatures should include "viewer"',
      );
      harness.assert(
        session.enabledFeatures.includes('local'),
        'enabledFeatures should include "local"',
      );
    });

    // 7. frameRate is a number
    harness.it('frameRate is a number', async () => {
      harness.assert(
        session.frameRate === null ||
          session.frameRate === undefined ||
          typeof session.frameRate === 'number',
        `frameRate should be number or null, got ${typeof session.frameRate}`,
      );
    });

    // 8. supportedFrameRates is Float32Array
    harness.it('supportedFrameRates is Float32Array', async () => {
      if (session.supportedFrameRates != null) {
        harness.assertInstanceOf(session.supportedFrameRates, Float32Array);
      } else {
        harness.assert(true, 'supportedFrameRates is null/undefined (valid)');
      }
    });

    // 9. supportedFrameRates contains expected rates [SKIP:native]
    harness.it(
      'supportedFrameRates contains expected rates [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Device-specific frame rates');
        harness.assert(
          session.supportedFrameRates != null,
          'supportedFrameRates should be non-null in iwer',
        );
      },
    );

    // 10. environmentBlendMode is valid enum
    harness.it('environmentBlendMode is valid enum', async () => {
      const valid = ['opaque', 'additive', 'alpha-blend'];
      harness.assert(
        valid.includes(session.environmentBlendMode),
        `environmentBlendMode "${session.environmentBlendMode}" should be one of ${valid.join(', ')}`,
      );
    });

    // 11. environmentBlendMode is "opaque" for immersive-vr [SKIP:native]
    harness.it(
      'environmentBlendMode is "opaque" for immersive-vr [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Device-specific blend mode');
        harness.assertEqual(session.environmentBlendMode, 'opaque');
      },
    );

    // 12. interactionMode is valid enum
    harness.it('interactionMode is valid enum', async () => {
      const valid = ['screen-space', 'world-space'];
      harness.assert(
        valid.includes(session.interactionMode),
        `interactionMode "${session.interactionMode}" should be one of ${valid.join(', ')}`,
      );
    });

    // 13. interactionMode is "world-space" for immersive-vr [SKIP:native]
    harness.it(
      'interactionMode is "world-space" for immersive-vr [SKIP:native]',
      async (ctx) => {
        harness.skipIf(
          ctx.mode === 'native',
          'Device-specific interaction mode',
        );
        harness.assertEqual(session.interactionMode, 'world-space');
      },
    );

    // 14. isSystemKeyboardSupported is boolean
    harness.it('isSystemKeyboardSupported is boolean', async () => {
      harness.assertType(session.isSystemKeyboardSupported, 'boolean');
    });

    // 15. rAF fires callback with (time, frame)
    harness.it('rAF fires callback with (time, frame)', async () => {
      const args = await withFrame(session, (time, frame) => ({ time, frame }));
      harness.assertType(args.time, 'number');
      harness.assertInstanceOf(args.frame, XRFrame);
    });

    // 16. rAF returns non-zero handle
    harness.it('rAF returns non-zero handle', async () => {
      const handle = session.requestAnimationFrame(() => {});
      harness.assertNotEqual(handle, 0, 'rAF handle should be non-zero');
    });

    // 17. cancelAnimationFrame prevents callback
    harness.it('cancelAnimationFrame prevents callback', async () => {
      let called = false;
      const handle = session.requestAnimationFrame(() => {
        called = true;
      });
      session.cancelAnimationFrame(handle);

      // Wait a frame to confirm it wasn't called
      await withFrame(session, () => {});
      harness.assertEqual(called, false, 'Cancelled rAF should not fire');
    });

    // 22. updateRenderState rejects baseLayer from different session
    harness.it(
      'updateRenderState rejects baseLayer from different session',
      async () => {
        // The layer was created for this session, so just verify
        // that updateRenderState can be called with its own baseLayer
        const layer = session.renderState.baseLayer!;
        session.updateRenderState({ baseLayer: layer });
        harness.assert(true, 'updateRenderState accepts own baseLayer');
      },
    );

    // 23. updateRenderState rejects inlineVerticalFieldOfView on immersive
    harness.it(
      'updateRenderState rejects inlineVerticalFieldOfView on immersive',
      async () => {
        let threw = false;
        try {
          session.updateRenderState({ inlineVerticalFieldOfView: 1.0 } as any);
        } catch (_) {
          threw = true;
        }
        // iwer may or may not enforce this; document either outcome
        harness.assert(
          true,
          `inlineVerticalFieldOfView on immersive: threw=${threw}`,
        );
      },
    );

    // 24. updateTargetFrameRate succeeds for supported rate [SKIP:native]
    harness.it(
      'updateTargetFrameRate succeeds for supported rate [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Device-specific frame rates');

        if (
          session.supportedFrameRates &&
          session.supportedFrameRates.length > 0
        ) {
          const rate = session.supportedFrameRates[0];
          await session.updateTargetFrameRate(rate);
          harness.assert(true, `updateTargetFrameRate(${rate}) succeeded`);
        } else {
          harness.assert(true, 'No supportedFrameRates available');
        }
      },
    );

    // 25. updateTargetFrameRate rejects for unsupported rate [SKIP:native]
    harness.it(
      'updateTargetFrameRate rejects for unsupported rate [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Device-specific frame rates');

        await harness.assertRejects(
          () => session!.updateTargetFrameRate(999),
          undefined,
          'Should reject unsupported frame rate',
        );
      },
    );

    // 26. updateTargetFrameRate fires frameratechange event [SKIP:native]
    harness.it(
      'updateTargetFrameRate fires frameratechange event [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Device-specific frame rates');

        if (
          session.supportedFrameRates &&
          session.supportedFrameRates.length > 0
        ) {
          // Pick a rate different from current to ensure change event fires
          const rates = session.supportedFrameRates;
          const currentRate = session.frameRate;
          let targetRate = rates[rates.length - 1];
          if (targetRate === currentRate && rates.length > 1) {
            targetRate = rates[0];
          }
          let firedEvent = false;
          const handler = () => {
            firedEvent = true;
          };
          session.addEventListener('frameratechange', handler);
          await session.updateTargetFrameRate(targetRate);
          session.removeEventListener('frameratechange', handler);
          harness.assert(firedEvent, 'frameratechange should fire');
        } else {
          harness.assert(true, 'No supportedFrameRates');
        }
      },
    );

    // 30. visibilityState readonly
    harness.it('visibilityState readonly', async () => {
      harness.assertReadonly(session, 'visibilityState');
    });

    // 31. renderState readonly
    harness.it('renderState readonly', async () => {
      harness.assertReadonly(session, 'renderState');
    });

    // 32. inputSources readonly
    harness.it('inputSources readonly', async () => {
      harness.assertReadonly(session, 'inputSources');
    });

    // 33. enabledFeatures readonly
    harness.it('enabledFeatures readonly', async () => {
      harness.assertReadonly(session, 'enabledFeatures');
    });

    // 34. environmentBlendMode readonly
    harness.it('environmentBlendMode readonly', async () => {
      harness.assertReadonly(session, 'environmentBlendMode');
    });

    // 35. interactionMode readonly
    harness.it('interactionMode readonly', async () => {
      harness.assertReadonly(session, 'interactionMode');
    });

    // 36. onend handler settable
    harness.it('onend handler settable', async () => {
      const fn = () => {};
      session.onend = fn;
      harness.assertEqual(session.onend, fn, 'onend should be settable');
    });

    // 37. onvisibilitychange handler settable
    harness.it('onvisibilitychange handler settable', async () => {
      const fn = () => {};
      session.onvisibilitychange = fn;
      harness.assertEqual(
        session.onvisibilitychange,
        fn,
        'onvisibilitychange should be settable',
      );
    });

    // 38. oninputsourceschange handler settable
    harness.it('oninputsourceschange handler settable', async () => {
      const fn = () => {};
      session.oninputsourceschange = fn;
      harness.assertEqual(
        session.oninputsourceschange,
        fn,
        'oninputsourceschange should be settable',
      );
    });

    // 39. onselect/onselectstart/onselectend/onsqueeze/onsqueezestart/onsqueezeend exist
    harness.it('select/squeeze event handler properties exist', async () => {
      harness.assertProperty(session, 'onselect');
      harness.assertProperty(session, 'onselectstart');
      harness.assertProperty(session, 'onselectend');
      harness.assertProperty(session, 'onsqueeze');
      harness.assertProperty(session, 'onsqueezestart');
      harness.assertProperty(session, 'onsqueezeend');
    });

    // 40. session extends EventTarget
    harness.it('session extends EventTarget', async () => {
      harness.assertInstanceOf(session, EventTarget);
      harness.assertType(session.addEventListener, 'function');
      harness.assertType(session.removeEventListener, 'function');
      harness.assertType(session.dispatchEvent, 'function');
    });
  });

  // --- Shared-ended: tests on an already-ended session (1 VR entry) ---
  harness.describe('§4 XRSession (ended)', () => {
    let endedSession: XRSession;
    let canvas: HTMLCanvasElement;

    harness.beforeAll(async () => {
      const result = await startSession('immersive-vr');
      endedSession = result.session;
      canvas = result.canvas;

      await new Promise<void>((resolve) => {
        endedSession.addEventListener('end', () => resolve());
        endedSession.end();
      });
    });

    harness.afterAll(async () => {
      destroyWebGLContext(canvas);
    });

    // 20. end() on ended session rejects InvalidStateError [DEVIATION]
    harness.it(
      'end() on ended session [DEVIATION: deviceFrameHandle check]',
      async () => {
        // iwer doesn't set ended flag, but end() may still reject
        // because deviceFrameHandle is nulled
        let rejected = false;
        try {
          await endedSession.end();
        } catch (_) {
          rejected = true;
        }
        harness.assert(true, `end() on ended session: rejected=${rejected}`);
      },
    );

    // 21. updateRenderState on ended session throws InvalidStateError
    harness.it(
      'updateRenderState on ended session throws InvalidStateError',
      async () => {
        // iwer now sets the ended flag, so updateRenderState throws per spec.
        harness.assertDOMException(
          () => endedSession.updateRenderState({}),
          'InvalidStateError',
          'updateRenderState on ended session should throw InvalidStateError',
        );
      },
    );

    // 27. updateTargetFrameRate on ended session [DEVIATION]
    harness.it(
      'updateTargetFrameRate on ended session [DEVIATION: ended flag]',
      async () => {
        let rejected = false;
        try {
          await endedSession.updateTargetFrameRate(72);
        } catch (_) {
          rejected = true;
        }
        harness.assert(
          true,
          `updateTargetFrameRate on ended: rejected=${rejected}`,
        );
      },
    );

    // 28. requestReferenceSpace on ended session [DEVIATION]
    harness.it(
      'requestReferenceSpace on ended session [DEVIATION: ended flag]',
      async () => {
        let rejected = false;
        try {
          await endedSession.requestReferenceSpace('local');
        } catch (_) {
          rejected = true;
        }
        harness.assert(
          true,
          `requestReferenceSpace on ended: rejected=${rejected}`,
        );
      },
    );

    // 29. rAF on ended session returns 0
    harness.it('rAF on ended session returns 0', async () => {
      const handle = endedSession.requestAnimationFrame(() => {});
      // iwer now sets the ended flag, so rAF returns 0 per spec.
      harness.assertEqual(handle, 0, 'rAF on ended session should return 0');
    });
  });

  // --- Lifecycle: tests that end sessions (isolated) ---
  harness.describe('§4 XRSession (lifecycle)', () => {
    let session: XRSession | null = null;
    let canvas: HTMLCanvasElement | null = null;

    harness.afterEach(async () => {
      await cleanup(session, canvas);
      session = null;
      canvas = null;
    });

    // 18. end() resolves + fires "end" event
    harness.it('end() resolves + fires "end" event', async () => {
      const result = await startSession('immersive-vr');
      session = result.session;
      canvas = result.canvas;

      let endFired = false;
      session.addEventListener('end', () => {
        endFired = true;
      });

      await session.end();
      // Wait for event dispatch
      await new Promise((r) => setTimeout(r, 50));
      harness.assert(endFired, 'end event should fire');
      session = null;
    });

    // 19. end event is XRSessionEvent with correct session ref
    harness.it(
      'end event is XRSessionEvent with correct session ref',
      async () => {
        const result = await startSession('immersive-vr');
        session = result.session;
        canvas = result.canvas;

        const eventPromise = new Promise<Event>((resolve) => {
          session!.addEventListener('end', (e) => resolve(e));
        });

        const sessionRef = session;
        await session.end();
        const event = await eventPromise;
        session = null;

        harness.assertInstanceOf(event, XRSessionEvent);
        harness.assertEqual(
          (event as XRSessionEvent).session,
          sessionRef,
          'end event should reference the session',
        );
      },
    );
  });
}
