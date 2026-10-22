/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_JOINT_SPACE, P_SESSION, P_SPACE } from '../../src/private.js';
import { mat4, quat, vec3 } from 'gl-matrix';

import { REMOTE_METHOD_SCHEMAS } from '../../src/remote/catalog.js';
import { XRDevice } from '../../src/device/XRDevice.js';
import { XRFrame } from '../../src/frameloop/XRFrame.js';
import { XRHandJoint } from '../../src/input/XRHand.js';
import { ease } from '../../src/remote/hand-motion.js';
import { metaQuest3 } from '../../src/device/configs/headset/meta.js';
import type {
  CancelSequenceResult,
  ResolvedTarget,
  RunSequenceParams,
  SequencePlan,
  SequenceResult,
  SequenceStep,
  TargetResolver,
} from '../../src/remote/types.js';

type Side = 'left' | 'right';
type Box = { min: number[]; max: number[]; normal?: number[] };

const v = (a: ArrayLike<number>) => ({ x: a[0], y: a[1], z: a[2] });

/** The scene of the plan's scenario: a button, a piece with a knob, a tray. */
const sceneBoxes = (): Record<string, Box> => ({
  button: { min: [-0.04, 0.95, -0.54], max: [0.04, 0.99, -0.46] },
  piece: { min: [-0.2225, 0.94, -0.4225], max: [-0.1775, 1.0, -0.3775] },
  tray: { min: [0.125, 0.936, -0.455], max: [0.275, 0.956, -0.305] },
});

/**
 * A resolver over axis-aligned boxes: the surface point is the centre of the
 * face with the given normal (default up), the box is the box.
 */
const boxResolver = (
  boxes: Record<string, Box>,
  calls?: { target: unknown; intent: string; anchor: string }[],
): TargetResolver => ({
  resolve(target, context) {
    calls?.push({ target, intent: context.intent, anchor: context.anchor });
    const name = typeof target === 'string' ? target : target.name;
    const box = boxes[name];
    if (!box) return null;
    const normal = box.normal ?? [0, 1, 0];
    const center = box.min.map((m, i) => (m + box.max[i]) / 2);
    const position = center.map((c, i) =>
      normal[i] > 0 ? box.max[i] : normal[i] < 0 ? box.min[i] : c,
    );
    const resolved: ResolvedTarget = {
      name,
      position: v(position),
      normal: v(normal),
      box: { min: v(box.min), max: v(box.max) },
    };
    return resolved;
  },
  list() {
    return Object.entries(boxes).map(([name, box]) => ({
      name,
      position: v(box.min.map((m, i) => (m + box.max[i]) / 2)),
      size: v(box.min.map((m, i) => box.max[i] - m)),
    }));
  },
});

/** Distance from a point to a box (0 inside), as a touch pointer measures it. */
const boxDistance = (p: vec3, box: Box) =>
  Math.hypot(
    ...[0, 1, 2].map((i) => Math.max(box.min[i] - p[i], 0, p[i] - box.max[i])),
  );

const scenario: RunSequenceParams = {
  device: 'hand-right',
  steps: [
    { label: 'press', target: 'button', press: {} },
    {
      label: 'grab',
      target: 'piece',
      poseId: 'default',
      approach: { distance: 0.06 },
      pinch: { value: 1, at: 'arrival' },
    },
    {
      label: 'carry',
      target: 'tray',
      depart: { distance: 0.06 },
      approach: { distance: 0.06 },
    },
    { label: 'let go', pinch: 0, duration: 0.2 },
    {
      label: 'thumbs up',
      position: { relativeTo: 'head', x: 0.14, y: -0.3, z: -0.38 },
      anchor: 'wrist',
      orientation: { fingers: 'forward', thumb: 'up' },
      poseId: 'thumbs-up',
    },
  ],
};

