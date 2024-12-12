/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { GlobalSpace, XRSpace, XRSpaceUtils } from '../../src/spaces/XRSpace';
import { mat4, quat, vec3 } from 'gl-matrix';

import { P_SPACE } from '../../src/private';

describe('XRSpace and XRSpaceUtils', () => {
	let globalSpace: GlobalSpace;
	let xrSpace: XRSpace;

	beforeEach(() => {
		globalSpace = new GlobalSpace();
		xrSpace = new XRSpace();
	});

	test('XRSpace should initialize with default values', () => {
		expect(
			mat4.equals(xrSpace[P_SPACE].offsetMatrix, mat4.create()),
		).toBeTruthy();
		expect(xrSpace[P_SPACE].parentSpace).toBeUndefined();
	});

	test('GlobalSpace should initialize as an XRSpace with no parent', () => {
		expect(globalSpace[P_SPACE].parentSpace).toBeUndefined();
		expect(
			mat4.equals(globalSpace[P_SPACE].offsetMatrix, mat4.create()),
		).toBeTruthy();
	});

	test('updateOffsetPosition should update XRSpace offset matrix', () => {
		const position = vec3.fromValues(1, 2, 3);
		XRSpaceUtils.updateOffsetPosition(xrSpace, position);

		const expectedMatrix = mat4.create();
		mat4.fromTranslation(expectedMatrix, position);
		expect(
			mat4.equals(xrSpace[P_SPACE].offsetMatrix, expectedMatrix),
		).toBeTruthy();
	});

	test('updateOffsetQuaternion should update XRSpace offset matrix with rotation', () => {
		const quaternion = quat.create();
		quat.rotateX(quaternion, quaternion, Math.PI / 2); // Rotate 90 degrees around X-axis
		XRSpaceUtils.updateOffsetQuaternion(xrSpace, quaternion);

		const expectedMatrix = mat4.create();
		mat4.fromQuat(expectedMatrix, quaternion);
		expect(
			mat4.equals(xrSpace[P_SPACE].offsetMatrix, expectedMatrix),
		).toBeTruthy();
	});

	test('calculateGlobalOffsetMatrix should return global offset for XRSpace', () => {
		const position = vec3.fromValues(1, 2, 3);
		XRSpaceUtils.updateOffsetPosition(xrSpace, position);

		const globalMatrix = XRSpaceUtils.calculateGlobalOffsetMatrix(xrSpace);

		const expectedMatrix = mat4.create();
		mat4.fromTranslation(expectedMatrix, position);
		expect(mat4.equals(globalMatrix, expectedMatrix)).toBeTruthy();
	});

	test('calculateGlobalOffsetMatrix with nested XRSpaces', () => {
		// Create child and grandchild spaces with globalSpace as the root
		const childSpace = new XRSpace(globalSpace);
		const grandchildSpace = new XRSpace(childSpace);

		// Set position and orientation for each space
		const parentPosition = vec3.fromValues(1, 0, 0);
		const parentQuaternion = quat.create();
		quat.rotateY(parentQuaternion, parentQuaternion, Math.PI / 4); // Rotate 45 degrees around Y-axis

		const childPosition = vec3.fromValues(0, 2, 0);
		const childQuaternion = quat.create();
		quat.rotateX(childQuaternion, childQuaternion, Math.PI / 2); // Rotate 90 degrees around X-axis

		XRSpaceUtils.updateOffsetPosition(globalSpace, parentPosition);
		XRSpaceUtils.updateOffsetQuaternion(globalSpace, parentQuaternion);
		XRSpaceUtils.updateOffsetPosition(childSpace, childPosition);
		XRSpaceUtils.updateOffsetQuaternion(childSpace, childQuaternion);

		// Calculate the global offset matrix for the grandchild space
		const globalMatrix =
			XRSpaceUtils.calculateGlobalOffsetMatrix(grandchildSpace);

		// Expected global offset matrix
		const expectedMatrix = mat4.create();
		const parentMatrix = mat4.create();
		mat4.fromRotationTranslation(
			parentMatrix,
			parentQuaternion,
			parentPosition,
		);
		const childMatrix = mat4.create();
		mat4.fromRotationTranslation(childMatrix, childQuaternion, childPosition);
		mat4.multiply(expectedMatrix, parentMatrix, childMatrix);

		expect(mat4.equals(globalMatrix, expectedMatrix)).toBeTruthy();
	});
});
