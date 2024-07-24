/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
	PRIVATE as GAMEPAD_PRIVATE,
	Gamepad,
	GamepadConfig,
} from '../gamepad/Gamepad.js';
import { GlobalSpace, XRSpace } from '../spaces/XRSpace.js';
import {
	XRHandedness,
	XRInputSource,
	XRTargetRayMode,
} from '../input/XRInputSource.js';
import {
	PRIVATE as XRTRACKEDINPUT_PRIVATE,
	XRTrackedInput,
} from './XRTrackedInput.js';

import { mat4 } from 'gl-matrix';

export const PRIVATE = Symbol('@immersive-web-emulation-runtime/xr-controller');

export interface XRControllerConfig {
	profileId: string;
	fallbackProfileIds: string[];
	layout: {
		[handedness in XRHandedness]?: {
			gamepad: GamepadConfig;
			gripOffsetMatrix?: mat4;
			numHapticActuators: number;
		};
	};
}

export class XRController extends XRTrackedInput {
	[PRIVATE]: {
		gamepadConfig: GamepadConfig;
	};

	constructor(
		controllerConfig: XRControllerConfig,
		handedness: XRHandedness,
		globalSpace: GlobalSpace,
	) {
		if (!controllerConfig.layout[handedness]) {
			throw new DOMException('Handedness not supported', 'InvalidStateError');
		}
		const targetRaySpace = new XRSpace(globalSpace);
		const gripSpace = controllerConfig.layout[handedness]!.gripOffsetMatrix
			? new XRSpace(
					targetRaySpace,
					controllerConfig.layout[handedness]!.gripOffsetMatrix,
			  )
			: undefined;
		const profiles = [
			controllerConfig.profileId,
			...controllerConfig.fallbackProfileIds,
		];
		const inputSource = new XRInputSource(
			handedness,
			XRTargetRayMode.TrackedPointer,
			profiles,
			targetRaySpace,
			new Gamepad(controllerConfig.layout[handedness]!.gamepad),
			gripSpace,
		);

		super(inputSource);
		this[PRIVATE] = {
			gamepadConfig: controllerConfig.layout[handedness]!.gamepad,
		};
	}

	get gamepadConfig() {
		return this[PRIVATE].gamepadConfig;
	}

	updateButtonValue(id: string, value: number) {
		if (value > 1 || value < 0) {
			console.warn(`Out-of-range value ${value} provided for button ${id}.`);
			return;
		}
		const gamepadButton =
			this[XRTRACKEDINPUT_PRIVATE].inputSource.gamepad![GAMEPAD_PRIVATE]
				.buttonsMap[id];
		if (gamepadButton) {
			if (
				gamepadButton[GAMEPAD_PRIVATE].type === 'binary' &&
				value != 1 &&
				value != 0
			) {
				console.warn(
					`Non-binary value ${value} provided for binary button ${id}.`,
				);
				return;
			}
			gamepadButton[GAMEPAD_PRIVATE].pendingValue = value;
		} else {
			console.warn(`Current controller does not have button ${id}.`);
		}
	}

	updateButtonTouch(id: string, touched: boolean) {
		const gamepadButton =
			this[XRTRACKEDINPUT_PRIVATE].inputSource.gamepad![GAMEPAD_PRIVATE]
				.buttonsMap[id];
		if (gamepadButton) {
			gamepadButton[GAMEPAD_PRIVATE].touched = touched;
		} else {
			console.warn(`Current controller does not have button ${id}.`);
		}
	}

	updateAxis(id: string, type: 'x-axis' | 'y-axis', value: number) {
		if (value > 1 || value < -1) {
			console.warn(`Out-of-range value ${value} provided for ${id} axes.`);
			return;
		}
		const axesById =
			this[XRTRACKEDINPUT_PRIVATE].inputSource.gamepad![GAMEPAD_PRIVATE]
				.axesMap[id];
		if (axesById) {
			if (type === 'x-axis') {
				axesById.x = value;
			} else if (type === 'y-axis') {
				axesById.y = value;
			}
		} else {
			console.warn(`Current controller does not have ${id} axes.`);
		}
	}

	updateAxes(id: string, x: number, y: number) {
		if (x > 1 || x < -1 || y > 1 || y < -1) {
			console.warn(
				`Out-of-range value x:${x}, y:${y} provided for ${id} axes.`,
			);
			return;
		}
		const axesById =
			this[XRTRACKEDINPUT_PRIVATE].inputSource.gamepad![GAMEPAD_PRIVATE]
				.axesMap[id];
		if (axesById) {
			axesById.x = x;
			axesById.y = y;
		} else {
			console.warn(`Current controller does not have ${id} axes.`);
		}
	}
}
