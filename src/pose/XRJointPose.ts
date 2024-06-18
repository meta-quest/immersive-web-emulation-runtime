/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRPose } from './XRPose.js';
import { XRRigidTransform } from '../primitives/XRRigidTransform.js';

export const PRIVATE = Symbol('@immersive-web-emulation-runtime/xr-joint-pose');

export class XRJointPose extends XRPose {
	[PRIVATE]: {
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
		this[PRIVATE] = { radius };
	}

	get radius() {
		return this[PRIVATE].radius;
	}
}
