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
import { bluetoothGamepad } from '../controller/generic.js';

const XREAL_VERTICAL_FOV_DEGREES = 28;

/**
 * XREAL One Pro developer notes market a 52° diagonal FOV when paired with the Beam Pro.
 * Optical calibration reports ~43° horizontal by ~28° vertical with ~68% stereo overlap.
 * The Beam Pro's 6DOF compositor keeps the 1920x1080 per-eye render targets used for media mode and WebXR AR sessions.
 */
export const xrealOnePro: XRDeviceConfig = {
  name: 'XREAL One Pro',
  controllerConfig: bluetoothGamepad,
  supportedSessionModes: ['inline', 'immersive-ar', 'immersive-vr'],
  supportedFeatures: [
    'viewer',
    'local',
    'unbounded',
    'anchors',
    'plane-detection',
    'hit-test',
    'layers',
    'hand-tracking',
  ],
  supportedFrameRates: [60, 72, 90, 120],
  isSystemKeyboardSupported: true,
  internalNominalFrameRate: 90,
  environmentBlendModes: {
    ['immersive-ar']: XREnvironmentBlendMode.AlphaBlend,
    ['immersive-vr']: XREnvironmentBlendMode.Opaque,
  },
  interactionMode: XRInteractionMode.WorldSpace,
  userAgent:
    'Mozilla/5.0 (Linux; Android 14; XREAL One Pro Build/UP1A.231105.003; arm64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.6533.72 Mobile Safari/537.36',
  ipd: 0.058,
  fieldOfView: {
    diagonal: 52,
    horizontal: 43,
    vertical: XREAL_VERTICAL_FOV_DEGREES,
  },
  stereoOverlap: 0.68,
  resolutionWidth: 1920,
  resolutionHeight: 1080,
  handGestureDetectionSupported: true,
};
