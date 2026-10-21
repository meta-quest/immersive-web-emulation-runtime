/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  P_DEVICE,
  P_REF_SPACE,
  P_SESSION,
  P_SPACE,
} from '../../src/private.js';
import { mat4, quat, vec3 } from 'gl-matrix';

import { BUILTIN_HAND_POSE_IDS } from '../../src/device/configs/hand/ids.js';
import { XRDevice } from '../../src/device/XRDevice.js';
import { XRFrame } from '../../src/frameloop/XRFrame.js';
import { XRHandJoint } from '../../src/input/XRHand.js';
import { XRHandedness } from '../../src/input/XRInputSource.js';
import { XRReferenceSpaceType } from '../../src/spaces/XRReferenceSpace.js';
import { metaQuest3 } from '../../src/device/configs/headset/meta.js';
import { wristRotationFromDirections } from '../../src/device/XRHandInput.js';
import type {
  AnimateToResult,
  GetHandStateResult,
  RemoteDeviceState,
  SetTransformResult,
} from '../../src/remote/types.js';
import type { Vec3 } from '../../src/types/state.js';

type Side = 'left' | 'right';

const toVec = (v: Vec3) => vec3.fromValues(v.x, v.y, v.z);

describe('hand motion primitives', () => {
  let device: XRDevice;
  let frame: XRFrame;
  let events: string[];
  let enabledFeatures: string[];

  const setOrigin = (offset: mat4) => {
    const session = {
      mode: 'immersive-vr',
      get enabledFeatures() {
        return enabledFeatures;
      },
      [P_SESSION]: {
        referenceSpaces: [{ [P_SPACE]: { offsetMatrix: offset } }],
      },
      dispatchEvent: (event: { type: string }) => {
        events.push(event.type);
        return true;
      },
    };
    Object.defineProperty(device, 'activeSession', {
      get: () => session,
      configurable: true,
    });
    frame = { session } as unknown as XRFrame;
  };

  beforeEach(() => {
    device = new XRDevice(metaQuest3);
    device.primaryInputMode = 'hand';
    events = [];
    enabledFeatures = [];
    setOrigin(mat4.create());
  });

  afterEach(() => device.remote.forceRelease());

  // The way XRDevice drives a frame: remote control first, then the inputs.
  const runFrame = (deltaMs = 1000 / 60) => {
    device.remote.update(deltaMs);
    device.hands.left!.onFrameStart(frame);
    device.hands.right!.onFrameStart(frame);
  };
  const run = async <T>(
    promise: Promise<unknown>,
    frames = 600,
    deltaMs?: number,
  ): Promise<T> => {
    let done = false;
    let value: unknown;
    let error: unknown;
    promise.then(
      (v) => ((done = true), (value = v)),
      (e) => ((done = true), (error = e)),
    );
    for (let i = 0; i < frames && !done; i++) {
      runFrame(deltaMs);
      await Promise.resolve();
    }
    await Promise.resolve();
    if (error) throw error;
    if (!done) throw new Error('did not finish');
    return value as T;
  };
  const dispatch = <T>(method: string, params: Record<string, unknown>) =>
    run<T>(device.remote.dispatch(method, params));

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
  /** A joint's position in the target-ray frame. */
  const localJointOf = (side: Side, joint: XRHandJoint) =>
    mat4.getTranslation(
      vec3.create(),
      device.hands[side]!.inputSource.hand!.get(joint)![P_SPACE].offsetMatrix,
    );
  const gripOf = (side: Side) => {
    const hand = device.hands[side]!;
    return mat4.getTranslation(
      vec3.create(),
      mat4.multiply(
        mat4.create(),
        hand.inputSource.targetRaySpace[P_SPACE].offsetMatrix,
        hand.inputSource.gripSpace![P_SPACE].offsetMatrix,
      ),
    );
  };
  const graspOf = (side: Side) =>
    vec3.transformMat4(
      vec3.create(),
      device.hands[side]!.anchorOffset('grasp'),
      device.hands[side]!.inputSource.targetRaySpace[P_SPACE].offsetMatrix,
    );
  const handState = (side: Side, joints?: 'all') =>
    device.remote.dispatch('get_hand_state', {
      device: `hand-${side}`,
      ...(joints ? { joints } : {}),
    }) as Promise<GetHandStateResult>;
  /** The hand's finger, palm and thumb directions in GlobalSpace. */
  const worldAxes = (side: Side) => {
    const hand = device.hands[side]!;
    const axes = hand.handAxes();
    const world = (v: vec3) =>
      vec3.transformQuat(vec3.create(), v, hand.quaternion.quat);
    return {
      fingers: world(axes.fingers),
      palm: world(axes.palm),
      thumb: world(axes.thumb),
    };
  };

  describe('hand shape', () => {
    test.each([...BUILTIN_HAND_POSE_IDS])(
      'both fingertips meet at the grasp point at full pinch, and the grip stays within 6.8 cm (%s)',
      (poseId) => {
        const hand = device.hands.right!;
        hand.poseId = poseId;
        runFrame();
        const grasp = graspOf('right');
        hand.updatePinchValue(1);
        runFrame();
        for (const tip of [XRHandJoint.ThumbTip, XRHandJoint.IndexFingerTip]) {
          expect(vec3.distance(jointOf('right', tip), grasp)).toBeLessThan(
            0.002,
          );
        }
        expect(vec3.distance(gripOf('right'), grasp)).toBeLessThan(0.068);
      },
    );

    test('the grasp point of the default hand is where the plan measured it, mirrored on the right', () => {
      runFrame();
      const left = device.hands.left!.anchorOffset('grasp');
      const right = device.hands.right!.anchorOffset('grasp');
      const expected = [-0.0017, -0.0252, -0.0089];
      for (let i = 0; i < 3; i++) {
        expect(left[i]).toBeCloseTo(expected[i], 3);
      }
      expect(Array.from(right)).toEqual([-left[0], left[1], left[2]]);
    });

    test('pinching moves only the thumb and index: the wrist, grip and other fingers keep the pose', () => {
      const hand = device.hands.right!;
      runFrame();
      const still = [
        XRHandJoint.Wrist,
        XRHandJoint.MiddleFingerTip,
        XRHandJoint.RingFingerTip,
        XRHandJoint.PinkyFingerTip,
      ];
      const before = still.map((joint) => localJointOf('right', joint));
      const grip = mat4.clone(
        hand.inputSource.gripSpace![P_SPACE].offsetMatrix,
      );
      const indexTip = localJointOf('right', XRHandJoint.IndexFingerTip);
      hand.updatePinchValue(1);
      runFrame();
      still.forEach((joint, i) => {
        expect(
          vec3.distance(localJointOf('right', joint), before[i]),
        ).toBeLessThan(1e-6);
      });
      expect(
        Array.from(hand.inputSource.gripSpace![P_SPACE].offsetMatrix),
      ).toEqual(Array.from(grip));
      expect(
        vec3.distance(
          localJointOf('right', XRHandJoint.IndexFingerTip),
          indexTip,
        ),
      ).toBeGreaterThan(0.01);
    });

    test('thumb and index bone lengths stay between their open and pinched lengths through a ramp', () => {
      const hand = device.hands.left!;
      const chains = [
        [
          XRHandJoint.Wrist,
          XRHandJoint.ThumbMetacarpal,
          XRHandJoint.ThumbPhalanxProximal,
          XRHandJoint.ThumbPhalanxDistal,
          XRHandJoint.ThumbTip,
        ],
        [
          XRHandJoint.Wrist,
          XRHandJoint.IndexFingerMetacarpal,
          XRHandJoint.IndexFingerPhalanxProximal,
          XRHandJoint.IndexFingerPhalanxIntermediate,
          XRHandJoint.IndexFingerPhalanxDistal,
          XRHandJoint.IndexFingerTip,
        ],
      ];
      const lengths = () =>
        chains.flatMap((chain) =>
          chain
            .slice(1)
            .map((joint, i) =>
              vec3.distance(
                localJointOf('left', joint),
                localJointOf('left', chain[i]),
              ),
            ),
        );
      const at = (pinch: number) => {
        hand.updatePinchValue(pinch);
        runFrame();
        return lengths();
      };
      const open = at(0);
      const closed = at(1);
      for (let pinch = 0.1; pinch < 1; pinch += 0.1) {
        at(pinch).forEach((length, i) => {
          expect(length).toBeGreaterThanOrEqual(
            Math.min(open[i], closed[i]) - 1e-6,
          );
          expect(length).toBeLessThanOrEqual(
            Math.max(open[i], closed[i]) + 1e-6,
          );
        });
      }
    });

    test('the right grip is the left grip mirrored, like the joints', () => {
      runFrame();
      const left =
        device.hands.left!.inputSource.gripSpace![P_SPACE].offsetMatrix;
      const right =
        device.hands.right!.inputSource.gripSpace![P_SPACE].offsetMatrix;
      const leftPosition = mat4.getTranslation(vec3.create(), left);
      const rightPosition = mat4.getTranslation(vec3.create(), right);
      expect(rightPosition[0]).toBeCloseTo(-leftPosition[0], 6);
      expect(rightPosition[1]).toBeCloseTo(leftPosition[1], 6);
      expect(rightPosition[2]).toBeCloseTo(leftPosition[2], 6);
      expect(
        vec3.distance(
          gripOf('right'),
          jointOf('right', XRHandJoint.MiddleFingerMetacarpal),
        ),
      ).toBeCloseTo(
        vec3.distance(
          gripOf('left'),
          jointOf('left', XRHandJoint.MiddleFingerMetacarpal),
        ),
        6,
      );
    });
  });

  describe('anchors', () => {
    const target = { x: 0.1, y: 1.1, z: -0.4 };

    test.each([
      ['wrist', XRHandJoint.Wrist],
      ['index-tip', XRHandJoint.IndexFingerTip],
      ['thumb-tip', XRHandJoint.ThumbTip],
      ['middle-finger-tip', XRHandJoint.MiddleFingerTip],
    ] as const)(
      'set_transform with anchor %s puts that joint on the position and reports the solved pose',
      async (anchor, joint) => {
        const result = await dispatch<SetTransformResult>('set_transform', {
          device: 'hand-right',
          position: target,
          anchor,
        });
        expect(
          vec3.distance(jointOf('right', joint), toVec(target)),
        ).toBeLessThan(1e-4);
        const ray = device.hands.right!.position;
        expect(result.position.x).toBeCloseTo(ray.x, 6);
        expect(result.position.y).toBeCloseTo(ray.y, 6);
        expect(result.position.z).toBeCloseTo(ray.z, 6);
        runFrame();
        expect(
          vec3.distance(jointOf('right', joint), toVec(target)),
        ).toBeLessThan(1e-4);
      },
    );

    test.each(['grip', 'grasp'] as const)(
      'set_transform with anchor %s puts that point on the position',
      async (anchor) => {
        await dispatch('set_transform', {
          device: 'hand-left',
          position: target,
          anchor,
        });
        const point = anchor === 'grip' ? gripOf('left') : graspOf('left');
        expect(vec3.distance(point, toVec(target))).toBeLessThan(1e-4);
        const state = await handState('left');
        expect(state.pin).toEqual({
          anchor,
          target: expect.objectContaining({ x: expect.any(Number) }),
        });
        expect(
          vec3.distance(toVec(state.anchors[anchor]), toVec(target)),
        ).toBeLessThan(1e-4);
      },
    );

    test('placing the grasp point on an object and pinching closes both tips onto it, the wrist still', async () => {
      await dispatch('set_transform', {
        device: 'hand-right',
        position: target,
        anchor: 'grasp',
      });
      const wrist = jointOf('right', XRHandJoint.Wrist);
      await dispatch('set_select_value', {
        device: 'hand-right',
        value: 1,
        duration: 0.2,
      });
      runFrame();
      for (const tip of [XRHandJoint.ThumbTip, XRHandJoint.IndexFingerTip]) {
        expect(
          vec3.distance(jointOf('right', tip), toVec(target)),
        ).toBeLessThan(0.002);
      }
      expect(
        vec3.distance(jointOf('right', XRHandJoint.Wrist), wrist),
      ).toBeLessThan(1e-4);
      expect(events).toEqual(['selectstart']);
    });

    test('rejects an unknown anchor', async () => {
      await expect(
        dispatch('set_transform', {
          device: 'hand-right',
          position: target,
          anchor: 'elbow',
        }),
      ).rejects.toThrow("Unknown anchor 'elbow'");
    });
  });

  describe('anchor pin', () => {
    const target = { x: 0.1, y: 1.1, z: -0.4 };
    const pinAt = (anchor = 'index-tip', position = target) =>
      dispatch('set_transform', { device: 'hand-right', position, anchor });

    test('keeps the anchor within 1 mm every frame while a move, a pinch ramp and a pose fade run together', async () => {
      await pinAt();
      const hand = device.hands.right!;
      const to = { x: 0.16, y: 1.02, z: -0.46 };
      const done = device.remote.runHandMotion('hand-right', {
        move: {
          position: to,
          anchor: 'index-tip',
          duration: 0.5,
          easing: 'minimum-jerk',
        },
        pose: { poseId: 'point', duration: 0.4 },
        pinch: { value: 0.6, duration: 0.3 },
      });
      let worst = 0;
      let frames = 0;
      const pinches = new Set<number>();
      const progress = new Set<number | null>();
      let finished = false;
      done.then(() => (finished = true));
      while (!finished && frames < 120) {
        runFrame();
        await Promise.resolve();
        frames++;
        pinches.add(hand.pinchValue);
        progress.add(hand.poseTransitionProgress);
        worst = Math.max(
          worst,
          vec3.distance(
            jointOf('right', XRHandJoint.IndexFingerTip),
            hand.pin!.target,
          ),
        );
      }
      const state = (await done) as GetHandStateResult;
      expect(worst).toBeLessThan(0.001);
      // All three channels really ran, in the same frames.
      expect(frames).toBeGreaterThanOrEqual(30);
      expect(frames).toBeLessThan(40);
      expect(pinches.size).toBeGreaterThan(10);
      expect(progress.size).toBeGreaterThan(10);
      expect(state.poseId).toBe('point');
      expect(state.pinchValue).toBeCloseTo(0.6, 6);
      expect(
        vec3.distance(toVec(state.anchors['index-tip']), toVec(to)),
      ).toBeLessThan(0.001);
    });

    test('a pose set in the same frame as an anchored placement lands the new tip on target', async () => {
      const p1 = device.remote.dispatch('set_hand_pose', {
        device: 'hand-right',
        poseId: 'point',
      });
      const p2 = device.remote.dispatch('set_transform', {
        device: 'hand-right',
        position: { x: 0, y: 1, z: -0.5 },
        anchor: 'index-tip',
      });
      runFrame();
      await Promise.all([p1, p2]);
      expect(
        vec3.distance(
          jointOf('right', XRHandJoint.IndexFingerTip),
          [0, 1, -0.5],
        ),
      ).toBeLessThan(0.001);
    });

    test('a placement reports the hand solved for a pose set earlier in the same frame', async () => {
      const posed = device.remote.dispatch('set_hand_pose', {
        device: 'hand-right',
        poseId: 'fist',
      });
      const placed = device.remote.dispatch('set_transform', {
        device: 'hand-right',
        position: target,
        anchor: 'index-tip',
      });
      // Remote control only: the hand's own frame update has not run yet.
      device.remote.update(1000 / 60);
      await posed;
      const result = (await placed) as SetTransformResult;
      // The hand's frame update finds nothing left to correct.
      device.hands.right!.onFrameStart(frame);
      const ray = device.hands.right!.position;
      expect(
        vec3.distance(toVec(result.position), [ray.x, ray.y, ray.z]),
      ).toBeLessThan(1e-6);
      expect(
        vec3.distance(
          jointOf('right', XRHandJoint.IndexFingerTip),
          toVec(target),
        ),
      ).toBeLessThan(1e-4);
    });

    test('a placement with a position replaces the pin', async () => {
      await pinAt('index-tip');
      await pinAt('wrist', { x: 0, y: 1.2, z: -0.3 });
      expect(device.hands.right!.pin!.anchor).toBe('wrist');
      expect(
        vec3.distance(jointOf('right', XRHandJoint.Wrist), [0, 1.2, -0.3]),
      ).toBeLessThan(1e-4);
    });

    test('set_hand_pose and pinch changes keep the pin: the anchor stays put while the shape changes', async () => {
      await pinAt('index-tip');
      await dispatch('set_hand_pose', { device: 'hand-right', poseId: 'fist' });
      await dispatch('set_select_value', { device: 'hand-right', value: 0.5 });
      runFrame();
      await dispatch('set_hand_pose', {
        device: 'hand-right',
        poseId: 'open',
        duration: 0.2,
      });
      expect(device.hands.right!.pin!.anchor).toBe('index-tip');
      expect(
        vec3.distance(
          jointOf('right', XRHandJoint.IndexFingerTip),
          toVec(target),
        ),
      ).toBeLessThan(1e-4);
    });

    test('an orientation-only placement naming the pinned anchor rotates the hand about it', async () => {
      await pinAt('index-tip');
      const before = worldAxes('right').fingers;
      await dispatch('set_transform', {
        device: 'hand-right',
        anchor: 'index-tip',
        orientation: { fingers: 'up', palm: 'forward' },
      });
      expect(device.hands.right!.pin!.anchor).toBe('index-tip');
      expect(
        vec3.distance(
          jointOf('right', XRHandJoint.IndexFingerTip),
          toVec(target),
        ),
      ).toBeLessThan(1e-4);
      expect(vec3.dot(worldAxes('right').fingers, [0, 1, 0])).toBeGreaterThan(
        0.999,
      );
      expect(vec3.dot(before, [0, 1, 0])).toBeLessThan(0.5);
    });

    test('an orientation-only animate_to naming the pinned anchor turns about it every frame', async () => {
      await pinAt('index-tip');
      const done = device.remote.dispatch('animate_to', {
        device: 'hand-right',
        anchor: 'index-tip',
        orientation: { fingers: 'left', palm: 'down' },
        duration: 0.3,
      });
      let worst = 0;
      for (let i = 0; i < 25; i++) {
        runFrame();
        await Promise.resolve();
        worst = Math.max(
          worst,
          vec3.distance(
            jointOf('right', XRHandJoint.IndexFingerTip),
            toVec(target),
          ),
        );
      }
      await done;
      expect(worst).toBeLessThan(0.001);
      expect(vec3.dot(worldAxes('right').fingers, [-1, 0, 0])).toBeGreaterThan(
        0.999,
      );
    });

    test.each([
      [
        'set_transform with a position and no anchor',
        {
          method: 'set_transform',
          params: { device: 'hand-right', position: { x: 0, y: 1, z: -0.3 } },
        },
      ],
      [
        'set_transform with only a quaternion and no anchor',
        {
          method: 'set_transform',
          params: {
            device: 'hand-right',
            orientation: { x: 0, y: 0, z: 0, w: 1 },
          },
        },
      ],
      [
        'animate_to with no anchor',
        {
          method: 'animate_to',
          params: {
            device: 'hand-right',
            position: { x: 0, y: 1, z: -0.3 },
            duration: 0.1,
          },
        },
      ],
      [
        'look_at',
        {
          method: 'look_at',
          params: { device: 'hand-right', target: { x: 0, y: 1, z: -1 } },
        },
      ],
      [
        'set_connected false',
        {
          method: 'set_connected',
          params: { device: 'hand-right', connected: false },
        },
      ],
      [
        'set_input_mode',
        { method: 'set_input_mode', params: { mode: 'controller' } },
      ],
      [
        'set_device_state',
        {
          method: 'set_device_state',
          params: { state: { stereoEnabled: false } },
        },
      ],
      [
        'the set_device_state reset',
        { method: 'set_device_state', params: {} },
      ],
    ])('%s lets go of the pin', async (_name, { method, params }) => {
      await pinAt('grasp');
      expect(device.hands.right!.pin).not.toBeNull();
      await dispatch(method, params);
      expect(device.hands.right!.pin).toBeNull();
    });

    test('forceRelease lets go of pins and pose fades, and stops ramps where they are', async () => {
      await pinAt('grasp');
      const hand = device.hands.right!;
      const fade = device.remote.dispatch('set_hand_pose', {
        device: 'hand-right',
        poseId: 'fist',
        duration: 0.5,
      });
      fade.catch(() => {});
      runFrame();
      runFrame();
      expect(hand.poseTransitionProgress).not.toBeNull();
      device.remote.forceRelease();
      await expect(fade).rejects.toThrow('Capture released');
      expect(hand.pin).toBeNull();
      expect(hand.poseTransitionProgress).toBeNull();
      expect(hand.poseId).toBe('fist');
    });

    test('any switch to manual control lets go of the hands, however it happens', async () => {
      await pinAt('grasp');
      const hand = device.hands.right!;
      const ramp = device.remote.dispatch('set_select_value', {
        device: 'hand-right',
        value: 1,
        duration: 1,
      });
      ramp.catch(() => {});
      runFrame();
      runFrame();
      const pinch = hand.pinchValue;
      expect(pinch).toBeGreaterThan(0);
      // e.g. the DevUI taking over.
      device.controlMode = 'manual';
      expect(hand.pin).toBeNull();
      runFrame();
      runFrame();
      expect(hand.pinchValue).toBe(pinch);
    });

    test('the release timer going manual lets go of the pin', async () => {
      jest.useFakeTimers();
      try {
        const placed = device.remote.dispatch('set_transform', {
          device: 'hand-right',
          position: target,
          anchor: 'index-tip',
        });
        runFrame();
        await placed;
        expect(device.hands.right!.pin).not.toBeNull();
        expect(device.remote.isCaptured).toBe(true);
        jest.advanceTimersByTime(device.remote.RELEASE_TIMEOUT_MS + 1);
        expect(device.controlMode).toBe('manual');
        expect(device.hands.right!.pin).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    test('the session ending lets go of the hands', async () => {
      await pinAt('grasp');
      device.remote.onSessionEnd();
      expect(device.hands.right!.pin).toBeNull();
    });
  });

  describe('hand directions', () => {
    test.each([XRHandedness.Left, XRHandedness.Right])(
      '{ fingers, thumb } lands on the %s hand and reads back from get_hand_state',
      async (handedness) => {
        const side = handedness === XRHandedness.Left ? 'left' : 'right';
        await dispatch('set_transform', {
          device: `hand-${side}`,
          position: { x: 0, y: 1.2, z: -0.4 },
          anchor: 'wrist',
          orientation: { fingers: 'forward', thumb: 'up' },
        });
        const axes = worldAxes(side);
        expect(vec3.dot(axes.fingers, [0, 0, -1])).toBeGreaterThan(0.999);
        expect(vec3.dot(axes.thumb, [0, 1, 0])).toBeGreaterThan(0.999);
        const state = await handState(side);
        expect(state.axes.fingers.z).toBeCloseTo(-1, 3);
        expect(state.axes.thumb.y).toBeCloseTo(1, 3);
      },
    );

    test.each([XRHandedness.Left, XRHandedness.Right])(
      '{ fingers, palm } lands on the %s hand; fingers stay exact, the palm is made perpendicular',
      async (handedness) => {
        const side = handedness === XRHandedness.Left ? 'left' : 'right';
        await dispatch('set_transform', {
          device: `hand-${side}`,
          position: { x: 0, y: 1.2, z: -0.4 },
          anchor: 'wrist',
          orientation: { fingers: [0, -1, -1], palm: [0, -1, 0] },
        });
        const axes = worldAxes(side);
        const fingers = vec3.normalize(vec3.create(), [0, -1, -1]);
        expect(vec3.dot(axes.fingers, fingers)).toBeGreaterThan(0.9999);
        expect(Math.abs(vec3.dot(axes.palm, axes.fingers))).toBeLessThan(1e-4);
        expect(axes.palm[1]).toBeLessThan(-0.7);
      },
    );

    test('a thumbs up points the thumb up in the world', async () => {
      await dispatch('set_hand_pose', {
        device: 'hand-right',
        poseId: 'thumbs-up',
      });
      await dispatch('set_transform', {
        device: 'hand-right',
        position: { x: 0.1, y: 1.3, z: -0.4 },
        anchor: 'wrist',
        orientation: { fingers: 'forward', thumb: 'up' },
      });
      runFrame();
      const base = jointOf('right', XRHandJoint.ThumbPhalanxProximal);
      const tip = jointOf('right', XRHandJoint.ThumbTip);
      const dir = vec3.normalize(
        vec3.create(),
        vec3.sub(vec3.create(), tip, base),
      );
      expect(dir[1]).toBeGreaterThan(0.8);
    });

    test('named directions follow the way the headset faces', async () => {
      // Headset turned 90° to the left: forward is -X.
      device.quaternion.set(0, Math.SQRT1_2, 0, Math.SQRT1_2);
      await dispatch('set_transform', {
        device: 'hand-right',
        position: { x: -0.4, y: 1.2, z: 0 },
        anchor: 'wrist',
        orientation: { fingers: 'forward', palm: 'left' },
      });
      const axes = worldAxes('right');
      expect(vec3.dot(axes.fingers, [-1, 0, 0])).toBeGreaterThan(0.999);
      expect(vec3.dot(axes.palm, [0, 0, 1])).toBeGreaterThan(0.999);
    });

    test("toward-head points from the hand's position to the head", async () => {
      const position = { x: 0.2, y: 1.3, z: -0.4 };
      await dispatch('set_transform', {
        device: 'hand-right',
        position,
        anchor: 'wrist',
        orientation: { fingers: 'up', palm: 'toward-head' },
      });
      const toHead = vec3.normalize(
        vec3.create(),
        vec3.sub(vec3.create(), device.position.vec3, toVec(position)),
      );
      const palm = worldAxes('right').palm;
      // The palm is made perpendicular to the fingers (up).
      const flat = vec3.normalize(vec3.create(), [toHead[0], 0, toHead[2]]);
      expect(vec3.dot(palm, flat)).toBeGreaterThan(0.999);
    });

    test("orientation 'auto' reaches from the shoulder toward the position, palm down", async () => {
      const position = { x: 0.25, y: 1.0, z: -0.5 };
      await dispatch('set_transform', {
        device: 'hand-right',
        position,
        anchor: 'index-tip',
        orientation: 'auto',
      });
      const axes = worldAxes('right');
      const shoulder = vec3.fromValues(0.18, 1.6 - 0.25, 0.05);
      const reach = vec3.normalize(
        vec3.create(),
        vec3.sub(vec3.create(), toVec(position), shoulder),
      );
      expect(vec3.dot(axes.fingers, reach)).toBeGreaterThan(0.8);
      expect(axes.palm[1]).toBeLessThan(-0.8);
      // Rolled a little toward thumb-up: the palm turns toward the body's middle.
      expect(axes.palm[0]).toBeLessThan(0);
    });

    test("orientation 'auto' is resolved once, when an animation starts", async () => {
      const animate = async (turnHead: boolean) => {
        device.quaternion.set(0, 0, 0, 1);
        const done = device.remote.dispatch('animate_to', {
          device: 'hand-left',
          position: { x: -0.2, y: 1.1, z: -0.45 },
          anchor: 'grasp',
          orientation: 'auto',
          duration: 0.3,
        });
        runFrame();
        if (turnHead) device.quaternion.set(0, Math.SQRT1_2, 0, Math.SQRT1_2);
        await run(done);
        return device.hands.left!.wristRotation();
      };
      const still = await animate(false);
      const turned = await animate(true);
      expect(Math.abs(quat.dot(still, turned))).toBeGreaterThan(0.99999);
    });

    test.each([
      [{ fingers: 'forward' }, 'exactly one of palm or thumb'],
      [{ fingers: 'forward', palm: 'down', thumb: 'up' }, 'exactly one'],
      [{ fingers: 'forward', palm: 'forward' }, 'parallel'],
      [{ fingers: 'ahead', palm: 'down' }, "Unknown direction 'ahead'"],
      [{ fingers: [0, 0, 0], palm: 'down' }, 'zero vector'],
    ])('rejects %j', async (orientation, message) => {
      await expect(
        dispatch('set_transform', {
          device: 'hand-right',
          position: { x: 0, y: 1.2, z: -0.4 },
          orientation,
        }),
      ).rejects.toThrow(message);
    });

    test('wristRotationFromDirections rejects parallel directions', () => {
      expect(
        wristRotationFromDirections(
          { fingers: [0, 0, -1], palm: [0, 0, -1] },
          XRHandedness.Right,
        ),
      ).toBeNull();
    });
  });

  describe('XR origin', () => {
    // A rotated, offset origin, like a `local` space that faces sideways.
    const origin = mat4.fromRotationTranslation(
      mat4.create(),
      quat.setAxisAngle(quat.create(), [0, 1, 0], Math.PI / 2),
      [1, 0.5, 2],
    );
    const expectVec = (got: Vec3, want: Vec3, digits = 5) => {
      expect(got.x).toBeCloseTo(want.x, digits);
      expect(got.y).toBeCloseTo(want.y, digits);
      expect(got.z).toBeCloseTo(want.z, digits);
    };

    beforeEach(() => setOrigin(origin));

    test('set_transform and get_transform round-trip positions and orientations', async () => {
      const orientation = quat.setAxisAngle(quat.create(), [1, 0, 0], 0.3);
      const q = {
        x: orientation[0],
        y: orientation[1],
        z: orientation[2],
        w: orientation[3],
      };
      await dispatch('set_transform', {
        device: 'controller-right',
        position: { x: 0.1, y: 1.2, z: -0.5 },
        orientation: q,
      });
      const got = (await device.remote.dispatch('get_transform', {
        device: 'controller-right',
      })) as { position: Vec3; orientation: typeof q };
      expectVec(got.position, { x: 0.1, y: 1.2, z: -0.5 });
      expect(
        Math.abs(
          quat.dot(
            [
              got.orientation.x,
              got.orientation.y,
              got.orientation.z,
              got.orientation.w,
            ],
            orientation,
          ),
        ),
      ).toBeCloseTo(1, 6);
      // In GlobalSpace the controller sits rotated and offset.
      expect(device.controllers.right!.position.x).not.toBeCloseTo(0.1, 2);
    });

    test('animate_to moves to, and reports, XR-origin positions', async () => {
      const result = await dispatch<AnimateToResult>('animate_to', {
        device: 'headset',
        position: { x: 0.3, y: 1.6, z: -1 },
        duration: 0.1,
      });
      expectVec(result.position, { x: 0.3, y: 1.6, z: -1 });
      const global = vec3.transformMat4(vec3.create(), [0.3, 1.6, -1], origin);
      expect(vec3.distance(device.position.vec3 as vec3, global)).toBeLessThan(
        1e-5,
      );
    });

    test('look_at aims at an XR-origin point and reports XR-origin results', async () => {
      await dispatch('set_transform', {
        device: 'controller-left',
        position: { x: 0, y: 1, z: 0 },
      });
      const result = (await dispatch('look_at', {
        device: 'controller-left',
        target: { x: 0, y: 1, z: -2 },
      })) as { position: Vec3 };
      expectVec(result.position, { x: 0, y: 1, z: 0 });
      const got = (await device.remote.dispatch('get_transform', {
        device: 'controller-left',
      })) as { orientation: Vec3 & { w: number } };
      const forward = vec3.transformQuat(
        vec3.create(),
        [0, 0, -1],
        [
          got.orientation.x,
          got.orientation.y,
          got.orientation.z,
          got.orientation.w,
        ],
      );
      expect(vec3.dot(forward, [0, 0, -1])).toBeGreaterThan(0.9999);
    });

    test('get_device_state and set_device_state use the XR origin too', async () => {
      await dispatch('set_device_state', {
        state: {
          headset: { position: { x: 0, y: 1.5, z: 0.2 } },
          hands: {
            right: {
              position: { x: 0.2, y: 1.1, z: -0.3 },
              orientation: { x: 0, y: 0, z: 0, w: 1 },
            },
          },
        },
      });
      const state = (await device.remote.dispatch(
        'get_device_state',
      )) as RemoteDeviceState;
      expectVec(state.headset.position, { x: 0, y: 1.5, z: 0.2 });
      expectVec(state.hands.right.position, { x: 0.2, y: 1.1, z: -0.3 });
      expect(state.hands.right.orientation.w).toBeCloseTo(1, 6);
    });

    test('anchors, pins and hand directions are XR-origin too', async () => {
      const position = { x: 0.1, y: 1.1, z: -0.4 };
      await dispatch('set_transform', {
        device: 'hand-right',
        position,
        anchor: 'index-tip',
        orientation: { fingers: [0, 0, -1], palm: [0, -1, 0] },
      });
      const state = await handState('right');
      expectVec(state.anchors['index-tip'], position, 4);
      expectVec(state.pin!.target, position, 5);
      expectVec(state.axes.fingers, { x: 0, y: 0, z: -1 }, 4);
      expectVec(state.axes.palm, { x: 0, y: -1, z: 0 }, 4);
    });

    test('the reset without a state stays in the floor frame', async () => {
      await dispatch('set_device_state', {});
      // GlobalSpace (the floor frame) keeps the 1.6 m headset.
      expect(device.position.y).toBeCloseTo(1.6, 6);
    });

    test('the XR origin is the first reference space that is not the viewer space', () => {
      const viewer = mat4.fromTranslation(mat4.create(), [0, 1.6, 0]);
      const floor = mat4.fromTranslation(mat4.create(), [0, 0, 3]);
      const real = new XRDevice(metaQuest3);
      Object.defineProperty(real, 'activeSession', {
        get: () => ({
          [P_SESSION]: {
            referenceSpaces: [
              {
                [P_SPACE]: { offsetMatrix: viewer },
                [P_REF_SPACE]: { type: XRReferenceSpaceType.Viewer },
              },
              {
                [P_SPACE]: { offsetMatrix: floor },
                [P_REF_SPACE]: { type: XRReferenceSpaceType.LocalFloor },
              },
            ],
          },
        }),
        configurable: true,
      });
      expect(real[P_DEVICE].runtime.getSession()!.originOffsetMatrix).toBe(
        floor,
      );
    });
  });

  describe('timed commands', () => {
    test('animate_to starts from where the device is when it starts running', async () => {
      const placed = device.remote.dispatch('set_transform', {
        device: 'headset',
        position: { x: 1, y: 1.6, z: 0 },
      });
      const moved = device.remote.dispatch('animate_to', {
        device: 'headset',
        position: { x: 2, y: 1.6, z: 0 },
        duration: 0.1,
      });
      // The set_transform runs first in this frame; the animation then gets
      // the whole 50 ms.
      runFrame(50);
      await placed;
      expect(device.position.x).toBeCloseTo(1.5, 6);
      await run(moved);
      expect(device.position.x).toBeCloseTo(2, 6);
    });

    test('animate_to eases linearly by default, or with minimum-jerk', async () => {
      const at = async (easing: string | undefined) => {
        device.position.set(0, 1.6, 0);
        const done = device.remote.dispatch('animate_to', {
          device: 'headset',
          position: { x: 1, y: 1.6, z: 0 },
          duration: 1,
          ...(easing ? { easing } : {}),
        });
        runFrame(250);
        const x = device.position.x;
        await run(done, 10, 1000);
        return x;
      };
      expect(await at(undefined)).toBeCloseTo(0.25, 6);
      expect(await at('minimum-jerk')).toBeCloseTo(0.103515625, 6);
      await expect(at('bouncy')).rejects.toThrow("Unknown easing 'bouncy'");
    });

    test("a finished command passes the frame's leftover time to the next one", async () => {
      const first = device.remote.dispatch('animate_to', {
        device: 'headset',
        position: { x: 1, y: 1.6, z: 0 },
        duration: 0.1,
      });
      const second = device.remote.dispatch('animate_to', {
        device: 'headset',
        position: { x: 1, y: 1.6, z: -1 },
        duration: 0.1,
      });
      runFrame(150);
      const result = (await first) as AnimateToResult;
      expect(result.actualDuration).toBeCloseTo(0.15, 6);
      expect(device.position.z).toBeCloseTo(-0.5, 6);
      await run(second);
    });

    test('timed hand commands keep their order', async () => {
      const hand = device.hands.right!;
      const log: string[] = [];
      const track = (name: string, promise: Promise<unknown>) =>
        promise.then(() => log.push(name));
      const done = Promise.all([
        track(
          'move',
          device.remote.dispatch('animate_to', {
            device: 'hand-right',
            position: { x: 0.1, y: 1.1, z: -0.4 },
            anchor: 'index-tip',
            duration: 0.2,
          }),
        ),
        track(
          'pose',
          device.remote.dispatch('set_hand_pose', {
            device: 'hand-right',
            poseId: 'fist',
            duration: 0.2,
          }),
        ),
        track(
          'pinch',
          device.remote.dispatch('set_select_value', {
            device: 'hand-right',
            value: 0.5,
            duration: 0.2,
          }),
        ),
        track(
          'place',
          device.remote.dispatch('set_transform', {
            device: 'hand-right',
            position: { x: 0, y: 1.2, z: -0.3 },
          }),
        ),
      ]);
      const seen: string[] = [];
      for (let i = 0; i < 60; i++) {
        runFrame();
        await Promise.resolve();
        const now =
          hand.pinchValue > 0
            ? 'pinch'
            : hand.poseId === 'fist'
              ? 'pose'
              : hand.pin
                ? 'move'
                : 'idle';
        if (seen[seen.length - 1] !== now) seen.push(now);
      }
      await done;
      expect(seen.slice(0, 3)).toEqual(['move', 'pose', 'pinch']);
      expect(log).toEqual(['move', 'pose', 'pinch', 'place']);
      expect(hand.pin).toBeNull();
    });

    test('set_select_value with a duration ramps, and the press lands when the pinch reaches 0.9', async () => {
      const values: number[] = [];
      let pressedAt = -1;
      const done = device.remote.dispatch('set_select_value', {
        device: 'hand-right',
        value: 1,
        duration: 0.2,
      });
      for (let i = 0; i < 20; i++) {
        runFrame();
        values.push(device.hands.right!.pinchValue);
        if (pressedAt < 0 && events.length > 0) pressedAt = i;
        await Promise.resolve();
      }
      await done;
      expect(values.filter((v) => v > 0 && v < 1).length).toBeGreaterThan(5);
      expect(events).toEqual(['selectstart']);
      expect(values[pressedAt]).toBeGreaterThanOrEqual(0.9);
      expect(values[pressedAt - 1]).toBeLessThan(0.9);
    });

    test('a controller trigger can ramp too', async () => {
      const done = device.remote.dispatch('set_select_value', {
        device: 'controller-right',
        value: 1,
        duration: 0.1,
        easing: 'linear',
      });
      runFrame(50);
      runFrame(0);
      expect(device.controllers.right!.getButtonValue('trigger')).toBeCloseTo(
        0.5,
        6,
      );
      await run(done);
      expect(device.controllers.right!.getButtonValue('trigger')).toBe(1);
    });

    test('a hand select closes its pinch over 0.1 s, holds, and opens it over 0.1 s', async () => {
      const values: number[] = [];
      const done = device.remote.dispatch('select', {
        device: 'hand-right',
        duration: 0.1,
      });
      for (let i = 0; i < 40; i++) {
        runFrame(10);
        values.push(device.hands.right!.pinchValue);
        await Promise.resolve();
      }
      await done;
      const closing = values.slice(0, values.indexOf(1));
      const opening = values.slice(values.lastIndexOf(1) + 1);
      expect(closing.length).toBeGreaterThanOrEqual(8);
      expect(opening.filter((v) => v > 0).length).toBeGreaterThanOrEqual(8);
      expect(events).toEqual(['selectstart', 'select', 'selectend']);
    });

    test.each([70, 100, 200])(
      'a hand select still delivers press and release at %i ms frames',
      async (frameMs) => {
        const done = device.remote.dispatch('select', {
          device: 'hand-right',
          duration: 0.02,
        });
        for (let i = 0; i < 30; i++) {
          runFrame(frameMs);
          await Promise.resolve();
        }
        await done;
        expect(events).toEqual(['selectstart', 'select', 'selectend']);
      },
    );

    test('set_hand_pose with a duration fades, reporting the new pose and the fade right away', async () => {
      const hand = device.hands.right!;
      await dispatch('set_hand_pose', { device: 'hand-right', poseId: 'open' });
      const done = device.remote.dispatch('set_hand_pose', {
        device: 'hand-right',
        poseId: 'fist',
        duration: 0.3,
      });
      runFrame();
      runFrame();
      expect(hand.poseId).toBe('fist');
      const state = await handState('right');
      expect(state.poseId).toBe('fist');
      expect(state.transition).toEqual({
        from: 'open',
        progress: expect.any(Number),
      });
      expect(state.transition!.progress).toBeGreaterThan(0);
      expect(state.transition!.progress).toBeLessThan(1);
      await run(done);
      expect(hand.poseTransitionProgress).toBeNull();
      expect((await handState('right')).transition).toBeNull();
    });

    test('a fade sent right after an instant pose starts from that pose', async () => {
      await dispatch('set_hand_pose', { device: 'hand-right', poseId: 'open' });
      const fist = device.remote.dispatch('set_hand_pose', {
        device: 'hand-right',
        poseId: 'fist',
      });
      const fade = device.remote.dispatch('set_hand_pose', {
        device: 'hand-right',
        poseId: 'point',
        duration: 1,
      });
      fade.catch(() => {});
      // Both start in this frame; the fade has barely begun.
      runFrame(1);
      await fist;
      expect(device.hands.right!.poseTransitionFrom).toBe('fist');
      const shown = localJointOf('right', XRHandJoint.MiddleFingerTip);
      device.hands.right!.poseId = 'fist';
      runFrame(0);
      expect(
        vec3.distance(
          shown,
          localJointOf('right', XRHandJoint.MiddleFingerTip),
        ),
      ).toBeLessThan(0.001);
      await run(fade);
    });

    test('a fade interrupted mid-way restarts from the displayed hand, not from the old pose', () => {
      const hand = device.hands.right!;
      runFrame();
      const relaxed = localJointOf('right', XRHandJoint.IndexFingerTip);
      hand.beginPoseTransition('fist');
      hand.poseTransitionProgress = 0.5;
      runFrame();
      const halfway = localJointOf('right', XRHandJoint.IndexFingerTip);
      hand.beginPoseTransition('open');
      expect(hand.poseTransitionFrom).toBe('fist');
      runFrame();
      // Progress 0 of the new fade shows the half-closed hand.
      expect(
        vec3.distance(
          localJointOf('right', XRHandJoint.IndexFingerTip),
          halfway,
        ),
      ).toBeLessThan(1e-6);
      expect(vec3.distance(halfway, relaxed)).toBeGreaterThan(0.005);
    });

    test('setting poseId directly (the DevUI) cancels a fade and snaps', async () => {
      const hand = device.hands.right!;
      const done = device.remote.dispatch('set_hand_pose', {
        device: 'hand-right',
        poseId: 'fist',
        duration: 0.3,
      });
      done.catch(() => {});
      runFrame();
      runFrame();
      hand.poseId = 'open';
      expect(hand.poseTransitionProgress).toBeNull();
      runFrame();
      // The rest of the fade no longer touches the hand.
      expect(hand.poseTransitionProgress).toBeNull();
      await run(done);
      expect(hand.poseId).toBe('open');
      const snapped = localJointOf('right', XRHandJoint.IndexFingerTip);
      hand.poseId = 'open';
      runFrame();
      expect(
        vec3.distance(
          localJointOf('right', XRHandJoint.IndexFingerTip),
          snapped,
        ),
      ).toBeLessThan(1e-9);
    });

    test('rejects bad durations at dispatch', async () => {
      await expect(
        device.remote.dispatch('set_hand_pose', {
          device: 'hand-right',
          poseId: 'fist',
          duration: -1,
        }),
      ).rejects.toThrow('duration must be a number of seconds');
      await expect(
        device.remote.dispatch('set_select_value', {
          device: 'hand-right',
          value: 1,
          duration: Number.NaN,
        }),
      ).rejects.toThrow('duration must be a number of seconds');
      expect(device.remote.queueLength).toBe(0);
    });
  });

  describe('read-back', () => {
    test('get_hand_state reports pose, pinch, pressed, pin and key anchors; joints "all" adds every joint', async () => {
      await dispatch('set_transform', {
        device: 'hand-left',
        position: { x: -0.1, y: 1.1, z: -0.4 },
        anchor: 'grasp',
      });
      await dispatch('set_hand_pose', {
        device: 'hand-left',
        poseId: 'open',
        fingers: { middle: 'fist' },
      });
      await dispatch('set_select_value', { device: 'hand-left', value: 0.95 });
      runFrame();
      const state = await handState('left');
      expect(state).toMatchObject({
        device: 'hand-left',
        connected: true,
        poseId: 'open',
        fingers: { middle: { poseId: 'fist', weight: 1 } },
        transition: null,
        pinchValue: 0.95,
        pressed: true,
        pin: { anchor: 'grasp' },
      });
      expect(Object.keys(state.anchors).sort()).toEqual(
        ['grasp', 'grip', 'index-tip', 'thumb-tip', 'wrist'].sort(),
      );
      expect(
        vec3.distance(
          toVec(state.anchors['index-tip']),
          jointOf('left', XRHandJoint.IndexFingerTip),
        ),
      ).toBeLessThan(1e-6);
      expect(state.joints).toBeUndefined();
      const all = await handState('left', 'all');
      expect(Object.keys(all.joints!)).toHaveLength(25);
      expect(all.joints!['thumb-tip'].radius).toBeGreaterThan(0);
    });

    test('get_device_state reports hand poses and pinch; set_device_state applies them', async () => {
      await dispatch('set_device_state', {
        state: {
          hands: {
            right: { poseId: 'point', pinchValue: 0.4 },
          },
        },
      });
      runFrame();
      const state = (await device.remote.dispatch(
        'get_device_state',
      )) as RemoteDeviceState;
      expect(state.hands.right).toMatchObject({
        poseId: 'point',
        pinchValue: 0.4,
      });
      expect(state.hands.left).toMatchObject({
        poseId: 'default',
        pinchValue: 0,
      });
      await expect(
        dispatch('set_device_state', {
          state: { hands: { left: { poseId: 'wave' } } },
        }),
      ).rejects.toThrow("Unknown hand pose 'wave'");
    });
  });

  describe('live-hand checks', () => {
    const anchored = {
      device: 'hand-right',
      position: { x: 0.1, y: 1.1, z: -0.4 },
      anchor: 'index-tip',
    };

    test('new parameters need a live hand, checked when the command reaches the head of the queue', async () => {
      device.primaryInputMode = 'controller';
      await expect(dispatch('set_transform', anchored)).rejects.toThrow(
        'hand-right is not live: the input mode is controllers',
      );
      // A queued switch to hands ahead of it counts.
      const mode = device.remote.dispatch('set_input_mode', { mode: 'hand' });
      await dispatch('set_transform', anchored);
      await mode;
      expect(device.hands.right!.pin).not.toBeNull();
    });

    test.each([
      [
        'set_hand_pose',
        { device: 'hand-right', poseId: 'fist', duration: 0.1 },
      ],
      ['set_select_value', { device: 'hand-right', value: 1, duration: 0.1 }],
      ['animate_to', { ...anchored, duration: 0.1 }],
      [
        'set_transform',
        { device: 'hand-right', orientation: { fingers: 'up', palm: 'back' } },
      ],
    ])(
      '%s with new parameters throws for a disconnected hand',
      async (method, params) => {
        device.hands.right!.connected = false;
        await expect(dispatch(method, params)).rejects.toThrow(
          'hand-right is disconnected',
        );
      },
    );

    test("an anchored placement throws when the app's session has no hand tracking", async () => {
      enabledFeatures = ['local-floor'];
      await expect(dispatch('set_transform', anchored)).rejects.toThrow(
        "did not enable 'hand-tracking'",
      );
    });

    test('legacy hand commands still apply to a hand the app cannot see', async () => {
      device.primaryInputMode = 'controller';
      await dispatch('set_transform', {
        device: 'hand-right',
        position: { x: 0.3, y: 1.2, z: -0.3 },
      });
      expect(device.hands.right!.position.x).toBeCloseTo(0.3, 6);
      await dispatch('set_hand_pose', { device: 'hand-right', poseId: 'fist' });
      expect(device.hands.right!.poseId).toBe('fist');
      await dispatch('set_select_value', { device: 'hand-right', value: 0.5 });
      runFrame();
      expect(device.hands.right!.pinchValue).toBe(0.5);
    });
  });
});
