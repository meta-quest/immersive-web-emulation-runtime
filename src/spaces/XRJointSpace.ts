/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRHandJoint } from '../input/XRHand.js';
import { XRSpace } from './XRSpace.js';
import { mat4 } from 'gl-matrix';

export const PRIVATE = Symbol(
	'@immersive-web-emulation-runtime/xr-joint-space',
);

export class XRJointSpace extends XRSpace {
	[PRIVATE]: {
		jointName: XRHandJoint;
		radius: number;
	};

	constructor(
		jointName: XRHandJoint,
		parentSpace?: XRSpace,
		offsetMatrix?: mat4,
	) {
		super(parentSpace, offsetMatrix);
		this[PRIVATE] = { jointName, radius: 0 };
	}

	get jointName() {
		return this[PRIVATE].jointName;
	}
}
