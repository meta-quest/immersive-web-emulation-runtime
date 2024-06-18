/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRRigidTransform } from '../primitives/XRRigidTransform.js';
import { XRSession } from '../session/XRSession.js';

export const PRIVATE = Symbol('@immersive-web-emulation-runtime/xr-view');

export enum XREye {
	None = 'none',
	Left = 'left',
	Right = 'right',
}

export class XRView {
	[PRIVATE]: {
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
		this[PRIVATE] = {
			eye,
			projectionMatrix,
			transform,
			recommendedViewportScale: null,
			requestedViewportScale: 1.0,
			session,
		};
	}

	get eye(): XREye {
		return this[PRIVATE].eye;
	}

	get projectionMatrix(): Float32Array {
		return this[PRIVATE].projectionMatrix;
	}

	get transform(): XRRigidTransform {
		return this[PRIVATE].transform;
	}

	get recommendedViewportScale(): number | null {
		return this[PRIVATE].recommendedViewportScale;
	}

	requestViewportScale(scale: number | null): void {
		if (scale === null || scale <= 0 || scale > 1) {
			console.warn('Invalid scale value. Scale must be > 0 and <= 1.');
			return;
		}
		this[PRIVATE].requestedViewportScale = scale;
	}
}
