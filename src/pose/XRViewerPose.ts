/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRPose } from './XRPose.js';
import { XRRigidTransform } from '../primitives/XRRigidTransform.js';
import { XRView } from '../views/XRView.js';

export const PRIVATE = Symbol(
	'@immersive-web-emulation-runtime/xr-viewer-pose',
);

export class XRViewerPose extends XRPose {
	[PRIVATE]: {
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
		this[PRIVATE] = {
			views: Object.freeze(views),
		};
	}

	get views() {
		return this[PRIVATE].views;
	}
}
