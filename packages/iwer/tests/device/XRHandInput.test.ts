/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  HandPose,
  XRHandInput,
  handFingerJoints,
  oculusHandConfig,
} from '../../src/device/XRHandInput';
import { XRHandJoint } from '../../src/input/XRHand';
import { XRHandedness } from '../../src/input/XRInputSource';
import { GlobalSpace } from '../../src/spaces/XRSpace';
import { XRFrame } from '../../src/frameloop/XRFrame';
import { BUILTIN_HAND_POSE_IDS } from '../../src/device/configs/hand/ids';
import { handPoseAngles } from '../../src/device/configs/hand/library';
import { P_SPACE } from '../../src/private';
import { mat4, vec3 } from 'gl-matrix';

const jointPosition = (matrix: mat4) =>
  mat4.getTranslation(vec3.create(), matrix);
const poseJoint = (poseId: string, joint: XRHandJoint) =>
  oculusHandConfig.poses[poseId].jointTransforms[joint].offsetMatrix;
const distance = (a: mat4, b: mat4) =>
  vec3.distance(jointPosition(a), jointPosition(b));
const expectMatrixClose = (actual: mat4, expected: mat4, digits = 5) => {
  for (let i = 0; i < 16; i++) {
    expect(actual[i]).toBeCloseTo(expected[i], digits);
  }
};
const clonePose = (pose: HandPose): HandPose => {
  const clone = { jointTransforms: {} } as HandPose;
  for (const [joint, transform] of Object.entries(pose.jointTransforms)) {
    clone.jointTransforms[joint as XRHandJoint] = {
      offsetMatrix: mat4.clone(transform.offsetMatrix),
      radius: transform.radius,
    };
  }
  clone.gripOffsetMatrix = pose.gripOffsetMatrix;
  return clone;
};
const configWith = (poses: Record<string, HandPose>) => ({
  ...oculusHandConfig,
  poses: { ...oculusHandConfig.poses, ...poses },
});

// Mock console.warn
const originalWarn = console.warn;

