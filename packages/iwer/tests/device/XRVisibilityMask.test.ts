/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  calculateVisibilityMaskBounds,
  type XRFieldOfView,
} from '../../src/device/XRVisibilityMask.js';
import { XRDevice } from '../../src/device/XRDevice.js';
import {
  metaVRGlasses,
  metaQuest3,
} from '../../src/device/configs/headset/meta.js';

const degrees = (value: number): number => (value * Math.PI) / 180;

describe('XR visibility masks', () => {
  test('Meta VR Glasses profile contains the measured asymmetric vertical FOV', () => {
    const left = metaVRGlasses.visibilityMask?.left;
    expect(left).toBeDefined();
    expect(left!.angleLeft).toBeCloseTo(degrees(37));
    expect(left!.angleRight).toBeCloseTo(degrees(37));
    expect(left!.angleUp).toBeCloseTo(degrees(25));
    expect(left!.angleDown).toBeCloseTo(degrees(43));
    expect(metaVRGlasses.supportedFrameRates).toEqual([72, 90, 96, 100, 120]);
  });

  test('uses the profile mask by default and allows an instance override', () => {
    const device = new XRDevice(metaVRGlasses);
    expect(device.visibilityMask).toBe(metaVRGlasses.visibilityMask);
    expect(device.visibilityMaskEnabled).toBe(true);

    const initiallyDisabled = new XRDevice(metaVRGlasses, {
      visibilityMaskEnabled: false,
    });
    expect(initiallyDisabled.visibilityMaskEnabled).toBe(false);

    device.visibilityMaskEnabled = false;
    expect(device.visibilityMaskEnabled).toBe(false);

    device.visibilityMaskEnabled = true;
    expect(device.visibilityMaskEnabled).toBe(true);

    expect(
      new XRDevice(metaVRGlasses, { visibilityMask: null }).visibilityMask,
    ).toBeUndefined();
  });

  test('cannot enable the mask for an unsupported device profile', () => {
    const quest3 = new XRDevice(metaQuest3);

    expect(quest3.visibilityMask).toBeUndefined();
    expect(quest3.visibilityMaskEnabled).toBe(false);

    quest3.visibilityMaskEnabled = true;
    expect(quest3.visibilityMaskEnabled).toBe(false);
  });

  test('maps angular bounds into a symmetric preview projection', () => {
    const fov: XRFieldOfView = {
      angleLeft: degrees(37),
      angleRight: degrees(37),
      angleUp: degrees(25),
      angleDown: degrees(43),
    };

    const bounds = calculateVisibilityMaskBounds(fov, Math.PI / 2, 1000, 1000);

    expect(bounds.x).toBeCloseTo(123.222, 2);
    expect(bounds.y).toBeCloseTo(266.846, 2);
    expect(bounds.width).toBeCloseTo(753.555, 2);
    expect(bounds.height).toBeCloseTo(699.411, 2);
  });

  test('clamps target angles that exceed the preview field of view', () => {
    const fov: XRFieldOfView = {
      angleLeft: degrees(60),
      angleRight: degrees(60),
      angleUp: degrees(60),
      angleDown: degrees(60),
    };

    expect(calculateVisibilityMaskBounds(fov, Math.PI / 2, 1000, 1000)).toEqual(
      { x: 0, y: 0, width: 1000, height: 1000 },
    );
  });
});
