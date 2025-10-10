/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { metaQuest2, metaQuest3 } from '../../src/device/configs/headset/meta';
import { XRDevice } from '../../src/device/XRDevice';

describe('Meta headset profiles', () => {
  it('exposes Quest 2 optical values and stereo sizing', () => {
    const device = new XRDevice(metaQuest2);

    expect(device.ipd).toBeCloseTo(0.063, 5);
    const quest2VerticalFoVDegrees = metaQuest2.fieldOfView?.vertical ?? 0;
    expect(device.fovy).toBeCloseTo(
      (quest2VerticalFoVDegrees * Math.PI) / 180,
      5,
    );
    expect(device.fieldOfView).toEqual(
      expect.objectContaining({ diagonal: 110, horizontal: 97, vertical: 93 }),
    );
    expect(device.stereoOverlap).toBeCloseTo(0.86, 5);
    expect(device.resolutionWidth).toBe(1832);
    expect(device.resolutionHeight).toBe(1920);
    expect(device.getRecommendedRenderTargetSize(true)).toEqual({
      width: Math.round(1832 * (2 - 0.86)),
      height: 1920,
    });
    expect(device.supportedFeatures).toEqual(
      expect.arrayContaining(['layers', 'hit-test', 'hand-tracking']),
    );
  });

  it('keeps Quest 3 defaults aligned with MR expectations', () => {
    const device = new XRDevice(metaQuest3);

    expect(device.handGestureDetectionSupported).toBe(true);
    expect(device.resolutionWidth).toBe(2064);
    expect(device.resolutionHeight).toBe(2208);
    expect(device.getRecommendedRenderTargetSize(true)).toEqual({
      width: Math.round(2064 * (2 - 0.88)),
      height: 2208,
    });
    expect(device.fieldOfView).toEqual(
      expect.objectContaining({ diagonal: 121, horizontal: 110, vertical: 96 }),
    );
    expect(device.userAgent).toContain('Chrome/126.0.6478.122');
  });
});
