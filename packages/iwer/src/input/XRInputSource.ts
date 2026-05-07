/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Gamepad } from '../gamepad/Gamepad.js';
import { P_INPUT_SOURCE } from '../private.js';
import { XRHand } from './XRHand.js';
import { XRSpace } from '../spaces/XRSpace.js';

export enum XRHandedness {
  None = 'none',
  Left = 'left',
  Right = 'right',
}

export enum XRTargetRayMode {
  Gaze = 'gaze',
  TrackedPointer = 'tracked-pointer',
  Screen = 'screen',
  TransientPointer = 'transient-pointer',
}

export class XRInputSourceArray extends Array<XRInputSource> {}

export class XRInputSource {
  [P_INPUT_SOURCE]: {
    handedness: XRHandedness;
    targetRayMode: XRTargetRayMode;
    targetRaySpace: XRSpace;
    gripSpace?: XRSpace;
    profiles: Array<string>;
    gamepad?: Gamepad;
    hand?: XRHand;
  };

  constructor(
    handedness: XRHandedness,
    targetRayMode: XRTargetRayMode,
    profiles: string[],
    targetRaySpace: XRSpace,
    gamepad?: Gamepad,
    gripSpace?: XRSpace,
    hand?: XRHand,
  ) {
    this[P_INPUT_SOURCE] = {
      handedness,
      targetRayMode,
      targetRaySpace,
      gripSpace,
      profiles,
      gamepad,
      hand,
    };
  }

  get handedness() {
    return this[P_INPUT_SOURCE].handedness;
  }

  get targetRayMode() {
    return this[P_INPUT_SOURCE].targetRayMode;
  }

  get targetRaySpace() {
    return this[P_INPUT_SOURCE].targetRaySpace;
  }

  get gripSpace() {
    return this[P_INPUT_SOURCE].gripSpace;
  }

  get profiles() {
    return this[P_INPUT_SOURCE].profiles;
  }

  get gamepad() {
    return this[P_INPUT_SOURCE].gamepad;
  }

  get hand() {
    return this[P_INPUT_SOURCE].hand;
  }
}
