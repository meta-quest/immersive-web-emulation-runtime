/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  XREnvironmentBlendMode,
  XRInteractionMode,
} from '../../../session/XRSession.js';

import { XRDeviceConfig } from '../../XRDevice.js';

export const xrealOnePro: XRDeviceConfig = {
  name: 'XREAL One Pro',
  controllerConfig: undefined,
  supportedSessionModes: ['inline', 'immersive-ar'],
  supportedFeatures: [
    'viewer',
    'local',
    'hand-tracking',
  ],
  supportedFrameRates: [60, 72, 90, 120],
  isSystemKeyboardSupported: false,
  internalNominalFrameRate: 90,
  environmentBlendModes: {
    ['immersive-ar']: XREnvironmentBlendMode.AlphaBlend,
  },
  interactionMode: XRInteractionMode.WorldSpace,
  userAgent:
    'Mozilla/5.0 (X11; Linux x86_64; XREAL One Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.122 VR Safari/537.36',
  ipd: 0.063,
  fovy: (57 * Math.PI) / 180, // 57 degrees diagonal FOV
  resolutionWidth: 1920,
  resolutionHeight: 1080,
};