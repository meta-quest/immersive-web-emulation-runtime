/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { GlobalSpace, XRSpaceUtils } from '../../src/spaces/XRSpace';
import { P_REF_SPACE, P_SPACE } from '../../src/private';
import {
	XRReferenceSpace,
	XRReferenceSpaceType,
} from '../../src/spaces/XRReferenceSpace';
import { mat4, vec3 } from 'gl-matrix';

describe('XRReferenceSpace', () => {
	let globalSpace: GlobalSpace;
	let xrReferenceSpace: XRReferenceSpace;

	beforeEach(() => {
		globalSpace = new GlobalSpace();
		xrReferenceSpace = new XRReferenceSpace(
			XRReferenceSpaceType.Local,
			globalSpace,
		);
	});

	test('XRReferenceSpace should initialize correctly', () => {
		expect(xrReferenceSpace).toBeDefined();
		expect(xrReferenceSpace[P_REF_SPACE].type).toBe(XRReferenceSpaceType.Local);
		expect(xrReferenceSpace[P_SPACE].parentSpace).toBe(globalSpace);
	});

	test('getOffsetReferenceSpace should create a new XRReferenceSpace with correct offset', () => {
		const offsetMatrix = mat4.create();
		mat4.translate(offsetMatrix, offsetMatrix, vec3.fromValues(1, 2, 3)); // Some arbitrary offset

		const offsetSpace = xrReferenceSpace.getOffsetReferenceSpace(offsetMatrix);

		expect(offsetSpace).toBeInstanceOf(XRReferenceSpace);
		expect(offsetSpace[P_SPACE].parentSpace).toBe(xrReferenceSpace);
		expect(
			mat4.equals(offsetSpace[P_SPACE].offsetMatrix, offsetMatrix),
		).toBeTruthy();
	});

	test('calculateGlobalOffsetMatrix should return correct global offset for nested XRReferenceSpaces created with getOffsetReferenceSpace', () => {
		// Create a parent XRReferenceSpace
		const parentSpace = new XRReferenceSpace(
			XRReferenceSpaceType.Local,
			globalSpace,
		);
		XRSpaceUtils.updateOffsetPosition(parentSpace, vec3.fromValues(0, 1, 0)); // 1 unit up

		// Create an offset XRReferenceSpace from parentSpace
		const offsetMatrix = mat4.create();
		mat4.fromTranslation(offsetMatrix, vec3.fromValues(1, 0, 0)); // 1 unit right
		const offsetSpace = parentSpace.getOffsetReferenceSpace(offsetMatrix);

		// Calculate the global offset matrix for offsetSpace
		const globalMatrix = XRSpaceUtils.calculateGlobalOffsetMatrix(offsetSpace);

		// Expected global matrix combines parent's and offsetSpace's transformations
		const expectedMatrix = mat4.create();
		mat4.translate(expectedMatrix, expectedMatrix, vec3.fromValues(1, 1, 0)); // Combined translation

		expect(mat4.equals(globalMatrix, expectedMatrix)).toBeTruthy();
	});
});
