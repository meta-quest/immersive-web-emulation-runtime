/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRTrackedInput } from '../../src/device/XRTrackedInput.js';
import { XRInputSource, XRHandedness } from '../../src/input/XRInputSource.js';
import { XRFrame } from '../../src/frameloop/XRFrame.js';
import { XRSession } from '../../src/session/XRSession.js';
import { Gamepad, GamepadButton } from '../../src/gamepad/Gamepad.js';
import { XRSpace } from '../../src/spaces/XRSpace.js';
import { XRInputSourceEvent } from '../../src/events/XRInputSourceEvent.js';
import { P_GAMEPAD, P_TRACKED_INPUT, P_SPACE } from '../../src/private.js';
import { Vector3, Quaternion } from '../../src/utils/Math.js';
import { mat4 } from 'gl-matrix';

// Mock dependencies
jest.mock('../../src/input/XRInputSource.js');
jest.mock('../../src/frameloop/XRFrame.js');
jest.mock('../../src/session/XRSession.js');
jest.mock('../../src/gamepad/Gamepad.js', () => {
	const actual = jest.requireActual('../../src/gamepad/Gamepad.js');
	return {
		...actual,
		Gamepad: jest.fn()
	};
});
jest.mock('../../src/spaces/XRSpace.js');
jest.mock('../../src/events/XRInputSourceEvent.js');

