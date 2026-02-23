/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { Vec3, Quat, EulerRotation } from '../types/state.js';

/**
 * Convert a Vector3-like object to a plain Vec3 object
 */
export function vec3ToObj(v: { x: number; y: number; z: number }): Vec3 {
	return { x: v.x, y: v.y, z: v.z };
}

/**
 * Convert a Quaternion-like object to a plain Quat object
 */
export function quatToObj(q: {
	x: number;
	y: number;
	z: number;
	w: number;
}): Quat {
	return { x: q.x, y: q.y, z: q.z, w: q.w };
}

/**
 * Convert quaternion to euler angles (in degrees)
 * Uses YXZ order (yaw-pitch-roll) which is standard for XR:
 * - Yaw: rotation around Y axis (turning left/right)
 * - Pitch: rotation around X axis (looking up/down)
 * - Roll: rotation around Z axis (tilting head)
 */
export function quatToEuler(q: Quat): EulerRotation {
	const { x, y, z, w } = q;
	const RAD_TO_DEG = 180 / Math.PI;

	// YXZ order
	const sinp = Math.max(-1, Math.min(1, 2 * (w * x - y * z)));
	let pitch: number;
	if (Math.abs(sinp) >= 1) {
		pitch = (Math.sign(sinp) * Math.PI) / 2;
	} else {
		pitch = Math.asin(sinp);
	}

	const siny_cosp = 2 * (w * y + x * z);
	const cosy_cosp = 1 - 2 * (x * x + y * y);
	const yaw = Math.atan2(siny_cosp, cosy_cosp);

	const sinr_cosp = 2 * (w * z + x * y);
	const cosr_cosp = 1 - 2 * (x * x + z * z);
	const roll = Math.atan2(sinr_cosp, cosr_cosp);

	return {
		pitch: pitch * RAD_TO_DEG,
		yaw: yaw * RAD_TO_DEG,
		roll: roll * RAD_TO_DEG,
	};
}

/**
 * Convert euler angles (in degrees) to quaternion
 * Uses YXZ order (yaw-pitch-roll) which is standard for XR:
 * - Yaw: rotation around Y axis (turning left/right)
 * - Pitch: rotation around X axis (looking up/down)
 * - Roll: rotation around Z axis (tilting head)
 * Missing angles default to 0.
 */
export function eulerToQuat(euler: Partial<EulerRotation>): Quat {
	const DEG_TO_RAD = Math.PI / 180;
	const pitch = (euler.pitch ?? 0) * DEG_TO_RAD; // X-axis
	const yaw = (euler.yaw ?? 0) * DEG_TO_RAD; // Y-axis
	const roll = (euler.roll ?? 0) * DEG_TO_RAD; // Z-axis

	// Half angles
	const cx = Math.cos(pitch * 0.5);
	const sx = Math.sin(pitch * 0.5);
	const cy = Math.cos(yaw * 0.5);
	const sy = Math.sin(yaw * 0.5);
	const cz = Math.cos(roll * 0.5);
	const sz = Math.sin(roll * 0.5);

	// YXZ order: first yaw, then pitch, then roll
	return {
		w: cx * cy * cz + sx * sy * sz,
		x: sx * cy * cz + cx * sy * sz,
		y: cx * sy * cz - sx * cy * sz,
		z: cx * cy * sz - sx * sy * cz,
	};
}

/**
 * Calculate normalized direction vector from one point to another
 * Returns default forward direction (0, 0, -1) if points are coincident
 */
export function directionTo(from: Vec3, to: Vec3): Vec3 {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const dz = to.z - from.z;
	const length = Math.sqrt(dx * dx + dy * dy + dz * dz);

	if (length === 0) {
		return { x: 0, y: 0, z: -1 }; // Default forward (WebXR convention)
	}

	return {
		x: dx / length,
		y: dy / length,
		z: dz / length,
	};
}

/**
 * Calculate gimbal-style look rotation (yaw + pitch only, roll = 0)
 * This keeps the camera/headset level while looking at a target.
 * @param direction - The direction to look towards
 * @returns Quaternion with only yaw and pitch, no roll
 */
export function lookRotationGimbal(direction: Vec3): Quat {
	// Calculate horizontal distance
	const horizontalDist = Math.sqrt(
		direction.x * direction.x + direction.z * direction.z,
	);

	// Calculate yaw: rotation around Y axis to face target horizontally
	// atan2(-z, -x) gives angle from negative Z axis (forward in WebXR)
	// We use -z, x to match WebXR's -Z forward convention
	let yaw = 0;
	if (horizontalDist > 0.0001) {
		yaw = Math.atan2(-direction.x, -direction.z);
	}

	// Calculate pitch: rotation around X axis to look up/down
	// Positive direction.y (target above) = positive pitch (look up)
	// Negative direction.y (target below) = negative pitch (look down)
	const pitch = Math.atan2(direction.y, horizontalDist);

	// Convert to degrees and create quaternion (roll = 0)
	const RAD_TO_DEG = 180 / Math.PI;
	return eulerToQuat({
		pitch: pitch * RAD_TO_DEG,
		yaw: yaw * RAD_TO_DEG,
		roll: 0,
	});
}

