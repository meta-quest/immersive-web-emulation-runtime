/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { mat4, quat, vec3 } from 'gl-matrix';

export const PRIVATE = Symbol('@immersive-web-emulation-runtime/xr-space');

export class XRSpace extends EventTarget {
	[PRIVATE]: {
		parentSpace: XRSpace | undefined;
		offsetMatrix: mat4;
		emulated: boolean;
	};

	constructor(parentSpace?: XRSpace, offsetMatrix?: mat4) {
		super();
		this[PRIVATE] = {
			parentSpace,
			offsetMatrix: offsetMatrix ? mat4.clone(offsetMatrix) : mat4.create(),
			emulated: true,
		};
	}
}

export class GlobalSpace extends XRSpace {
	constructor() {
		super(undefined, mat4.create()); // GlobalSpace has no parent
	}
}

export class XRSpaceUtils {
	// Update the position component of the offsetMatrix of a given XRSpace
	static updateOffsetPosition(space: XRSpace, position: vec3): void {
		const offsetMatrix = space[PRIVATE].offsetMatrix;
		mat4.fromTranslation(offsetMatrix, position);
	}

	// Update the rotation component of the offsetMatrix of a given XRSpace using a quaternion
	static updateOffsetQuaternion(space: XRSpace, quaternion: quat): void {
		const offsetMatrix = space[PRIVATE].offsetMatrix;
		const translation = vec3.create();
		mat4.getTranslation(translation, offsetMatrix);
		mat4.fromRotationTranslation(offsetMatrix, quaternion, translation);
	}

	// Update the offsetMatrix of a given XRSpace directly
	static updateOffsetMatrix(space: XRSpace, matrix: mat4): void {
		const offsetMatrix = space[PRIVATE].offsetMatrix;
		mat4.copy(offsetMatrix, matrix);
	}

	// Calculate the global offset matrix for a given XRSpace
	static calculateGlobalOffsetMatrix(
		space: XRSpace,
		globalOffset: mat4 = mat4.create(),
	): mat4 {
		const parentOffset = space[PRIVATE].parentSpace
			? XRSpaceUtils.calculateGlobalOffsetMatrix(space[PRIVATE].parentSpace)
			: mat4.create(); // Identity matrix for GlobalSpace

		mat4.multiply(globalOffset, parentOffset, space[PRIVATE].offsetMatrix);
		return globalOffset;
	}
}
