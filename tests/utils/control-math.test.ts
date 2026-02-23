/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
	vec3ToObj,
	quatToObj,
	quatToEuler,
	eulerToQuat,
	directionTo,
	lookRotation,
	lookRotationGimbal,
	waitForCondition,
} from '../../src/utils/control-math.js';

describe('control-math utilities', () => {
	describe('vec3ToObj', () => {
		test('should convert Vector3-like to plain object', () => {
			const result = vec3ToObj({ x: 1, y: 2, z: 3 });
			expect(result).toEqual({ x: 1, y: 2, z: 3 });
		});

		test('should handle zero values', () => {
			const result = vec3ToObj({ x: 0, y: 0, z: 0 });
			expect(result).toEqual({ x: 0, y: 0, z: 0 });
		});

		test('should handle negative values', () => {
			const result = vec3ToObj({ x: -1.5, y: -2.5, z: -3.5 });
			expect(result).toEqual({ x: -1.5, y: -2.5, z: -3.5 });
		});
	});

	describe('quatToObj', () => {
		test('should convert Quaternion-like to plain object', () => {
			const result = quatToObj({ x: 0, y: 0, z: 0, w: 1 });
			expect(result).toEqual({ x: 0, y: 0, z: 0, w: 1 });
		});

		test('should handle non-identity quaternion', () => {
			const result = quatToObj({ x: 0.5, y: 0.5, z: 0.5, w: 0.5 });
			expect(result).toEqual({ x: 0.5, y: 0.5, z: 0.5, w: 0.5 });
		});
	});

	describe('eulerToQuat', () => {
		test('should convert identity rotation', () => {
			const result = eulerToQuat({ pitch: 0, yaw: 0, roll: 0 });
			expect(result.x).toBeCloseTo(0);
			expect(result.y).toBeCloseTo(0);
			expect(result.z).toBeCloseTo(0);
			expect(result.w).toBeCloseTo(1);
		});

		test('should convert 90 degree yaw rotation', () => {
			const result = eulerToQuat({ pitch: 0, yaw: 90, roll: 0 });
			// 90 deg around Y: w = cos(45deg), y = sin(45deg)
			expect(result.x).toBeCloseTo(0);
			expect(result.y).toBeCloseTo(Math.SQRT1_2);
			expect(result.z).toBeCloseTo(0);
			expect(result.w).toBeCloseTo(Math.SQRT1_2);
		});

		test('should convert 90 degree pitch rotation', () => {
			const result = eulerToQuat({ pitch: 90, yaw: 0, roll: 0 });
			// 90 deg around X: w = cos(45deg), x = sin(45deg)
			expect(result.x).toBeCloseTo(Math.SQRT1_2);
			expect(result.y).toBeCloseTo(0);
			expect(result.z).toBeCloseTo(0);
			expect(result.w).toBeCloseTo(Math.SQRT1_2);
		});

		test('should convert 90 degree roll rotation', () => {
			const result = eulerToQuat({ pitch: 0, yaw: 0, roll: 90 });
			// 90 deg around Z: w = cos(45deg), z = sin(45deg)
			expect(result.x).toBeCloseTo(0);
			expect(result.y).toBeCloseTo(0);
			expect(result.z).toBeCloseTo(Math.SQRT1_2);
			expect(result.w).toBeCloseTo(Math.SQRT1_2);
		});
	});

	describe('quatToEuler', () => {
		test('should convert identity quaternion', () => {
			const result = quatToEuler({ x: 0, y: 0, z: 0, w: 1 });
			expect(result.pitch).toBeCloseTo(0);
			expect(result.yaw).toBeCloseTo(0);
			expect(result.roll).toBeCloseTo(0);
		});

		test('should roundtrip with eulerToQuat', () => {
			const original = { pitch: 30, yaw: 45, roll: 15 };
			const quat = eulerToQuat(original);
			const result = quatToEuler(quat);
			expect(result.pitch).toBeCloseTo(original.pitch, 1);
			expect(result.yaw).toBeCloseTo(original.yaw, 1);
			expect(result.roll).toBeCloseTo(original.roll, 1);
		});

		test('should handle 90 degree yaw', () => {
			const quat = eulerToQuat({ pitch: 0, yaw: 90, roll: 0 });
			const result = quatToEuler(quat);
			expect(result.pitch).toBeCloseTo(0, 1);
			expect(result.yaw).toBeCloseTo(90, 1);
			expect(result.roll).toBeCloseTo(0, 1);
		});
	});

	describe('directionTo', () => {
		test('should calculate forward direction', () => {
			const result = directionTo(
				{ x: 0, y: 0, z: 0 },
				{ x: 0, y: 0, z: -1 },
			);
			expect(result.x).toBeCloseTo(0);
			expect(result.y).toBeCloseTo(0);
			expect(result.z).toBeCloseTo(-1);
		});

		test('should calculate right direction', () => {
			const result = directionTo(
				{ x: 0, y: 0, z: 0 },
				{ x: 1, y: 0, z: 0 },
			);
			expect(result.x).toBeCloseTo(1);
			expect(result.y).toBeCloseTo(0);
			expect(result.z).toBeCloseTo(0);
		});

		test('should calculate up direction', () => {
			const result = directionTo(
				{ x: 0, y: 0, z: 0 },
				{ x: 0, y: 1, z: 0 },
			);
			expect(result.x).toBeCloseTo(0);
			expect(result.y).toBeCloseTo(1);
			expect(result.z).toBeCloseTo(0);
		});

		test('should normalize diagonal direction', () => {
			const result = directionTo(
				{ x: 0, y: 0, z: 0 },
				{ x: 1, y: 1, z: 1 },
			);
			const length = Math.sqrt(
				result.x * result.x + result.y * result.y + result.z * result.z,
			);
			expect(length).toBeCloseTo(1);
		});

		test('should return default forward for coincident points', () => {
			const result = directionTo(
				{ x: 1, y: 2, z: 3 },
				{ x: 1, y: 2, z: 3 },
			);
			expect(result.x).toBeCloseTo(0);
			expect(result.y).toBeCloseTo(0);
			expect(result.z).toBeCloseTo(-1);
		});
	});

	describe('lookRotation', () => {
		test('should create a valid quaternion looking forward', () => {
			const result = lookRotation({ x: 0, y: 0, z: -1 });
			// Should produce a normalized quaternion
			const length = Math.sqrt(
				result.x * result.x +
				result.y * result.y +
				result.z * result.z +
				result.w * result.w,
			);
			expect(length).toBeCloseTo(1);
		});

		test('should create a valid quaternion looking right', () => {
			const result = lookRotation({ x: 1, y: 0, z: 0 });
			// Should produce a normalized quaternion
			const length = Math.sqrt(
				result.x * result.x +
				result.y * result.y +
				result.z * result.z +
				result.w * result.w,
			);
			expect(length).toBeCloseTo(1);
		});

		test('should create a valid quaternion looking left', () => {
			const result = lookRotation({ x: -1, y: 0, z: 0 });
			// Should produce a normalized quaternion
			const length = Math.sqrt(
				result.x * result.x +
				result.y * result.y +
				result.z * result.z +
				result.w * result.w,
			);
			expect(length).toBeCloseTo(1);
		});

		test('should return identity for zero direction', () => {
			const result = lookRotation({ x: 0, y: 0, z: 0 });
			expect(result.x).toBeCloseTo(0);
			expect(result.y).toBeCloseTo(0);
			expect(result.z).toBeCloseTo(0);
			expect(result.w).toBeCloseTo(1);
		});
	});

	describe('lookRotationGimbal', () => {
		test('should create a valid quaternion looking forward', () => {
			const result = lookRotationGimbal({ x: 0, y: 0, z: -1 });
			// Should produce a normalized quaternion
			const length = Math.sqrt(
				result.x * result.x +
					result.y * result.y +
					result.z * result.z +
					result.w * result.w,
			);
			expect(length).toBeCloseTo(1);
		});

		test('should produce zero roll when looking at any direction', () => {
			// Looking forward and up
			const result1 = lookRotationGimbal({ x: 0, y: 1, z: -1 });
			const euler1 = quatToEuler(result1);
			expect(euler1.roll).toBeCloseTo(0);

			// Looking forward and down
			const result2 = lookRotationGimbal({ x: 0, y: -1, z: -1 });
			const euler2 = quatToEuler(result2);
			expect(euler2.roll).toBeCloseTo(0);

			// Looking right and up
			const result3 = lookRotationGimbal({ x: 1, y: 1, z: 0 });
			const euler3 = quatToEuler(result3);
			expect(euler3.roll).toBeCloseTo(0);

			// Looking left and down
			const result4 = lookRotationGimbal({ x: -1, y: -1, z: 0 });
			const euler4 = quatToEuler(result4);
			expect(euler4.roll).toBeCloseTo(0);
		});

		test('should produce correct yaw when looking horizontally', () => {
			// Looking right (positive X)
			const result1 = lookRotationGimbal({ x: 1, y: 0, z: 0 });
			const euler1 = quatToEuler(result1);
			expect(euler1.yaw).toBeCloseTo(-90);
			expect(euler1.pitch).toBeCloseTo(0);
			expect(euler1.roll).toBeCloseTo(0);

			// Looking left (negative X)
			const result2 = lookRotationGimbal({ x: -1, y: 0, z: 0 });
			const euler2 = quatToEuler(result2);
			expect(euler2.yaw).toBeCloseTo(90);
			expect(euler2.pitch).toBeCloseTo(0);
			expect(euler2.roll).toBeCloseTo(0);

			// Looking backward (positive Z)
			const result3 = lookRotationGimbal({ x: 0, y: 0, z: 1 });
			const euler3 = quatToEuler(result3);
			expect(Math.abs(euler3.yaw)).toBeCloseTo(180);
			expect(euler3.pitch).toBeCloseTo(0);
			expect(euler3.roll).toBeCloseTo(0);
		});

		test('should produce correct pitch when looking vertically', () => {
			// Looking up (pure vertical) - target above = positive pitch (nose up)
			const result1 = lookRotationGimbal({ x: 0, y: 1, z: 0 });
			const euler1 = quatToEuler(result1);
			expect(euler1.pitch).toBeCloseTo(90);
			expect(euler1.roll).toBeCloseTo(0);

			// Looking down (pure vertical) - target below = negative pitch (nose down)
			const result2 = lookRotationGimbal({ x: 0, y: -1, z: 0 });
			const euler2 = quatToEuler(result2);
			expect(euler2.pitch).toBeCloseTo(-90);
			expect(euler2.roll).toBeCloseTo(0);
		});
	});

	describe('quatToEuler floating-point edge cases (fix #6)', () => {
		test('should handle sinp slightly > 1 due to floating-point rounding', () => {
			// Craft a quaternion where 2*(w*x - y*z) slightly exceeds 1
			// For sinp = 1: we need w*x - y*z = 0.5
			// Use x=0.70711, w=0.70711, y=0, z=0 (pure 90deg pitch)
			// Then perturb slightly to push sinp past 1.0
			const q = { x: 0.7071068, y: 0.0000001, z: -0.0000001, w: 0.7071068 };
			// This gives sinp = 2*(0.7071068*0.7071068 - 0.0000001*(-0.0000001))
			// = 2*(0.50000... + tiny) which could exceed 1.0
			const result = quatToEuler(q);
			expect(result.pitch).not.toBeNaN();
			expect(result.yaw).not.toBeNaN();
			expect(result.roll).not.toBeNaN();
			expect(Math.abs(result.pitch)).toBeCloseTo(90, 0);
		});

		test('should handle exact gimbal lock at pitch = +90', () => {
			const q = eulerToQuat({ pitch: 90, yaw: 0, roll: 0 });
			const result = quatToEuler(q);
			expect(result.pitch).toBeCloseTo(90, 1);
			expect(result.pitch).not.toBeNaN();
		});

		test('should handle exact gimbal lock at pitch = -90', () => {
			const q = eulerToQuat({ pitch: -90, yaw: 0, roll: 0 });
			const result = quatToEuler(q);
			expect(result.pitch).toBeCloseTo(-90, 1);
			expect(result.pitch).not.toBeNaN();
		});

		test('should not produce NaN for any axis', () => {
			// Quaternion that maximizes sinp beyond 1.0 due to floating-point
			// Manually construct: sinp = 2*(w*x - y*z) with values that exceed 1
			const q = { x: 0.70710678118, y: 0, z: 0, w: 0.70710678119 };
			const result = quatToEuler(q);
			expect(result.pitch).not.toBeNaN();
			expect(result.yaw).not.toBeNaN();
			expect(result.roll).not.toBeNaN();
		});
	});

	describe('eulerToQuat with partial inputs (fix #8)', () => {
		test('should handle yaw-only input', () => {
			const result = eulerToQuat({ yaw: 90 });
			// 90 deg around Y: w = cos(45deg), y = sin(45deg)
			expect(result.y).toBeCloseTo(Math.SQRT1_2);
			expect(result.w).toBeCloseTo(Math.SQRT1_2);
			expect(result.x).toBeCloseTo(0);
			expect(result.z).toBeCloseTo(0);
		});

		test('should handle empty object as identity', () => {
			const result = eulerToQuat({});
			expect(result.x).toBeCloseTo(0);
			expect(result.y).toBeCloseTo(0);
			expect(result.z).toBeCloseTo(0);
			expect(result.w).toBeCloseTo(1);
		});
	});

	describe('lookRotation direction correctness (fix #8)', () => {
		test('should produce identity for forward direction (0,0,-1)', () => {
			const result = lookRotation({ x: 0, y: 0, z: -1 });
			// Forward in WebXR is -Z, so this should be close to identity
			expect(result.x).toBeCloseTo(0, 1);
			expect(result.y).toBeCloseTo(0, 1);
			expect(result.z).toBeCloseTo(0, 1);
			expect(result.w).toBeCloseTo(1, 1);
		});

		test('should produce -90 yaw for right direction (1,0,0)', () => {
			const result = lookRotation({ x: 1, y: 0, z: 0 });
			const euler = quatToEuler(result);
			expect(euler.yaw).toBeCloseTo(-90, 0);
			expect(euler.pitch).toBeCloseTo(0, 0);
		});

		test('should produce upward pitch for direction (0,1,0)', () => {
			const result = lookRotation({ x: 0, y: 1, z: 0 });
			const euler = quatToEuler(result);
			expect(Math.abs(euler.pitch)).toBeCloseTo(90, 0);
		});
	});

	describe('waitForCondition (fix #8)', () => {
		beforeEach(() => {
			// Mock requestAnimationFrame
			jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(
				(cb: FrameRequestCallback) => {
					setTimeout(() => cb(performance.now()), 0);
					return 0;
				},
			);
		});

		afterEach(() => {
			jest.restoreAllMocks();
		});

		test('should resolve immediately when condition is true', async () => {
			await expect(
				waitForCondition(() => true),
			).resolves.toBeUndefined();
		});

		test('should resolve when condition becomes true', async () => {
			let ready = false;
			setTimeout(() => {
				ready = true;
			}, 10);

			await expect(
				waitForCondition(() => ready, 5000),
			).resolves.toBeUndefined();
		});

		test('should reject on timeout', async () => {
			await expect(
				waitForCondition(() => false, 50),
			).rejects.toThrow('Timeout waiting for condition');
		});
	});
});
