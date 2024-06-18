/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { mat4, quat, vec3 } from 'gl-matrix';

import { DOMPointReadOnly } from '../utils/DOMPointReadOnly.js';

export const PRIVATE = Symbol(
	'@immersive-web-emulation-runtime/xr-rigid-transform',
);

export class XRRigidTransform {
	[PRIVATE]: {
		matrix: mat4;
		position: vec3;
		orientation: quat;
		inverse: XRRigidTransform | null;
	};

	constructor(position?: DOMPointInit, orientation?: DOMPointInit) {
		// Default values
		const defaultPosition = vec3.fromValues(0, 0, 0);
		const defaultOrientation = quat.create();

		this[PRIVATE] = {
			matrix: mat4.create(),
			position: position
				? vec3.fromValues(position.x!, position.y!, position.z!)
				: defaultPosition,
			orientation: orientation
				? quat.normalize(
						quat.create(),
						quat.fromValues(
							orientation.x!,
							orientation.y!,
							orientation.z!,
							orientation.w!,
						),
				  )
				: defaultOrientation,
			inverse: null,
		};

		this.updateMatrix();
	}

	private updateMatrix(): void {
		mat4.fromRotationTranslation(
			this[PRIVATE].matrix,
			this[PRIVATE].orientation,
			this[PRIVATE].position,
		);
	}

	get matrix(): Float32Array {
		return this[PRIVATE].matrix as Float32Array;
	}

	get position(): DOMPointReadOnly {
		const pos = this[PRIVATE].position;
		return new DOMPointReadOnly(pos[0], pos[1], pos[2], 1);
	}

	get orientation(): DOMPointReadOnly {
		const ori = this[PRIVATE].orientation;
		return new DOMPointReadOnly(ori[0], ori[1], ori[2], ori[3]);
	}

	get inverse(): XRRigidTransform {
		if (!this[PRIVATE].inverse) {
			const invMatrix = mat4.create();
			if (!mat4.invert(invMatrix, this[PRIVATE].matrix)) {
				throw new Error('Matrix is not invertible.');
			}

			// Decomposing the inverse matrix into position and orientation
			let invPosition = vec3.create();
			mat4.getTranslation(invPosition, invMatrix);

			let invOrientation = quat.create();
			mat4.getRotation(invOrientation, invMatrix);

			// Creating a new XRRigidTransform for the inverse
			this[PRIVATE].inverse = new XRRigidTransform(
				new DOMPointReadOnly(invPosition[0], invPosition[1], invPosition[2], 1),
				new DOMPointReadOnly(
					invOrientation[0],
					invOrientation[1],
					invOrientation[2],
					invOrientation[3],
				),
			);

			// Setting the inverse of the inverse to be this transform
			this[PRIVATE].inverse[PRIVATE].inverse = this;
		}

		return this[PRIVATE].inverse;
	}
}
