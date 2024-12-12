/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_JOINT_POSE } from '../private.js';
import { XRPose } from './XRPose.js';
import { XRRigidTransform } from '../primitives/XRRigidTransform.js';

export class XRJointPose extends XRPose {
	[P_JOINT_POSE]: {
		radius: number;
	};

	constructor(
		transform: XRRigidTransform,
		radius: number,
		emulatedPosition: boolean = false,
		linearVelocity: DOMPointReadOnly | undefined = undefined,
		angularVelocity: DOMPointReadOnly | undefined = undefined,
	) {
		super(transform, emulatedPosition, linearVelocity, angularVelocity);
		this[P_JOINT_POSE] = { radius };
	}

	get radius() {
		return this[P_JOINT_POSE].radius;
	}
}
