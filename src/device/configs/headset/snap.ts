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

const SPECTACLES_VERTICAL_FOV_DEGREES = 26;

/**
 * Snap Spectacles 3.0 (2025) developer specifications expose a diagonal marketing FOV of ~42°.
 * Optical characterization from Snap Lens Studio tooling reports ~34° horizontal by ~26° vertical.
 * The 1280x1280 render targets are per-eye; the runtime derives the combined stereo width using the overlap value.
 * We store the vertical measurement for render state calculations while preserving the marketing claim.
 */
export const snapSpectacles3: XRDeviceConfig = {
  name: 'Snap Spectacles 3.0',
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
  supportedFrameRates: [60],
  isSystemKeyboardSupported: false,
  internalNominalFrameRate: 60,
  environmentBlendModes: {
    ['immersive-ar']: XREnvironmentBlendMode.AlphaBlend,
    ['immersive-vr']: XREnvironmentBlendMode.Opaque,
  },
  interactionMode: XRInteractionMode.WorldSpace,
  userAgent:
    'Mozilla/5.0 (Linux; Android 14; Spectacles 3.0 Build/UP1A.231105.003; arm64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.6533.72 Mobile Safari/537.36',
  ipd: 0.063,
  fieldOfView: {
    diagonal: 42,
    horizontal: 34,
    vertical: SPECTACLES_VERTICAL_FOV_DEGREES,
  },
  stereoOverlap: 0.62,
  resolutionWidth: 1280,
  resolutionHeight: 1280,
  handGestureDetectionSupported: true,
};
