/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRRigidTransform } from '../primitives/XRRigidTransform.js';

export const PRIVATE = Symbol('@immersive-web-emulation-runtime/xr-pose');

export class XRPose {
	[PRIVATE]: {
		transform: XRRigidTransform;
		emulatedPosition: boolean;
		linearVelocity?: DOMPointReadOnly;
		angularVelocity?: DOMPointReadOnly;
	};

	constructor(
		transform: XRRigidTransform,
		emulatedPosition = false,
		linearVelocity: DOMPointReadOnly | undefined = undefined,
		angularVelocity: DOMPointReadOnly | undefined = undefined,
	) {
		this[PRIVATE] = {
			transform,
			emulatedPosition,
			linearVelocity,
			angularVelocity,
		};
	}

	get transform() {
		return this[PRIVATE].transform;
	}

	get emulatedPosition() {
		return this[PRIVATE].emulatedPosition;
	}

	get linearVelocity() {
		return this[PRIVATE].linearVelocity;
	}

	get angularVelocity() {
		return this[PRIVATE].angularVelocity;
	}
}
