/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Gamepad, GamepadConfig } from '../gamepad/Gamepad.js';
import { GlobalSpace, XRSpace } from '../spaces/XRSpace.js';
import { P_CONTROLLER, P_GAMEPAD, P_TRACKED_INPUT } from '../private.js';
import {
	XRHandedness,
	XRInputSource,
	XRTargetRayMode,
} from '../input/XRInputSource.js';

import { XRTrackedInput } from './XRTrackedInput.js';
import { mat4 } from 'gl-matrix';

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
	[P_CONTROLLER]: {
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
		this[P_CONTROLLER] = {
			gamepadConfig: controllerConfig.layout[handedness]!.gamepad,
		};
	}

	get gamepadConfig() {
		return this[P_CONTROLLER].gamepadConfig;
	}

	updateButtonValue(id: string, value: number) {
		if (value > 1 || value < 0) {
			console.warn(`Out-of-range value ${value} provided for button ${id}.`);
			return;
		}
		const gamepadButton =
			this[P_TRACKED_INPUT].inputSource.gamepad![P_GAMEPAD].buttonsMap[id];
		if (gamepadButton) {
			if (
				gamepadButton[P_GAMEPAD].type === 'binary' &&
				value != 1 &&
				value != 0
			) {
				console.warn(
					`Non-binary value ${value} provided for binary button ${id}.`,
				);
				return;
			}
			gamepadButton[P_GAMEPAD].pendingValue = value;
		} else {
			console.warn(`Current controller does not have button ${id}.`);
		}
	}

	updateButtonTouch(id: string, touched: boolean) {
		const gamepadButton =
			this[P_TRACKED_INPUT].inputSource.gamepad![P_GAMEPAD].buttonsMap[id];
		if (gamepadButton) {
			gamepadButton[P_GAMEPAD].touched = touched;
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
			this[P_TRACKED_INPUT].inputSource.gamepad![P_GAMEPAD].axesMap[id];
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
			this[P_TRACKED_INPUT].inputSource.gamepad![P_GAMEPAD].axesMap[id];
		if (axesById) {
			axesById.x = x;
			axesById.y = y;
		} else {
			console.warn(`Current controller does not have ${id} axes.`);
		}
	}
}
