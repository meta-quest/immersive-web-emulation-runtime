/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  HOST_INPUT_JOINTS,
  HOST_INPUT_JOINT_STRIDE,
  XRHostInput,
  XRHostInputMode,
  XRHostInputState,
} from '../../src/device/XRHostInput';
import { P_DEVICE, P_SESSION } from '../../src/private.js';
import {
  XRReferenceSpace,
  XRReferenceSpaceType,
} from '../../src/spaces/XRReferenceSpace';
import { mat4, quat } from 'gl-matrix';

import { XRDevice } from '../../src/device/XRDevice';
import { XRFrame } from '../../src/frameloop/XRFrame';
import { XRHandJoint } from '../../src/input/XRHand';
import { XRInputSource } from '../../src/input/XRInputSource';
import { XRInputSourcesChangeEvent } from '../../src/events/XRInputSourcesChangeEvent';
import { XRJointSpace } from '../../src/spaces/XRJointSpace';
import { XRSession } from '../../src/session/XRSession';
import { XRSystem } from '../../src/initialization/XRSystem';
import { XRWebGLLayer } from '../../src/layers/XRWebGLLayer';
import { Vector3 } from '../../src/utils/Math';
import { metaQuest3 } from '../../src/device/configs/headset/meta';

// silence console logs
console.log = () => {};

const mockGL = () =>
  ({
    getParameter: jest.fn((param: number) =>
      param === 0 ? [0, 0, 0, 0] : param === 1 ? 1 : 0,
    ),
    clearColor: jest.fn(),
    clearDepth: jest.fn(),
    clearStencil: jest.fn(),
    clear: jest.fn(),
    COLOR_CLEAR_VALUE: 0,
    DEPTH_CLEAR_VALUE: 1,
    STENCIL_CLEAR_VALUE: 2,
    DEPTH_BUFFER_BIT: 3,
    COLOR_BUFFER_BIT: 4,
    STENCIL_BUFFER_BIT: 5,
    canvas: document.createElement('canvas'),
  }) as any;

type Logged = { frame: number; type: string; source?: XRInputSource };

const setPose = (
  out: Float32Array,
  position: [number, number, number],
  orientation: [number, number, number, number] = [0, 0, 0, 1],
) => {
  out.set(position, 0);
  out.set(orientation, 3);
};

