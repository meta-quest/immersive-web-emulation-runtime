/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_GAMEPAD, P_SPACE, P_TRACKED_INPUT } from '../private.js';
import { Quaternion, Vector3 } from '../utils/Math.js';
import { XRHandedness, XRInputSource } from '../input/XRInputSource.js';

import { GamepadButton } from '../gamepad/Gamepad.js';
import { XRFrame } from '../frameloop/XRFrame.js';
import { XRInputSourceEvent } from '../events/XRInputSourceEvent.js';
import { mat4 } from 'gl-matrix';

const DEFAULT_TRANSFORM = {
  [XRHandedness.Left]: {
    position: new Vector3(-0.25, 1.5, -0.4),
    quaternion: new Quaternion(),
  },
  [XRHandedness.Right]: {
    position: new Vector3(0.25, 1.5, -0.4),
    quaternion: new Quaternion(),
  },
  [XRHandedness.None]: {
    position: new Vector3(0.25, 1.5, -0.4),
    quaternion: new Quaternion(),
  },
};

export class XRTrackedInput {
  [P_TRACKED_INPUT]: {
    inputSource: XRInputSource;
    // input state
    position: Vector3;
    quaternion: Quaternion;
    connected: boolean;
    lastFrameConnected: boolean;
    inputSourceChanged: boolean;
  };

  constructor(inputSource: XRInputSource) {
    this[P_TRACKED_INPUT] = {
      inputSource,
      position: DEFAULT_TRANSFORM[inputSource.handedness].position.clone(),
      quaternion: DEFAULT_TRANSFORM[inputSource.handedness].quaternion.clone(),
      connected: true,
      lastFrameConnected: false,
      inputSourceChanged: true,
    };
  }

  get position(): Vector3 {
    return this[P_TRACKED_INPUT].position;
  }

  get quaternion(): Quaternion {
    return this[P_TRACKED_INPUT].quaternion;
  }

  get inputSource(): XRInputSource {
    return this[P_TRACKED_INPUT].inputSource;
  }

  get connected() {
    return this[P_TRACKED_INPUT].connected;
  }

  set connected(value: boolean) {
    this[P_TRACKED_INPUT].connected = value;
    this[P_TRACKED_INPUT].inputSource.gamepad![P_GAMEPAD].connected = value;
  }

  onFrameStart(frame: XRFrame) {
    const targetRaySpace = this[P_TRACKED_INPUT].inputSource.targetRaySpace;
    mat4.fromRotationTranslation(
      targetRaySpace[P_SPACE].offsetMatrix,
      this[P_TRACKED_INPUT].quaternion.quat,
      this[P_TRACKED_INPUT].position.vec3,
    );

    const session = frame.session;
    this[P_TRACKED_INPUT].inputSource.gamepad!.buttons.forEach((button) => {
      if (button instanceof GamepadButton) {
        // apply pending values and record last frame values
        button[P_GAMEPAD].lastFrameValue = button[P_GAMEPAD].value;
        if (button[P_GAMEPAD].pendingValue != null) {
          button[P_GAMEPAD].value = button[P_GAMEPAD].pendingValue;
          button[P_GAMEPAD].pendingValue = null;
        }
        // trigger input source events
        if (button[P_GAMEPAD].eventTrigger != null) {
          if (
            button[P_GAMEPAD].lastFrameValue === 0 &&
            button[P_GAMEPAD].value > 0
          ) {
            session.dispatchEvent(
              new XRInputSourceEvent(button[P_GAMEPAD].eventTrigger, {
                frame,
                inputSource: this[P_TRACKED_INPUT].inputSource,
              }),
            );
            session.dispatchEvent(
              new XRInputSourceEvent(button[P_GAMEPAD].eventTrigger + 'start', {
                frame,
                inputSource: this[P_TRACKED_INPUT].inputSource,
              }),
            );
          } else if (
            button[P_GAMEPAD].lastFrameValue > 0 &&
            button[P_GAMEPAD].value === 0
          ) {
            session.dispatchEvent(
              new XRInputSourceEvent(button[P_GAMEPAD].eventTrigger + 'end', {
                frame,
                inputSource: this[P_TRACKED_INPUT].inputSource,
              }),
            );
          }
        }
      }
    });

    this[P_TRACKED_INPUT].inputSourceChanged =
      this.connected !== this[P_TRACKED_INPUT].lastFrameConnected;
    this[P_TRACKED_INPUT].lastFrameConnected = this.connected;
  }
}
