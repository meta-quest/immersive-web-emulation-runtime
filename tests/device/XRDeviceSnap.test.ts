/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { snapSpectacles3 } from '../../src/device/configs/headset/snap';
import { XRDevice } from '../../src/device/XRDevice';
import { XRHandedness } from '../../src/input/XRInputSource';

describe('Snap Spectacles 3.0 Device', () => {
  it('exposes the Snap Spectacles 3.0 profile with measured optics and capabilities', () => {
    const device = new XRDevice(snapSpectacles3);

    expect(device.name).toBe('Snap Spectacles 3.0');
    expect(device.supportedSessionModes).toEqual([
      'inline',
      'immersive-ar',
      'immersive-vr',
    ]);
    expect(device.supportedFeatures).toEqual(
      expect.arrayContaining([
        'viewer',
        'local',
        'unbounded',
        'anchors',
        'plane-detection',
        'hit-test',
        'layers',
        'hand-tracking',
      ]),
    );

    expect(device.ipd).toBeCloseTo(0.063, 5);
    const verticalFoVDegrees = snapSpectacles3.fieldOfView?.vertical ?? 0;
    expect(device.fovy).toBeCloseTo((verticalFoVDegrees * Math.PI) / 180, 5);
    expect(device.fieldOfView).toEqual(
      expect.objectContaining({ diagonal: 42, horizontal: 34, vertical: 26 }),
    );
    expect(device.stereoOverlap).toBeCloseTo(0.62, 5);
    expect(device.resolutionWidth).toBe(1280);
    expect(device.resolutionHeight).toBe(1280);
    expect(device.getRecommendedRenderTargetSize()).toEqual({
      width: 1280,
      height: 1280,
    });
    const monoWidth = snapSpectacles3.resolutionWidth ?? 0;
    const overlap = snapSpectacles3.stereoOverlap ?? 0;
    expect(device.getRecommendedRenderTargetSize(true)).toEqual({
      width: Math.round(monoWidth * (2 - overlap)),
      height: 1280,
    });
    expect(device.handGestureDetectionSupported).toBe(true);
  });

  it('defaults to hand input when only a Bluetooth gamepad is provided', () => {
    const device = new XRDevice(snapSpectacles3);

    expect(device.controllers[XRHandedness.None]).toBeDefined();
    expect(device.primaryInputMode).toBe('hand');
  });
});
