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
import {
  metaQuestTouchPlus,
  metaQuestTouchPro,
  oculusTouchV2,
  oculusTouchV3,
} from '../controller/meta.js';

export const oculusQuest1: XRDeviceConfig = {
  name: 'Oculus Quest 1',
  controllerConfig: oculusTouchV2,
  supportedSessionModes: ['inline', 'immersive-vr', 'immersive-ar'],
  supportedFeatures: [
    'viewer',
    'local',
    'local-floor',
    'bounded-floor',
    'unbounded',
    'anchors',
    'plane-detection',
    'hit-test',
    'layers',
    'hand-tracking',
  ],
  supportedFrameRates: [72, 80, 90],
  isSystemKeyboardSupported: true,
  internalNominalFrameRate: 72,
  environmentBlendModes: {
    ['immersive-vr']: XREnvironmentBlendMode.Opaque,
    ['immersive-ar']: XREnvironmentBlendMode.AlphaBlend,
  },
  interactionMode: XRInteractionMode.WorldSpace,
  userAgent:
    'Mozilla/5.0 (X11; Linux x86_64; Quest 1) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/33.0.0.x.x.x Chrome/126.0.6478.122 VR Safari/537.36',
  ipd: 0.064,
  fieldOfView: {
    diagonal: 104,
    horizontal: 94,
    vertical: 96,
  },
  resolutionWidth: 1440,
  resolutionHeight: 1600,
  stereoOverlap: 0.86,
  handGestureDetectionSupported: true,
};

export const metaQuest2: XRDeviceConfig = {
  name: 'Meta Quest 2',
  controllerConfig: oculusTouchV3,
  supportedSessionModes: ['inline', 'immersive-vr', 'immersive-ar'],
  supportedFeatures: [
    'viewer',
    'local',
    'local-floor',
    'bounded-floor',
    'unbounded',
    'anchors',
    'plane-detection',
    'mesh-detection',
    'hit-test',
    'layers',
    'hand-tracking',
  ],
  supportedFrameRates: [72, 80, 90, 120],
  isSystemKeyboardSupported: true,
  internalNominalFrameRate: 72,
  environmentBlendModes: {
    ['immersive-vr']: XREnvironmentBlendMode.Opaque,
    ['immersive-ar']: XREnvironmentBlendMode.AlphaBlend,
  },
  interactionMode: XRInteractionMode.WorldSpace,
  userAgent:
    'Mozilla/5.0 (X11; Linux x86_64; Quest 2) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/33.0.0.x.x.x Chrome/126.0.6478.122 VR Safari/537.36',
  ipd: 0.063,
  fieldOfView: {
    diagonal: 110,
    horizontal: 97,
    vertical: 93,
  },
  resolutionWidth: 1832,
  resolutionHeight: 1920,
  stereoOverlap: 0.86,
  handGestureDetectionSupported: true,
};

export const metaQuestPro: XRDeviceConfig = {
  name: 'Meta Quest Pro',
  controllerConfig: metaQuestTouchPro,
  supportedSessionModes: ['inline', 'immersive-vr', 'immersive-ar'],
  supportedFeatures: [
    'viewer',
    'local',
    'local-floor',
    'bounded-floor',
    'unbounded',
    'anchors',
    'plane-detection',
    'mesh-detection',
    'hit-test',
    'layers',
    'hand-tracking',
  ],
  supportedFrameRates: [72, 80, 90, 120],
  isSystemKeyboardSupported: true,
  internalNominalFrameRate: 90,
  environmentBlendModes: {
    ['immersive-vr']: XREnvironmentBlendMode.Opaque,
    ['immersive-ar']: XREnvironmentBlendMode.AlphaBlend,
  },
  interactionMode: XRInteractionMode.WorldSpace,
  userAgent:
    'Mozilla/5.0 (X11; Linux x86_64; Quest Pro) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/33.0.0.x.x.x Chrome/126.0.6478.122 VR Safari/537.36',
  ipd: 0.064,
  fieldOfView: {
    diagonal: 112,
    horizontal: 106,
    vertical: 98,
  },
  resolutionWidth: 1800,
  resolutionHeight: 1920,
  stereoOverlap: 0.87,
  handGestureDetectionSupported: true,
};

export const metaQuest3: XRDeviceConfig = {
  name: 'Meta Quest 3',
  controllerConfig: metaQuestTouchPlus,
  supportedSessionModes: ['inline', 'immersive-vr', 'immersive-ar'],
  supportedFeatures: [
    'viewer',
    'local',
    'local-floor',
    'bounded-floor',
    'unbounded',
    'anchors',
    'plane-detection',
    'mesh-detection',
    'hit-test',
    'hand-tracking',
    'depth-sensing',
    'layers',
  ],
  supportedFrameRates: [72, 80, 90, 120],
  isSystemKeyboardSupported: true,
  internalNominalFrameRate: 90,
  environmentBlendModes: {
    ['immersive-vr']: XREnvironmentBlendMode.Opaque,
    ['immersive-ar']: XREnvironmentBlendMode.AlphaBlend,
  },
  interactionMode: XRInteractionMode.WorldSpace,
  userAgent:
    'Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/33.0.0.x.x.x Chrome/126.0.6478.122 VR Safari/537.36',
  ipd: 0.064,
  fieldOfView: {
    diagonal: 121,
    horizontal: 110,
    vertical: 96,
  },
  resolutionWidth: 2064,
  resolutionHeight: 2208,
  stereoOverlap: 0.88,
  handGestureDetectionSupported: true,
};
