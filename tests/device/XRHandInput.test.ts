/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRHandInput, oculusHandConfig } from '../../src/device/XRHandInput';
import { XRHandedness } from '../../src/input/XRInputSource';
import { GlobalSpace } from '../../src/spaces/XRSpace';
import { XRFrame } from '../../src/frameloop/XRFrame';

// Mock console.warn
const originalWarn = console.warn;

describe('XRHandInput', () => {
	let globalSpace: GlobalSpace;
	let xrHandInput: XRHandInput;
	let mockFrame: XRFrame;

	beforeEach(() => {
		// Reset console.warn
		console.warn = jest.fn();
		
		globalSpace = new GlobalSpace();
		
		// Create a mock frame with session
		mockFrame = {
			session: {
				dispatchEvent: jest.fn()
			}
		} as any;
	});

	afterEach(() => {
		console.warn = originalWarn;
	});

	test('should create XRHandInput for left hand', () => {
		xrHandInput = new XRHandInput(oculusHandConfig, XRHandedness.Left, globalSpace);
		
		expect(xrHandInput).toBeDefined();
		expect(xrHandInput.inputSource.handedness).toBe(XRHandedness.Left);
		expect(xrHandInput.poseId).toBe('default');
	});

	test('should create XRHandInput for right hand', () => {
		xrHandInput = new XRHandInput(oculusHandConfig, XRHandedness.Right, globalSpace);
		
		expect(xrHandInput).toBeDefined();
		expect(xrHandInput.inputSource.handedness).toBe(XRHandedness.Right);
		expect(xrHandInput.poseId).toBe('default');
	});

	test('should throw error for invalid handedness', () => {
		expect(() => {
			new XRHandInput(oculusHandConfig, 'invalid' as any, globalSpace);
		}).toThrow('handedness for XRHandInput must be either "left" or "right"');
	});

	test('should throw error for missing default pose config', () => {
		const invalidConfig = {
			...oculusHandConfig,
			poses: {
				// Missing default pose, only have pinch
				pinch: oculusHandConfig.poses.pinch,
				point: oculusHandConfig.poses.point
			}
		} as any;

		expect(() => {
			new XRHandInput(invalidConfig, XRHandedness.Left, globalSpace);
		}).toThrow('"default" and "pinch" hand pose configs are required');
	});

	test('should throw error for missing pinch pose config', () => {
		const invalidConfig = {
			...oculusHandConfig,
			poses: {
				// Missing pinch pose, only have default
				default: oculusHandConfig.poses.default,
				point: oculusHandConfig.poses.point
			}
		} as any;

		expect(() => {
			new XRHandInput(invalidConfig, XRHandedness.Left, globalSpace);
		}).toThrow('"default" and "pinch" hand pose configs are required');
	});

	test('should get and set poseId', () => {
		xrHandInput = new XRHandInput(oculusHandConfig, XRHandedness.Left, globalSpace);
		
		expect(xrHandInput.poseId).toBe('default');
		
		xrHandInput.poseId = 'pinch';
		expect(xrHandInput.poseId).toBe('pinch');
		
		xrHandInput.poseId = 'point';
		expect(xrHandInput.poseId).toBe('point');
	});

	test('should warn and not change poseId for invalid pose', () => {
		xrHandInput = new XRHandInput(oculusHandConfig, XRHandedness.Left, globalSpace);
		
		const originalPoseId = xrHandInput.poseId;
		xrHandInput.poseId = 'invalid-pose';
		
		expect(console.warn).toHaveBeenCalledWith('Pose config invalid-pose not found');
		expect(xrHandInput.poseId).toBe(originalPoseId);
	});

	test('should get pinchValue', () => {
		xrHandInput = new XRHandInput(oculusHandConfig, XRHandedness.Left, globalSpace);
		
		const pinchValue = xrHandInput.pinchValue;
		expect(typeof pinchValue).toBe('number');
		expect(pinchValue).toBeGreaterThanOrEqual(0);
		expect(pinchValue).toBeLessThanOrEqual(1);
	});

	test('should update pinch value within valid range', () => {
		xrHandInput = new XRHandInput(oculusHandConfig, XRHandedness.Left, globalSpace);
		
		xrHandInput.updatePinchValue(0.5);
		xrHandInput.onFrameStart(mockFrame); // Process pending value
		expect(xrHandInput.pinchValue).toBe(0.5);
		
		xrHandInput.updatePinchValue(0);
		xrHandInput.onFrameStart(mockFrame); // Process pending value
		expect(xrHandInput.pinchValue).toBe(0);
		
		xrHandInput.updatePinchValue(1);
		xrHandInput.onFrameStart(mockFrame); // Process pending value
		expect(xrHandInput.pinchValue).toBe(1);
	});

	test('should warn for out-of-range pinch values and not update', () => {
		xrHandInput = new XRHandInput(oculusHandConfig, XRHandedness.Left, globalSpace);
		
		const originalValue = xrHandInput.pinchValue;
		
		xrHandInput.updatePinchValue(-0.1);
		expect(console.warn).toHaveBeenCalledWith('Out-of-range value -0.1 provided for pinch');
		expect(xrHandInput.pinchValue).toBe(originalValue);
		
		xrHandInput.updatePinchValue(1.1);
		expect(console.warn).toHaveBeenCalledWith('Out-of-range value 1.1 provided for pinch');
		expect(xrHandInput.pinchValue).toBe(originalValue);
	});

	test('should call updateHandPose on frame start', () => {
		xrHandInput = new XRHandInput(oculusHandConfig, XRHandedness.Left, globalSpace);
		
		// Spy on updateHandPose method
		const updateHandPoseSpy = jest.spyOn(xrHandInput, 'updateHandPose');
		
		xrHandInput.onFrameStart(mockFrame);
		
		expect(updateHandPoseSpy).toHaveBeenCalled();
	});

	test('should handle different hand poses correctly', () => {
		xrHandInput = new XRHandInput(oculusHandConfig, XRHandedness.Left, globalSpace);
		
		// Test switching between poses
		xrHandInput.poseId = 'default';
		expect(xrHandInput.poseId).toBe('default');
		
		xrHandInput.poseId = 'pinch';
		expect(xrHandInput.poseId).toBe('pinch');
		
		xrHandInput.poseId = 'point';
		expect(xrHandInput.poseId).toBe('point');
		
		// Update hand pose to apply changes
		expect(() => xrHandInput.updateHandPose()).not.toThrow();
	});
});