/**
 * Calculate quaternion that looks from origin towards a direction
 * @param direction - The direction to look towards (will be normalized)
 * @param up - The up vector (default: world up Y-axis)
 */
export function lookRotation(
	direction: Vec3,
	up: Vec3 = { x: 0, y: 1, z: 0 },
): Quat {
	// Normalize direction
	const dirLen = Math.sqrt(
		direction.x * direction.x +
			direction.y * direction.y +
			direction.z * direction.z,
	);

	if (dirLen === 0) {
		return { x: 0, y: 0, z: 0, w: 1 }; // Identity quaternion
	}

	const forward = {
		x: direction.x / dirLen,
		y: direction.y / dirLen,
		z: direction.z / dirLen,
	};

	// Calculate right vector (cross product of forward and up, NOT up and forward)
	// forward × up gives correct right-hand orientation
	const right = {
		x: forward.y * up.z - forward.z * up.y,
		y: forward.z * up.x - forward.x * up.z,
		z: forward.x * up.y - forward.y * up.x,
	};
	const rightLen = Math.sqrt(
		right.x * right.x + right.y * right.y + right.z * right.z,
	);

	if (rightLen === 0) {
		// Direction is parallel to up, choose a different up
		const altUp = { x: 1, y: 0, z: 0 };
		right.x = forward.y * altUp.z - forward.z * altUp.y;
		right.y = forward.z * altUp.x - forward.x * altUp.z;
		right.z = forward.x * altUp.y - forward.y * altUp.x;
		const altRightLen = Math.sqrt(
			right.x * right.x + right.y * right.y + right.z * right.z,
		);
		right.x /= altRightLen;
		right.y /= altRightLen;
		right.z /= altRightLen;
	} else {
		right.x /= rightLen;
		right.y /= rightLen;
		right.z /= rightLen;
	}

	// Recalculate up (cross product of right and forward for proper orientation)
	const newUp = {
		x: right.y * forward.z - right.z * forward.y,
		y: right.z * forward.x - right.x * forward.z,
		z: right.x * forward.y - right.y * forward.x,
	};

	// Build rotation matrix and convert to quaternion
	// Matrix: [right, newUp, -forward] (column vectors)
	const m00 = right.x,
		m01 = newUp.x,
		m02 = -forward.x;
	const m10 = right.y,
		m11 = newUp.y,
		m12 = -forward.y;
	const m20 = right.z,
		m21 = newUp.z,
		m22 = -forward.z;

	const trace = m00 + m11 + m22;
	let qw: number, qx: number, qy: number, qz: number;

	if (trace > 0) {
		const s = 0.5 / Math.sqrt(trace + 1.0);
		qw = 0.25 / s;
		qx = (m21 - m12) * s;
		qy = (m02 - m20) * s;
		qz = (m10 - m01) * s;
	} else if (m00 > m11 && m00 > m22) {
		const s = 2.0 * Math.sqrt(1.0 + m00 - m11 - m22);
		qw = (m21 - m12) / s;
		qx = 0.25 * s;
		qy = (m01 + m10) / s;
		qz = (m02 + m20) / s;
	} else if (m11 > m22) {
		const s = 2.0 * Math.sqrt(1.0 + m11 - m00 - m22);
		qw = (m02 - m20) / s;
		qx = (m01 + m10) / s;
		qy = 0.25 * s;
		qz = (m12 + m21) / s;
	} else {
		const s = 2.0 * Math.sqrt(1.0 + m22 - m00 - m11);
		qw = (m10 - m01) / s;
		qx = (m02 + m20) / s;
		qy = (m12 + m21) / s;
		qz = 0.25 * s;
	}

	// Normalize the quaternion to ensure unit length
	const len = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
	if (len > 0) {
		qx /= len;
		qy /= len;
		qz /= len;
		qw /= len;
	}

	return { x: qx, y: qy, z: qz, w: qw };
}

/**
 * Wait for a condition to become true, checking each animation frame
 */
export function waitForCondition(
	condition: () => boolean,
	timeoutMs: number = 5000,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const startTime = Date.now();
		const check = () => {
			if (condition()) {
				resolve();
			} else if (Date.now() - startTime > timeoutMs) {
				reject(new Error('Timeout waiting for condition'));
			} else {
				requestAnimationFrame(check);
			}
		};
		check();
	});
}
