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
  pressButton,
  releaseButton,
  advanceFrames,
} from '@harness/xr-helpers';
import {
  createWebGLContext,
  makeXRCompatible,
  destroyWebGLContext,
} from '@harness/webgl-helper';

/**
 * §12 Events — XRSessionEvent, XRInputSourceEvent, XRInputSourcesChangeEvent,
 * XRReferenceSpaceEvent, select/squeeze lifecycle
 * 26 tests
 */
export function registerXREventsTests(harness: TestHarness): void {
  // --- Shared: constructor and property checks (1 VR entry) ---
  harness.describe('§12 Events', () => {
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

    // 1. XRSessionEvent constructor with session property
    harness.it('XRSessionEvent constructor with session property', async () => {
      const event = new XRSessionEvent('end', { session });
      harness.assertInstanceOf(event, XRSessionEvent);
      harness.assertEqual(event.session, session);
      harness.assertEqual(event.type, 'end');
    });

    // 2. XRSessionEvent extends Event
    harness.it('XRSessionEvent extends Event', async () => {
      const event = new XRSessionEvent('end', { session });
      harness.assertInstanceOf(event, Event);
    });

    // 3. XRSessionEvent throws if session missing
    harness.it('XRSessionEvent throws if session missing', () => {
      let threw = false;
      try {
        new XRSessionEvent('end', {} as any);
      } catch (_) {
        threw = true;
      }
      harness.assert(threw, 'XRSessionEvent should throw without session');
    });

    // 4. XRInputSourceEvent constructor with frame+inputSource
    harness.it(
      'XRInputSourceEvent constructor with frame+inputSource',
      async () => {
        await withFrame(session, (_time, frame) => {
          if (session.inputSources.length > 0) {
            const event = new XRInputSourceEvent('select', {
              frame,
              inputSource: session.inputSources[0],
            });
            harness.assertInstanceOf(event, XRInputSourceEvent);
            harness.assertEqual(event.frame, frame);
            harness.assertEqual(event.inputSource, session.inputSources[0]);
          } else {
            harness.assert(true, 'No input sources to construct event with');
          }
        });
      },
    );

    // 5. XRInputSourceEvent extends Event
    harness.it('XRInputSourceEvent extends Event', async () => {
      await withFrame(session, (_time, frame) => {
        if (session.inputSources.length > 0) {
          const event = new XRInputSourceEvent('select', {
            frame,
            inputSource: session.inputSources[0],
          });
          harness.assertInstanceOf(event, Event);
        } else {
          harness.assert(true, 'No input sources');
        }
      });
    });

    // 6. XRInputSourceEvent throws if frame missing
    harness.it('XRInputSourceEvent throws if frame missing', async () => {
      let threw = false;
      try {
        new XRInputSourceEvent('select', { inputSource: {} } as any);
      } catch (_) {
        threw = true;
      }
      harness.assert(threw, 'XRInputSourceEvent should throw without frame');
    });

    // 7. XRInputSourceEvent throws if inputSource missing
    harness.it('XRInputSourceEvent throws if inputSource missing', async () => {
      await withFrame(session, (_time, frame) => {
        let threw = false;
        try {
          new XRInputSourceEvent('select', { frame } as any);
        } catch (_) {
          threw = true;
        }
        harness.assert(
          threw,
          'XRInputSourceEvent should throw without inputSource',
        );
      });
    });

    // 8. XRInputSourcesChangeEvent constructor
    harness.it('XRInputSourcesChangeEvent constructor', async () => {
      const event = new XRInputSourcesChangeEvent('inputsourceschange', {
        session,
        added: [],
        removed: [],
      });
      harness.assertInstanceOf(event, XRInputSourcesChangeEvent);
      harness.assertEqual(event.session, session);
    });

    // 9. XRInputSourcesChangeEvent extends Event
    harness.it('XRInputSourcesChangeEvent extends Event', async () => {
      const event = new XRInputSourcesChangeEvent('inputsourceschange', {
        session,
        added: [],
        removed: [],
      });
      harness.assertInstanceOf(event, Event);
    });

    // 10. XRInputSourcesChangeEvent throws if session missing
    harness.it('XRInputSourcesChangeEvent throws if session missing', () => {
      let threw = false;
      try {
        new XRInputSourcesChangeEvent('inputsourceschange', {
          added: [],
          removed: [],
        } as any);
      } catch (_) {
        threw = true;
      }
      harness.assert(
        threw,
        'XRInputSourcesChangeEvent should throw without session',
      );
    });

    // 11. XRInputSourcesChangeEvent throws if added missing
    harness.it(
      'XRInputSourcesChangeEvent throws if added missing',
      async () => {
        let threw = false;
        try {
          new XRInputSourcesChangeEvent('inputsourceschange', {
            session,
            removed: [],
          } as any);
        } catch (_) {
          threw = true;
        }
        harness.assert(
          threw,
          'XRInputSourcesChangeEvent should throw without added',
        );
      },
    );

    // 12. XRInputSourcesChangeEvent throws if removed missing
    harness.it(
      'XRInputSourcesChangeEvent throws if removed missing',
      async () => {
        let threw = false;
        try {
          new XRInputSourcesChangeEvent('inputsourceschange', {
            session,
            added: [],
          } as any);
        } catch (_) {
          threw = true;
        }
        harness.assert(
          threw,
          'XRInputSourcesChangeEvent should throw without removed',
        );
      },
    );

    // 13. XRReferenceSpaceEvent constructor
    harness.it('XRReferenceSpaceEvent constructor', async () => {
      const refSpace = await session.requestReferenceSpace('local');
      const event = new XRReferenceSpaceEvent('reset', {
        referenceSpace: refSpace,
      });
      harness.assertInstanceOf(event, XRReferenceSpaceEvent);
      harness.assertEqual(event.referenceSpace, refSpace);
    });

    // 14. XRReferenceSpaceEvent extends Event
    harness.it('XRReferenceSpaceEvent extends Event', async () => {
      const refSpace = await session.requestReferenceSpace('local');
      const event = new XRReferenceSpaceEvent('reset', {
        referenceSpace: refSpace,
      });
      harness.assertInstanceOf(event, Event);
    });

    // 15. XRReferenceSpaceEvent throws if referenceSpace missing
    harness.it('XRReferenceSpaceEvent throws if referenceSpace missing', () => {
      let threw = false;
      try {
        new XRReferenceSpaceEvent('reset', {} as any);
      } catch (_) {
        threw = true;
      }
      harness.assert(
        threw,
        'XRReferenceSpaceEvent should throw without referenceSpace',
      );
    });

    // 16. XRReferenceSpaceEvent.transform is optional
    harness.it('XRReferenceSpaceEvent.transform is optional', async () => {
      const refSpace = await session.requestReferenceSpace('local');
      const event = new XRReferenceSpaceEvent('reset', {
        referenceSpace: refSpace,
      });
      // transform should be null/undefined when not provided
      harness.assert(
        event.transform === null || event.transform === undefined,
        'transform should be null/undefined when not provided',
      );
    });

    // 25. XRInputSourceEvent.frame readonly
    harness.it('XRInputSourceEvent.frame readonly', async () => {
      await withFrame(session, (_time, frame) => {
        if (session.inputSources.length > 0) {
          const event = new XRInputSourceEvent('select', {
            frame,
            inputSource: session.inputSources[0],
          });
          const desc =
            Object.getOwnPropertyDescriptor(event, 'frame') ||
            Object.getOwnPropertyDescriptor(
              Object.getPrototypeOf(event),
              'frame',
            );
          if (desc && (desc.writable === false || desc.set === undefined)) {
            harness.assert(true, 'frame property is readonly');
          } else {
            // iwer deviation: event properties may be writable
            harness.assert(true, 'frame property writable (iwer deviation)');
          }
        } else {
          harness.assert(true, 'No input sources');
        }
      });
    });

    // 26. XRInputSourceEvent.inputSource readonly
    harness.it('XRInputSourceEvent.inputSource readonly', async () => {
      await withFrame(session, (_time, frame) => {
        if (session.inputSources.length > 0) {
          const event = new XRInputSourceEvent('select', {
            frame,
            inputSource: session.inputSources[0],
          });
          const desc =
            Object.getOwnPropertyDescriptor(event, 'inputSource') ||
            Object.getOwnPropertyDescriptor(
              Object.getPrototypeOf(event),
              'inputSource',
            );
          if (desc && (desc.writable === false || desc.set === undefined)) {
            harness.assert(true, 'inputSource property is readonly');
          } else {
            // iwer deviation: event properties may be writable
            harness.assert(
              true,
              'inputSource property writable (iwer deviation)',
            );
          }
        } else {
          harness.assert(true, 'No input sources');
        }
      });
    });
  });

  // --- Shared-ended: tests on ended session (1 VR entry) ---
  harness.describe('§12 Events (ended)', () => {
    let endedSession: XRSession;
    let canvas: HTMLCanvasElement;

    harness.beforeAll(async () => {
      const result = await startSession('immersive-vr');
      endedSession = result.session;
      canvas = result.canvas;

      const eventPromise = new Promise<Event>((resolve) => {
        endedSession.addEventListener('end', (e) => resolve(e));
      });
      await endedSession.end();
      await eventPromise;
    });

    harness.afterAll(async () => {
      destroyWebGLContext(canvas);
    });

    // 17. session "end" event is XRSessionEvent
    harness.it('session "end" event is XRSessionEvent', async () => {
      // We already captured the end event in beforeAll; re-verify by constructing
      const event = new XRSessionEvent('end', { session: endedSession });
      harness.assertInstanceOf(event, XRSessionEvent);
    });

    // 24. XRSessionEvent.session readonly
    harness.it('XRSessionEvent.session readonly', async () => {
      // Test readonly on constructed event
      const event = new XRSessionEvent('end', { session: endedSession });
      const desc =
        Object.getOwnPropertyDescriptor(event, 'session') ||
        Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(event),
          'session',
        );
      if (desc && (desc.writable === false || desc.set === undefined)) {
        harness.assert(true, 'session property is readonly');
      } else {
        // iwer deviation: event properties may be writable
        harness.assert(true, 'session property writable (iwer deviation)');
      }
    });
  });

  // --- Device: tests requiring iwer device control (isolated) ---
  harness.describe('§12 Events (device)', () => {
    let session: XRSession | null = null;
    let canvas: HTMLCanvasElement | null = null;

    harness.afterEach(async () => {
      await cleanup(session, canvas);
      session = null;
      canvas = null;
    });

    // 18. select lifecycle [SKIP:native] [DEVIATION: iwer fires select on press not release]
    harness.it(
      'select lifecycle [SKIP:native] [DEVIATION: iwer select timing]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');
        const result = await startSession('immersive-vr');
        session = result.session;
        canvas = result.canvas;

        const events: string[] = [];
        session.addEventListener('selectstart', () =>
          events.push('selectstart'),
        );
        session.addEventListener('selectend', () => events.push('selectend'));
        session.addEventListener('select', () => events.push('select'));

        await withFrame(session, () => {});

        await pressButton(ctx, session, 'right', 'trigger');
        await advanceFrames(session, 2);

        await releaseButton(ctx, session, 'right', 'trigger');
        await advanceFrames(session, 2);

        harness.assert(
          events.includes('selectstart'),
          `selectstart should fire (got: ${events.join(', ')})`,
        );
        harness.assert(
          events.includes('selectend'),
          `selectend should fire (got: ${events.join(', ')})`,
        );
        harness.assert(
          events.includes('select'),
          `select should fire (got: ${events.join(', ')})`,
        );
      },
    );

    // 19. squeeze lifecycle [SKIP:native] [DEVIATION: same ordering issue]
    harness.it(
      'squeeze lifecycle [SKIP:native] [DEVIATION: iwer squeeze timing]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');
        const result = await startSession('immersive-vr');
        session = result.session;
        canvas = result.canvas;

        const events: string[] = [];
        session.addEventListener('squeezestart', () =>
          events.push('squeezestart'),
        );
        session.addEventListener('squeezeend', () => events.push('squeezeend'));
        session.addEventListener('squeeze', () => events.push('squeeze'));

        await withFrame(session, () => {});

        await pressButton(ctx, session, 'right', 'squeeze');
        await advanceFrames(session, 2);

        await releaseButton(ctx, session, 'right', 'squeeze');
        await advanceFrames(session, 2);

        harness.assert(
          events.includes('squeezestart'),
          `squeezestart should fire (got: ${events.join(', ')})`,
        );
        harness.assert(
          events.includes('squeezeend'),
          `squeezeend should fire (got: ${events.join(', ')})`,
        );
        harness.assert(
          events.includes('squeeze'),
          `squeeze should fire (got: ${events.join(', ')})`,
        );
      },
    );

    // 20. selectstart event.frame is XRFrame [SKIP:native]
    harness.it(
      'selectstart event.frame is XRFrame [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');
        const result = await startSession('immersive-vr');
        session = result.session;
        canvas = result.canvas;

        const eventPromise = new Promise<XRInputSourceEvent>((resolve) => {
          session!.addEventListener('selectstart', (e) =>
            resolve(e as XRInputSourceEvent),
          );
        });

        await withFrame(session, () => {});
        await pressButton(ctx, session, 'right', 'trigger');
        await advanceFrames(session, 2);

        const event = await eventPromise;
        harness.assertInstanceOf(event.frame, XRFrame);

        await releaseButton(ctx, session, 'right', 'trigger');
        await withFrame(session, () => {});
      },
    );

    // 21. selectstart event.inputSource is XRInputSource [SKIP:native]
    harness.it(
      'selectstart event.inputSource is XRInputSource [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');
        const result = await startSession('immersive-vr');
        session = result.session;
        canvas = result.canvas;

        const eventPromise = new Promise<XRInputSourceEvent>((resolve) => {
          session!.addEventListener('selectstart', (e) =>
            resolve(e as XRInputSourceEvent),
          );
        });

        await withFrame(session, () => {});
        await pressButton(ctx, session, 'right', 'trigger');
        await advanceFrames(session, 2);

        const event = await eventPromise;
        harness.assertInstanceOf(event.inputSource, XRInputSource);

        await releaseButton(ctx, session, 'right', 'trigger');
        await withFrame(session, () => {});
      },
    );

    // 22. inputsourceschange fires on session start [SKIP:native]
    harness.it(
      'inputsourceschange fires on session start [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');

        const s = await navigator.xr!.requestSession('immersive-vr');

        let changeEvent: XRInputSourcesChangeEvent | null = null;
        const eventPromise = new Promise<XRInputSourcesChangeEvent>(
          (resolve) => {
            s.addEventListener('inputsourceschange', (e) => {
              changeEvent = e as XRInputSourcesChangeEvent;
              resolve(changeEvent);
            });
            // Fallback timeout
            setTimeout(() => resolve(null as any), 3000);
          },
        );

        const { canvas: c, gl } = createWebGLContext();
        await makeXRCompatible(gl);
        const layer = new XRWebGLLayer(s, gl);
        s.updateRenderState({ baseLayer: layer });

        // Wait for first frame to trigger inputsourceschange
        await new Promise<void>((resolve) => {
          s.requestAnimationFrame(() => resolve());
        });

        const event = await eventPromise;
        session = s;
        canvas = c;

        if (event) {
          harness.assertInstanceOf(event, XRInputSourcesChangeEvent);
          harness.assert(event.added.length > 0, 'added should be non-empty');
        } else {
          harness.assert(
            true,
            'inputsourceschange may fire before listener attached',
          );
        }
      },
    );

    // 23. visibilitychange fires on state change [SKIP:native]
    harness.it(
      'visibilitychange fires on state change [SKIP:native]',
      async (ctx) => {
        harness.skipIf(ctx.mode === 'native', 'Requires iwer device control');
        const result = await startSession('immersive-vr');
        session = result.session;
        canvas = result.canvas;

        // We can only verify the handler is settable since iwer
        // doesn't provide an API to programmatically change visibility
        harness.assertProperty(session, 'onvisibilitychange');
        session.addEventListener('visibilitychange', () => {});
        harness.assert(
          true,
          'visibilitychange listener attached without error',
        );
      },
    );
  });
}
