/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { NativeFeatureName } from './types.ts';

/**
 * What each WebXR feature needs in the Android manifest on Horizon OS.
 *
 * Source: Meta's public Horizon OS / OpenXR developer documentation for hand
 * tracking, eye tracking, passthrough, the Scene API (planes, meshes, depth
 * and scene-based hit test) and spatial anchors. Re-check these names against
 * the current docs when the template APK is built.
 */
export interface FeatureManifestNeeds {
  permissions: readonly string[];
  /** `<uses-feature>` names; `required` follows the feature's requirement. */
  usesFeatures: readonly string[];
}

export const FEATURE_MANIFEST: Readonly<
  Record<NativeFeatureName, FeatureManifestNeeds>
> = {
  handTracking: {
    permissions: ['com.oculus.permission.HAND_TRACKING'],
    usesFeatures: ['oculus.software.handtracking'],
  },
  anchors: {
    permissions: ['com.oculus.permission.USE_ANCHOR_API'],
    usesFeatures: [],
  },
  hitTest: {
    permissions: ['com.oculus.permission.USE_SCENE'],
    usesFeatures: [],
  },
  planeDetection: {
    permissions: ['com.oculus.permission.USE_SCENE'],
    usesFeatures: [],
  },
  meshDetection: {
    permissions: ['com.oculus.permission.USE_SCENE'],
    usesFeatures: [],
  },
  depthSensing: {
    permissions: ['com.oculus.permission.USE_SCENE'],
    usesFeatures: [],
  },
  passthrough: {
    permissions: [],
    usesFeatures: ['com.oculus.feature.PASSTHROUGH'],
  },
  gazeTracking: {
    permissions: ['com.oculus.permission.EYE_TRACKING'],
    usesFeatures: ['oculus.software.eye_tracking'],
  },
};

/** Permission added whenever the network allowlist is non-empty. */
export const INTERNET_PERMISSION = 'android.permission.INTERNET';

/**
 * IWSDK `world.xr.features` keys that map to a native feature. Keys not listed
 * here (layers, unbounded) need no manifest entry.
 */
export const IWSDK_FEATURE_ALIASES: Readonly<
  Record<string, NativeFeatureName>
> = {
  handTracking: 'handTracking',
  anchors: 'anchors',
  hitTest: 'hitTest',
  planeDetection: 'planeDetection',
  meshDetection: 'meshDetection',
  depthSensing: 'depthSensing',
  gazeTracking: 'gazeTracking',
  eyeTracking: 'gazeTracking',
};
