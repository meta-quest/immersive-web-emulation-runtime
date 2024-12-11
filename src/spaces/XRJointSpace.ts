/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_JOINT_SPACE } from '../private.js';
import { XRHandJoint } from '../input/XRHand.js';
import { XRSpace } from './XRSpace.js';
import { mat4 } from 'gl-matrix';

export class XRJointSpace extends XRSpace {
	[P_JOINT_SPACE]: {
		jointName: XRHandJoint;
		radius: number;
	};

	constructor(
		jointName: XRHandJoint,
		parentSpace?: XRSpace,
		offsetMatrix?: mat4,
	) {
		super(parentSpace, offsetMatrix);
		this[P_JOINT_SPACE] = { jointName, radius: 0 };
	}

	get jointName() {
		return this[P_JOINT_SPACE].jointName;
	}
}
