/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRRay } from '../../src/hittest/XRRay.js';
import { XRRigidTransform } from '../../src/primitives/XRRigidTransform.js';

describe('XRRay', () => {
	describe('constructor', () => {
		it('should create a ray with default origin and direction', () => {
			const ray = new XRRay();
			
			expect(ray.origin.x).toBe(0);
			expect(ray.origin.y).toBe(0);
			expect(ray.origin.z).toBe(0);
			expect(ray.origin.w).toBe(1);
			
			expect(ray.direction.x).toBe(0);
			expect(ray.direction.y).toBe(0);
			expect(ray.direction.z).toBe(-1);
			expect(ray.direction.w).toBe(0);
		});

		it('should create a ray with custom origin', () => {
			const origin = { x: 1, y: 2, z: 3, w: 1 };
			const ray = new XRRay(origin);
			
			expect(ray.origin.x).toBe(1);
			expect(ray.origin.y).toBe(2);
			expect(ray.origin.z).toBe(3);
			expect(ray.origin.w).toBe(1);
		});

		it('should create a ray with custom origin and direction', () => {
			const origin = { x: 1, y: 2, z: 3, w: 1 };
			const direction = { x: 0, y: 1, z: 0, w: 0 };
			const ray = new XRRay(origin, direction);
			
			expect(ray.origin.x).toBe(1);
			expect(ray.origin.y).toBe(2);
			expect(ray.origin.z).toBe(3);
			expect(ray.origin.w).toBe(1);
			
			expect(ray.direction.x).toBe(0);
			expect(ray.direction.y).toBe(1);
			expect(ray.direction.z).toBe(0);
			expect(ray.direction.w).toBe(0);
		});

		it('should normalize direction vector', () => {
			const direction = { x: 2, y: 0, z: 0, w: 0 };
			const ray = new XRRay(undefined, direction);
			
			// Should be normalized to unit vector
			expect(ray.direction.x).toBe(1);
			expect(ray.direction.y).toBe(0);
			expect(ray.direction.z).toBe(0);
			expect(ray.direction.w).toBe(0);
		});

		it('should throw error for zero-length direction vector', () => {
			const direction = { x: 0, y: 0, z: 0, w: 0 };
			
			expect(() => new XRRay(undefined, direction)).toThrow(DOMException);
			expect(() => new XRRay(undefined, direction)).toThrow('Invalid direction value to construct XRRay');
		});

		it('should throw error for direction with w !== 0', () => {
			const direction = { x: 1, y: 0, z: 0, w: 1 };
			
			expect(() => new XRRay(undefined, direction)).toThrow(DOMException);
			expect(() => new XRRay(undefined, direction)).toThrow('Invalid direction value to construct XRRay');
		});

		it('should create ray from XRRigidTransform', () => {
			const transform = new XRRigidTransform(
				{ x: 1, y: 2, z: 3, w: 1 },
				{ x: 0, y: 0, z: 0, w: 1 } // Identity quaternion
			);
			const ray = new XRRay(transform);
			
			// Origin should be transformed
			expect(ray.origin.x).toBe(1);
			expect(ray.origin.y).toBe(2);
			expect(ray.origin.z).toBe(3);
			expect(ray.origin.w).toBe(1);
			
			// Direction should be transformed from default (0, 0, -1)
			expect(ray.direction.z).toBe(-1);
		});
	});

	describe('matrix getter', () => {
		it('should return a matrix for default ray', () => {
			const ray = new XRRay();
			const matrix = ray.matrix;
			
			expect(matrix).toBeInstanceOf(Float32Array);
			expect(matrix.length).toBe(16);
		});

		it('should return the same matrix on subsequent calls', () => {
			const ray = new XRRay();
			const matrix1 = ray.matrix;
			const matrix2 = ray.matrix;
			
			expect(matrix1).toBe(matrix2);
		});

		it('should handle edge case where direction is opposite to -z', () => {
			const direction = { x: 0, y: 0, z: 1, w: 0 }; // Opposite to default -z
			const ray = new XRRay(undefined, direction);
			const matrix = ray.matrix;
			
			expect(matrix).toBeInstanceOf(Float32Array);
			expect(matrix.length).toBe(16);
		});

		it('should handle edge case where direction is same as -z', () => {
			const direction = { x: 0, y: 0, z: -1, w: 0 }; // Same as default -z
			const ray = new XRRay(undefined, direction);
			const matrix = ray.matrix;
			
			expect(matrix).toBeInstanceOf(Float32Array);
			expect(matrix.length).toBe(16);
		});

		it('should handle arbitrary direction vectors', () => {
			const direction = { x: 1, y: 1, z: 1, w: 0 };
			const ray = new XRRay(undefined, direction);
			const matrix = ray.matrix;
			
			expect(matrix).toBeInstanceOf(Float32Array);
			expect(matrix.length).toBe(16);
		});
	});

	describe('origin getter', () => {
		it('should return immutable origin', () => {
			const ray = new XRRay();
			const origin = ray.origin;
			
			expect(origin.x).toBe(0);
			expect(origin.y).toBe(0);
			expect(origin.z).toBe(0);
			expect(origin.w).toBe(1);
		});
	});

	describe('direction getter', () => {
		it('should return immutable direction', () => {
			const ray = new XRRay();
			const direction = ray.direction;
			
			expect(direction.x).toBe(0);
			expect(direction.y).toBe(0);
			expect(direction.z).toBe(-1);
			expect(direction.w).toBe(0);
		});
	});
});