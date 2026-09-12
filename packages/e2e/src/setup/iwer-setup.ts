/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRDevice, metaQuest3 } from 'iwer';

export async function setupIwer(): Promise<XRDevice> {
  const xrDevice = new XRDevice(metaQuest3, {
    stereoEnabled: true,
  });
  // This harness explicitly tests IWER. Headless Chromium can expose a native
  // navigator.xr without an attached XR device, so replace that inert runtime.
  xrDevice.installRuntime({ forceInstall: true });
  (globalThis as any).__IWER_INJECTED__ = true;
  return xrDevice;
}
