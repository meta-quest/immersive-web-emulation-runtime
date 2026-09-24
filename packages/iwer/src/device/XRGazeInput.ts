/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  XRHandedness,
  XRInputSource,
  XRTargetRayMode,
} from '../input/XRInputSource.js';
import { XRSpace } from '../spaces/XRSpace.js';
import { XRTrackedInput } from './XRTrackedInput.js';

export const GAZE_TRACKING_FEATURES = [
  'gaze-tracking',
  'eye-tracking',
] as const;

export type GazeTrackingFeature = (typeof GAZE_TRACKING_FEATURES)[number];

export const isGazeTrackingFeature = (
  feature: string,
): feature is GazeTrackingFeature =>
  GAZE_TRACKING_FEATURES.includes(feature as GazeTrackingFeature);

/**
 * Returns whether a feature list advertises either spelling of the gaze
 * capability. The two descriptors are compatibility aliases for one source.
 */
export const supportsGazeTracking = (
  supportedFeatures: readonly string[],
): boolean => supportedFeatures.some(isGazeTrackingFeature);

/**
 * A persistent, viewer-relative gaze source.
 *
 * Gaze intentionally has no gamepad and emits no select events. Applications
 * combine its target ray with select state from an independent hand or
 * controller source (the gaze-plus-pinch contract used by IWSDK).
 */
export class XRGazeInput extends XRTrackedInput {
  constructor(viewerSpace: XRSpace) {
    const inputSource = new XRInputSource(
      XRHandedness.None,
      XRTargetRayMode.Gaze,
      ['eye-gaze'],
      new XRSpace(viewerSpace),
    );
    super(inputSource);

    // Unlike controllers and hands, gaze is expressed in viewer-local space.
    // Its origin is always the viewer origin; only its local orientation moves.
    this.position.set(0, 0, 0);
  }

  override updateTargetRaySpace(): void {
    // Re-pin the origin in case a consumer mutated the interoperable Vector3.
    this.position.set(0, 0, 0);
    super.updateTargetRaySpace();
  }
}
