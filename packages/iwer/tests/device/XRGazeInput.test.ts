/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { mat4, quat, vec3 } from 'gl-matrix';

import {
  XRGazeInput,
  isGazeTrackingFeature,
  supportsGazeTracking,
} from '../../src/device/XRGazeInput.js';
import { XRFrame } from '../../src/frameloop/XRFrame.js';
import {
  XRHandedness,
  XRTargetRayMode,
} from '../../src/input/XRInputSource.js';
import { P_SPACE } from '../../src/private.js';
import {
  XRReferenceSpace,
  XRReferenceSpaceType,
} from '../../src/spaces/XRReferenceSpace.js';
import { GlobalSpace, XRSpaceUtils } from '../../src/spaces/XRSpace.js';

describe('XRGazeInput', () => {
  const createGaze = () => {
    const globalSpace = new GlobalSpace();
    const viewerSpace = new XRReferenceSpace(
      XRReferenceSpaceType.Viewer,
      globalSpace,
    );
    return { gaze: new XRGazeInput(viewerSpace), viewerSpace };
  };

  test('exposes a standards-shaped gaze source without selection state', () => {
    const { gaze, viewerSpace } = createGaze();

    expect(gaze.inputSource.handedness).toBe(XRHandedness.None);
    expect(gaze.inputSource.targetRayMode).toBe(XRTargetRayMode.Gaze);
    expect(gaze.inputSource.profiles).toEqual(['eye-gaze']);
    expect(gaze.inputSource.gamepad).toBeUndefined();
    expect(gaze.inputSource.gripSpace).toBeUndefined();
    expect(gaze.inputSource.hand).toBeUndefined();
    expect(gaze.inputSource.targetRaySpace[P_SPACE].parentSpace).toBe(
      viewerSpace,
    );
  });

  test('pins its origin to the viewer while preserving local orientation', () => {
    const { gaze, viewerSpace } = createGaze();
    const viewerOrientation = quat.setAxisAngle(quat.create(), [0, 1, 0], 0.4);
    const viewerPosition = vec3.fromValues(1, 2, 3);
    mat4.fromRotationTranslation(
      viewerSpace[P_SPACE].offsetMatrix,
      viewerOrientation,
      viewerPosition,
    );

    const localOrientation = quat.setAxisAngle(quat.create(), [1, 0, 0], -0.2);
    gaze.quaternion.set(
      localOrientation[0],
      localOrientation[1],
      localOrientation[2],
      localOrientation[3],
    );
    gaze.position.set(9, 8, 7);
    gaze.updateTargetRaySpace();

    expect(Array.from(gaze.position.vec3)).toEqual([0, 0, 0]);

    const actual = XRSpaceUtils.calculateGlobalOffsetMatrix(
      gaze.inputSource.targetRaySpace,
    );
    const expectedLocal = mat4.fromQuat(mat4.create(), localOrientation);
    const expected = mat4.multiply(
      mat4.create(),
      viewerSpace[P_SPACE].offsetMatrix,
      expectedLocal,
    );
    Array.from(expected).forEach((value, index) => {
      expect(actual[index]).toBeCloseTo(value, 5);
    });
  });

  test('can connect and update a frame without a gamepad or input events', () => {
    const { gaze } = createGaze();
    const dispatchEvent = jest.fn();
    const frame = { session: { dispatchEvent } } as unknown as XRFrame;

    expect(() => {
      gaze.connected = false;
      gaze.connected = true;
      gaze.onFrameStart(frame);
    }).not.toThrow();
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  test('treats the gaze descriptors as aliases for one capability', () => {
    expect(isGazeTrackingFeature('gaze-tracking')).toBe(true);
    expect(isGazeTrackingFeature('eye-tracking')).toBe(true);
    expect(isGazeTrackingFeature('hand-tracking')).toBe(false);
    expect(supportsGazeTracking(['gaze-tracking'])).toBe(true);
    expect(supportsGazeTracking(['eye-tracking'])).toBe(true);
    expect(supportsGazeTracking(['hand-tracking'])).toBe(false);
  });
});
