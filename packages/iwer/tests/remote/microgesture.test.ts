/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_JOINT_SPACE, P_SESSION, P_SPACE } from '../../src/private.js';
import { mat4, vec3 } from 'gl-matrix';

import { MICROGESTURES } from '../../src/remote/microgesture.js';
import { REMOTE_METHOD_SCHEMAS } from '../../src/remote/catalog.js';
import { XRDevice } from '../../src/device/XRDevice.js';
import { XRFrame } from '../../src/frameloop/XRFrame.js';
import { XRHandJoint } from '../../src/input/XRHand.js';
import { metaQuest3 } from '../../src/device/configs/headset/meta.js';
import type {
  MicrogestureResult,
  RunSequenceParams,
  SequencePlan,
  SequenceResult,
  SequenceStep,
} from '../../src/remote/types.js';

type Side = 'left' | 'right';

/** Seconds into a gesture: the thumb touches the finger, slides, returns. */
const TOUCH_S = 0.07;
const SWIPE_END_S = 0.18;
const SWIPE_S = 0.32;
const READY_S = 0.25;

describe('microgestures', () => {
  let device: XRDevice;
  let frame: XRFrame;
  let events: { type: string; frame: number }[];
  let frameCount: number;
  /** Per frame and hand: the gamepad buttons the app sees pressed. */
  let seen: Record<Side, number[][]>;

  const setup = () => {
    device = new XRDevice(metaQuest3);
    device.primaryInputMode = 'hand';
    events = [];
    frameCount = 0;
    seen = { left: [], right: [] };
    const session = {
      mode: 'immersive-vr',
      enabledFeatures: [],
      [P_SESSION]: {
        referenceSpaces: [{ [P_SPACE]: { offsetMatrix: mat4.create() } }],
      },
      dispatchEvent: (event: { type: string }) => {
        events.push({ type: event.type, frame: frameCount });
        return true;
      },
    };
    Object.defineProperty(device, 'activeSession', {
      get: () => session,
      configurable: true,
    });
    frame = { session } as unknown as XRFrame;
    device.position.set(0, 1.6, 0);
  };
  beforeEach(setup);

  afterEach(() => {
    device.remote.forceRelease();
  });

  const pressed = (side: Side) =>
    device.hands[side]!.inputSource.gamepad!.buttons.flatMap((button, i) =>
      button?.pressed ? [i] : [],
    );
  // The way XRDevice drives a frame: remote control first, then the inputs.
  const runFrame = (deltaMs = 1000 / 72) => {
    frameCount++;
    device.remote.update(deltaMs);
    device.hands.left!.onFrameStart(frame);
    device.hands.right!.onFrameStart(frame);
    seen.left.push(pressed('left'));
    seen.right.push(pressed('right'));
  };
  /** Runs frames until `promise` settles; `deltas` cycles through frame times. */
  const run = async <T>(
    promise: Promise<unknown>,
    options: { deltas?: number[]; each?: () => void } = {},
  ): Promise<T> => {
    const { deltas = [1000 / 72], each } = options;
    let done = false;
    let value: unknown;
    let error: unknown;
    promise.then(
      (x) => ((done = true), (value = x)),
      (e) => ((done = true), (error = e)),
    );
    for (let i = 0; i < 3000 && !done; i++) {
      runFrame(deltas[i % deltas.length]);
      each?.();
      await Promise.resolve();
    }
    await Promise.resolve();
    if (error) throw error;
    if (!done) throw new Error('did not finish');
    return value as T;
  };
  const dispatch = <T = unknown>(
    method: string,
    params: Record<string, unknown>,
  ) => {
    const promise = device.remote.dispatch(method, params) as Promise<T>;
    promise.catch(() => undefined);
    return promise;
  };
  const microgesture = (side: Side, gesture: string) =>
    dispatch<MicrogestureResult>('microgesture', {
      device: `hand-${side}`,
      gesture,
    });
  const sequence = (params: RunSequenceParams) =>
    dispatch<SequenceResult>(
      'run_sequence',
      params as unknown as Record<string, unknown>,
    );
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  /** Frames on which `button` went down. */
  const presses = (side: Side, button: number) =>
    seen[side].filter(
      (now, i) =>
        now.includes(button) && !(seen[side][i - 1] ?? []).includes(button),
    ).length;
  const framesDown = (side: Side, button: number) =>
    seen[side].filter((now) => now.includes(button)).length;
  /** A joint in the hand's target-ray frame. */
  const local = (side: Side, joint: XRHandJoint) =>
    mat4.getTranslation(
      vec3.create(),
      device.hands[side]!.inputSource.hand!.get(joint)![P_SPACE].offsetMatrix,
    );
  const radius = (side: Side, joint: XRHandJoint) =>
    device.hands[side]!.inputSource.hand!.get(joint)![P_JOINT_SPACE].radius;
  /** How far the thumb tip's surface is from the index's middle bone (< 0: touching). */
  const thumbGap = (side: Side) => {
    const a = local(side, XRHandJoint.IndexFingerPhalanxIntermediate);
    const b = local(side, XRHandJoint.IndexFingerPhalanxDistal);
    const tip = local(side, XRHandJoint.ThumbTip);
    const ab = vec3.sub(vec3.create(), b, a);
    const f = Math.min(
      1,
      Math.max(
        0,
        vec3.dot(vec3.sub(vec3.create(), tip, a), ab) / vec3.dot(ab, ab),
      ),
    );
    const closest = vec3.scaleAndAdd(vec3.create(), a, ab, f);
    return (
      vec3.distance(tip, closest) -
      radius(side, XRHandJoint.IndexFingerPhalanxIntermediate) -
      radius(side, XRHandJoint.ThumbTip)
    );
  };
  const makeReady = (side: Side) => {
    device.hands[side]!.poseId = 'microgesture';
    runFrame();
  };

  describe('the microgesture command', () => {
    test.each(
      (['right', 'left'] as const).flatMap((side) =>
        MICROGESTURES.map((gesture, i) => [side, gesture, 5 + i] as const),
      ),
    )(
      'hand-%s %s pulses button %i for 35 ms, once, with no events',
      async (side, gesture, button) => {
        const result = await run<MicrogestureResult>(
          microgesture(side, gesture),
        );
        expect(result).toEqual({
          device: `hand-${side}`,
          gesture,
          button,
          registeredAtMs: expect.any(Number),
        });
        // 35 ms at 72 Hz is three frames, in one press.
        expect(presses(side, button)).toBe(1);
        expect(framesDown(side, button)).toBe(3);
        expect(seen[side].flat().every((i) => i === button)).toBe(true);
        expect(seen[side === 'left' ? 'right' : 'left'].flat()).toEqual([]);
        expect(events).toEqual([]);
        // It registers once the slide is over, as the thumb lifts: the hand
        // took the pose first (0.25 s).
        const slideEnd = gesture === 'tap' ? 0.09 : SWIPE_END_S;
        expect(result.registeredAtMs).toBeGreaterThan(
          (READY_S + slideEnd) * 1000,
        );
        expect(result.registeredAtMs).toBeLessThan(
          (READY_S + slideEnd + 0.14) * 1000,
        );
        const hand = device.hands[side]!;
        expect(hand.poseId).toBe('microgesture');
        expect(hand.thumbMotion).toBeNull();
        expect(pressed(side)).toEqual([]);
      },
    );

    test.each(['right', 'left'] as const)(
      'the hand-%s thumb slides along the side of the index finger: toward its tip or knuckle, over it or back, or taps',
      async (side) => {
        makeReady(side);
        const restTip = local(side, XRHandJoint.ThumbTip);
        const restGap = thumbGap(side);
        const indexAxis = vec3.normalize(
          vec3.create(),
          vec3.sub(
            vec3.create(),
            local(side, XRHandJoint.IndexFingerPhalanxDistal),
            local(side, XRHandJoint.IndexFingerPhalanxIntermediate),
          ),
        );
        const fingers = device.hands[side]!.handAxes().fingers;
        expect(restGap).toBeGreaterThan(0.005);
        const slides: Record<string, vec3> = {};
        for (const gesture of MICROGESTURES) {
          // 5 ms frames: the samples line up with the gesture's phases.
          let t = 0;
          let touch: vec3 | null = null;
          let slideEnd: vec3 | null = null;
          const gaps: number[] = [];
          let closestToIndexTip = Infinity;
          const end = gesture === 'tap' ? 0.09 : SWIPE_END_S;
          await run(microgesture(side, gesture), {
            deltas: [5],
            each: () => {
              t += 0.005;
              const tip = local(side, XRHandJoint.ThumbTip);
              closestToIndexTip = Math.min(
                closestToIndexTip,
                vec3.distance(tip, local(side, XRHandJoint.IndexFingerTip)),
              );
              if (t >= TOUCH_S - 1e-9 && t <= end + 1e-9) {
                gaps.push(thumbGap(side));
                touch ??= tip;
                slideEnd = tip;
              }
            },
          });
          const slide = vec3.sub(vec3.create(), slideEnd!, touch!);
          slides[gesture] = slide;
          // On the finger's surface (within 2.5 mm) all the way.
          expect([gesture, Math.max(...gaps) < 0.0025]).toEqual([
            gesture,
            true,
          ]);
          expect([gesture, Math.min(...gaps) > -0.0025]).toEqual([
            gesture,
            true,
          ]);
          // Never near enough the index tip for a joint-based pinch (2 cm).
          expect([gesture, closestToIndexTip > 0.02]).toEqual([gesture, true]);
          // Back at rest.
          expect(
            vec3.distance(local(side, XRHandJoint.ThumbTip), restTip),
          ).toBe(0);
        }
        const along = (v: vec3) => vec3.dot(v, indexAxis);
        // Swiping left: the right thumb toward the index tip, the left one
        // toward the knuckle (the user's left either way); right is mirrored.
        const sign = side === 'right' ? 1 : -1;
        expect(sign * along(slides['swipe-left'])).toBeGreaterThan(0.012);
        expect(sign * along(slides['swipe-right'])).toBeLessThan(-0.012);
        // Forward goes over the finger (along the hand's fingers), backward
        // the other way; neither along the bone.
        for (const gesture of ['swipe-forward', 'swipe-backward']) {
          expect(Math.abs(along(slides[gesture]))).toBeLessThan(0.002);
          expect(vec3.length(slides[gesture])).toBeGreaterThan(0.012);
        }
        expect(vec3.dot(slides['swipe-forward'], fingers)).toBeGreaterThan(
          0.005,
        );
        expect(vec3.dot(slides['swipe-backward'], fingers)).toBeLessThan(
          -0.005,
        );
        expect(vec3.length(slides.tap)).toBeLessThan(1e-6);
      },
    );

    test.each<[string, number[], boolean]>([
      ['72 Hz', [1000 / 72], true],
      ['30 Hz', [1000 / 30], true],
      ['10 Hz', [100], true],
      ['10 Hz, taking the pose first', [100], false],
      ['5 Hz (past the device cap)', [200], true],
      ['uneven', [8, 100, 33, 61], false],
    ])(
      'at %s frames the app sees the button go down once, for at least a frame, then up',
      async (_name, deltas, ready) => {
        if (ready) makeReady('right');
        seen.right = [];
        const result = await run<MicrogestureResult>(
          microgesture('right', 'swipe-left'),
          { deltas },
        );
        expect(result.button).toBe(5);
        expect(presses('right', 5)).toBe(1);
        expect(framesDown('right', 5)).toBeGreaterThanOrEqual(1);
        runFrame(deltas[0]);
        expect(pressed('right')).toEqual([]);
        expect(device.hands.right!.thumbMotion).toBeNull();
      },
    );

    test('a hand already in the microgesture pose starts at once', async () => {
      makeReady('right');
      const start = frameCount;
      const result = await run<MicrogestureResult>(
        microgesture('right', 'swipe-forward'),
      );
      expect(result.registeredAtMs).toBeGreaterThan(SWIPE_END_S * 1000);
      expect(result.registeredAtMs).toBeLessThan((SWIPE_END_S + 0.14) * 1000);
      // 0.32 s at 72 Hz.
      expect(frameCount - start).toBeGreaterThanOrEqual(23);
      expect(frameCount - start).toBeLessThanOrEqual(25);
    });

    test('a hand not in the pose takes it first, letting go of a light pinch without selecting', async () => {
      const hand = device.hands.right!;
      hand.poseId = 'fist';
      hand.updatePinchValue(0.4);
      runFrame();
      let faded = false;
      const result = await run<MicrogestureResult>(
        microgesture('right', 'tap'),
        {
          each: () => {
            if (hand.poseTransitionProgress !== null) faded = true;
          },
        },
      );
      expect(faded).toBe(true);
      expect(hand.poseId).toBe('microgesture');
      expect(hand.fingerPoses).toEqual({});
      expect(hand.pinchValue).toBe(0);
      expect(result.registeredAtMs).toBeGreaterThan(READY_S * 1000);
      expect(events).toEqual([]);
    });

    test('a hand that is selecting is asked to let go first', async () => {
      const hand = device.hands.right!;
      hand.updatePinchValue(1);
      runFrame();
      events = [];
      await expect(run(microgesture('right', 'tap'))).rejects.toThrow(
        'hand-right is pinching (select is pressed); let go first',
      );
      expect(hand.pinchValue).toBe(1);
      expect(pressed('right')).toEqual([0]);
      expect(events).toEqual([]);
    });

    test('waits a frame after a select write to the same hand, so a let-go sent just before it counts', async () => {
      const hand = device.hands.right!;
      hand.updatePinchValue(1);
      runFrame();
      events = [];
      const letGo = dispatch('set_select_value', {
        device: 'hand-right',
        value: 0,
      });
      const result = await run<MicrogestureResult>(
        microgesture('right', 'tap'),
      );
      await letGo;
      expect(result.button).toBe(9);
      expect(events.map((e) => e.type)).toEqual(['select', 'selectend']);
    });

    test('is checked at dispatch: a hand device, a known gesture, a session', async () => {
      await expect(microgesture('right', 'pinch')).rejects.toThrow(
        'gesture must be one of swipe-left, swipe-right, swipe-forward, swipe-backward, tap (got "pinch").',
      );
      await expect(
        dispatch('microgesture', {
          device: 'controller-right',
          gesture: 'tap',
        }),
      ).rejects.toThrow("Expected device 'hand-left' or 'hand-right'");
      Object.defineProperty(device, 'activeSession', {
        get: () => undefined,
        configurable: true,
      });
      await expect(microgesture('right', 'tap')).rejects.toThrow(
        "Cannot execute 'microgesture': No active XR session.",
      );
    });

    test('needs a live hand when it reaches the head of the queue', async () => {
      device.primaryInputMode = 'controller';
      await expect(run(microgesture('right', 'tap'))).rejects.toThrow(
        'hand-right is not live: the input mode is controllers.',
      );
      const mode = dispatch('set_input_mode', { mode: 'hand' });
      const result = await run<MicrogestureResult>(
        microgesture('right', 'tap'),
      );
      await mode;
      expect(result.button).toBe(9);
    });

    test.each<[string, () => void, RegExp]>([
      [
        'forceRelease()',
        () => device.remote.forceRelease(),
        /Capture released/,
      ],
      [
        'a switch to manual control',
        () => (device.controlMode = 'manual'),
        /microgesture stopped: remote control let go of the hand/,
      ],
      [
        'the session ending',
        () => device.remote.onSessionEnd(),
        /The XR session ended/,
      ],
    ])(
      '%s mid-press returns the thumb and lifts the button',
      async (_name, interrupt, message) => {
        makeReady('right');
        const promise = microgesture('right', 'swipe-backward');
        for (let i = 0; i < 100 && !pressed('right').includes(8); i++) {
          runFrame();
        }
        expect(pressed('right')).toEqual([8]);
        interrupt();
        runFrame();
        await expect(promise).rejects.toThrow(message);
        runFrame();
        expect(pressed('right')).toEqual([]);
        expect(device.hands.right!.thumbMotion).toBeNull();
      },
    );

    test('is a queued method that needs a session, with a strict schema naming the five gestures', () => {
      expect(device.remote.listMethods()).toContainEqual({
        method: 'microgesture',
        immediate: false,
        requiresSession: true,
      });
      const schema = REMOTE_METHOD_SCHEMAS.microgesture as {
        properties: { gesture: { enum: string[] } };
        required: string[];
        additionalProperties: boolean;
      };
      expect(schema.properties.gesture.enum).toEqual([...MICROGESTURES]);
      expect(schema.required).toEqual(['device', 'gesture']);
      expect(schema.additionalProperties).toBe(false);
    });

    test("counts toward a sequence's time budget while it waits in the queue", async () => {
      const long: RunSequenceParams = {
        device: 'hand-right',
        steps: [{ duration: 24.7 }],
      };
      microgesture('right', 'tap');
      await expect(sequence(long)).rejects.toThrow(
        /after 0\.\d s of commands queued ahead/,
      );
      device.remote.forceRelease();
      // The same sequence alone fits.
      let settled = false;
      sequence(long).then(
        () => (settled = true),
        () => (settled = true),
      );
      await settle();
      expect(settled).toBe(false);
    });
  });

  describe('microgesture steps in run_sequence', () => {
    // The hand raised side-on in front of the chest, ready for microgestures.
    const raise: SequenceStep = {
      label: 'raise',
      position: { relativeTo: 'head', x: 0.12, y: -0.4, z: -0.3 },
      anchor: 'wrist',
      orientation: { fingers: [0, -0.585, -0.811], palm: 'left' },
      poseId: 'microgesture',
    };
    const all: RunSequenceParams = {
      device: 'hand-right',
      steps: [
        raise,
        { label: 'settle', duration: 0.3 },
        { label: 'left', microgesture: 'swipe-left' },
        { label: 'pause', duration: 0.2 },
        { label: 'right', microgesture: 'swipe-right' },
        { label: 'forward', microgesture: 'swipe-forward' },
        { label: 'backward', microgesture: 'swipe-backward' },
        { label: 'tap', microgesture: 'tap' },
      ],
    };

    test('makes microgestures as steps and reports each in events, from the button edges', async () => {
      // The wrist during the first microgesture: still, but never perfectly.
      const wrist: vec3[] = [];
      const result = await run<SequenceResult>(sequence(all), {
        deltas: [1000 / 60],
        each: () => {
          if (device.hands.right!.thumbMotion && wrist.length < 15) {
            wrist.push(vec3.clone(device.hands.right!.anchorOffset('wrist')));
            vec3.transformQuat(
              wrist[wrist.length - 1],
              wrist[wrist.length - 1],
              device.hands.right!.quaternion.quat,
            );
            vec3.add(
              wrist[wrist.length - 1],
              wrist[wrist.length - 1],
              device.hands.right!.position.vec3,
            );
          }
        },
      });
      const drift = Math.max(...wrist.map((p) => vec3.distance(p, wrist[0])));
      expect(drift).toBeGreaterThan(0.0001);
      expect(drift).toBeLessThan(0.005);
      expect(result.completed).toBe(true);
      expect(result.warnings).toEqual([]);
      const gestures = result.events.filter((e) =>
        (MICROGESTURES as readonly string[]).includes(e.type),
      );
      expect(gestures.map((e) => e.type)).toEqual([...MICROGESTURES]);
      expect(result.events).toEqual(gestures);
      // Each is reported within its own step.
      for (const event of gestures) {
        const label = {
          'swipe-left': 'left',
          'swipe-right': 'right',
          'swipe-forward': 'forward',
          'swipe-backward': 'backward',
          tap: 'tap',
        }[event.type]!;
        const step = result.steps.find((s) => s.label === label)!;
        expect(event.t).toBeGreaterThan(step.start);
        expect(event.t).toBeLessThanOrEqual(step.end + 1 / 60 + 1e-6);
      }
      MICROGESTURES.forEach((_, i) => {
        expect(presses('right', 5 + i)).toBe(1);
      });
      expect(events).toEqual([]);
      expect(result.final!.poseId).toBe('microgesture');
      expect(device.hands.right!.thumbMotion).toBeNull();
      runFrame();
      expect(pressed('right')).toEqual([]);
    });

    test('a dry run lists microgesture segments, the hand ready after the step that poses it', async () => {
      const plan = (await sequence({
        ...all,
        dryRun: true,
      })) as unknown as SequencePlan;
      const micro = plan.segments.filter((s) => s.kind === 'microgesture');
      expect(micro.map((s) => s.label)).toEqual([
        'left',
        'right',
        'forward',
        'backward',
        'tap',
      ]);
      expect(micro.map((s) => s.duration)).toEqual([
        SWIPE_S,
        SWIPE_S,
        SWIPE_S,
        SWIPE_S,
        0.23,
      ]);
      // Without the raise step the first one takes the pose first.
      const unready = (await sequence({
        device: 'hand-right',
        steps: [{ microgesture: 'tap' }, { microgesture: 'tap' }],
        dryRun: true,
      })) as unknown as SequencePlan;
      expect(unready.segments.map((s) => s.duration)).toEqual([
        READY_S + 0.23,
        0.23,
      ]);
    });

    test('a microgesture step takes the pose first when the hand is not ready, letting go of a light pinch', async () => {
      const hand = device.hands.right!;
      hand.updatePinchValue(0.3);
      runFrame();
      const result = await run<SequenceResult>(
        sequence({
          device: 'hand-right',
          steps: [{ label: 'tap', microgesture: 'tap' }],
        }),
      );
      expect(result.completed).toBe(true);
      expect(result.events.map((e) => e.type)).toEqual(['tap']);
      const step = result.steps[0];
      expect(step.end - step.start).toBeCloseTo(READY_S + 0.23, 1);
      expect(hand.poseId).toBe('microgesture');
      expect(result.pinchValue).toBe(0);
      expect(events).toEqual([]);
    });

    test('a microgesture step is checked at dispatch: a known gesture, and nothing but a label', async () => {
      await expect(
        sequence({
          device: 'hand-right',
          steps: [{ label: 'tap', microgesture: 'tap', duration: 1 } as never],
        }),
      ).rejects.toThrow(
        "Step 0 ('tap'): a microgesture step takes only a label (got duration)",
      );
      await expect(
        sequence({
          device: 'hand-right',
          steps: [{ microgesture: 'pinch' } as never],
        }),
      ).rejects.toThrow('Step 0: microgesture must be one of swipe-left');
    });

    test('a hand still pinching when the step starts stops the sequence there; a step before it may let go', async () => {
      const failed = await run<SequenceResult>(
        sequence({
          device: 'hand-right',
          idleHand: 'keep',
          steps: [
            { label: 'pinch', pinch: 1, duration: 0.2 },
            { label: 'tap', microgesture: 'tap' },
          ],
        }),
      );
      expect(failed.completed).toBe(false);
      expect(failed.failedStep).toBe(1);
      expect(failed.reason).toMatch(/the hand is pinching/);
      expect(presses('right', 9)).toBe(0);
      // The dry run warns about it.
      const plan = (await sequence({
        device: 'hand-right',
        steps: [{ pinch: 1, duration: 0.2 }, { microgesture: 'tap' }],
        dryRun: true,
      })) as unknown as SequencePlan;
      expect(plan.warnings).toEqual([
        expect.stringMatching(/^Step 1: the hand is pinching/),
      ]);

      // Sent while pinching, with a let-go first: fine.
      const letGo = await run<SequenceResult>(
        sequence({
          device: 'hand-right',
          idleHand: 'keep',
          steps: [
            { label: 'let go', pinch: 0, duration: 0.2 },
            { label: 'tap', microgesture: 'tap' },
          ],
        }),
      );
      expect(letGo.completed).toBe(true);
      expect(letGo.events.map((e) => e.type)).toEqual([
        'select',
        'selectend',
        'tap',
      ]);
    });

    test('cancel_sequence mid-press returns the thumb and lifts the button', async () => {
      makeReady('right');
      const promise = sequence({
        device: 'hand-right',
        steps: [{ microgesture: 'swipe-right' }],
      });
      for (let i = 0; i < 100 && !pressed('right').includes(6); i++) {
        runFrame();
        await Promise.resolve();
      }
      expect(pressed('right')).toEqual([6]);
      const cancel = (await dispatch('cancel_sequence', {})) as {
        cancelled: boolean;
      };
      expect(cancel.cancelled).toBe(true);
      expect((await promise).cancelled).toBe(true);
      runFrame();
      expect(pressed('right')).toEqual([]);
      expect(device.hands.right!.thumbMotion).toBeNull();
    });

    test("a gesture registering on its step's last frame is held for a frame, reported, then lifted", async () => {
      makeReady('right');
      // At 200 ms frames the press lands on the step's last frame (0.4 s).
      const result = await run<SequenceResult>(
        sequence({
          device: 'hand-right',
          idleHand: 'keep',
          gaze: 'fixed',
          steps: [{ microgesture: 'swipe-forward' }],
        }),
        { deltas: [200] },
      );
      expect(result.events.map((e) => e.type)).toEqual(['swipe-forward']);
      expect(framesDown('right', 7)).toBe(1);
      runFrame(200);
      expect(pressed('right')).toEqual([]);
    });

    test('a cancel right after a last-frame press still lifts the button', async () => {
      makeReady('right');
      const promise = sequence({
        device: 'hand-right',
        idleHand: 'keep',
        gaze: 'fixed',
        steps: [{ microgesture: 'swipe-forward' }, { duration: 1 }],
      });
      runFrame(200);
      runFrame(200);
      expect(pressed('right')).toEqual([7]);
      await dispatch('cancel_sequence', {});
      expect((await promise).cancelled).toBe(true);
      runFrame(200);
      expect(pressed('right')).toEqual([]);
    });
  });
});
