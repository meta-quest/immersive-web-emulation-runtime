/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Quaternion, Vector3 } from '../utils/Math.js';

const OFFSET = new Vector3(0, 0.4, 2);
// pitched down so the camera looks at the headset it is placed behind
const PITCH = new Quaternion().setFromAxisAngle(
  new Vector3(1, 0, 0),
  -Math.atan2(OFFSET.y, OFFSET.z),
);

/**
 * Third-person debug camera. While `enabled`, IWER appends it to the app's
 * XRViewerPose.views as one more view, the way WebXR exposes secondary views,
 * and presents it instead of the headset view.
 */
export class XRSpectator {
  enabled = false;
  /** Vertical field of view in radians. */
  fovy = Math.PI / 3;
  /** Position in IWER global space. */
  readonly position = new Vector3();
  /** Orientation in IWER global space. */
  readonly quaternion = new Quaternion();

  /** Place the spectator 2 m behind and 0.4 m above a headset, facing it. */
  placeBehind(headsetPosition: Vector3, headsetQuaternion: Quaternion): void {
    const forward = new Vector3(0, 0, -1).applyQuaternion(headsetQuaternion);
    // yaw only, the inverse of recenter()'s angle
    this.quaternion.setFromAxisAngle(
      new Vector3(0, 1, 0),
      Math.atan2(-forward.x, -forward.z),
    );
    this.position
      .copy(OFFSET)
      .applyQuaternion(this.quaternion)
      .add(headsetPosition);
    this.quaternion.multiply(PITCH);
  }
}
