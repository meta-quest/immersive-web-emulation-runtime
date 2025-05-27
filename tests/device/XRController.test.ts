/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRController, XRControllerConfig } from '../../src/device/XRController.js';
import { XRHandedness } from '../../src/input/XRInputSource.js';
import { GlobalSpace, XRSpace } from '../../src/spaces/XRSpace.js';
import { Gamepad, GamepadConfig } from '../../src/gamepad/Gamepad.js';
import { XRInputSource } from '../../src/input/XRInputSource.js';
import { XRTrackedInput } from '../../src/device/XRTrackedInput.js';
import { P_GAMEPAD, P_TRACKED_INPUT } from '../../src/private.js';
import { mat4 } from 'gl-matrix';

// Mock dependencies
jest.mock('../../src/spaces/XRSpace.js');
jest.mock('../../src/gamepad/Gamepad.js');
jest.mock('../../src/input/XRInputSource.js');
jest.mock('../../src/device/XRTrackedInput.js');

// Mock console.warn to test warning messages
const mockConsoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});

describe('XRController', () => {
	let mockGlobalSpace: jest.Mocked<GlobalSpace>;
	let mockGamepadConfig: GamepadConfig;
	let mockControllerConfig: XRControllerConfig;
	let mockGamepad: jest.Mocked<Gamepad>;
	let mockInputSource: jest.Mocked<XRInputSource>;

	beforeEach(() => {
		// Clear console.warn mock before each test
		mockConsoleWarn.mockClear();

		// Create mock global space
		mockGlobalSpace = {} as any;

		// Create mock gamepad config
		mockGamepadConfig = {
			buttons: [
				{ id: 'trigger', type: 'analog' },
				{ id: 'grip', type: 'analog' },
				{ id: 'a', type: 'binary' },
				{ id: 'b', type: 'binary' }
			],
			axes: [
				{ id: 'thumbstick' }
			]
		} as any;

		// Create mock controller config
		mockControllerConfig = {
			profileId: 'meta-quest-touch-plus',
			fallbackProfileIds: ['meta-quest-touch', 'generic-trigger'],
			layout: {
				[XRHandedness.Right]: {
					gamepad: mockGamepadConfig,
					gripOffsetMatrix: mat4.create(),
					numHapticActuators: 1
				},
				[XRHandedness.Left]: {
					gamepad: mockGamepadConfig,
					numHapticActuators: 1
				}
			}
		};

		// Create fresh mock gamepad with button and axis maps for each test
		const createMockButton = (type: 'analog' | 'binary') => ({
			[P_GAMEPAD]: {
				type,
				pendingValue: 0,
				touched: false
			}
		});

		const mockAxes = { x: 0, y: 0 };

		mockGamepad = {
			[P_GAMEPAD]: {
				buttonsMap: {
					trigger: createMockButton('analog'),
					grip: createMockButton('analog'),
					a: createMockButton('binary'),
					b: createMockButton('binary')
				} as any,
				axesMap: {
					thumbstick: { ...mockAxes }
				} as any
			}
		} as any;

		// Create mock input source
		mockInputSource = {
			gamepad: mockGamepad
		} as any;

		// Mock constructors
		(XRSpace as any).mockImplementation(() => ({} as any));
		(Gamepad as any).mockImplementation(() => mockGamepad);
		(XRInputSource as any).mockImplementation(() => mockInputSource);
		(XRTrackedInput as any).mockImplementation(function(this: any, inputSource: any) {
			this[P_TRACKED_INPUT] = { inputSource };
		});
	});

	afterAll(() => {
		mockConsoleWarn.mockRestore();
	});

	describe('constructor', () => {
		it('should create controller with right handedness', () => {
			const controller = new XRController(mockControllerConfig, XRHandedness.Right, mockGlobalSpace);

			expect(controller).toBeDefined();
			expect(controller.profileId).toBe('meta-quest-touch-plus');
			expect(controller.gamepadConfig).toBe(mockGamepadConfig);
		});

		it('should create controller with left handedness', () => {
			const controller = new XRController(mockControllerConfig, XRHandedness.Left, mockGlobalSpace);

			expect(controller).toBeDefined();
			expect(controller.profileId).toBe('meta-quest-touch-plus');
		});

		it('should throw error for unsupported handedness', () => {
			const configWithoutNone = {
				...mockControllerConfig,
				layout: {
					[XRHandedness.Right]: mockControllerConfig.layout[XRHandedness.Right]!
				}
			};

			expect(() => {
				new XRController(configWithoutNone, XRHandedness.Left, mockGlobalSpace);
			}).toThrow(DOMException);
			expect(() => {
				new XRController(configWithoutNone, XRHandedness.Left, mockGlobalSpace);
			}).toThrow('Handedness not supported');
		});

		it('should throw InvalidStateError for unsupported handedness', () => {
			const configWithoutLeft = {
				...mockControllerConfig,
				layout: {
					[XRHandedness.Right]: mockControllerConfig.layout[XRHandedness.Right]!
				}
			};

			try {
				new XRController(configWithoutLeft, XRHandedness.Left, mockGlobalSpace);
				fail('Expected DOMException to be thrown');
			} catch (error) {
				expect(error).toBeInstanceOf(DOMException);
				expect((error as DOMException).name).toBe('InvalidStateError');
			}
		});

		it('should create grip space when gripOffsetMatrix is provided', () => {
			(XRSpace as jest.Mock).mockClear();
			
			new XRController(mockControllerConfig, XRHandedness.Right, mockGlobalSpace);

			// XRSpace should be called twice: once for targetRaySpace, once for gripSpace
			expect(XRSpace).toHaveBeenCalledTimes(2);
		});

		it('should not create grip space when gripOffsetMatrix is not provided', () => {
			(XRSpace as jest.Mock).mockClear();
			
			const configWithoutGrip = {
				...mockControllerConfig,
				layout: {
					[XRHandedness.Left]: {
						gamepad: mockGamepadConfig,
						numHapticActuators: 1
						// No gripOffsetMatrix
					}
				}
			};

			new XRController(configWithoutGrip, XRHandedness.Left, mockGlobalSpace);

			// XRSpace should be called once for targetRaySpace only
			expect(XRSpace).toHaveBeenCalledTimes(1);
		});

		it('should create input source with correct profiles', () => {
			new XRController(mockControllerConfig, XRHandedness.Right, mockGlobalSpace);

			expect(XRInputSource).toHaveBeenCalledWith(
				XRHandedness.Right,
				'tracked-pointer',
				['meta-quest-touch-plus', 'meta-quest-touch', 'generic-trigger'],
				expect.any(Object), // targetRaySpace
				mockGamepad,
				expect.any(Object)  // gripSpace
			);
		});

		it('should extend XRTrackedInput', () => {
			const controller = new XRController(mockControllerConfig, XRHandedness.Right, mockGlobalSpace);

			expect(controller).toBeInstanceOf(XRTrackedInput);
		});
	});

	describe('profileId getter', () => {
		it('should return the profile ID', () => {
			const controller = new XRController(mockControllerConfig, XRHandedness.Right, mockGlobalSpace);

			expect(controller.profileId).toBe('meta-quest-touch-plus');
		});

		it('should return consistent profile ID on multiple calls', () => {
			const controller = new XRController(mockControllerConfig, XRHandedness.Right, mockGlobalSpace);

			const id1 = controller.profileId;
			const id2 = controller.profileId;

			expect(id1).toBe(id2);
			expect(id1).toBe('meta-quest-touch-plus');
		});
	});

	describe('gamepadConfig getter', () => {
		it('should return the gamepad config', () => {
			const controller = new XRController(mockControllerConfig, XRHandedness.Right, mockGlobalSpace);

			expect(controller.gamepadConfig).toBe(mockGamepadConfig);
		});

		it('should return consistent gamepad config on multiple calls', () => {
			const controller = new XRController(mockControllerConfig, XRHandedness.Right, mockGlobalSpace);

			const config1 = controller.gamepadConfig;
			const config2 = controller.gamepadConfig;

			expect(config1).toBe(config2);
			expect(config1).toBe(mockGamepadConfig);
		});
	});

	describe('updateButtonValue method', () => {
		let controller: XRController;

		beforeEach(() => {
			controller = new XRController(mockControllerConfig, XRHandedness.Right, mockGlobalSpace);
		});

		it('should update analog button value within valid range', () => {
			controller.updateButtonValue('trigger', 0.5);

			expect((mockGamepad[P_GAMEPAD].buttonsMap as any).trigger[P_GAMEPAD].pendingValue).toBe(0.5);
			expect(mockConsoleWarn).not.toHaveBeenCalled();
		});

		it('should update button value to 0', () => {
			controller.updateButtonValue('trigger', 0);

			expect((mockGamepad[P_GAMEPAD].buttonsMap as any).trigger[P_GAMEPAD].pendingValue).toBe(0);
		});

		it('should update button value to 1', () => {
			controller.updateButtonValue('trigger', 1);

			expect((mockGamepad[P_GAMEPAD].buttonsMap as any).trigger[P_GAMEPAD].pendingValue).toBe(1);
		});

		it('should warn and reject values greater than 1', () => {
			controller.updateButtonValue('trigger', 1.5);

			expect((mockGamepad[P_GAMEPAD].buttonsMap as any).trigger[P_GAMEPAD].pendingValue).toBe(0); // unchanged
			expect(mockConsoleWarn).toHaveBeenCalledWith('Out-of-range value 1.5 provided for button trigger.');
		});

		it('should warn and reject negative values', () => {
			controller.updateButtonValue('trigger', -0.5);

			expect((mockGamepad[P_GAMEPAD].buttonsMap as any).trigger[P_GAMEPAD].pendingValue).toBe(0); // unchanged
			expect(mockConsoleWarn).toHaveBeenCalledWith('Out-of-range value -0.5 provided for button trigger.');
		});

		it('should update binary button with value 0', () => {
			controller.updateButtonValue('a', 0);

			expect((mockGamepad[P_GAMEPAD].buttonsMap as any).a[P_GAMEPAD].pendingValue).toBe(0);
			expect(mockConsoleWarn).not.toHaveBeenCalled();
		});

		it('should update binary button with value 1', () => {
			controller.updateButtonValue('a', 1);

			expect((mockGamepad[P_GAMEPAD].buttonsMap as any).a[P_GAMEPAD].pendingValue).toBe(1);
			expect(mockConsoleWarn).not.toHaveBeenCalled();
		});

		it('should warn and reject non-binary values for binary buttons', () => {
			controller.updateButtonValue('a', 0.5);

			expect((mockGamepad[P_GAMEPAD].buttonsMap as any).a[P_GAMEPAD].pendingValue).toBe(0); // unchanged
			expect(mockConsoleWarn).toHaveBeenCalledWith('Non-binary value 0.5 provided for binary button a.');
		});

		it('should warn for non-existent button', () => {
			controller.updateButtonValue('nonexistent', 0.5);

			expect(mockConsoleWarn).toHaveBeenCalledWith('Current controller does not have button nonexistent.');
		});

		it('should handle multiple button updates', () => {
			controller.updateButtonValue('trigger', 0.7);
			controller.updateButtonValue('grip', 0.3);
			controller.updateButtonValue('a', 1);

			expect((mockGamepad[P_GAMEPAD].buttonsMap as any).trigger[P_GAMEPAD].pendingValue).toBe(0.7);
			expect((mockGamepad[P_GAMEPAD].buttonsMap as any).grip[P_GAMEPAD].pendingValue).toBe(0.3);
			expect((mockGamepad[P_GAMEPAD].buttonsMap as any).a[P_GAMEPAD].pendingValue).toBe(1);
		});
	});

	describe('updateButtonTouch method', () => {
		let controller: XRController;

		beforeEach(() => {
			controller = new XRController(mockControllerConfig, XRHandedness.Right, mockGlobalSpace);
		});

		it('should set button touch to true', () => {
			controller.updateButtonTouch('trigger', true);

			expect((mockGamepad[P_GAMEPAD].buttonsMap as any).trigger[P_GAMEPAD].touched).toBe(true);
		});

		it('should set button touch to false', () => {
			controller.updateButtonTouch('trigger', false);

			expect((mockGamepad[P_GAMEPAD].buttonsMap as any).trigger[P_GAMEPAD].touched).toBe(false);
		});

		it('should handle multiple touch updates', () => {
			controller.updateButtonTouch('trigger', true);
			controller.updateButtonTouch('grip', false);
			controller.updateButtonTouch('a', true);

			expect((mockGamepad[P_GAMEPAD].buttonsMap as any).trigger[P_GAMEPAD].touched).toBe(true);
			expect((mockGamepad[P_GAMEPAD].buttonsMap as any).grip[P_GAMEPAD].touched).toBe(false);
			expect((mockGamepad[P_GAMEPAD].buttonsMap as any).a[P_GAMEPAD].touched).toBe(true);
		});

		it('should warn for non-existent button', () => {
			controller.updateButtonTouch('nonexistent', true);

			expect(mockConsoleWarn).toHaveBeenCalledWith('Current controller does not have button nonexistent.');
		});
	});

	describe('updateAxis method', () => {
		let controller: XRController;

		beforeEach(() => {
			controller = new XRController(mockControllerConfig, XRHandedness.Right, mockGlobalSpace);
		});

		it('should update x-axis value within valid range', () => {
			controller.updateAxis('thumbstick', 'x-axis', 0.5);

			expect((mockGamepad[P_GAMEPAD].axesMap as any).thumbstick.x).toBe(0.5);
			expect(mockConsoleWarn).not.toHaveBeenCalled();
		});

		it('should update y-axis value within valid range', () => {
			controller.updateAxis('thumbstick', 'y-axis', -0.7);

			expect((mockGamepad[P_GAMEPAD].axesMap as any).thumbstick.y).toBe(-0.7);
			expect(mockConsoleWarn).not.toHaveBeenCalled();
		});

		it('should update axis to extreme values', () => {
			controller.updateAxis('thumbstick', 'x-axis', 1);
			controller.updateAxis('thumbstick', 'y-axis', -1);

			expect((mockGamepad[P_GAMEPAD].axesMap as any).thumbstick.x).toBe(1);
			expect((mockGamepad[P_GAMEPAD].axesMap as any).thumbstick.y).toBe(-1);
		});

		it('should warn and reject x-axis values greater than 1', () => {
			controller.updateAxis('thumbstick', 'x-axis', 1.5);

			expect((mockGamepad[P_GAMEPAD].axesMap as any).thumbstick.x).toBe(0); // unchanged
			expect(mockConsoleWarn).toHaveBeenCalledWith('Out-of-range value 1.5 provided for thumbstick axes.');
		});

		it('should warn and reject y-axis values less than -1', () => {
			controller.updateAxis('thumbstick', 'y-axis', -1.5);

			expect((mockGamepad[P_GAMEPAD].axesMap as any).thumbstick.y).toBe(0); // unchanged
			expect(mockConsoleWarn).toHaveBeenCalledWith('Out-of-range value -1.5 provided for thumbstick axes.');
		});

		it('should warn for non-existent axis', () => {
			controller.updateAxis('nonexistent', 'x-axis', 0.5);

			expect(mockConsoleWarn).toHaveBeenCalledWith('Current controller does not have nonexistent axes.');
		});

		it('should handle both x and y axis updates separately', () => {
			controller.updateAxis('thumbstick', 'x-axis', 0.3);
			controller.updateAxis('thumbstick', 'y-axis', 0.8);

			expect((mockGamepad[P_GAMEPAD].axesMap as any).thumbstick.x).toBe(0.3);
			expect((mockGamepad[P_GAMEPAD].axesMap as any).thumbstick.y).toBe(0.8);
		});
	});

	describe('updateAxes method', () => {
		let controller: XRController;

		beforeEach(() => {
			controller = new XRController(mockControllerConfig, XRHandedness.Right, mockGlobalSpace);
		});

		it('should update both axes within valid range', () => {
			controller.updateAxes('thumbstick', 0.5, -0.3);

			expect((mockGamepad[P_GAMEPAD].axesMap as any).thumbstick.x).toBe(0.5);
			expect((mockGamepad[P_GAMEPAD].axesMap as any).thumbstick.y).toBe(-0.3);
			expect(mockConsoleWarn).not.toHaveBeenCalled();
		});

		it('should update axes to extreme values', () => {
			controller.updateAxes('thumbstick', 1, -1);

			expect((mockGamepad[P_GAMEPAD].axesMap as any).thumbstick.x).toBe(1);
			expect((mockGamepad[P_GAMEPAD].axesMap as any).thumbstick.y).toBe(-1);
		});

		it('should update axes to zero', () => {
			controller.updateAxes('thumbstick', 0, 0);

			expect((mockGamepad[P_GAMEPAD].axesMap as any).thumbstick.x).toBe(0);
			expect((mockGamepad[P_GAMEPAD].axesMap as any).thumbstick.y).toBe(0);
		});

		it('should warn and reject when x value is out of range', () => {
			controller.updateAxes('thumbstick', 1.5, 0.5);

			expect((mockGamepad[P_GAMEPAD].axesMap as any).thumbstick.x).toBe(0); // unchanged
			expect((mockGamepad[P_GAMEPAD].axesMap as any).thumbstick.y).toBe(0); // unchanged
			expect(mockConsoleWarn).toHaveBeenCalledWith('Out-of-range value x:1.5, y:0.5 provided for thumbstick axes.');
		});

		it('should warn and reject when y value is out of range', () => {
			controller.updateAxes('thumbstick', 0.5, -1.5);

			expect((mockGamepad[P_GAMEPAD].axesMap as any).thumbstick.x).toBe(0); // unchanged
			expect((mockGamepad[P_GAMEPAD].axesMap as any).thumbstick.y).toBe(0); // unchanged
			expect(mockConsoleWarn).toHaveBeenCalledWith('Out-of-range value x:0.5, y:-1.5 provided for thumbstick axes.');
		});

		it('should warn and reject when both values are out of range', () => {
			controller.updateAxes('thumbstick', 1.5, -1.5);

			expect((mockGamepad[P_GAMEPAD].axesMap as any).thumbstick.x).toBe(0); // unchanged
			expect((mockGamepad[P_GAMEPAD].axesMap as any).thumbstick.y).toBe(0); // unchanged
			expect(mockConsoleWarn).toHaveBeenCalledWith('Out-of-range value x:1.5, y:-1.5 provided for thumbstick axes.');
		});

		it('should warn for non-existent axes', () => {
			controller.updateAxes('nonexistent', 0.5, 0.3);

			expect(mockConsoleWarn).toHaveBeenCalledWith('Current controller does not have nonexistent axes.');
		});

		it('should handle multiple axes updates', () => {
			// First update
			controller.updateAxes('thumbstick', 0.2, 0.4);
			expect((mockGamepad[P_GAMEPAD].axesMap as any).thumbstick.x).toBe(0.2);
			expect((mockGamepad[P_GAMEPAD].axesMap as any).thumbstick.y).toBe(0.4);

			// Second update
			controller.updateAxes('thumbstick', -0.6, 0.8);
			expect((mockGamepad[P_GAMEPAD].axesMap as any).thumbstick.x).toBe(-0.6);
			expect((mockGamepad[P_GAMEPAD].axesMap as any).thumbstick.y).toBe(0.8);
		});
	});

	describe('edge cases and integration', () => {
		it('should handle controller config with empty fallback profiles', () => {
			const configWithoutFallbacks = {
				...mockControllerConfig,
				fallbackProfileIds: []
			};

			new XRController(configWithoutFallbacks, XRHandedness.Right, mockGlobalSpace);

			expect(XRInputSource).toHaveBeenCalledWith(
				XRHandedness.Right,
				'tracked-pointer',
				['meta-quest-touch-plus'], // Only main profile, no fallbacks
				expect.any(Object),
				mockGamepad,
				expect.any(Object)
			);
		});

		it('should handle config with complex profile hierarchy', () => {
			const complexConfig = {
				...mockControllerConfig,
				profileId: 'custom-controller',
				fallbackProfileIds: ['fallback1', 'fallback2', 'generic']
			};

			const controller = new XRController(complexConfig, XRHandedness.Right, mockGlobalSpace);

			expect(controller.profileId).toBe('custom-controller');
			expect(XRInputSource).toHaveBeenCalledWith(
				XRHandedness.Right,
				'tracked-pointer',
				['custom-controller', 'fallback1', 'fallback2', 'generic'],
				expect.any(Object),
				mockGamepad,
				expect.any(Object)
			);
		});

		it('should work with all update methods together', () => {
			const controller = new XRController(mockControllerConfig, XRHandedness.Right, mockGlobalSpace);

			// Update various inputs
			controller.updateButtonValue('trigger', 0.8);
			controller.updateButtonTouch('grip', true);
			controller.updateAxis('thumbstick', 'x-axis', 0.5);
			controller.updateAxes('thumbstick', -0.3, 0.7);

			// Verify all updates
			expect((mockGamepad[P_GAMEPAD].buttonsMap as any).trigger[P_GAMEPAD].pendingValue).toBe(0.8);
			expect((mockGamepad[P_GAMEPAD].buttonsMap as any).grip[P_GAMEPAD].touched).toBe(true);
			expect((mockGamepad[P_GAMEPAD].axesMap as any).thumbstick.x).toBe(-0.3); // Last update wins
			expect((mockGamepad[P_GAMEPAD].axesMap as any).thumbstick.y).toBe(0.7);
		});
	});
});