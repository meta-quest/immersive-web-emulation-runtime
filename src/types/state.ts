/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// =============================================================================
// Core Math Types
// =============================================================================

/**
 * 3D position vector
 */
export interface Vec3 {
	x: number;
	y: number;
	z: number;
}

/**
 * Quaternion for rotation representation
 */
export interface Quat {
	x: number;
	y: number;
	z: number;
	w: number;
}

/**
 * Euler angles in degrees for human-readable rotation
 * Uses YXZ order (yaw-pitch-roll) which is standard for XR:
 * - Yaw: rotation around Y axis (turning left/right)
 * - Pitch: rotation around X axis (looking up/down)
 * - Roll: rotation around Z axis (tilting head)
 */
export interface EulerRotation {
	pitch: number; // degrees, X-axis
	yaw: number; // degrees, Y-axis
	roll: number; // degrees, Z-axis
}

// =============================================================================
// Control Types
// =============================================================================

/**
 * Input mode - controller or hand tracking
 */
export type InputMode = 'controller' | 'hand';

/**
 * Control mode for XRDevice:
 * - manual: User controls device via DevUI (default)
 * - programmatic: External API controls device
 */
export type ControlMode = 'manual' | 'programmatic';