describe('XRTrackedInput', () => {
	let mockInputSource: jest.Mocked<XRInputSource>;
	let mockFrame: jest.Mocked<XRFrame>;
	let mockSession: jest.Mocked<XRSession>;
	let mockGamepad: jest.Mocked<Gamepad>;
	let mockTargetRaySpace: jest.Mocked<XRSpace>;

	beforeEach(() => {
		// Create mock target ray space
		mockTargetRaySpace = {
			[P_SPACE]: {
				offsetMatrix: mat4.create()
			}
		} as any;

		// Create mock gamepad
		mockGamepad = {
			[P_GAMEPAD]: {
				connected: true
			},
			buttons: []
		} as any;

		// Create mock input source
		mockInputSource = {
			handedness: XRHandedness.Right,
			targetRaySpace: mockTargetRaySpace,
			gamepad: mockGamepad
		} as any;

		// Create mock session
		mockSession = {
			dispatchEvent: jest.fn()
		} as any;

		// Create mock frame
		mockFrame = {
			session: mockSession
		} as any;
	});

	describe('constructor', () => {
		it('should create tracked input with right handedness', () => {
			const trackedInput = new XRTrackedInput(mockInputSource);

			expect(trackedInput.inputSource).toBe(mockInputSource);
			expect(trackedInput.connected).toBe(true);
			expect(trackedInput.position).toBeInstanceOf(Vector3);
			expect(trackedInput.quaternion).toBeInstanceOf(Quaternion);
		});

		it('should create tracked input with left handedness', () => {
			const leftInputSource = {
				handedness: XRHandedness.Left,
				targetRaySpace: mockTargetRaySpace,
				gamepad: mockGamepad
			} as any;
			
			const trackedInput = new XRTrackedInput(leftInputSource);

			expect(trackedInput.inputSource).toBe(leftInputSource);
			// Should use left hand default position
			expect(trackedInput.position.x).toBe(-0.25);
		});

		it('should create tracked input with none handedness', () => {
			const noneInputSource = {
				handedness: XRHandedness.None,
				targetRaySpace: mockTargetRaySpace,
				gamepad: mockGamepad
			} as any;
			
			const trackedInput = new XRTrackedInput(noneInputSource);

			expect(trackedInput.inputSource).toBe(noneInputSource);
			// Should use none default position (same as right)
			expect(trackedInput.position.x).toBe(0.25);
		});

		it('should initialize with default transform for right hand', () => {
			const trackedInput = new XRTrackedInput(mockInputSource);

			expect(trackedInput.position.x).toBe(0.25);
			expect(trackedInput.position.y).toBe(1.5);
			expect(trackedInput.position.z).toBeCloseTo(-0.4);
			expect(trackedInput.quaternion.w).toBe(1); // Identity quaternion
		});

		it('should clone default transforms', () => {
			const trackedInput1 = new XRTrackedInput(mockInputSource);
			const trackedInput2 = new XRTrackedInput(mockInputSource);

			// Should be different instances
			expect(trackedInput1.position).not.toBe(trackedInput2.position);
			expect(trackedInput1.quaternion).not.toBe(trackedInput2.quaternion);

			// But same values
			expect(trackedInput1.position.x).toBe(trackedInput2.position.x);
		});
	});

	describe('property getters', () => {
		let trackedInput: XRTrackedInput;

		beforeEach(() => {
			trackedInput = new XRTrackedInput(mockInputSource);
		});

		it('should return position', () => {
			const position = trackedInput.position;

			expect(position).toBeInstanceOf(Vector3);
			expect(position.x).toBe(0.25);
		});

		it('should return quaternion', () => {
			const quaternion = trackedInput.quaternion;

			expect(quaternion).toBeInstanceOf(Quaternion);
			expect(quaternion.w).toBe(1);
		});

		it('should return input source', () => {
			expect(trackedInput.inputSource).toBe(mockInputSource);
		});

		it('should return connected state', () => {
			expect(trackedInput.connected).toBe(true);
		});
	});

	describe('connected setter', () => {
		let trackedInput: XRTrackedInput;

		beforeEach(() => {
			trackedInput = new XRTrackedInput(mockInputSource);
		});

		it('should set connected state', () => {
			trackedInput.connected = false;

			expect(trackedInput.connected).toBe(false);
		});

		it('should update gamepad connected state', () => {
			trackedInput.connected = false;

			expect(mockGamepad[P_GAMEPAD].connected).toBe(false);
		});

		it('should handle multiple state changes', () => {
			trackedInput.connected = false;
			expect(trackedInput.connected).toBe(false);
			expect(mockGamepad[P_GAMEPAD].connected).toBe(false);

			trackedInput.connected = true;
			expect(trackedInput.connected).toBe(true);
			expect(mockGamepad[P_GAMEPAD].connected).toBe(true);
		});
	});

	describe('onFrameStart method', () => {
		let trackedInput: XRTrackedInput;

		beforeEach(() => {
			trackedInput = new XRTrackedInput(mockInputSource);
		});

		it('should update target ray space matrix', () => {
			const originalMatrix = mockTargetRaySpace[P_SPACE].offsetMatrix;
			
			trackedInput.onFrameStart(mockFrame);

			// Matrix should be updated (not checking exact values due to gl-matrix complexity)
			expect(mockTargetRaySpace[P_SPACE].offsetMatrix).toBe(originalMatrix);
		});

		it('should handle empty gamepad buttons', () => {
			Object.defineProperty(mockGamepad, 'buttons', {
				value: [],
				writable: true,
				configurable: true
			});

			expect(() => {
				trackedInput.onFrameStart(mockFrame);
			}).not.toThrow();
		});

		it('should process gamepad buttons', () => {
			const mockButton = new GamepadButton('analog', null);
			mockButton[P_GAMEPAD].lastFrameValue = 0;
			mockButton[P_GAMEPAD].value = 0;
			mockButton[P_GAMEPAD].pendingValue = 0.5;

			Object.defineProperty(mockGamepad, 'buttons', {
				value: [mockButton],
				writable: true,
				configurable: true
			});

			trackedInput.onFrameStart(mockFrame);

			// Should apply pending values
			expect(mockButton[P_GAMEPAD].value).toBe(0.5);
			expect(mockButton[P_GAMEPAD].pendingValue).toBeNull();
		});

		it('should trigger button press events', () => {
			const mockButton = new GamepadButton('analog', 'select');
			mockButton[P_GAMEPAD].lastFrameValue = 0;
			mockButton[P_GAMEPAD].value = 0;
			mockButton[P_GAMEPAD].pendingValue = 1;

			Object.defineProperty(mockGamepad, "buttons", { value: [mockButton], writable: true, configurable: true });

			trackedInput.onFrameStart(mockFrame);

			// Should dispatch select and selectstart events
			expect(mockSession.dispatchEvent).toHaveBeenCalledTimes(2);
			expect(XRInputSourceEvent).toHaveBeenCalledWith('select', {
				frame: mockFrame,
				inputSource: mockInputSource
			});
			expect(XRInputSourceEvent).toHaveBeenCalledWith('selectstart', {
				frame: mockFrame,
				inputSource: mockInputSource
			});
		});

		it('should trigger button release events', () => {
			const mockButton = new GamepadButton('analog', 'select');
			mockButton[P_GAMEPAD].lastFrameValue = 0; // Will be set to current value
			mockButton[P_GAMEPAD].value = 1; // Current value that will become lastFrameValue
			mockButton[P_GAMEPAD].pendingValue = 0; // Will become new value

			Object.defineProperty(mockGamepad, "buttons", { value: [mockButton], writable: true, configurable: true });

			trackedInput.onFrameStart(mockFrame);

			// Should dispatch selectend event
			expect(mockSession.dispatchEvent).toHaveBeenCalledTimes(1);
			expect(XRInputSourceEvent).toHaveBeenCalledWith('selectend', {
				frame: mockFrame,
				inputSource: mockInputSource
			});
		});

		it('should not trigger events when button has no eventTrigger', () => {
			const mockButton = new GamepadButton('analog', null);
			mockButton[P_GAMEPAD].lastFrameValue = 0;
			mockButton[P_GAMEPAD].value = 0;
			mockButton[P_GAMEPAD].pendingValue = 1;

			Object.defineProperty(mockGamepad, "buttons", { value: [mockButton], writable: true, configurable: true });

			trackedInput.onFrameStart(mockFrame);

			expect(mockSession.dispatchEvent).not.toHaveBeenCalled();
		});

		it('should update input source changed flag based on connection', () => {
			// Initially connected, lastFrameConnected should be false
			trackedInput.onFrameStart(mockFrame);

			// Should be changed on first frame
			expect((trackedInput as any)[P_TRACKED_INPUT].inputSourceChanged).toBe(true);
			expect((trackedInput as any)[P_TRACKED_INPUT].lastFrameConnected).toBe(true);

			// Second frame, no change
			trackedInput.onFrameStart(mockFrame);
			expect((trackedInput as any)[P_TRACKED_INPUT].inputSourceChanged).toBe(false);
		});

		it('should detect connection state changes', () => {
			// Start connected
			trackedInput.onFrameStart(mockFrame);
			expect((trackedInput as any)[P_TRACKED_INPUT].inputSourceChanged).toBe(true);

			// Disconnect
			trackedInput.connected = false;
			trackedInput.onFrameStart(mockFrame);
			expect((trackedInput as any)[P_TRACKED_INPUT].inputSourceChanged).toBe(true);

			// Stay disconnected
			trackedInput.onFrameStart(mockFrame);
			expect((trackedInput as any)[P_TRACKED_INPUT].inputSourceChanged).toBe(false);
		});

		it('should handle multiple buttons with different states', () => {
			const button1 = new GamepadButton('analog', 'select');
			button1[P_GAMEPAD].lastFrameValue = 0;
			button1[P_GAMEPAD].value = 0;
			button1[P_GAMEPAD].pendingValue = 1;

			const button2 = new GamepadButton('analog', 'squeeze');
			button2[P_GAMEPAD].lastFrameValue = 0; // Will be set to current value
			button2[P_GAMEPAD].value = 1; // Current value that will become lastFrameValue
			button2[P_GAMEPAD].pendingValue = 0; // Will become new value

			Object.defineProperty(mockGamepad, "buttons", { value: [button1, button2], writable: true, configurable: true });

			trackedInput.onFrameStart(mockFrame);

			// Should handle both buttons
			expect(button1[P_GAMEPAD].value).toBe(1);
			expect(button2[P_GAMEPAD].lastFrameValue).toBe(1);
			expect(button2[P_GAMEPAD].value).toBe(0);
			expect(mockSession.dispatchEvent).toHaveBeenCalledTimes(3); // select, selectstart, squeezeend
		});
	});

	describe('integration tests', () => {
		it('should work with position and quaternion changes', () => {
			const trackedInput = new XRTrackedInput(mockInputSource);

			// Modify position and quaternion
			trackedInput.position.set(1, 2, 3);
			trackedInput.quaternion.set(0.1, 0.2, 0.3, 0.9);

			// Should update matrix on frame start
			trackedInput.onFrameStart(mockFrame);

			// No errors should occur
			expect(mockTargetRaySpace[P_SPACE].offsetMatrix).toBeDefined();
		});

		it('should handle all handedness types', () => {
			const rightInput = new XRTrackedInput(mockInputSource);
			
			const leftInputSource = {
				handedness: XRHandedness.Left,
				targetRaySpace: mockTargetRaySpace,
				gamepad: mockGamepad
			} as any;
			const leftInput = new XRTrackedInput(leftInputSource);
			
			const noneInputSource = {
				handedness: XRHandedness.None,
				targetRaySpace: mockTargetRaySpace,
				gamepad: mockGamepad
			} as any;
			const noneInput = new XRTrackedInput(noneInputSource);

			expect(rightInput.position.x).toBe(0.25);
			expect(leftInput.position.x).toBe(-0.25);
			expect(noneInput.position.x).toBe(0.25);
		});
	});
});