describe('run_sequence', () => {
  let device: XRDevice;
  let frame: XRFrame;
  /** Session events, with the frame they were dispatched on. */
  let events: { type: string; frame: number }[];
  let frameCount: number;
  let boxes: Record<string, Box>;

  /** A fresh device in hand mode, with the scene's resolver. */
  const setup = () => {
    device = new XRDevice(metaQuest3);
    device.primaryInputMode = 'hand';
    events = [];
    frameCount = 0;
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
    boxes = sceneBoxes();
    device.remote.setTargetResolver(boxResolver(boxes));
  };
  beforeEach(setup);

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    device.remote.forceRelease();
  });

  // The way XRDevice drives a frame: remote control first, then the inputs.
  const runFrame = (deltaMs = 1000 / 60) => {
    frameCount++;
    device.remote.update(deltaMs);
    device.hands.left!.onFrameStart(frame);
    device.hands.right!.onFrameStart(frame);
  };
  /**
   * Runs frames until `promise` settles. `deltas` cycles through frame times;
   * `each` runs after every frame.
   */
  const run = async <T>(
    promise: Promise<unknown>,
    options: { deltas?: number[]; each?: () => void; frames?: number } = {},
  ): Promise<T> => {
    const { deltas = [1000 / 60], each, frames = 3000 } = options;
    let done = false;
    let value: unknown;
    let error: unknown;
    promise.then(
      (x) => ((done = true), (value = x)),
      (e) => ((done = true), (error = e)),
    );
    for (let i = 0; i < frames && !done; i++) {
      runFrame(deltas[i % deltas.length]);
      each?.();
      await Promise.resolve();
    }
    await Promise.resolve();
    if (error) throw error;
    if (!done) throw new Error('did not finish');
    return value as T;
  };
  /** dispatch(), with rejections the test doesn't wait for left handled. */
  const dispatch = <T = unknown>(
    method: string,
    params: Record<string, unknown>,
  ) => {
    const promise = device.remote.dispatch(method, params) as Promise<T>;
    promise.catch(() => undefined);
    return promise;
  };
  const sequence = (params: RunSequenceParams) =>
    dispatch<SequenceResult>(
      'run_sequence',
      params as unknown as Record<string, unknown>,
    );
  /** Lets promise callbacks run. */
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const steps = (...list: SequenceStep[]): RunSequenceParams => ({
    device: 'hand-right',
    steps: list,
  });

  /** A joint's position in GlobalSpace. */
  const jointOf = (side: Side, joint: XRHandJoint) => {
    const hand = device.hands[side]!;
    const local = hand.inputSource.hand!.get(joint)![P_SPACE].offsetMatrix;
    const ray = hand.inputSource.targetRaySpace[P_SPACE].offsetMatrix;
    return mat4.getTranslation(
      vec3.create(),
      mat4.multiply(mat4.create(), ray, local),
    );
  };
  const tipOf = (side: Side = 'right') =>
    jointOf(side, XRHandJoint.IndexFingerTip);
  /** Angle (degrees) between where the headset looks and `point`. */
  const offGaze = (point: ArrayLike<number>) => {
    const forward = vec3.transformQuat(
      vec3.create(),
      [0, 0, -1],
      device.quaternion.quat,
    );
    const to = vec3.normalize(
      vec3.create(),
      vec3.sub(vec3.create(), point as vec3, device.position.vec3),
    );
    return (Math.acos(Math.min(1, vec3.dot(forward, to))) * 180) / Math.PI;
  };

  describe('the scenario', () => {
    test('runs press, grab, carry, let go and thumbs up, reporting the select events the app saw', async () => {
      const result = await run<SequenceResult>(sequence(scenario));
      expect(result.reason).toBeUndefined();
      expect(result.completed).toBe(true);
      expect(result.cancelled).toBe(false);
      expect(result.steps.map((s) => s.label)).toEqual([
        'press',
        'grab',
        'carry',
        'let go',
        'thumbs up',
      ]);
      const types = ['selectstart', 'select', 'selectend'];
      expect(events.map((e) => e.type)).toEqual(types);
      expect(result.events.map((e) => e.type)).toEqual(types);
      // The grab lands as the hand arrives; the let go releases it.
      const [, grab, , letGo] = result.steps;
      expect(result.events[0].t).toBeGreaterThan(grab.start);
      expect(result.events[0].t).toBeLessThanOrEqual(grab.end + 0.02);
      expect(result.events[1].t).toBeGreaterThanOrEqual(letGo.start);
      expect(result.events[1].t).toBeLessThanOrEqual(letGo.end + 0.02);
      // Steps follow each other on sequence time.
      for (let i = 1; i < result.steps.length; i++) {
        expect(result.steps[i].start).toBeCloseTo(result.steps[i - 1].end, 3);
      }
      expect(result.presses).toHaveLength(1);
      expect(result.warnings).toEqual([]);
      expect(result.pinchValue).toBe(0);
      expect(result.final!.poseId).toBe('thumbs-up');
      expect(result.final!.pin!.anchor).toBe('wrist');
      expect(device.hands.right!.poseId).toBe('thumbs-up');
    });

    test('the piece ends on the tray: the grasp point sets its base down on the tray floor', async () => {
      const result = await run<SequenceResult>(
        sequence({ ...scenario, steps: scenario.steps.slice(1, 3) }),
      );
      // The knob's top is 6 cm above the piece's base; the tray floor is at
      // 0.956; 0.5 mm clearance.
      expect(result.final!.anchors.grasp.y).toBeCloseTo(
        0.956 + 0.06 + 0.0005,
        3,
      );
      expect(result.final!.anchors.grasp.x).toBeCloseTo(0.2, 2);
      expect(result.final!.anchors.grasp.z).toBeCloseTo(-0.38, 2);
    });

    test('a hand that already holds something keeps holding when it pinches on arrival again', async () => {
      const result = await run<SequenceResult>(
        sequence(
          steps(scenario.steps[1], {
            target: 'tray',
            pinch: { value: 1, at: 'arrival' },
          }),
        ),
      );
      expect(result.completed).toBe(true);
      expect(events.map((e) => e.type)).toEqual(['selectstart']);
    });

    test('the resolver is told why each target is wanted', async () => {
      const calls: { target: unknown; intent: string; anchor: string }[] = [];
      device.remote.setTargetResolver(boxResolver(boxes, calls));
      await run(sequence(scenario));
      // Dispatch resolves every target to plan; each step resolves again.
      const atRun = calls.slice(calls.length / 2);
      expect(atRun.map((c) => [c.target, c.intent, c.anchor])).toEqual([
        ['button', 'press', 'index-tip'],
        ['piece', 'grasp', 'grasp'],
        ['tray', 'place', 'grasp'],
      ]);
    });
  });

  describe('timing', () => {
    test('uneven frame times give the same steps, the same motion and the same events', async () => {
      const smooth = await run<SequenceResult>(sequence(scenario));
      const smoothHand = vec3.clone(device.hands.right!.position.vec3);
      const smoothEvents = events.map((e) => e.type);
      device.remote.forceRelease();
      setup();
      const uneven = await run<SequenceResult>(sequence(scenario), {
        deltas: [8, 33, 100, 16, 61, 4, 100, 25],
      });
      expect(uneven.completed).toBe(true);
      expect(uneven.steps.map((s) => [s.label, s.start, s.end])).toEqual(
        smooth.steps.map((s) => [s.label, s.start, s.end]),
      );
      expect(events.map((e) => e.type)).toEqual(smoothEvents);
      uneven.events.forEach((event, i) => {
        expect(event.type).toBe(smooth.events[i].type);
        expect(Math.abs(event.t - smooth.events[i].t)).toBeLessThanOrEqual(0.1);
      });
      expect(
        vec3.distance(device.hands.right!.position.vec3, smoothHand),
      ).toBeLessThan(1e-4);
    });

    test("shows each step's end for a frame and carries the frame's leftover time into the next step and the next command", async () => {
      const a = [0.15, 1.2, -0.4];
      const b = [0.25, 1.2, -0.35];
      const placed = {
        anchor: 'wrist' as const,
        orientation: { fingers: 'forward' as const, palm: 'down' as const },
      };
      const done = sequence({
        ...steps(
          {
            position: a as [number, number, number],
            duration: 0.25,
            ...placed,
          },
          { position: b as [number, number, number], duration: 0.3 },
        ),
        gaze: 'fixed',
        body: 'fixed',
        idleHand: 'keep',
      });
      // Queued behind it: a controller animation, linear over 0.3 s.
      const controller = device.controllers.left!;
      controller.position.set(0, 1, -0.3);
      const next = dispatch('animate_to', {
        device: 'controller-left',
        position: { x: 0.3, y: 1, z: -0.3 },
        duration: 0.3,
      });
      let resolved = false;
      done.then(() => (resolved = true));
      const wrist = () => jointOf('right', XRHandJoint.Wrist);
      runFrame(100);
      runFrame(100);
      runFrame(100); // step 0 ends at 0.25 s, 0.05 s left over
      expect(vec3.distance(wrist(), a as vec3)).toBeLessThan(1e-4);
      runFrame(100); // step 1 gets 0.05 + 0.1 s
      const expected = vec3.lerp(
        vec3.create(),
        a as vec3,
        b as vec3,
        ease('reach', 0.15 / 0.3),
      );
      expect(vec3.distance(wrist(), expected)).toBeLessThan(1e-4);
      runFrame(100);
      runFrame(100); // step 1 ends at 0.55 s, 0.05 s left over
      expect(vec3.distance(wrist(), b as vec3)).toBeLessThan(1e-4);
      await settle();
      expect(resolved).toBe(false); // the end is shown for a frame first
      runFrame(100); // resolves; the animation gets 0.05 + 0.1 s
      await settle();
      expect(resolved).toBe(true);
      expect(controller.position.x).toBeCloseTo(0.15, 5);
      const result = await done;
      expect(result.steps.map((s) => [s.start, s.end])).toEqual([
        [0, 0.25],
        [0.25, 0.55],
      ]);
      await run(next);
    });

    test('a press and the release that follows it land on different frames', async () => {
      const result = await run<SequenceResult>(
        sequence(
          steps(
            { pinch: 1, duration: 0.05 },
            { pinch: 0, duration: 0 },
            { duration: 0.1 },
          ),
        ),
        { deltas: [100] },
      );
      expect(events.map((e) => e.type)).toEqual([
        'selectstart',
        'select',
        'selectend',
      ]);
      expect(events[1].frame).toBeGreaterThan(events[0].frame);
      expect(result.events.map((e) => e.type)).toEqual([
        'selectstart',
        'select',
        'selectend',
      ]);
    });

    test('gives up 28 s after dispatch with the steps done so far, letting go of nothing but its channels', async () => {
      let now = 1000;
      jest.spyOn(performance, 'now').mockImplementation(() => now);
      const done = sequence(scenario);
      for (let i = 0; i < 100; i++) runFrame();
      now += device.remote.SEQUENCE_DEADLINE_MS + 1;
      const result = await run<SequenceResult>(done);
      expect(result.completed).toBe(false);
      expect(result.reason).toBe('deadline');
      expect(result.steps.length).toBeGreaterThan(0);
      // The hand stays where it was, pinned.
      expect(device.hands.right!.pin).not.toBeNull();
    });

    test('checks the time budget at dispatch, counting what is queued ahead', async () => {
      const hold = { duration: 1.5 };
      await expect(
        sequence(steps(...Array.from({ length: 18 }, () => hold))),
      ).rejects.toThrow(/about 27\.0 s; keep it under 25 s/);
      const long = dispatch('animate_to', {
        device: 'controller-left',
        position: { x: 0, y: 1, z: -1 },
        duration: 22,
      });
      await expect(sequence(scenario)).rejects.toThrow(
        /after 22\.0 s of commands queued ahead/,
      );
      // Time already run counts off what is queued.
      for (let i = 0; i < 150; i++) runFrame(100);
      const done = sequence(scenario);
      await run(long);
      expect((await run<SequenceResult>(done)).completed).toBe(true);
    });
  });

  describe('stopping', () => {
    const untilPressed = async () => {
      for (let i = 0; i < 600; i++) {
        runFrame();
        await Promise.resolve();
        if (device.hands.right!.inputSource.gamepad!.buttons[0]!.pressed) {
          return;
        }
      }
      throw new Error('never pinched');
    };

    test('cancel_sequence stops at once: fades, ramps and pins let go, the pinch left as it is', async () => {
      const done = sequence(scenario);
      await untilPressed();
      runFrame();
      device.hands.right!.beginPoseTransition('fist');
      const cancel = (await device.remote.dispatch(
        'cancel_sequence',
        {},
      )) as CancelSequenceResult;
      expect(cancel.cancelled).toBe(true);
      const result = await done;
      expect(cancel.sequence).toBe(result);
      expect(result.completed).toBe(false);
      expect(result.cancelled).toBe(true);
      expect(result.reason).toBe('cancelled');
      expect(result.steps.map((s) => s.label)).toEqual(['press', 'grab']);
      const pinch = device.hands.right!.pinchValue;
      expect(pinch).toBeGreaterThanOrEqual(0.9);
      expect(result.pinchValue).toBe(pinch);
      expect(result.final!.pin).toBeNull();
      const hand = device.hands.right!;
      expect(hand.pin).toBeNull();
      expect(device.hands.left!.pin).toBeNull();
      expect(hand.poseTransitionProgress).toBeNull();
      // The pinch stays closed: no events.
      const seen = events.length;
      for (let i = 0; i < 10; i++) runFrame();
      expect(events.length).toBe(seen);
      expect(hand.pinchValue).toBe(pinch);
      expect(hand.inputSource.gamepad!.buttons[0]!.pressed).toBe(true);
    });

    test('cancel_sequence without a running sequence cancels nothing', async () => {
      expect(await device.remote.dispatch('cancel_sequence', {})).toEqual({
        cancelled: false,
      });
      // Asking takes no control of the device.
      expect(device.remote.isCaptured).toBe(false);
      // A sequence still waiting behind another command is not running.
      const ahead = dispatch('animate_to', {
        device: 'controller-left',
        position: { x: 0, y: 1, z: -1 },
        duration: 0.2,
      });
      const done = sequence(steps({ duration: 0.1 }));
      runFrame();
      expect(await device.remote.dispatch('cancel_sequence', {})).toEqual({
        cancelled: false,
      });
      await run(ahead);
      expect((await run<SequenceResult>(done)).completed).toBe(true);
    });

    test.each([
      ['forceRelease()', 'released', () => device.remote.forceRelease()],
      [
        'the session ending',
        'session-ended',
        () => device.remote.onSessionEnd(),
      ],
    ])(
      '%s resolves a running sequence with what it did and rejects the commands behind it',
      async (_name, reason, stop) => {
        const done = sequence(scenario);
        const behind = dispatch('set_select_value', {
          device: 'hand-right',
          value: 0,
        });
        await untilPressed();
        stop();
        const result = await done;
        expect(result.completed).toBe(false);
        expect(result.cancelled).toBe(true);
        expect(result.reason).toBe(reason);
        expect(result.steps.length).toBe(2);
        await expect(behind).rejects.toThrow();
        expect(device.hands.right!.pin).toBeNull();
      },
    );

    test('a switch to manual control mid-sequence stops it as released', async () => {
      const done = sequence(scenario);
      for (let i = 0; i < 30; i++) runFrame();
      device.controlMode = 'manual';
      const result = await run<SequenceResult>(done);
      expect(result.completed).toBe(false);
      expect(result.reason).toBe('released');
      expect(result.failedStep).toBe(0);
      expect(device.hands.right!.pin).toBeNull();
    });

    test('forceRelease also cancels the pinch: the app sees selectend alone', async () => {
      const done = sequence(scenario);
      await untilPressed();
      device.remote.forceRelease();
      const result = await done;
      expect(result.pinchValue).toBe(0);
      runFrame();
      expect(events.map((e) => e.type)).toEqual(['selectstart', 'selectend']);
    });

    test('the queue watchdog resolves a sequence whose frames stopped as stalled', async () => {
      jest.useFakeTimers();
      const done = sequence(scenario);
      for (let i = 0; i < 20; i++) runFrame();
      jest.advanceTimersByTime(device.remote.ACTION_TIMEOUT_MS + 1);
      const result = await done;
      expect(result.reason).toBe('stalled');
      expect(result.cancelled).toBe(true);
    });

    test('other commands wait behind a running sequence; queries answer at once', async () => {
      const done = sequence(steps({ duration: 0.5 }));
      const pose = dispatch('set_hand_pose', {
        device: 'hand-right',
        poseId: 'fist',
      });
      let posed = false;
      pose.then(() => (posed = true));
      runFrame(100);
      await Promise.resolve();
      const state = (await device.remote.dispatch('get_hand_state', {
        device: 'hand-right',
      })) as { poseId: string };
      expect(state.poseId).toBe('default');
      expect(posed).toBe(false);
      await run(done);
      await run(pose);
      expect(device.hands.right!.poseId).toBe('fist');
    });
  });

  describe('targets', () => {
    test('an unknown target is rejected at dispatch, listing the closest names', async () => {
      await expect(
        sequence(steps({ target: 'buton', anchor: 'index-tip' })),
      ).rejects.toThrow(/Unknown target 'buton'\. Known targets: button, /);
    });

    test('targets are resolved again when their step starts', async () => {
      const done = sequence({ ...scenario, steps: scenario.steps.slice(0, 2) });
      // The piece moves 10 cm after the sequence was sent.
      boxes.piece.min[0] += 0.1;
      boxes.piece.max[0] += 0.1;
      const result = await run<SequenceResult>(done);
      expect(result.final!.anchors.grasp.x).toBeCloseTo(-0.1, 2);
    });

    test('a target that is gone when its step starts stops the sequence there, the pinch left as it is', async () => {
      const done = sequence({ ...scenario, steps: scenario.steps.slice(0, 3) });
      let removed = false;
      const result = await run<SequenceResult>(done, {
        each: () => {
          if (!removed && device.hands.right!.pinchValue === 1) {
            delete boxes.tray;
            removed = true;
          }
        },
      });
      expect(result.completed).toBe(false);
      expect(result.failedStep).toBe(2);
      expect(result.reason).toMatch(/Unknown target 'tray'/);
      expect(result.pinchValue).toBe(1);
      expect(device.hands.right!.pinchValue).toBe(1);
    });

    test('list_targets reports the resolver, or that there is none, and targets need one', async () => {
      expect(await device.remote.dispatch('list_targets', {})).toEqual({
        resolver: true,
        targets: boxResolver(boxes).list!(),
      });
      device.remote.setTargetResolver(null);
      expect(await device.remote.dispatch('list_targets', {})).toEqual({
        resolver: false,
        targets: [],
      });
      await expect(
        sequence(steps({ target: 'button', press: {} })),
      ).rejects.toThrow(/target resolver/);
    });
  });

  describe('press', () => {
    // A 2 cm touch pointer at the index tip joint, no hysteresis, on the
    // target's box (0 inside it); a click is down then up within 800 ms.
    test.each([
      ['the top of a button', 'button', sceneBoxes().button],
      [
        'a thin vertical panel',
        'panel',
        {
          min: [0.05, 1.15, -0.454],
          max: [0.25, 1.3, -0.45],
          normal: [0, 0, 1],
        },
      ],
    ])(
      'presses %s once: one touch down and up within 350 ms, %s',
      async (_name, name, box) => {
        boxes[name] = box;
        let down = false;
        let downs = 0;
        let ups = 0;
        let downFrames = 0;
        let deepest = 0;
        const normal = vec3.fromValues(
          ...((box.normal ?? [0, 1, 0]) as [number, number, number]),
        );
        const surface = vec3.fromValues(
          ...([0, 1, 2].map((i) =>
            normal[i] > 0 ? box.max[i] : normal[i] < 0 ? box.min[i] : 0,
          ) as [number, number, number]),
        );
        const result = await run<SequenceResult>(
          sequence(steps({ target: name, press: {} })),
          {
            each: () => {
              const tip = tipOf();
              const touching = boxDistance(tip, box) <= 0.02;
              if (touching && !down) downs++;
              if (!touching && down) ups++;
              if (touching) downFrames++;
              down = touching;
              // How far the fingertip pad goes past the surface.
              const radius = device.hands.right!.inputSource.hand!.get(
                XRHandJoint.IndexFingerTip,
              )![P_JOINT_SPACE].radius;
              const offset = vec3.sub(vec3.create(), tip, surface);
              deepest = Math.max(deepest, radius - vec3.dot(offset, normal));
            },
          },
        );
        expect(result.completed).toBe(true);
        expect([downs, ups]).toEqual([1, 1]);
        expect(downFrames / 60).toBeLessThanOrEqual(0.35 + 1 / 60);
        expect(result.presses).toHaveLength(1);
        expect(result.presses[0].contactMs).not.toBeNull();
        expect(deepest).toBeGreaterThan(0.005);
        expect(deepest).toBeLessThan(0.015);
        // Pulled back beyond the touch range.
        expect(boxDistance(tipOf(), box)).toBeGreaterThan(0.04);
      },
    );

    test.each([
      ['pulling back', [{ label: 'press', target: 'button', press: {} }]],
      ['moving on to a grab', scenario.steps.slice(0, 2)],
    ])(
      'a press %s keeps the touch within 350 ms and still holds at depth',
      async (_name, list) => {
        // Fine frames, so the touch is measured to 4 ms.
        const frameS = 1 / 240;
        let downFrames = 0;
        let atDepthFrames = 0;
        const heights: number[] = [];
        await run(sequence(steps(...(list as SequenceStep[]))), {
          deltas: [frameS * 1000],
          each: () => {
            const tip = tipOf();
            if (boxDistance(tip, boxes.button) <= 0.02) downFrames++;
            heights.push(tip[1]);
          },
        });
        const deepest = Math.min(...heights);
        for (const y of heights) if (y < deepest + 0.0005) atDepthFrames++;
        expect(downFrames * frameS).toBeLessThanOrEqual(0.35);
        // The default 0.03 s hold at depth survives the limit.
        expect(atDepthFrames * frameS).toBeGreaterThanOrEqual(0.03);
      },
    );

    test('a press needs a surface normal', async () => {
      await expect(
        sequence(steps({ position: [0, 1, -0.4], press: {} })),
      ).rejects.toThrow(/Step 0: press needs the surface normal/);
      const withNormal = await run<SequenceResult>(
        sequence(
          steps({ position: { x: 0, y: 1, z: -0.4, normal: 'up' }, press: {} }),
        ),
      );
      expect(withNormal.completed).toBe(true);
    });
  });

  describe('paths', () => {
    test('approach comes straight in along the normal and depart lifts straight off', async () => {
      const target = vec3.fromValues(0.1, 1.0, -0.42);
      const samples: vec3[] = [];
      await run(
        sequence({
          ...steps(
            {
              position: [0.1, 1.0, -0.42],
              anchor: 'grasp',
              approach: { distance: 0.06, normal: 'up' },
            },
            {
              position: [0.25, 1.15, -0.35],
              depart: { distance: 0.06, normal: 'up' },
            },
          ),
          gaze: 'fixed',
        }),
        {
          each: () =>
            samples.push(
              vec3.clone(
                device.remote['anchorPosition'](device.hands.right!, 'grasp'),
              ),
            ),
        },
      );
      const horizontal = (p: vec3) =>
        Math.hypot(p[0] - target[0], p[2] - target[2]);
      // Coming in: within 3 cm of the target, the hand is right above it.
      const arrival = samples.findIndex((p) => vec3.distance(p, target) < 1e-4);
      const near = samples
        .slice(0, arrival)
        .filter((p) => vec3.distance(p, target) < 0.03);
      expect(near.length).toBeGreaterThan(2);
      for (const p of near) expect(horizontal(p)).toBeLessThan(0.006);
      // Leaving: the first 2 cm of rise go straight up.
      const leaving = samples
        .slice(arrival)
        .filter((p) => p[1] - target[1] > 0.002 && p[1] - target[1] < 0.02);
      expect(leaving.length).toBeGreaterThan(2);
      for (const p of leaving) expect(horizontal(p)).toBeLessThan(0.006);
    });

    test('a move arcs over a listed obstacle instead of passing through it', async () => {
      boxes.wall = { min: [-0.1, 0.9, -0.5], max: [0.1, 1.15, -0.45] };
      let inside = 0;
      const result = await run<SequenceResult>(
        sequence({
          ...steps(
            { position: [-0.25, 1.0, -0.48], anchor: 'grasp', duration: 0 },
            { position: [0.25, 1.0, -0.48] },
          ),
          gaze: 'fixed',
        }),
        {
          each: () => {
            for (const joint of [
              XRHandJoint.IndexFingerTip,
              XRHandJoint.ThumbTip,
              XRHandJoint.Wrist,
            ]) {
              if (boxDistance(jointOf('right', joint), boxes.wall) === 0)
                inside++;
            }
          },
        },
      );
      expect(result.warnings).toEqual([]);
      expect(inside).toBe(0);
    });
  });

  describe('body', () => {
    test('walks to a target out of reach, carrying the head and the resting hand, the anchor ending on target', async () => {
      boxes.far = { min: [0.15, 1.1, -1.3], max: [0.25, 1.15, -1.2] };
      const head = vec3.clone(device.position.vec3);
      const plan = (await sequence({
        ...steps({ target: 'far', anchor: 'index-tip' }),
        dryRun: true,
      })) as unknown as SequencePlan;
      expect(plan.segments[0].walk).toBeGreaterThan(0.4);
      const result = await run<SequenceResult>(
        sequence(steps({ target: 'far', anchor: 'index-tip' })),
      );
      expect(result.warnings).toEqual([]);
      const walked = vec3.sub(vec3.create(), device.position.vec3, head);
      expect(Math.hypot(walked[0], walked[2])).toBeGreaterThan(0.4);
      expect(Math.abs(walked[1])).toBeLessThan(0.01);
      const tip = result.final!.anchors['index-tip'];
      expect(
        vec3.distance([tip.x, tip.y, tip.z], [0.2, 1.15, -1.25]),
      ).toBeLessThan(0.003);
      // The resting hand went along: it hangs by the hip of the walked body.
      const left = device.hands.left!.pin!.target;
      expect(Math.abs(left[2] - device.position.z)).toBeLessThan(0.1);
      expect(left[1]).toBeLessThan(1.0);
    });

    test('leans toward a low target in front, up to 10 cm', async () => {
      const result = await run<SequenceResult>(
        sequence(steps({ position: [0.15, 0.75, -0.45], anchor: 'grasp' })),
      );
      expect(result.completed).toBe(true);
      const drop = 1.6 - device.position.y;
      expect(drop).toBeGreaterThan(0.05);
      expect(drop).toBeLessThan(0.1 + 0.005);
    });

    test("body: 'fixed' rejects a target beyond reach, naming the step", async () => {
      boxes.far = { min: [0.15, 1.1, -1.3], max: [0.25, 1.15, -1.2] };
      await expect(
        sequence({
          ...steps({ label: 'reach', target: 'far', anchor: 'index-tip' }),
          body: 'fixed',
        }),
      ).rejects.toThrow(
        /Step 0 \('reach'\): the index-tip target is .* m from the shoulder/,
      );
    });

    test('body.position walks first, carrying the pinned hand; body.facing turns the body', async () => {
      await run(
        sequence(
          steps({
            position: [0.15, 1.2, -0.4],
            anchor: 'wrist',
            orientation: { fingers: 'forward', palm: 'down' },
            duration: 0,
          }),
        ),
      );
      const before = vec3.sub(
        vec3.create(),
        device.hands.right!.pin!.target,
        device.position.vec3,
      );
      await run(sequence(steps({ body: { position: [0, 0, -0.5] } })));
      expect(device.position.x).toBeCloseTo(0, 1);
      expect(device.position.z).toBeCloseTo(-0.5, 1);
      const after = vec3.sub(
        vec3.create(),
        device.hands.right!.pin!.target,
        device.position.vec3,
      );
      expect(vec3.distance(after, before)).toBeLessThan(0.01);
      // Turning left carries the hand round to the left.
      await run(
        sequence({ ...steps({ body: { facing: 'left' } }), gaze: 'fixed' }),
      );
      const forward = vec3.transformQuat(
        vec3.create(),
        [0, 0, -1],
        device.quaternion.quat,
      );
      expect(forward[0]).toBeLessThan(-0.95);
      const turned = vec3.sub(
        vec3.create(),
        device.hands.right!.pin!.target,
        device.position.vec3,
      );
      // The hand was in front-right; now it is in front of the turned body.
      expect(turned[0]).toBeLessThan(-0.3);
      expect(Math.hypot(turned[0], turned[2])).toBeCloseTo(
        Math.hypot(before[0], before[2]),
        1,
      );
      // A head-relative position in a step that turns is in front of the
      // body's new facing.
      await run(
        sequence({
          ...steps({
            body: { facing: 'right' },
            position: { relativeTo: 'head', x: 0, y: -0.3, z: -0.4 },
            anchor: 'wrist',
            duration: 0,
          }),
          gaze: 'fixed',
        }),
      );
      const ahead = vec3.sub(
        vec3.create(),
        device.hands.right!.pin!.target,
        device.position.vec3,
      );
      expect(ahead[2]).toBeCloseTo(-0.4, 1);
      expect(Math.abs(ahead[0])).toBeLessThan(0.05);
    });

    test('the body keeps facing its way between sequences until the headset is placed', async () => {
      const gesture = steps({
        position: { relativeTo: 'head', x: 0, y: -0.3, z: -0.4 },
        anchor: 'wrist',
        duration: 0,
      });
      // Within reach and high enough that the body neither walks nor leans.
      boxes.left = { min: [-0.28, 1.27, -0.38], max: [-0.22, 1.3, -0.32] };
      // The head turns left to watch a reach there...
      await run(sequence(steps({ target: 'left', anchor: 'grasp' })));
      const forward = vec3.transformQuat(
        vec3.create(),
        [0, 0, -1],
        device.quaternion.quat,
      );
      expect(forward[0]).toBeLessThan(-0.3);
      // ...but the next gesture is still in front of the body.
      await run(sequence({ ...gesture, gaze: 'fixed' }));
      expect(device.hands.right!.pin!.target[0]).toBeCloseTo(0, 1);
      expect(device.hands.right!.pin!.target[2]).toBeCloseTo(-0.45, 1);
      // Placing the headset (turned right) stands the body anew.
      await run(
        dispatch('set_transform', {
          device: 'headset',
          orientation: { yaw: -90 },
        }),
      );
      await run(sequence({ ...gesture, gaze: 'fixed' }));
      expect(device.hands.right!.pin!.target[0]).toBeGreaterThan(0.3);
    });

    test('body.stepTo walks to comfortable reach of a target', async () => {
      boxes.far = { min: [0.15, 1.1, -1.3], max: [0.25, 1.15, -1.2] };
      await run(sequence(steps({ body: { stepTo: 'far' } })));
      const shoulder = vec3.fromValues(
        device.position.x + 0.18,
        device.position.y - 0.25,
        device.position.z + 0.05,
      );
      expect(vec3.distance(shoulder, [0.2, 1.15, -1.25])).toBeCloseTo(0.58, 1);
    });
  });

  describe('gaze', () => {
    test('the head turns toward each target before the hand gets there and keeps it in view', async () => {
      const gazeAt: Record<string, number> = {};
      let headMovedFirst = false;
      const hand0 = vec3.clone(device.hands.right!.position.vec3);
      const head0 = quat.clone(device.quaternion.quat);
      await run(sequence({ ...scenario, steps: scenario.steps.slice(0, 3) }), {
        each: () => {
          const tip = tipOf();
          if (boxDistance(tip, boxes.button) < 0.005 && !gazeAt.button) {
            gazeAt.button = offGaze([0, 0.99, -0.5]);
          }
          if (device.hands.right!.pinchValue >= 0.9 && !gazeAt.piece) {
            gazeAt.piece = offGaze([-0.2, 1.0, -0.4]);
          }
          if (
            !headMovedFirst &&
            Math.abs(quat.dot(device.quaternion.quat, head0)) < 0.9999 &&
            vec3.distance(device.hands.right!.position.vec3, hand0) < 1e-3
          ) {
            headMovedFirst = true;
          }
        },
      });
      expect(headMovedFirst).toBe(true);
      // IWER's default field of view is ±45°.
      expect(gazeAt.button).toBeLessThan(25);
      expect(gazeAt.piece).toBeLessThan(25);
    });

    test("gaze: 'fixed' leaves the head where it looks, but for a slight sway", async () => {
      const head0 = quat.clone(device.quaternion.quat);
      await run(
        sequence({
          ...scenario,
          steps: scenario.steps.slice(0, 1),
          gaze: 'fixed',
        }),
      );
      const angle =
        2 *
        Math.acos(
          Math.min(1, Math.abs(quat.dot(device.quaternion.quat, head0))),
        );
      expect((angle * 180) / Math.PI).toBeLessThan(2.5);
    });

    test("relativeTo 'head' ignores head pitch and roll; 'body' measures height from the floor", async () => {
      const gesture = {
        position: { relativeTo: 'head' as const, x: 0.1, y: -0.3, z: -0.4 },
        anchor: 'wrist' as const,
        duration: 0,
      };
      const params = {
        ...steps(gesture),
        gaze: 'fixed' as const,
        idleHand: 'keep' as const,
      };
      await run(sequence(params));
      const level = vec3.clone(device.hands.right!.pin!.target);
      device.remote.forceRelease();
      setup();
      device.quaternion.set(
        ...(quat.setAxisAngle(quat.create(), [1, 0, 0], -0.7) as [
          number,
          number,
          number,
          number,
        ]),
      );
      await run(sequence(params));
      expect(
        vec3.distance(device.hands.right!.pin!.target, level),
      ).toBeLessThan(0.005);
      device.remote.forceRelease();
      setup();
      await run(
        sequence({
          ...steps({
            ...gesture,
            position: { relativeTo: 'body', x: 0, y: 1.0, z: -0.3 },
          }),
          gaze: 'fixed',
        }),
      );
      expect(device.hands.right!.pin!.target[1]).toBeCloseTo(1.0, 2);
    });
  });

  describe('the other hand', () => {
    test('rests by the hip over the first step, its pose relaxing', async () => {
      const left = device.hands.left!;
      runFrame();
      const start = vec3.clone(jointOf('left', XRHandJoint.Wrist));
      const heights: number[] = [];
      await run(sequence(scenario), {
        each: () => heights.push(jointOf('left', XRHandJoint.Wrist)[1]),
      });
      // It moves gradually (no jump), and ends down by the side.
      for (let i = 1; i < heights.length; i++) {
        expect(Math.abs(heights[i] - heights[i - 1])).toBeLessThan(0.03);
      }
      expect(heights[0]).toBeCloseTo(start[1], 1);
      expect(left.pin!.target[1]).toBeLessThan(0.9);
      expect(Object.keys(left.fingerPoses).length).toBeGreaterThan(0);
      expect(left.poseTransitionProgress).toBeNull();
    });

    test("idleHand 'keep' leaves it, with a warning when it is in the way of a target", async () => {
      // The left hand waits right by the piece.
      device.hands.left!.position.set(-0.2, 1.05, -0.4);
      const before = vec3.clone(device.hands.left!.position.vec3);
      const result = await run<SequenceResult>(
        sequence({
          ...scenario,
          steps: scenario.steps.slice(1, 2),
          idleHand: 'keep',
        }),
      );
      expect(Array.from(device.hands.left!.position.vec3)).toEqual(
        Array.from(before),
      );
      expect(result.warnings.join(' ')).toMatch(
        /Step 0 \('grab'\): the other hand is within 10 cm/,
      );
    });
  });

  describe('validation', () => {
    test.each([
      [
        'an unknown sequence key',
        { with: { device: 'hand-left', steps: [] } },
        "run_sequence has unknown key 'with'",
      ],
      ['a controller', { device: 'controller-right' }, 'drives one hand'],
      ['no steps', { steps: [] }, 'non-empty steps'],
      [
        'a step that is not an object',
        { steps: [3] },
        'Step 0 must be an object',
      ],
      [
        'a placement before any anchor',
        { steps: [{ position: [0, 1, -0.4] }] },
        'Step 0 places the hand but no anchor',
      ],
      [
        'the pinch pose',
        {
          steps: [{ anchor: 'wrist', position: [0, 1, -0.4], poseId: 'pinch' }],
        },
        'use "pinch": 1',
      ],
      [
        'a misspelt step key',
        { steps: [{ target: 'button', pose: 'point' }] },
        "Step 0 has unknown key 'pose'",
      ],
      [
        'a misspelt press key',
        { steps: [{ label: 'p', target: 'button', press: { deep: 0.01 } }] },
        "Step 0 ('p'): press has unknown key 'deep'",
      ],
      [
        'a misspelt pinch key',
        { steps: [{ target: 'piece', pinch: { value: 1, att: 'arrival' } }] },
        "pinch has unknown key 'att'",
      ],
      [
        'a misspelt target key',
        { steps: [{ target: { nam: 'button' }, anchor: 'grasp' }] },
        "target has unknown key 'nam'",
      ],
      [
        'a misspelt body key',
        { steps: [{ body: { walkTo: 'button' } }] },
        "body has unknown key 'walkTo'",
      ],
      [
        'a misspelt approach key',
        {
          steps: [
            { target: 'piece', anchor: 'grasp', approach: { dist: 0.05 } },
          ],
        },
        "approach has unknown key 'dist'",
      ],
      [
        'a press deeper than 15 mm',
        { steps: [{ target: 'button', press: { depth: 0.03 } }] },
        'press.depth',
      ],
      [
        'a press and a pinch together',
        { steps: [{ target: 'button', press: {}, pinch: 1 }] },
        'press and pinch',
      ],
      [
        'arriving without a placement',
        { steps: [{ pinch: { value: 1, at: 'arrival' } }] },
        'needs a placement',
      ],
      ['a pinch out of range', { steps: [{ pinch: 2 }] }, 'pinch must be 0–1'],
      [
        'position and target together',
        { steps: [{ target: 'button', position: [0, 1, 0], anchor: 'grasp' }] },
        'not both',
      ],
      [
        'an unknown anchor',
        { steps: [{ anchor: 'elbow', position: [0, 1, -0.4] }] },
        "Unknown anchor 'elbow'",
      ],
      [
        'a bad direction',
        {
          steps: [
            {
              anchor: 'wrist',
              position: [0, 1, -0.4],
              orientation: { fingers: 'sideways', palm: 'down' },
            },
          ],
        },
        "Unknown direction 'sideways'",
      ],
      [
        'fingers without a pose',
        { steps: [{ fingers: { index: 'fist' } }] },
        'fingers needs a poseId',
      ],
      [
        'a negative duration',
        { steps: [{ duration: -1 }] },
        'duration must be',
      ],
      [
        'a window outside the step',
        { steps: [{ poseId: { value: 'fist', end: 2 } }] },
        'poseId.end must be a fraction',
      ],
      [
        'facing straight up',
        { steps: [{ body: { facing: 'up' } }] },
        'body.facing must not point straight up',
      ],
    ])('rejects %s at dispatch', async (_name, params, message) => {
      await expect(
        sequence({
          device: 'hand-right',
          steps: [],
          ...params,
        } as unknown as RunSequenceParams),
      ).rejects.toThrow(message);
    });

    test('the live-hand check runs when the sequence reaches the head of the queue', async () => {
      device.primaryInputMode = 'controller';
      const failing = sequence(steps({ duration: 0.1 }));
      await expect(run(failing)).rejects.toThrow(
        /not live: the input mode is controllers/,
      );
      void dispatch('set_input_mode', { mode: 'hand' });
      const done = sequence(steps({ duration: 0.1 }));
      expect((await run<SequenceResult>(done)).completed).toBe(true);
    });

    test('a dry run returns the expanded plan from the current state and moves nothing', async () => {
      const hand = vec3.clone(device.hands.right!.position.vec3);
      const head = vec3.clone(device.position.vec3);
      const plan = (await sequence({
        ...scenario,
        dryRun: true,
      })) as unknown as SequencePlan;
      expect(plan.segments.map((s) => [s.step, s.kind])).toEqual([
        [0, 'press'],
        [0, 'press-hold'],
        [1, 'move'],
        [2, 'move'],
        [3, 'hold'],
        [4, 'move'],
      ]);
      expect(plan.segments[2].target).toEqual({
        x: expect.closeTo(-0.2, 2),
        y: 1,
        z: expect.closeTo(-0.4, 2),
      });
      expect(plan.duration).toBeCloseTo(
        plan.segments.reduce((sum, s) => sum + s.duration, 0),
        2,
      );
      expect(plan.warnings).toEqual([]);
      expect(Array.from(device.hands.right!.position.vec3)).toEqual(
        Array.from(hand),
      );
      expect(Array.from(device.position.vec3)).toEqual(Array.from(head));
      expect(device.hands.right!.pin).toBeNull();
      // A dry run against a hand the app can't see says so.
      device.primaryInputMode = 'controller';
      const unseen = (await sequence({
        ...scenario,
        dryRun: true,
      })) as unknown as SequencePlan;
      expect(unseen.warnings.join(' ')).toMatch(/not live/);
    });

    test('a sequence and a select value written in the same frame land on different frames', async () => {
      const write = dispatch('set_select_value', {
        device: 'hand-right',
        value: 1,
      });
      const done = sequence(
        steps({ pinch: 0, duration: 0 }, { duration: 0.1 }),
      );
      // At 100 ms frames the sequence's first frame would take the pinch
      // most of the way back down, so sharing a frame would lose the press.
      await run(write, { deltas: [100] });
      await run(done, { deltas: [100] });
      expect(events.map((e) => e.type)).toEqual([
        'selectstart',
        'select',
        'selectend',
      ]);
    });
  });
});

describe('remote method catalog', () => {
  test('has a parameter schema for every remote method, and nothing else', () => {
    const device = new XRDevice(metaQuest3);
    const methods = device.remote
      .listMethods()
      .map((m) => m.method)
      .sort();
    expect(Object.keys(REMOTE_METHOD_SCHEMAS).sort()).toEqual(methods);
  });

  test('lists the sequence methods: run_sequence queued, cancel_sequence and list_targets immediate', () => {
    const device = new XRDevice(metaQuest3);
    const byName = Object.fromEntries(
      device.remote.listMethods().map((m) => [m.method, m.immediate]),
    );
    expect(byName).toMatchObject({
      run_sequence: false,
      cancel_sequence: true,
      list_targets: true,
    });
  });
});
