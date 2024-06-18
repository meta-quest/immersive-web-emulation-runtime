/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
	PRIVATE as GAMEPAD_PRIVATE,
	GamepadButton,
} from '../gamepad/Gamepad.js';
import { Quaternion, Vector3 } from '../utils/Math.js';
import { XRHandedness, XRInputSource } from '../input/XRInputSource.js';

import { XRFrame } from '../frameloop/XRFrame.js';
import { XRInputSourceEvent } from '../events/XRInputSourceEvent.js';
import { PRIVATE as XRSPACE_PRIVATE } from '../spaces/XRSpace.js';
import { mat4 } from 'gl-matrix';

export const PRIVATE = Symbol(
	'@immersive-web-emulation-runtime/xr-tracked-input',
);

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
	[PRIVATE]: {
		inputSource: XRInputSource;
		// input state
		position: Vector3;
		quaternion: Quaternion;
		connected: boolean;
		lastFrameConnected: boolean;
		inputSourceChanged: boolean;
	};

	constructor(inputSource: XRInputSource) {
		this[PRIVATE] = {
			inputSource,
			position: DEFAULT_TRANSFORM[inputSource.handedness].position.clone(),
			quaternion: DEFAULT_TRANSFORM[inputSource.handedness].quaternion.clone(),
			connected: true,
			lastFrameConnected: false,
			inputSourceChanged: true,
		};
	}

	get position(): Vector3 {
		return this[PRIVATE].position;
	}

	get quaternion(): Quaternion {
		return this[PRIVATE].quaternion;
	}

	get inputSource(): XRInputSource {
		return this[PRIVATE].inputSource;
	}

	get connected() {
		return this[PRIVATE].connected;
	}

	set connected(value: boolean) {
		this[PRIVATE].connected = value;
		this[PRIVATE].inputSource.gamepad![GAMEPAD_PRIVATE].connected = value;
	}

	onFrameStart(frame: XRFrame) {
		const targetRaySpace = this[PRIVATE].inputSource.targetRaySpace;
		mat4.fromRotationTranslation(
			targetRaySpace[XRSPACE_PRIVATE].offsetMatrix,
			this[PRIVATE].quaternion.quat,
			this[PRIVATE].position.vec3,
		);

		const session = frame.session;
		this[PRIVATE].inputSource.gamepad!.buttons.forEach((button) => {
			if (button instanceof GamepadButton) {
				// apply pending values and record last frame values
				button[GAMEPAD_PRIVATE].lastFrameValue = button[GAMEPAD_PRIVATE].value;
				if (button[GAMEPAD_PRIVATE].pendingValue != null) {
					button[GAMEPAD_PRIVATE].value = button[GAMEPAD_PRIVATE].pendingValue;
					button[GAMEPAD_PRIVATE].pendingValue = null;
				}
				// trigger input source events
				if (button[GAMEPAD_PRIVATE].eventTrigger != null) {
					if (
						button[GAMEPAD_PRIVATE].lastFrameValue === 0 &&
						button[GAMEPAD_PRIVATE].value > 0
					) {
						session.dispatchEvent(
							new XRInputSourceEvent(button[GAMEPAD_PRIVATE].eventTrigger, {
								frame,
								inputSource: this[PRIVATE].inputSource,
							}),
						);
						session.dispatchEvent(
							new XRInputSourceEvent(
								button[GAMEPAD_PRIVATE].eventTrigger + 'start',
								{
									frame,
									inputSource: this[PRIVATE].inputSource,
								},
							),
						);
					} else if (
						button[GAMEPAD_PRIVATE].lastFrameValue > 0 &&
						button[GAMEPAD_PRIVATE].value === 0
					) {
						session.dispatchEvent(
							new XRInputSourceEvent(
								button[GAMEPAD_PRIVATE].eventTrigger + 'end',
								{
									frame,
									inputSource: this[PRIVATE].inputSource,
								},
							),
						);
					}
				}
			}
		});

		this[PRIVATE].inputSourceChanged =
			this.connected !== this[PRIVATE].lastFrameConnected;
		this[PRIVATE].lastFrameConnected = this.connected;
	}
}
