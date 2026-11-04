/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_GAMEPAD, P_SPACE, P_TRACKED_INPUT } from '../private.js';
import { Quaternion, Vector3 } from '../utils/Math.js';
import { XRHandedness, XRInputSource } from '../input/XRInputSource.js';

import { advanceButton, edgeEventTypes } from '../gamepad/button-edges.js';

import { GamepadButton } from '../gamepad/Gamepad.js';
import { XRFrame } from '../frameloop/XRFrame.js';
import { XRInputSourceEvent } from '../events/XRInputSourceEvent.js';
import type { XRSession } from '../session/XRSession.js';
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

/**
 * Advances a button by one frame and dispatches the input source events for
 * its edge, if the button has an event trigger.
 */
export const dispatchButtonEdge = (
  session: XRSession,
  frame: XRFrame,
  inputSource: XRInputSource,
  button: GamepadButton,
) => {
  const edge = advanceButton(button);
  const trigger = button[P_GAMEPAD].eventTrigger;
  if (edge && trigger) {
    // an index loop: for-of over the shared (frozen) list would allocate
    // an iterator
    const types = edgeEventTypes(edge, trigger);
    for (let i = 0; i < types.length; i++) {
      session.dispatchEvent(
        new XRInputSourceEvent(types[i], { frame, inputSource }),
      );
    }
  }
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
    const gamepad = this[P_TRACKED_INPUT].inputSource.gamepad;
    if (gamepad) {
      gamepad[P_GAMEPAD].connected = value;
    }
  }

  updateTargetRaySpace(): void {
    const targetRaySpace = this[P_TRACKED_INPUT].inputSource.targetRaySpace;
    mat4.fromRotationTranslation(
      targetRaySpace[P_SPACE].offsetMatrix,
      this[P_TRACKED_INPUT].quaternion.quat,
      this[P_TRACKED_INPUT].position.vec3,
    );
  }

  onFrameStart(frame: XRFrame) {
    this.updateTargetRaySpace();

    const session = frame.session;
    const inputSource = this[P_TRACKED_INPUT].inputSource;
    const buttons = inputSource.gamepad?.buttons;
    if (buttons) {
      // An index loop, so the per-frame update creates no closure.
      for (let i = 0; i < buttons.length; i++) {
        const button = buttons[i];
        if (button instanceof GamepadButton) {
          dispatchButtonEdge(session, frame, inputSource, button);
        }
      }
    }

    this[P_TRACKED_INPUT].inputSourceChanged =
      this.connected !== this[P_TRACKED_INPUT].lastFrameConnected;
    this[P_TRACKED_INPUT].lastFrameConnected = this.connected;
  }
}