describe('XRHostInput', () => {
  let device: XRDevice;
  let session: XRSession;
  let input: XRHostInput;
  let local: XRReferenceSpace;
  let log: Logged[];
  let frameIndex: number;
  let haptics: [string, number, number, number][];

  // Runs one frame through the session's own frame loop; `inFrame` runs as a
  // requestAnimationFrame callback, while the frame is active.
  const runFrame = (inFrame?: (frame: XRFrame) => void) => {
    frameIndex++;
    if (inFrame) {
      session.requestAnimationFrame((_t, frame) => inFrame(frame));
    }
    session[P_SESSION].onDeviceFrame();
  };

  const start = async (features: string[] = ['hand-tracking']) => {
    const system = new XRSystem(device);
    session = await system.requestSession('immersive-vr', {
      optionalFeatures: features as any,
    });
    session.updateRenderState({
      baseLayer: new XRWebGLLayer(session, mockGL()),
    });
    local = await session.requestReferenceSpace(XRReferenceSpaceType.Local);
    for (const type of [
      'inputsourceschange',
      'selectstart',
      'select',
      'selectend',
      'squeezestart',
      'squeeze',
      'squeezeend',
    ]) {
      session.addEventListener(type, (event: any) => {
        log.push({
          frame: frameIndex,
          type,
          source: event.inputSource,
        });
      });
    }
  };

  const types = () => log.map((e) => [e.frame, e.type]);

  beforeEach(async () => {
    jest.useFakeTimers();
    log = [];
    frameIndex = 0;
    haptics = [];
    // Headset at the origin, so the local space is the global space.
    device = new XRDevice(metaQuest3, {
      headsetPosition: new Vector3(0, 0, 0),
    });
    input = device.enableHostInput({
      onHaptic: (handedness, intensity, durationMs, frequencyHz) => {
        haptics.push([handedness, intensity, durationMs, frequencyHz]);
      },
    });
    await start();
  });

  afterEach(() => {
    session.end();
    jest.useRealTimers();
  });

  describe('enabling', () => {
    test('enableHostInput returns one object per device; disable restores emulation', () => {
      expect(device.hostInput).toBe(input);
      expect(device.enableHostInput()).toBe(input);
      expect(input.left).toBeInstanceOf(XRHostInputState);
      expect(input.get('right')).toBe(input.right);
      // Nothing listed until the host picks a mode.
      expect(device.inputSources).toEqual([]);
      device.disableHostInput();
      expect(device.hostInput).toBeNull();
      expect(device.inputSources).toEqual([
        device.controllers.left!.inputSource,
        device.controllers.right!.inputSource,
      ]);
    });

    test('state objects start untracked with identity orientations', () => {
      const s = input.left;
      expect(s.mode).toBe(XRHostInputMode.None);
      expect(Array.from(s.targetRay)).toEqual([0, 0, 0, 0, 0, 0, 1]);
      expect(s.targetRayValid).toBe(false);
      expect(s.joints.length).toBe(HOST_INPUT_JOINTS * HOST_INPUT_JOINT_STRIDE);
      expect(s.joints[6]).toBe(1);
      expect(s.buttonValues.length).toBe(10);
    });
  });

  describe('gamepad layouts', () => {
    test('controllers: xr-standard, Touch profiles, left menu at 7, numeric axes', () => {
      const left = input.getController('left').inputSource;
      const right = input.getController('right').inputSource;
      expect(left.profiles).toEqual(
        device.controllers.left!.inputSource.profiles,
      );
      expect(left.profiles[0]).toBe('meta-quest-touch-plus');
      expect(left.gamepad!.mapping).toBe('xr-standard');
      expect(left.gamepad!.buttons.length).toBe(8);
      expect(right.gamepad!.buttons.length).toBe(7);
      expect(left.gamepad!.axes).toEqual([0, 0, 0, 0]);
      expect(left.gamepad!.hapticActuators.length).toBe(1);
      expect(left.targetRayMode).toBe('tracked-pointer');
      expect(left.handedness).toBe('left');
    });

    test('leftMenuButton: false keeps the config layout', () => {
      const other = new XRDevice(metaQuest3).enableHostInput({
        leftMenuButton: false,
      });
      expect(
        other.getController('left').inputSource.gamepad!.buttons.length,
      ).toBe(7);
    });

    test('hands: the hand gamepad, hand profiles, 25 joints', () => {
      const hand = input.getHand('right').inputSource;
      expect(hand.profiles[0]).toBe('oculus-hand');
      expect(hand.gamepad!.mapping).toBe('xr-standard');
      expect(hand.gamepad!.buttons.length).toBe(10);
      expect(hand.gamepad!.axes).toEqual([]);
      expect(hand.hand!.size).toBe(25);
      expect(Array.from(hand.hand!.keys())).toEqual(Object.values(XRHandJoint));
    });
  });

  describe('listing sources', () => {
    test('a mode lists its source with one inputsourceschange', () => {
      const changes: XRInputSourcesChangeEvent[] = [];
      session.addEventListener('inputsourceschange', (e: any) =>
        changes.push(e),
      );
      runFrame();
      expect(session.inputSources.length).toBe(0);
      input.left.mode = XRHostInputMode.Controller;
      input.right.mode = XRHostInputMode.Hand;
      runFrame();
      expect(changes.length).toBe(1);
      expect(changes[0].added).toEqual([
        input.getController('left').inputSource,
        input.getHand('right').inputSource,
      ]);
      expect(Array.from(session.inputSources)).toEqual(changes[0].added);
      expect(input.getController('left').inputSource.gamepad!.connected).toBe(
        true,
      );
      runFrame();
      expect(changes.length).toBe(1);
    });

    test('switching controller to hand swaps the source in one event', () => {
      input.left.mode = XRHostInputMode.Controller;
      runFrame();
      const changes: XRInputSourcesChangeEvent[] = [];
      session.addEventListener('inputsourceschange', (e: any) =>
        changes.push(e),
      );
      input.left.mode = XRHostInputMode.Hand;
      runFrame();
      expect(changes.length).toBe(1);
      expect(changes[0].removed).toEqual([
        input.getController('left').inputSource,
      ]);
      expect(changes[0].added).toEqual([input.getHand('left').inputSource]);
      expect(input.getController('left').inputSource.gamepad!.connected).toBe(
        false,
      );
    });

    test('without the hand-tracking feature, tracked hands stay out of inputSources', async () => {
      session.end();
      await start([]);
      input.left.mode = XRHostInputMode.Hand;
      input.right.mode = XRHostInputMode.Controller;
      runFrame();
      expect(Array.from(session.inputSources)).toEqual([
        input.getController('right').inputSource,
      ]);
    });

    test('a hidden session lists nothing and comes back without a click', () => {
      input.right.mode = XRHostInputMode.Controller;
      runFrame();
      runFrame();
      input.right.buttonPressed[0] = 1;
      runFrame();
      expect(types()).toEqual([
        [1, 'inputsourceschange'],
        [3, 'selectstart'],
      ]);
      log = [];
      device[P_DEVICE].pendingVisibilityState = 'hidden';
      runFrame();
      expect(session.inputSources.length).toBe(0);
      // Removed silently: no selectend for the hidden source.
      expect(types()).toEqual([[4, 'inputsourceschange']]);
      log = [];
      device[P_DEVICE].pendingVisibilityState = 'visible';
      runFrame();
      runFrame();
      // Still held when visible again: listed, then a new press next frame.
      expect(types()).toEqual([
        [5, 'inputsourceschange'],
        [6, 'selectstart'],
      ]);
    });

    test('steady frames skip the session diff and keep the same arrays', () => {
      input.left.mode = XRHostInputMode.Controller;
      runFrame();
      const sources = device.inputSources;
      const spy = jest.spyOn(device, 'inputSources', 'get');
      for (let i = 0; i < 5; i++) runFrame();
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
      expect(device.inputSources).toBe(sources);
    });
  });

  describe('poses', () => {
    test('target ray and grip come from the state, separately', () => {
      const s = input.left;
      s.mode = XRHostInputMode.Controller;
      const q = quat.setAxisAngle(quat.create(), [0, 1, 0], Math.PI / 2);
      setPose(s.targetRay, [0.1, 1.2, -0.3], [q[0], q[1], q[2], q[3]]);
      s.targetRayValid = true;
      setPose(s.grip, [0.12, 1.1, -0.25]);
      s.gripValid = true;
      let ray: XRPose | null = null;
      let grip: XRPose | null = null;
      runFrame((frame) => {
        const source = session.inputSources[0];
        ray = frame.getPose(source.targetRaySpace, local);
        grip = frame.getPose(source.gripSpace!, local);
      });
      expect(ray!.transform.position.x).toBeCloseTo(0.1);
      expect(ray!.transform.position.y).toBeCloseTo(1.2);
      expect(ray!.transform.position.z).toBeCloseTo(-0.3);
      expect(ray!.transform.orientation.y).toBeCloseTo(q[1]);
      expect(ray!.transform.orientation.w).toBeCloseTo(q[3]);
      expect(ray!.emulatedPosition).toBe(false);
      expect(grip!.transform.position.x).toBeCloseTo(0.12);
      expect(grip!.transform.position.z).toBeCloseTo(-0.25);
    });

    test('an invalid pose has no pose (as space or base space)', () => {
      const s = input.left;
      s.mode = XRHostInputMode.Controller;
      s.targetRayValid = true;
      s.gripValid = false;
      runFrame((frame) => {
        const source = session.inputSources[0];
        expect(frame.getPose(source.gripSpace!, local)).toBeNull();
        expect(frame.getPose(local, source.gripSpace!)).toBeNull();
        expect(frame.getPose(source.targetRaySpace, local)).not.toBeNull();
      });
      s.gripValid = true;
      runFrame((frame) => {
        const source = session.inputSources[0];
        expect(frame.getPose(source.gripSpace!, local)).not.toBeNull();
      });
    });

    test('hand joints, radii and validity', () => {
      const s = input.right;
      s.mode = XRHostInputMode.Hand;
      for (let j = 0; j < HOST_INPUT_JOINTS; j++) {
        const o = j * HOST_INPUT_JOINT_STRIDE;
        s.joints.set(
          [0.2, 0.9 + 0.015 * j, -0.35, 0, 0, 0, 1, 0.004 + 0.0002 * j],
          o,
        );
        s.jointValid[j] = 1;
      }
      s.jointValid[9] = 0; // index-finger-tip
      runFrame((frame) => {
        const hand = session.inputSources[0].hand!;
        const thumbTip = hand.get(XRHandJoint.ThumbTip)!;
        const pose = frame.getJointPose!(thumbTip, local)!;
        expect(pose.transform.position.y).toBeCloseTo(0.96);
        expect(pose.radius).toBeCloseTo(0.0048);
        expect(
          frame.getJointPose!(hand.get(XRHandJoint.IndexFingerTip)!, local),
        ).toBeNull();
        const spaces = Array.from(hand.values()) as XRJointSpace[];
        const transforms = new Float32Array(25 * 16);
        expect(frame.fillPoses!(spaces, local, transforms)).toBe(false);
        expect(transforms[9 * 16]).toBeNaN();
        expect(transforms[4 * 16 + 13]).toBeCloseTo(0.96);
        const radii = new Float32Array(25);
        expect(frame.fillJointRadii!(spaces, radii)).toBe(false);
        expect(radii[9]).toBeNaN();
        expect(radii[0]).toBeCloseTo(0.004);
      });
      s.jointValid[9] = 1;
      runFrame((frame) => {
        const spaces = Array.from(
          session.inputSources[0].hand!.values(),
        ) as XRJointSpace[];
        expect(frame.fillPoses!(spaces, local, new Float32Array(25 * 16))).toBe(
          true,
        );
        expect(frame.fillJointRadii!(spaces, new Float32Array(25))).toBe(true);
      });
    });

    test('a hand grip falls back to the palm', () => {
      const s = input.left;
      s.mode = XRHostInputMode.Hand;
      setPose(s.palm, [0.15, 1.25, -0.1]);
      s.palmValid = true;
      s.gripValid = false;
      runFrame((frame) => {
        const pose = frame.getPose(session.inputSources[0].gripSpace!, local);
        expect(pose!.transform.position.x).toBeCloseTo(0.15);
      });
      setPose(s.grip, [0.22, 1.3, -0.15]);
      s.gripValid = true;
      runFrame((frame) => {
        const pose = frame.getPose(session.inputSources[0].gripSpace!, local);
        expect(pose!.transform.position.x).toBeCloseTo(0.22);
      });
      s.gripValid = false;
      s.palmValid = false;
      runFrame((frame) => {
        expect(
          frame.getPose(session.inputSources[0].gripSpace!, local),
        ).toBeNull();
      });
    });

    test('matrices match gl-matrix for an arbitrary pose', () => {
      const s = input.left;
      s.mode = XRHostInputMode.Controller;
      const q = quat.normalize(quat.create(), [0.3, -0.5, 0.2, 0.7]);
      setPose(s.targetRay, [1, 2, 3], [q[0], q[1], q[2], q[3]]);
      s.targetRayValid = true;
      runFrame((frame) => {
        const pose = frame.getPose(
          session.inputSources[0].targetRaySpace,
          local,
        )!;
        const expected = mat4.fromRotationTranslation(
          mat4.create(),
          q,
          [1, 2, 3],
        );
        const actual = pose.transform.matrix;
        for (let i = 0; i < 16; i++) {
          expect(actual[i]).toBeCloseTo(expected[i], 5);
        }
      });
    });
  });

  describe('buttons and events', () => {
    beforeEach(() => {
      input.right.mode = XRHostInputMode.Controller;
      runFrame(); // listed and primed
      log = [];
    });

    test('values are verbatim; pressed implies touched; no threshold', () => {
      const s = input.right;
      s.buttonValues[0] = 0.65;
      s.buttonPressed[0] = 0;
      s.buttonTouched[5] = 1;
      s.buttonValues[4] = 1;
      s.buttonPressed[4] = 1;
      s.axes[2] = -0.75;
      s.axes[3] = 0.375;
      runFrame();
      const gamepad = session.inputSources[0].gamepad!;
      expect(gamepad.buttons[0]!.value).toBeCloseTo(0.65);
      expect(gamepad.buttons[0]!.pressed).toBe(false);
      expect(gamepad.buttons[5]!.touched).toBe(true);
      expect(gamepad.buttons[5]!.pressed).toBe(false);
      expect(gamepad.buttons[4]!.touched).toBe(true);
      expect(gamepad.axes).toEqual([0, 0, -0.75, 0.375]);
      expect(types()).toEqual([]);
    });

    test('trigger and squeeze edges fire WebXR events in order', () => {
      const s = input.right;
      s.buttonPressed[0] = 1;
      runFrame();
      s.buttonPressed[1] = 1;
      runFrame();
      s.buttonPressed[0] = 0;
      s.buttonPressed[1] = 0;
      runFrame();
      expect(types()).toEqual([
        [2, 'selectstart'],
        [3, 'squeezestart'],
        [4, 'select'],
        [4, 'selectend'],
        [4, 'squeeze'],
        [4, 'squeezeend'],
      ]);
      expect(log[0].source).toBe(session.inputSources[0]);
    });

    test('the gamepad agrees with the event on the frame it fires', () => {
      let pressedAtStart: boolean | null = null;
      session.addEventListener('selectstart', (e: any) => {
        pressedAtStart = e.inputSource.gamepad.buttons[0]!.pressed;
      });
      input.right.buttonPressed[0] = 1;
      runFrame();
      expect(pressedAtStart).toBe(true);
    });

    test('a source listed with a held trigger presses on the next frame', () => {
      input.left.mode = XRHostInputMode.Controller;
      input.left.buttonPressed[0] = 1;
      runFrame();
      runFrame();
      expect(types()).toEqual([
        [2, 'inputsourceschange'],
        [3, 'selectstart'],
      ]);
      expect(log[1].source).toBe(input.getController('left').inputSource);
    });

    test('a held press on a removed source ends without completing', () => {
      input.right.buttonPressed[0] = 1;
      runFrame();
      input.right.mode = XRHostInputMode.Hand;
      runFrame();
      expect(types()).toEqual([
        [2, 'selectstart'],
        [3, 'selectend'],
        [3, 'inputsourceschange'],
      ]);
    });

    test('the timestamp is the frame time', () => {
      let time = -1;
      runFrame((frame) => {
        time = frame.predictedDisplayTime;
      });
      expect(session.inputSources[0].gamepad!.timestamp).toBe(time);
    });

    test('a new session primes again', async () => {
      input.right.buttonPressed[0] = 1;
      runFrame();
      session.end();
      log = [];
      await start();
      runFrame();
      runFrame();
      expect(types()).toEqual([
        [frameIndex - 1, 'inputsourceschange'],
        [frameIndex, 'selectstart'],
      ]);
    });
  });

  describe('hands', () => {
    test('tracked hands: button 0 is the pinch and selects, button 4 is the menu, 1 to 3 report nothing', () => {
      const s = input.left;
      s.mode = XRHostInputMode.Hand;
      runFrame();
      log = [];
      s.buttonValues[0] = 1;
      s.buttonPressed[0] = 1;
      s.buttonValues[1] = 0.8;
      s.buttonPressed[1] = 1;
      s.buttonValues[4] = 1;
      s.buttonPressed[4] = 1;
      runFrame();
      const gamepad = session.inputSources[0].gamepad!;
      expect(gamepad.buttons[0]!.pressed).toBe(true);
      expect(gamepad.buttons[1]!.value).toBe(0);
      expect(gamepad.buttons[4]!.pressed).toBe(true);
      expect(types()).toEqual([[2, 'selectstart']]);
      s.buttonPressed[0] = 0;
      s.buttonValues[0] = 0;
      runFrame();
      expect(types()).toEqual([
        [2, 'selectstart'],
        [3, 'select'],
        [3, 'selectend'],
      ]);
    });
  });

  describe('haptics', () => {
    test('pulse goes to onHaptic, clamped', async () => {
      const actuator =
        input.getController('left').inputSource.gamepad!.hapticActuators[0];
      await expect(actuator.pulse(1.5, 40)).resolves.toBe(true);
      expect(haptics).toEqual([['left', 1, 40, 0]]);
    });

    test('a promise from onHaptic is the pulse result', async () => {
      input.onHaptic = () => Promise.resolve(false);
      const actuator =
        input.getController('right').inputSource.gamepad!.vibrationActuator!;
      await expect(actuator.pulse(0.5, 10)).resolves.toBe(false);
    });

    test('playEffect and reset', async () => {
      const actuator =
        input.getController('right').inputSource.gamepad!.vibrationActuator!;
      await expect(
        actuator.playEffect('dual-rumble', {
          duration: 100,
          strongMagnitude: 0.25,
          weakMagnitude: 0.75,
        }),
      ).resolves.toBe('complete');
      await expect(actuator.reset()).resolves.toBe('complete');
      expect(haptics).toEqual([
        ['right', 0.75, 100, 0],
        ['right', 0, 0, 0],
      ]);
      await expect(actuator.playEffect('bogus' as any)).rejects.toThrow();
    });

    test('enableHostInput again replaces onHaptic', async () => {
      const calls: string[] = [];
      device.enableHostInput({ onHaptic: (h) => void calls.push(h) });
      await input
        .getController('left')
        .inputSource.gamepad!.hapticActuators[0].pulse(1, 1);
      expect(calls).toEqual(['left']);
    });
  });
});