describe('XRHandInput', () => {
  let globalSpace: GlobalSpace;
  let xrHandInput: XRHandInput;
  let mockFrame: XRFrame;

  beforeEach(() => {
    // Reset console.warn
    console.warn = jest.fn();

    globalSpace = new GlobalSpace();

    // Create a mock frame with session
    mockFrame = {
      session: {
        dispatchEvent: jest.fn(),
      },
    } as any;
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  test('should create XRHandInput for left hand', () => {
    xrHandInput = new XRHandInput(
      oculusHandConfig,
      XRHandedness.Left,
      globalSpace,
    );

    expect(xrHandInput).toBeDefined();
    expect(xrHandInput.inputSource.handedness).toBe(XRHandedness.Left);
    expect(xrHandInput.poseId).toBe('default');
  });

  test('should create XRHandInput for right hand', () => {
    xrHandInput = new XRHandInput(
      oculusHandConfig,
      XRHandedness.Right,
      globalSpace,
    );

    expect(xrHandInput).toBeDefined();
    expect(xrHandInput.inputSource.handedness).toBe(XRHandedness.Right);
    expect(xrHandInput.poseId).toBe('default');
  });

  test('should throw error for invalid handedness', () => {
    expect(() => {
      new XRHandInput(oculusHandConfig, 'invalid' as any, globalSpace);
    }).toThrow('handedness for XRHandInput must be either "left" or "right"');
  });

  test('should throw error for missing default pose config', () => {
    const invalidConfig = {
      ...oculusHandConfig,
      poses: {
        // Missing default pose, only have pinch
        pinch: oculusHandConfig.poses.pinch,
        point: oculusHandConfig.poses.point,
      },
    } as any;

    expect(() => {
      new XRHandInput(invalidConfig, XRHandedness.Left, globalSpace);
    }).toThrow('"default" and "pinch" hand pose configs are required');
  });

  test('should throw error for missing pinch pose config', () => {
    const invalidConfig = {
      ...oculusHandConfig,
      poses: {
        // Missing pinch pose, only have default
        default: oculusHandConfig.poses.default,
        point: oculusHandConfig.poses.point,
      },
    } as any;

    expect(() => {
      new XRHandInput(invalidConfig, XRHandedness.Left, globalSpace);
    }).toThrow('"default" and "pinch" hand pose configs are required');
  });

  test('should get and set poseId', () => {
    xrHandInput = new XRHandInput(
      oculusHandConfig,
      XRHandedness.Left,
      globalSpace,
    );

    expect(xrHandInput.poseId).toBe('default');

    xrHandInput.poseId = 'pinch';
    expect(xrHandInput.poseId).toBe('pinch');

    xrHandInput.poseId = 'point';
    expect(xrHandInput.poseId).toBe('point');
  });

  test('should warn and not change poseId for invalid pose', () => {
    xrHandInput = new XRHandInput(
      oculusHandConfig,
      XRHandedness.Left,
      globalSpace,
    );

    const originalPoseId = xrHandInput.poseId;
    xrHandInput.poseId = 'invalid-pose';

    expect(console.warn).toHaveBeenCalledWith(
      'Pose config invalid-pose not found',
    );
    expect(xrHandInput.poseId).toBe(originalPoseId);
  });

  test('should get pinchValue', () => {
    xrHandInput = new XRHandInput(
      oculusHandConfig,
      XRHandedness.Left,
      globalSpace,
    );

    const pinchValue = xrHandInput.pinchValue;
    expect(typeof pinchValue).toBe('number');
    expect(pinchValue).toBeGreaterThanOrEqual(0);
    expect(pinchValue).toBeLessThanOrEqual(1);
  });

  test('should update pinch value within valid range', () => {
    xrHandInput = new XRHandInput(
      oculusHandConfig,
      XRHandedness.Left,
      globalSpace,
    );

    xrHandInput.updatePinchValue(0.5);
    xrHandInput.onFrameStart(mockFrame); // Process pending value
    expect(xrHandInput.pinchValue).toBe(0.5);

    xrHandInput.updatePinchValue(0);
    xrHandInput.onFrameStart(mockFrame); // Process pending value
    expect(xrHandInput.pinchValue).toBe(0);

    xrHandInput.updatePinchValue(1);
    xrHandInput.onFrameStart(mockFrame); // Process pending value
    expect(xrHandInput.pinchValue).toBe(1);
  });

  test('should synchronously clear both current and pending pinch state', () => {
    xrHandInput = new XRHandInput(
      oculusHandConfig,
      XRHandedness.Left,
      globalSpace,
    );

    xrHandInput.updatePinchValue(1);
    xrHandInput.onFrameStart(mockFrame);
    (mockFrame.session.dispatchEvent as jest.Mock).mockClear();
    xrHandInput.setPinchValueImmediate(0);

    expect(xrHandInput.pinchValue).toBe(0);
    xrHandInput.onFrameStart(mockFrame);
    expect(xrHandInput.pinchValue).toBe(0);
    expect(mockFrame.session.dispatchEvent).toHaveBeenCalledTimes(1);
    expect(
      (mockFrame.session.dispatchEvent as jest.Mock).mock.calls[0][0].type,
    ).toBe('selectend');
  });

  test('should warn for out-of-range pinch values and not update', () => {
    xrHandInput = new XRHandInput(
      oculusHandConfig,
      XRHandedness.Left,
      globalSpace,
    );

    const originalValue = xrHandInput.pinchValue;

    xrHandInput.updatePinchValue(-0.1);
    expect(console.warn).toHaveBeenCalledWith(
      'Out-of-range value -0.1 provided for pinch',
    );
    expect(xrHandInput.pinchValue).toBe(originalValue);

    xrHandInput.updatePinchValue(1.1);
    expect(console.warn).toHaveBeenCalledWith(
      'Out-of-range value 1.1 provided for pinch',
    );
    expect(xrHandInput.pinchValue).toBe(originalValue);
  });

  test('should call updateHandPose on frame start', () => {
    xrHandInput = new XRHandInput(
      oculusHandConfig,
      XRHandedness.Left,
      globalSpace,
    );

    // Spy on updateHandPose method
    const updateHandPoseSpy = jest.spyOn(xrHandInput, 'updateHandPose');

    xrHandInput.onFrameStart(mockFrame);

    expect(updateHandPoseSpy).toHaveBeenCalled();
  });

  test('should handle different hand poses correctly', () => {
    xrHandInput = new XRHandInput(
      oculusHandConfig,
      XRHandedness.Left,
      globalSpace,
    );

    // Test switching between poses
    xrHandInput.poseId = 'default';
    expect(xrHandInput.poseId).toBe('default');

    xrHandInput.poseId = 'pinch';
    expect(xrHandInput.poseId).toBe('pinch');

    xrHandInput.poseId = 'point';
    expect(xrHandInput.poseId).toBe('point');

    // Update hand pose to apply changes
    expect(() => xrHandInput.updateHandPose()).not.toThrow();
  });

  describe('built-in pose library', () => {
    test('lists every built-in pose', () => {
      xrHandInput = new XRHandInput(
        oculusHandConfig,
        XRHandedness.Left,
        globalSpace,
      );
      expect(xrHandInput.poseIds).toEqual([...BUILTIN_HAND_POSE_IDS]);
    });

    test('builds every library pose on the captured skeleton', () => {
      const rest = oculusHandConfig.poses.default;
      for (const poseId of Object.keys(handPoseAngles)) {
        const pose = oculusHandConfig.poses[poseId];
        for (const joints of Object.values(handFingerJoints)) {
          for (let i = 1; i < joints.length; i++) {
            expect(
              distance(
                pose.jointTransforms[joints[i - 1]].offsetMatrix,
                pose.jointTransforms[joints[i]].offsetMatrix,
              ),
            ).toBeCloseTo(
              distance(
                rest.jointTransforms[joints[i - 1]].offsetMatrix,
                rest.jointTransforms[joints[i]].offsetMatrix,
              ),
              6,
            );
          }
        }
      }
    });

    test('closes the pinch poses on the named fingertip', () => {
      const tips: Record<string, XRHandJoint> = {
        ok: XRHandJoint.IndexFingerTip,
        'pinch-middle': XRHandJoint.MiddleFingerTip,
        'pinch-ring': XRHandJoint.RingFingerTip,
        'pinch-pinky': XRHandJoint.PinkyFingerTip,
        tripod: XRHandJoint.IndexFingerTip,
      };
      for (const [poseId, tip] of Object.entries(tips)) {
        expect(
          distance(
            poseJoint(poseId, XRHandJoint.ThumbTip),
            poseJoint(poseId, tip),
          ),
        ).toBeLessThan(0.015);
      }
      // An open hand keeps the thumb far from every fingertip.
      expect(
        distance(
          poseJoint('open', XRHandJoint.ThumbTip),
          poseJoint('open', XRHandJoint.IndexFingerTip),
        ),
      ).toBeGreaterThan(0.08);
    });
  });

  describe('finger blending', () => {
    const jointMatrix = (input: XRHandInput, joint: XRHandJoint) =>
      input.inputSource.hand!.get(joint)![P_SPACE].offsetMatrix;

    beforeEach(() => {
      xrHandInput = new XRHandInput(
        oculusHandConfig,
        XRHandedness.Left,
        globalSpace,
      );
    });

    test('takes whole fingers from another pose', () => {
      xrHandInput.poseId = 'open';
      for (const finger of ['middle', 'ring', 'pinky'] as const) {
        xrHandInput.setFingerPose(finger, 'fist');
      }
      xrHandInput.updateHandPose();

      // Library poses share the wrist, so blended fingers match the source.
      for (const finger of ['middle', 'ring', 'pinky'] as const) {
        for (const joint of handFingerJoints[finger]) {
          expectMatrixClose(
            jointMatrix(xrHandInput, joint),
            poseJoint('fist', joint),
          );
        }
      }
      for (const finger of ['thumb', 'index'] as const) {
        for (const joint of handFingerJoints[finger]) {
          expectMatrixClose(
            jointMatrix(xrHandInput, joint),
            poseJoint('open', joint),
          );
        }
      }
    });

    test('attaches blended fingers to the base pose wrist', () => {
      // The captured point pose places the wrist differently from open.
      xrHandInput.poseId = 'point';
      xrHandInput.setFingerPose('index', 'open');
      xrHandInput.updateHandPose();

      const local = (wrist: mat4, joint: mat4) => {
        const out = mat4.create();
        mat4.invert(out, wrist);
        return mat4.multiply(out, out, joint);
      };
      for (const joint of handFingerJoints.index) {
        expectMatrixClose(
          local(
            jointMatrix(xrHandInput, XRHandJoint.Wrist),
            jointMatrix(xrHandInput, joint),
          ),
          local(poseJoint('open', XRHandJoint.Wrist), poseJoint('open', joint)),
        );
      }
    });

    test('keeps bone lengths through partial weights', () => {
      xrHandInput.poseId = 'open';
      xrHandInput.setFingerPose('index', 'fist', 0.5);
      xrHandInput.updateHandPose();

      const joints = handFingerJoints.index;
      for (let i = 1; i < joints.length; i++) {
        expect(
          distance(
            jointMatrix(xrHandInput, joints[i - 1]),
            jointMatrix(xrHandInput, joints[i]),
          ),
        ).toBeCloseTo(
          distance(
            poseJoint('open', joints[i - 1]),
            poseJoint('open', joints[i]),
          ),
          4,
        );
      }
      const tip = jointPosition(
        jointMatrix(xrHandInput, XRHandJoint.IndexFingerTip),
      );
      expect(
        vec3.distance(
          tip,
          jointPosition(poseJoint('open', XRHandJoint.IndexFingerTip)),
        ),
      ).toBeGreaterThan(0.02);
      expect(
        vec3.distance(
          tip,
          jointPosition(poseJoint('fist', XRHandJoint.IndexFingerTip)),
        ),
      ).toBeGreaterThan(0.02);
    });

    test('keeps bone lengths between two captured skeletons', () => {
      // The captured pinch and point poses come from different captures, so
      // their index bones differ slightly in length and parent orientation.
      xrHandInput.poseId = 'pinch';
      xrHandInput.setFingerPose('index', 'point', 0.5);
      xrHandInput.updateHandPose();

      const joints = [XRHandJoint.Wrist, ...handFingerJoints.index];
      for (let i = 1; i < joints.length; i++) {
        const bone = (poseId: string) =>
          distance(
            poseJoint(poseId, joints[i - 1]),
            poseJoint(poseId, joints[i]),
          );
        expect(
          distance(
            jointMatrix(xrHandInput, joints[i - 1]),
            jointMatrix(xrHandInput, joints[i]),
          ),
        ).toBeCloseTo((bone('pinch') + bone('point')) / 2, 6);
      }
    });

    test('keeps bone lengths when parent frames are oriented differently', () => {
      // Same skeleton as open, but the index metacarpal's frame is turned 90
      // degrees, so the proximal bone points another way in its parent frame.
      const twisted = clonePose(oculusHandConfig.poses.open);
      const metacarpal =
        twisted.jointTransforms[XRHandJoint.IndexFingerMetacarpal].offsetMatrix;
      mat4.rotateX(metacarpal, metacarpal, Math.PI / 2);
      const input = new XRHandInput(
        configWith({ twisted }),
        XRHandedness.Left,
        globalSpace,
      );
      input.poseId = 'open';
      input.setFingerPose('index', 'twisted', 0.5);
      input.updateHandPose();

      const joints = [XRHandJoint.Wrist, ...handFingerJoints.index];
      for (let i = 1; i < joints.length; i++) {
        expect(
          distance(
            jointMatrix(input, joints[i - 1]),
            jointMatrix(input, joints[i]),
          ),
        ).toBeCloseTo(
          distance(
            poseJoint('open', joints[i - 1]),
            poseJoint('open', joints[i]),
          ),
          6,
        );
      }
    });

    test('keeps bone lengths when a bone points the opposite way', () => {
      // Same skeleton as open, but the rest of the index finger is turned 180
      // degrees about the metacarpal joint, so the proximal bone points the
      // opposite way in its parent frame and a lerp would collapse it.
      const reversed = clonePose(oculusHandConfig.poses.open);
      const metacarpal =
        reversed.jointTransforms[XRHandJoint.IndexFingerMetacarpal]
          .offsetMatrix;
      const toMetacarpal = mat4.invert(mat4.create(), metacarpal)!;
      const bone = mat4.getTranslation(
        vec3.create(),
        mat4.multiply(
          mat4.create(),
          toMetacarpal,
          reversed.jointTransforms[XRHandJoint.IndexFingerPhalanxProximal]
            .offsetMatrix,
        ),
      );
      const axis = vec3.normalize(
        vec3.create(),
        vec3.cross(vec3.create(), bone, [1, 0, 0]),
      );
      const turn = mat4.multiply(
        mat4.create(),
        metacarpal,
        mat4.fromRotation(mat4.create(), Math.PI, axis),
      );
      mat4.multiply(turn, turn, toMetacarpal);
      for (const joint of handFingerJoints.index.slice(1)) {
        const matrix = reversed.jointTransforms[joint].offsetMatrix;
        mat4.multiply(matrix, turn, matrix);
      }
      const input = new XRHandInput(
        configWith({ reversed }),
        XRHandedness.Left,
        globalSpace,
      );
      input.poseId = 'open';
      input.setFingerPose('index', 'reversed', 0.5);
      input.updateHandPose();

      const joints = handFingerJoints.index;
      for (let i = 1; i < joints.length; i++) {
        expect(
          distance(
            jointMatrix(input, joints[i - 1]),
            jointMatrix(input, joints[i]),
          ),
        ).toBeCloseTo(
          distance(
            poseJoint('open', joints[i - 1]),
            poseJoint('open', joints[i]),
          ),
          6,
        );
      }

      // The finger swings smoothly through the halfway point instead of
      // jumping to an arbitrary direction there.
      const proximalAt = (weight: number) => {
        input.setFingerPose('index', 'reversed', weight);
        input.updateHandPose();
        return mat4.clone(
          jointMatrix(input, XRHandJoint.IndexFingerPhalanxProximal),
        );
      };
      const [before, halfway, after] = [0.49, 0.5, 0.51].map(proximalAt);
      expect(distance(before, halfway)).toBeLessThan(0.005);
      expect(distance(halfway, after)).toBeLessThan(0.005);
    });

    test('rebuilds blended fingers only when the pose or blends change', () => {
      const fist = clonePose(oculusHandConfig.poses.fist);
      const input = new XRHandInput(
        configWith({ fist }),
        XRHandedness.Left,
        globalSpace,
      );
      input.poseId = 'open';
      input.setFingerPose('index', 'fist');
      input.updateHandPose();
      const tip = () => jointMatrix(input, XRHandJoint.IndexFingerTip);
      const before = mat4.clone(tip());

      // An in-place edit of a source pose shows on the next blend change.
      const fistTip = fist.jointTransforms[XRHandJoint.IndexFingerTip];
      mat4.translate(fistTip.offsetMatrix, fistTip.offsetMatrix, [0, 0.01, 0]);
      input.updateHandPose();
      expectMatrixClose(tip(), before);

      input.setFingerPose('index', 'fist');
      input.updateHandPose();
      expect(distance(tip(), before)).toBeCloseTo(0.01, 6);
    });

    test('returns copies of the finger blends', () => {
      xrHandInput.setFingerPose('index', 'fist');
      const fingerPoses = xrHandInput.fingerPoses as Record<string, any>;
      fingerPoses.index.poseId = 'missing-pose';
      fingerPoses.middle = { poseId: 'missing-pose', weight: 1 };

      expect(xrHandInput.fingerPoses).toEqual({
        index: { poseId: 'fist', weight: 1 },
      });
      expect(() => xrHandInput.updateHandPose()).not.toThrow();
    });

    test('mirrors blended fingers onto the right hand', () => {
      const right = new XRHandInput(
        oculusHandConfig,
        XRHandedness.Right,
        globalSpace,
      );
      for (const input of [xrHandInput, right]) {
        input.poseId = 'open';
        input.setFingerPose('ring', 'fist');
        input.updateHandPose();
      }
      const leftTip = jointPosition(
        jointMatrix(xrHandInput, XRHandJoint.RingFingerTip),
      );
      const rightTip = jointPosition(
        jointMatrix(right, XRHandJoint.RingFingerTip),
      );
      expect(rightTip[0]).toBeCloseTo(-leftTip[0], 6);
      expect(rightTip[1]).toBeCloseTo(leftTip[1], 6);
      expect(rightTip[2]).toBeCloseTo(leftTip[2], 6);
    });

    test('clears finger blends when the pose changes', () => {
      xrHandInput.setFingerPose('thumb', 'thumbs-up');
      expect(xrHandInput.fingerPoses).toEqual({
        thumb: { poseId: 'thumbs-up', weight: 1 },
      });
      xrHandInput.poseId = 'fist';
      expect(xrHandInput.fingerPoses).toEqual({});
      xrHandInput.updateHandPose();
      for (const joint of handFingerJoints.thumb) {
        expectMatrixClose(
          jointMatrix(xrHandInput, joint),
          poseJoint('fist', joint),
        );
      }
    });

    test('clears one finger or all of them', () => {
      xrHandInput.setFingerPose('index', 'point');
      xrHandInput.setFingerPose('middle', 'fist');
      xrHandInput.clearFingerPoses('index');
      expect(Object.keys(xrHandInput.fingerPoses)).toEqual(['middle']);
      xrHandInput.clearFingerPoses();
      expect(xrHandInput.fingerPoses).toEqual({});
    });

    test('ignores unknown fingers, poses and out-of-range weights', () => {
      xrHandInput.setFingerPose('elbow' as any, 'fist');
      xrHandInput.setFingerPose('index', 'missing-pose');
      xrHandInput.setFingerPose('index', 'fist', 1.5);
      expect(xrHandInput.fingerPoses).toEqual({});
      expect(console.warn).toHaveBeenCalledWith('Unknown finger elbow');
      expect(console.warn).toHaveBeenCalledWith(
        'Pose config missing-pose not found',
      );
      expect(console.warn).toHaveBeenCalledWith(
        'Out-of-range weight 1.5 provided for index',
      );
    });

    test('ignores object prototype names and non-numeric weights', () => {
      xrHandInput.poseId = 'constructor';
      xrHandInput.setFingerPose('constructor' as any, 'fist');
      xrHandInput.setFingerPose('index', 'toString');
      xrHandInput.setFingerPose('index', 'fist', '0.5' as any);
      xrHandInput.clearFingerPoses('hasOwnProperty' as any);

      expect(xrHandInput.poseId).toBe('default');
      expect(xrHandInput.fingerPoses).toEqual({});
      expect(console.warn).toHaveBeenCalledWith(
        'Pose config constructor not found',
      );
      expect(console.warn).toHaveBeenCalledWith('Unknown finger constructor');
      expect(console.warn).toHaveBeenCalledWith(
        'Pose config toString not found',
      );
      expect(console.warn).toHaveBeenCalledWith(
        'Out-of-range weight 0.5 provided for index',
      );
      expect(console.warn).toHaveBeenCalledWith(
        'Unknown finger hasOwnProperty',
      );
      expect(() => xrHandInput.updateHandPose()).not.toThrow();
    });
  });
});
