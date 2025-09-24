/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { snapSpectacles3 } from '../../src/device/configs/headset/snap';
import { XRDevice } from '../../src/device/XRDevice';

describe('Snap Spectacles 3 Device', () => {
  it('should create a Snap Spectacles 3 device with correct properties', () => {
    const device = new XRDevice(snapSpectacles3);
    expect(device.name).toBe('Snap Spectacles 3');
    expect(device.ipd).toBe(0.063);
    expect(device.fovy).toBe((46 * Math.PI) / 180);
    expect(device.resolutionWidth).toBe(1216);
    expect(device.resolutionHeight).toBe(1216);
  });
});