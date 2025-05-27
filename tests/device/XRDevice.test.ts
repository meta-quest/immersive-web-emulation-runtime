/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRDevice, XRDeviceConfig } from '../../src/device/XRDevice.js';
import { GamepadMappingType } from '../../src/gamepad/Gamepad.js';
import { XREnvironmentBlendMode, XRInteractionMode } from '../../src/session/XRSession.js';
import { Vector3, Quaternion } from '../../src/utils/Math.js';

describe('XRDevice', () => {
	let mockDeviceConfig: XRDeviceConfig;

	beforeEach(() => {
		mockDeviceConfig = {
			name: 'Test Device',
			controllerConfig: {
				profileId: 'test-controller',
				fallbackProfileIds: [],
				layout: {
					left: {
						gamepad: {
							mapping: GamepadMappingType.XRStandard,
							buttons: [
								{ id: 'trigger', type: 'analog', eventTrigger: 'select' }
							],
							axes: [
								{ id: 'thumbstick', type: 'x-axis' },
								{ id: 'thumbstick', type: 'y-axis' }
							]
						},
						numHapticActuators: 1
					},
					right: {
						gamepad: {
							mapping: GamepadMappingType.XRStandard,
							buttons: [
								{ id: 'trigger', type: 'analog', eventTrigger: 'select' }
							],
							axes: [
								{ id: 'thumbstick', type: 'x-axis' },
								{ id: 'thumbstick', type: 'y-axis' }
							]
						},
						numHapticActuators: 1
					}
				}
			},
			supportedSessionModes: ['immersive-vr', 'inline'],
			supportedFeatures: ['local', 'hand-tracking'],
			supportedFrameRates: [60, 72, 90],
			isSystemKeyboardSupported: true,
			internalNominalFrameRate: 60,
			environmentBlendModes: {
				'immersive-vr': XREnvironmentBlendMode.Opaque
			},
			interactionMode: XRInteractionMode.WorldSpace,
			userAgent: 'Test User Agent'
		};
	});

	test('should create XRDevice with default options', () => {
		const device = new XRDevice(mockDeviceConfig);

		expect(device.name).toBe('Test Device');
		expect(device.supportedSessionModes).toEqual(['immersive-vr', 'inline']);
		expect(device.supportedFeatures).toEqual(['local', 'hand-tracking']);
		expect(device.supportedFrameRates).toEqual([60, 72, 90]);
		expect(device.isSystemKeyboardSupported).toBe(true);
		expect(device.internalNominalFrameRate).toBe(60);
		expect(device.stereoEnabled).toBe(false);
		expect(device.ipd).toBe(0.063);
		expect(device.fovy).toBe(Math.PI / 2);
		expect(device.primaryInputMode).toBe('controller');
		expect(device.visibilityState).toBe('visible');
	});

	test('should create XRDevice with custom options', () => {
		const customPosition = new Vector3(1, 2, 3);
		const customQuaternion = new Quaternion(0.5, 0.5, 0.5, 0.5);
		const canvasContainer = document.createElement('div');

		const device = new XRDevice(mockDeviceConfig, {
			ipd: 0.07,
			fovy: Math.PI / 3,
			stereoEnabled: true,
			headsetPosition: customPosition,
			headsetQuaternion: customQuaternion,
			canvasContainer
		});

		expect(device.ipd).toBe(0.07);
		expect(device.fovy).toBe(Math.PI / 3);
		expect(device.stereoEnabled).toBe(true);
		expect(device.position).toBe(customPosition);
		expect(device.quaternion).toBe(customQuaternion);
		expect(device.canvasContainer).toBe(canvasContainer);
	});

	test('should handle primary input mode changes', () => {
		const device = new XRDevice(mockDeviceConfig);

		device.primaryInputMode = 'hand';
		expect(device.primaryInputMode).toBe('hand');

		device.primaryInputMode = 'controller';
		expect(device.primaryInputMode).toBe('controller');

		// Should warn and not change for invalid mode
		const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
		device.primaryInputMode = 'invalid' as any;
		expect(device.primaryInputMode).toBe('controller');
		expect(consoleSpy).toHaveBeenCalledWith('primary input mode can only be "controller" or "hand"');
		consoleSpy.mockRestore();
	});

	test('should handle property getters and setters', () => {
		const device = new XRDevice(mockDeviceConfig);

		device.stereoEnabled = true;
		expect(device.stereoEnabled).toBe(true);

		device.ipd = 0.08;
		expect(device.ipd).toBe(0.08);

		device.fovy = Math.PI / 4;
		expect(device.fovy).toBe(Math.PI / 4);
	});

	test('should get controllers and hands', () => {
		const device = new XRDevice(mockDeviceConfig);

		expect(device.controllers).toBeDefined();
		expect(device.hands).toBeDefined();
		expect(device.controllers.left).toBeDefined();
		expect(device.controllers.right).toBeDefined();
		expect(device.hands.left).toBeDefined();
		expect(device.hands.right).toBeDefined();
	});

	test('should handle device without controller config', () => {
		const configWithoutController = {
			...mockDeviceConfig,
			controllerConfig: undefined
		};

		const device = new XRDevice(configWithoutController);

		expect(Object.keys(device.controllers)).toHaveLength(0);
		expect(device.hands.left).toBeDefined();
		expect(device.hands.right).toBeDefined();
	});

	test('should handle visibility state updates', () => {
		const device = new XRDevice(mockDeviceConfig);

		device.updateVisibilityState('hidden');
		// This should be pending until frames are produced
		expect(device.visibilityState).toBe('visible'); // unchanged until frame processing

		// Should throw for invalid visibility state
		expect(() => {
			device.updateVisibilityState('invalid' as any);
		}).toThrow('Invalid XRVisibilityState value');
	});

	test('should get canvas dimensions when canvas data exists', () => {
		const device = new XRDevice(mockDeviceConfig);

		// Initially no canvas data
		expect(device.canvasDimensions).toBeUndefined();
	});

	test('should get devui and sem when installed', () => {
		const device = new XRDevice(mockDeviceConfig);

		expect(device.devui).toBeUndefined();
		expect(device.sem).toBeUndefined();
	});
});