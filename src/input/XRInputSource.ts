/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Gamepad } from '../gamepad/Gamepad.js';
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

export const PRIVATE = Symbol(
	'@immersive-web-emulation-runtime/xr-input-source',
);

export class XRInputSource {
	[PRIVATE]: {
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
		this[PRIVATE] = {
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
		return this[PRIVATE].handedness;
	}

	get targetRayMode() {
		return this[PRIVATE].targetRayMode;
	}

	get targetRaySpace() {
		return this[PRIVATE].targetRaySpace;
	}

	get gripSpace() {
		return this[PRIVATE].gripSpace;
	}

	get profiles() {
		return this[PRIVATE].profiles;
	}

	get gamepad() {
		return this[PRIVATE].gamepad;
	}

	get hand() {
		return this[PRIVATE].hand;
	}
}
