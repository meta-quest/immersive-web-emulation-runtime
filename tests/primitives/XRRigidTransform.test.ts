/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { quat, vec3 } from 'gl-matrix';

import { XRRigidTransform } from '../../src/primitives/XRRigidTransform';

describe('XRRigidTransform', () => {
	it('should create an identity transform with no arguments', () => {
		const transform = new XRRigidTransform();
		expect(transform.position.x).toBe(0);
		expect(transform.position.y).toBe(0);
		expect(transform.position.z).toBe(0);
		expect(transform.orientation.x).toBe(0);
		expect(transform.orientation.y).toBe(0);
		expect(transform.orientation.z).toBe(0);
		expect(transform.orientation.w).toBe(1);
		expect(transform.matrix).toEqual(expect.any(Float32Array));
		expect(transform.matrix.length).toBe(16);
	});

	it('should create a transform with given position and default orientation', () => {
		const position = { x: 1, y: 2, z: 3, w: 1 };
		const transform = new XRRigidTransform(position);
		expect(transform.position.x).toBe(1);
		expect(transform.position.y).toBe(2);
		expect(transform.position.z).toBe(3);
		expect(transform.orientation.x).toBe(0);
		expect(transform.orientation.y).toBe(0);
		expect(transform.orientation.z).toBe(0);
		expect(transform.orientation.w).toBe(1);
	});

	it('should create a transform with given position and orientation', () => {
		const position = { x: 1, y: 2, z: 3, w: 1 };
		const orientation = { x: 0, y: 0, z: 1, w: 0 };
		const transform = new XRRigidTransform(position, orientation);
		expect(transform.position.x).toBe(1);
		expect(transform.position.y).toBe(2);
		expect(transform.position.z).toBe(3);
		expect(transform.orientation.x).toBeCloseTo(0);
		expect(transform.orientation.y).toBeCloseTo(0);
		expect(transform.orientation.z).toBeCloseTo(1);
		expect(transform.orientation.w).toBeCloseTo(0);
	});

	it('should correctly calculate the inverse transform', () => {
		const position = { x: 1, y: 2, z: 3, w: 1 };
		const orientation = {
			x: 0.11109410971403122,
			y: 0.21208874881267548,
			z: 0.3130834102630615,
			w: 0.9190512895584106,
		}; // (normalized)
		const transform = new XRRigidTransform(position, orientation);
		const inverse = transform.inverse;

		// Test applying the transform and then the inverse transform to a point
		const point = vec3.fromValues(5, 5, 5); // Arbitrary point
		const transformedPoint = vec3.transformMat4(
			vec3.create(),
			point,
			transform.matrix,
		);
		const retransformedPoint = vec3.transformMat4(
			vec3.create(),
			transformedPoint,
			inverse.matrix,
		);

		// The retransformedPoint should be close to the original point
		expect(retransformedPoint[0]).toBeCloseTo(point[0]);
		expect(retransformedPoint[1]).toBeCloseTo(point[1]);
		expect(retransformedPoint[2]).toBeCloseTo(point[2]);

		const originalQuat = quat.fromValues(
			transform.orientation.x,
			transform.orientation.y,
			transform.orientation.z,
			transform.orientation.w,
		);

		const inverseQuat = quat.fromValues(
			inverse.orientation.x,
			inverse.orientation.y,
			inverse.orientation.z,
			inverse.orientation.w,
		);

		// Normalizing the quaternions (if not already normalized)
		quat.normalize(originalQuat, originalQuat);
		quat.normalize(inverseQuat, inverseQuat);

		// Combining the original and inverse quaternion
		const combinedQuat = quat.create();
		quat.multiply(combinedQuat, inverseQuat, originalQuat);

		// The combined quaternion should be close to a neutral quaternion (0, 0, 0, 1)
		expect(combinedQuat[0]).toBeCloseTo(0);
		expect(combinedQuat[1]).toBeCloseTo(0);
		expect(combinedQuat[2]).toBeCloseTo(0);
		expect(combinedQuat[3]).toBeCloseTo(1);
	});
});
