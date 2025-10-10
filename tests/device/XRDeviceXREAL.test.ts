/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { xrealOnePro } from '../../src/device/configs/headset/xreal';
import { XRDevice } from '../../src/device/XRDevice';
import { XRHandedness } from '../../src/input/XRInputSource';

describe('XREAL One Pro Device', () => {
  it('exposes the XREAL One Pro optics and capabilities', () => {
    const device = new XRDevice(xrealOnePro);

    expect(device.name).toBe('XREAL One Pro');
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
    expect(device.supportedFrameRates).toEqual([60, 72, 90, 120]);

    expect(device.ipd).toBeCloseTo(0.058, 5);
    const verticalFoVDegrees = xrealOnePro.fieldOfView?.vertical ?? 0;
    expect(device.fovy).toBeCloseTo((verticalFoVDegrees * Math.PI) / 180, 5);
    expect(device.fieldOfView).toEqual(
      expect.objectContaining({ diagonal: 52, horizontal: 43, vertical: 28 }),
    );
    expect(device.stereoOverlap).toBeCloseTo(0.68, 5);
    expect(device.resolutionWidth).toBe(1920);
    expect(device.resolutionHeight).toBe(1080);
    expect(device.getRecommendedRenderTargetSize()).toEqual({
      width: 1920,
      height: 1080,
    });
    const monoWidth = xrealOnePro.resolutionWidth ?? 0;
    const overlap = xrealOnePro.stereoOverlap ?? 0;
    expect(device.getRecommendedRenderTargetSize(true)).toEqual({
      width: Math.round(monoWidth * (2 - overlap)),
      height: 1080,
    });
    expect(device.handGestureDetectionSupported).toBe(true);
    expect(device.isSystemKeyboardSupported).toBe(true);
  });

  it('keeps hands as the primary input while allowing Bluetooth gamepads', () => {
    const device = new XRDevice(xrealOnePro);

    expect(device.controllers[XRHandedness.None]).toBeDefined();
    expect(device.primaryInputMode).toBe('hand');
  });
});
