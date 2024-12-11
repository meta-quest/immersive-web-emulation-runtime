/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_POSE } from '../private.js';
import { XRRigidTransform } from '../primitives/XRRigidTransform.js';

export class XRPose {
	[P_POSE]: {
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
		this[P_POSE] = {
			transform,
			emulatedPosition,
			linearVelocity,
			angularVelocity,
		};
	}

	get transform() {
		return this[P_POSE].transform;
	}

	get emulatedPosition() {
		return this[P_POSE].emulatedPosition;
	}

	get linearVelocity() {
		return this[P_POSE].linearVelocity;
	}

	get angularVelocity() {
		return this[P_POSE].angularVelocity;
	}
}
