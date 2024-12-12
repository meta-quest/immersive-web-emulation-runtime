/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_VIEW } from '../private.js';
import { XRRigidTransform } from '../primitives/XRRigidTransform.js';
import { XRSession } from '../session/XRSession.js';

export enum XREye {
	None = 'none',
	Left = 'left',
	Right = 'right',
}

export class XRView {
	[P_VIEW]: {
		eye: XREye;
		projectionMatrix: Float32Array;
		transform: XRRigidTransform;
		recommendedViewportScale: number | null;
		requestedViewportScale: number;
		session: XRSession;
	};

	constructor(
		eye: XREye,
		projectionMatrix: Float32Array,
		transform: XRRigidTransform,
		session: XRSession,
	) {
		this[P_VIEW] = {
			eye,
			projectionMatrix,
			transform,
			recommendedViewportScale: null,
			requestedViewportScale: 1.0,
			session,
		};
	}

	get eye(): XREye {
		return this[P_VIEW].eye;
	}

	get projectionMatrix(): Float32Array {
		return this[P_VIEW].projectionMatrix;
	}

	get transform(): XRRigidTransform {
		return this[P_VIEW].transform;
	}

	get recommendedViewportScale(): number | null {
		return this[P_VIEW].recommendedViewportScale;
	}

	requestViewportScale(scale: number | null): void {
		if (scale === null || scale <= 0 || scale > 1) {
			console.warn('Invalid scale value. Scale must be > 0 and <= 1.');
			return;
		}
		this[P_VIEW].requestedViewportScale = scale;
	}
}
