/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_VIEWER_POSE } from '../private.js';
import { XRPose } from './XRPose.js';
import { XRRigidTransform } from '../primitives/XRRigidTransform.js';
import { XRView } from '../views/XRView.js';

export class XRViewerPose extends XRPose {
	[P_VIEWER_POSE]: {
		views: readonly XRView[];
	};

	constructor(
		transform: XRRigidTransform,
		views: XRView[],
		emulatedPosition: boolean = false,
		linearVelocity: DOMPointReadOnly | undefined = undefined,
		angularVelocity: DOMPointReadOnly | undefined = undefined,
	) {
		super(transform, emulatedPosition, linearVelocity, angularVelocity);
		this[P_VIEWER_POSE] = {
			views: Object.freeze(views),
		};
	}

	get views() {
		return this[P_VIEWER_POSE].views;
	}
}
