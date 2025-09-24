/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { xrealOnePro } from '../../src/device/configs/headset/xreal';
import { XRDevice } from '../../src/device/XRDevice';

describe('XREAL One Pro Device', () => {
  it('should create a XREAL One Pro device with correct properties', () => {
    const device = new XRDevice(xrealOnePro);
    expect(device.name).toBe('XREAL One Pro');
    expect(device.ipd).toBe(0.063);
    expect(device.fovy).toBe((57 * Math.PI) / 180);
    expect(device.resolutionWidth).toBe(1920);
    expect(device.resolutionHeight).toBe(1080);
  });
});