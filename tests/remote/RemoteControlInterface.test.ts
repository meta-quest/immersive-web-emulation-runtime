/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRDevice, XRDeviceConfig } from '../../src/device/XRDevice.js';
import { RemoteControlInterface } from '../../src/remote/RemoteControlInterface.js';
import { GamepadMappingType } from '../../src/gamepad/Gamepad.js';
import {
	XREnvironmentBlendMode,
	XRInteractionMode,
} from '../../src/session/XRSession.js';
import { P_SESSION, P_SPACE } from '../../src/private.js';
import { mat4 } from 'gl-matrix';
import type {
	GetTransformResult,
	SetTransformResult,
	LookAtResult,
	AnimateToResult,
	SetInputModeResult,
	SetConnectedResult,
	GetSelectValueResult,
	SetSelectValueResult,
	SelectResult,
	GetGamepadStateResult,
	SetGamepadStateResult,
	RemoteSessionStatus,
	RemoteDeviceState,
	SetDeviceStateResult,
} from '../../src/remote/types.js';

describe('RemoteControlInterface', () => {
	let mockDeviceConfig: XRDeviceConfig;
	let device: XRDevice;
	let remote: RemoteControlInterface;

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
								{ id: 'trigger', type: 'analog', eventTrigger: 'select' },
								{ id: 'squeeze', type: 'analog', eventTrigger: 'squeeze' },
								{ id: 'thumbstick', type: 'binary' },
								{ id: 'x-button', type: 'binary' },
								{ id: 'y-button', type: 'binary' },
								{ id: 'thumbrest', type: 'binary' },
							],
							axes: [
								{ id: 'thumbstick', type: 'x-axis' },
								{ id: 'thumbstick', type: 'y-axis' },
							],
						},
						numHapticActuators: 1,
					},
					right: {
						gamepad: {
							mapping: GamepadMappingType.XRStandard,
							buttons: [
								{ id: 'trigger', type: 'analog', eventTrigger: 'select' },
								{ id: 'squeeze', type: 'analog', eventTrigger: 'squeeze' },
								{ id: 'thumbstick', type: 'binary' },
								{ id: 'a-button', type: 'binary' },
								{ id: 'b-button', type: 'binary' },
								{ id: 'thumbrest', type: 'binary' },
							],
							axes: [
								{ id: 'thumbstick', type: 'x-axis' },
								{ id: 'thumbstick', type: 'y-axis' },
							],
						},
						numHapticActuators: 1,
					},
				},
			},
			supportedSessionModes: ['immersive-vr', 'inline'],
			supportedFeatures: ['local', 'hand-tracking'],
			supportedFrameRates: [60, 72, 90],
			isSystemKeyboardSupported: true,
			internalNominalFrameRate: 60,
			environmentBlendModes: {
				'immersive-vr': XREnvironmentBlendMode.Opaque,
			},
			interactionMode: XRInteractionMode.WorldSpace,
			userAgent: 'Test User Agent',
		};

		device = new XRDevice(mockDeviceConfig);
		remote = device.remote;
	});

	// Helper to mock an active session for tests that require it
	function mockActiveSession(): void {
		// Mock the activeSession getter to return a truthy object
		Object.defineProperty(device, 'activeSession', {
			get: () => ({ mode: 'immersive-vr' }),
			configurable: true,
		});
	}

	// Helper to mock an active session with a reference space that has an offset
	// This simulates a 'local' reference space where the XR origin is offset from GlobalSpace
	function mockActiveSessionWithReferenceSpace(
		offsetX: number,
		offsetY: number,
		offsetZ: number,
	): void {
		const offsetMatrix = mat4.create();
		mat4.fromTranslation(offsetMatrix, [offsetX, offsetY, offsetZ]);

		const mockRefSpace = {
			[P_SPACE]: {
				offsetMatrix,
			},
		};

		const mockSession = {
			mode: 'immersive-vr',
			[P_SESSION]: {
				referenceSpaces: [mockRefSpace],
			},
		};

		Object.defineProperty(device, 'activeSession', {
			get: () => mockSession,
			configurable: true,
		});
	}

	afterEach(() => {
		// Clean up any pending timers
		remote.forceRelease();
		jest.useRealTimers();
	});

	describe('constructor and properties', () => {
		test('should be accessible via device.remote', () => {
			expect(remote).toBeDefined();
			expect(remote).toBeInstanceOf(RemoteControlInterface);
		});

		test('should not be captured initially', () => {
			expect(remote.isCaptured).toBe(false);
		});

		test('should have empty queue initially', () => {
			expect(remote.queueLength).toBe(0);
		});
	});

	describe('update method', () => {
		test('should not change state when queue is empty', () => {
			expect(remote.isCaptured).toBe(false);
			remote.update(16.67);
			expect(remote.isCaptured).toBe(false);
		});

		test('should set captured state when queue has actions', async () => {
			mockActiveSession();
			// Enqueue a queued action (set_transform goes through queue, get_transform is immediate)
			const promise = remote.dispatch('set_transform', {
				device: 'headset',
				position: { x: 1, y: 2, z: 3 },
			});
			expect(remote.queueLength).toBe(1);

			// Process the action
			remote.update(16.67);
			expect(remote.isCaptured).toBe(true);
			expect(device.controlMode).toBe('programmatic');

			// Wait for promise to resolve
			await promise;
			expect(remote.queueLength).toBe(0);
		});

		test('should process multiple discrete actions in one update', async () => {
			mockActiveSession();
			// Enqueue multiple queued actions
			const promise1 = remote.dispatch('set_transform', {
				device: 'headset',
				position: { x: 1, y: 1, z: 1 },
			});
			const promise2 = remote.dispatch('set_transform', {
				device: 'controller-left',
				position: { x: 2, y: 2, z: 2 },
			});
			const promise3 = remote.dispatch('set_transform', {
				device: 'controller-right',
				position: { x: 3, y: 3, z: 3 },
			});

			expect(remote.queueLength).toBe(3);

			// All should be processed in one update
			remote.update(16.67);

			await Promise.all([promise1, promise2, promise3]);
			expect(remote.queueLength).toBe(0);
		});
	});

	describe('session requirement', () => {
		test('should reject queued methods when no active session', async () => {
			await expect(
				remote.dispatch('set_transform', {
					device: 'headset',
					position: { x: 1, y: 2, z: 3 },
				}),
			).rejects.toThrow('No active XR session');
		});

		test('should allow queued methods when session is active', async () => {
			mockActiveSession();
			const promise = remote.dispatch('set_transform', {
				device: 'headset',
				position: { x: 1, y: 2, z: 3 },
			});
			expect(remote.queueLength).toBe(1);
			remote.update(16.67);
			await promise;
		});
	});

	describe('immediate methods', () => {
		test('get_transform should execute immediately without queue', async () => {
			device.position.set(1, 2, 3);

			const result = (await remote.dispatch('get_transform', {
				device: 'headset',
			})) as GetTransformResult;

			// Should not be in queue and should not require update()
			expect(remote.queueLength).toBe(0);
			expect(remote.isCaptured).toBe(false);
			expect(result.position).toEqual({ x: 1, y: 2, z: 3 });
		});

		test('get_session_status should execute immediately', async () => {
			const result = (await remote.dispatch(
				'get_session_status',
				{},
			)) as RemoteSessionStatus;

			expect(remote.queueLength).toBe(0);
			expect(result.deviceName).toBe('Test Device');
		});

		test('get_device_state should execute immediately', async () => {
			device.position.set(5, 6, 7);

			const result = (await remote.dispatch(
				'get_device_state',
				{},
			)) as RemoteDeviceState;

			expect(remote.queueLength).toBe(0);
			expect(result.headset.position).toEqual({ x: 5, y: 6, z: 7 });
		});

		test('accept_session should execute immediately (and throw when no session)', async () => {
			await expect(remote.dispatch('accept_session', {})).rejects.toThrow(
				'No session has been offered',
			);
			expect(remote.queueLength).toBe(0);
		});

		test('end_session should execute immediately (and throw when no session)', async () => {
			await expect(remote.dispatch('end_session', {})).rejects.toThrow(
				'No active session',
			);
			expect(remote.queueLength).toBe(0);
		});
	});

	describe('capture/release timer', () => {
		beforeEach(() => {
			jest.useFakeTimers();
			mockActiveSession();
		});

		test('should release after RELEASE_TIMEOUT_MS when queue empties', async () => {
			const promise = remote.dispatch('set_transform', {
				device: 'headset',
				position: { x: 1, y: 2, z: 3 },
			});
			remote.update(16.67);
			await promise;

			expect(remote.isCaptured).toBe(true);

			// Advance time past release timeout
			jest.advanceTimersByTime(remote.RELEASE_TIMEOUT_MS + 100);

			expect(remote.isCaptured).toBe(false);
			expect(device.controlMode).toBe('manual');
		});

		test('should cancel release timer when new action is queued', async () => {
			const promise1 = remote.dispatch('set_transform', {
				device: 'headset',
				position: { x: 1, y: 2, z: 3 },
			});
			remote.update(16.67);
			await promise1;

			expect(remote.isCaptured).toBe(true);

			// Advance time halfway to release
			jest.advanceTimersByTime(remote.RELEASE_TIMEOUT_MS / 2);

			// Queue another action
			const promise2 = remote.dispatch('set_transform', {
				device: 'controller-left',
				position: { x: 4, y: 5, z: 6 },
			});
			remote.update(16.67);
			await promise2;

			// Advance past original release time
			jest.advanceTimersByTime(remote.RELEASE_TIMEOUT_MS / 2 + 100);

			// Should still be captured (timer was reset)
			expect(remote.isCaptured).toBe(true);

			// Advance past new release time
			jest.advanceTimersByTime(remote.RELEASE_TIMEOUT_MS);
			expect(remote.isCaptured).toBe(false);
		});
	});

	describe('forceRelease', () => {
		test('should immediately release capture', async () => {
			mockActiveSession();
			const promise = remote.dispatch('set_transform', {
				device: 'headset',
				position: { x: 1, y: 2, z: 3 },
			});
			remote.update(16.67);
			await promise;

			expect(remote.isCaptured).toBe(true);

			remote.forceRelease();

			expect(remote.isCaptured).toBe(false);
			expect(device.controlMode).toBe('manual');
		});

		test('should reject pending actions', async () => {
			mockActiveSession();
			const promise = remote.dispatch('set_transform', {
				device: 'headset',
				position: { x: 1, y: 1, z: 1 },
			});

			// Force release before processing
			remote.forceRelease();

			await expect(promise).rejects.toThrow('Capture released');
		});
	});

	describe('Session Tools', () => {
		describe('get_session_status', () => {
			test('should return session status when no session', async () => {
				// get_session_status is immediate, no update() needed
				const result = (await remote.dispatch(
					'get_session_status',
					{},
				)) as RemoteSessionStatus;

				expect(result.deviceName).toBe('Test Device');
				expect(result.isRuntimeInstalled).toBe(true);
				expect(result.sessionActive).toBe(false);
				expect(result.sessionOffered).toBe(false);
				expect(result.sessionMode).toBeNull();
				expect(result.enabledFeatures).toEqual([]);
				expect(result.visibilityState).toBe('visible');
			});
		});

		describe('accept_session', () => {
			test('should throw when no session offered', async () => {
				// accept_session is immediate
				await expect(remote.dispatch('accept_session', {})).rejects.toThrow(
					'No session has been offered',
				);
			});
		});

		describe('end_session', () => {
			test('should throw when no active session', async () => {
				// end_session is immediate
				await expect(remote.dispatch('end_session', {})).rejects.toThrow(
					'No active session',
				);
			});
		});
	});

	describe('Transform Tools', () => {
		describe('get_transform', () => {
			test('should get headset transform', async () => {
				device.position.set(1, 2, 3);
				device.quaternion.set(0, 0, 0, 1);

				// get_transform is immediate - no update() needed
				const result = (await remote.dispatch('get_transform', {
					device: 'headset',
				})) as GetTransformResult;

				expect(result.device).toBe('headset');
				expect(result.position).toEqual({ x: 1, y: 2, z: 3 });
				expect(result.orientation).toEqual({ x: 0, y: 0, z: 0, w: 1 });
				expect(result.euler).toBeDefined();
			});

			test('should get controller-left transform', async () => {
				device.controllers.left!.position.set(1, 2, 3);

				const result = (await remote.dispatch('get_transform', {
					device: 'controller-left',
				})) as GetTransformResult;

				expect(result.device).toBe('controller-left');
				expect(result.position).toEqual({ x: 1, y: 2, z: 3 });
			});

			test('should get controller-right transform', async () => {
				device.controllers.right!.position.set(4, 5, 6);

				const result = (await remote.dispatch('get_transform', {
					device: 'controller-right',
				})) as GetTransformResult;

				expect(result.device).toBe('controller-right');
				expect(result.position).toEqual({ x: 4, y: 5, z: 6 });
			});

			test('should get hand-left transform', async () => {
				device.hands.left!.position.set(7, 8, 9);

				const result = (await remote.dispatch('get_transform', {
					device: 'hand-left',
				})) as GetTransformResult;

				expect(result.device).toBe('hand-left');
				expect(result.position).toEqual({ x: 7, y: 8, z: 9 });
			});

			test('should get hand-right transform', async () => {
				device.hands.right!.position.set(10, 11, 12);

				const result = (await remote.dispatch('get_transform', {
					device: 'hand-right',
				})) as GetTransformResult;

				expect(result.device).toBe('hand-right');
				expect(result.position).toEqual({ x: 10, y: 11, z: 12 });
			});

			test('should throw for unknown device', async () => {
				// get_transform is immediate, error thrown synchronously
				await expect(
					remote.dispatch('get_transform', { device: 'unknown-device' }),
				).rejects.toThrow('Unknown device');
			});
		});

		describe('set_transform', () => {
			beforeEach(() => {
				mockActiveSession();
			});

			test('should set headset position', async () => {
				const promise = remote.dispatch('set_transform', {
					device: 'headset',
					position: { x: 5, y: 6, z: 7 },
				});
				remote.update(16.67);
				const result = (await promise) as SetTransformResult;

				expect(result.device).toBe('headset');
				expect(result.position).toEqual({ x: 5, y: 6, z: 7 });
				expect(device.position.x).toBe(5);
				expect(device.position.y).toBe(6);
				expect(device.position.z).toBe(7);
			});

			test('should set headset orientation with quaternion', async () => {
				const promise = remote.dispatch('set_transform', {
					device: 'headset',
					orientation: { x: 0, y: 0.707, z: 0, w: 0.707 },
				});
				remote.update(16.67);
				const result = (await promise) as SetTransformResult;

				expect(result.orientation.y).toBeCloseTo(0.707, 2);
				expect(result.orientation.w).toBeCloseTo(0.707, 2);
			});

			test('should set headset orientation with euler angles', async () => {
				const promise = remote.dispatch('set_transform', {
					device: 'headset',
					orientation: { pitch: 0, yaw: 90, roll: 0 },
				});
				remote.update(16.67);
				const result = (await promise) as SetTransformResult;

				// Y-axis rotation of 90 degrees
				expect(Math.abs(result.orientation.y)).toBeGreaterThan(0.5);
			});

			test('should set controller position', async () => {
				const promise = remote.dispatch('set_transform', {
					device: 'controller-right',
					position: { x: 1, y: 2, z: 3 },
				});
				remote.update(16.67);
				const result = (await promise) as SetTransformResult;

				expect(result.device).toBe('controller-right');
				expect(device.controllers.right!.position.x).toBe(1);
			});

			test('should set controller orientation', async () => {
				const promise = remote.dispatch('set_transform', {
					device: 'controller-left',
					orientation: { x: 0, y: 0.707, z: 0, w: 0.707 },
				});
				remote.update(16.67);
				const result = (await promise) as SetTransformResult;

				expect(result.device).toBe('controller-left');
				expect(result.orientation.y).toBeCloseTo(0.707, 2);
			});

			test('should set controller-right orientation', async () => {
				const promise = remote.dispatch('set_transform', {
					device: 'controller-right',
					orientation: { x: 0, y: 0.5, z: 0, w: 0.866 },
				});
				remote.update(16.67);
				const result = (await promise) as SetTransformResult;

				expect(result.device).toBe('controller-right');
				expect(result.orientation.y).toBeCloseTo(0.5, 2);
			});

			test('should set hand position', async () => {
				const promise = remote.dispatch('set_transform', {
					device: 'hand-left',
					position: { x: 0.5, y: 1.5, z: 0.5 },
				});
				remote.update(16.67);
				const result = (await promise) as SetTransformResult;

				expect(result.device).toBe('hand-left');
				expect(device.hands.left!.position.x).toBe(0.5);
			});

			test('should set hand orientation', async () => {
				const promise = remote.dispatch('set_transform', {
					device: 'hand-left',
					orientation: { x: 0, y: 0.383, z: 0, w: 0.924 },
				});
				remote.update(16.67);
				const result = (await promise) as SetTransformResult;

				expect(result.device).toBe('hand-left');
				expect(result.orientation.y).toBeCloseTo(0.383, 2);
			});

			test('should set hand-right orientation', async () => {
				const promise = remote.dispatch('set_transform', {
					device: 'hand-right',
					orientation: { x: 0, y: 0.259, z: 0, w: 0.966 },
				});
				remote.update(16.67);
				const result = (await promise) as SetTransformResult;

				expect(result.device).toBe('hand-right');
				expect(result.orientation.y).toBeCloseTo(0.259, 2);
			});
		});

		describe('look_at', () => {
			beforeEach(() => {
				mockActiveSession();
			});

			test('should orient headset to face target', async () => {
				device.position.set(0, 1.6, 0);

				const promise = remote.dispatch('look_at', {
					device: 'headset',
					target: { x: 0, y: 1.6, z: -5 },
				});
				remote.update(16.67);
				const result = (await promise) as LookAtResult;

				expect(result.device).toBe('headset');
				// Looking forward (-Z), quaternion should be close to identity
				expect(result.orientation.w).toBeCloseTo(1, 1);
			});

			test('should move headset to distance from target', async () => {
				device.position.set(0, 1.6, 0);

				const promise = remote.dispatch('look_at', {
					device: 'headset',
					target: { x: 0, y: 1.6, z: -10 },
					moveToDistance: 2,
				});
				remote.update(16.67);
				const result = (await promise) as LookAtResult;

				// Should be 2 units away from target at z=-10
				expect(result.position.z).toBeCloseTo(-8, 1);
			});

			test('should orient controller to face target', async () => {
				device.controllers.right!.position.set(0.2, 1.4, -0.3);

				const promise = remote.dispatch('look_at', {
					device: 'controller-right',
					target: { x: 0, y: 0, z: -2 },
				});
				remote.update(16.67);
				const result = (await promise) as LookAtResult;

				expect(result.device).toBe('controller-right');
			});
		});
	});

	describe('XR Origin Coordinate Transformation', () => {
		describe('look_at with reference space offset', () => {
			test('should transform target from XR-origin-relative to GlobalSpace', async () => {
				// Simulate a 'local' reference space with offset at (0, 1.6, 0)
				// This is typical when session starts with headset at y=1.6
				mockActiveSessionWithReferenceSpace(0, 1.6, 0);

				// Place headset at (0, 1.6, 0) in GlobalSpace
				device.position.set(0, 1.6, 0);

				// Target is at (0, 0, -2) relative to XR origin
				// After transformation: (0, 1.6, -2) in GlobalSpace
				// So headset should look forward (-Z direction)
				const promise = remote.dispatch('look_at', {
					device: 'headset',
					target: { x: 0, y: 0, z: -2 },
				});
				remote.update(16.67);
				const result = (await promise) as LookAtResult;

				// Looking straight forward (-Z), quaternion should be close to identity
				expect(result.orientation.w).toBeCloseTo(1, 1);
				expect(result.orientation.x).toBeCloseTo(0, 1);
				expect(result.orientation.y).toBeCloseTo(0, 1);
				expect(result.orientation.z).toBeCloseTo(0, 1);
			});

			test('should correctly orient when target is offset in XR-origin space', async () => {
				// Reference space offset at (0, 1.6, 0)
				mockActiveSessionWithReferenceSpace(0, 1.6, 0);

				// Place headset at (0, 1.6, 0) in GlobalSpace
				device.position.set(0, 1.6, 0);

				// Target is at (2, 0, 0) relative to XR origin
				// After transformation: (2, 1.6, 0) in GlobalSpace
				// Headset should look to the right (+X direction)
				const promise = remote.dispatch('look_at', {
					device: 'headset',
					target: { x: 2, y: 0, z: 0 },
				});
				remote.update(16.67);
				const result = (await promise) as LookAtResult;

				// Looking right (+X) means rotating -90 degrees around Y axis
				// quaternion for -90° Y rotation: (0, -0.707, 0, 0.707)
				expect(Math.abs(result.orientation.y)).toBeCloseTo(0.707, 1);
				expect(result.orientation.w).toBeCloseTo(0.707, 1);
			});

			test('should handle moveToDistance with transformed coordinates', async () => {
				// Reference space offset at (0, 1.6, 0)
				mockActiveSessionWithReferenceSpace(0, 1.6, 0);

				// Place headset at origin in GlobalSpace
				device.position.set(0, 1.6, 0);

				// Target is at (0, 0, -10) relative to XR origin
				// After transformation: (0, 1.6, -10) in GlobalSpace
				// With moveToDistance=2, headset should end up at (0, 1.6, -8)
				const promise = remote.dispatch('look_at', {
					device: 'headset',
					target: { x: 0, y: 0, z: -10 },
					moveToDistance: 2,
				});
				remote.update(16.67);
				const result = (await promise) as LookAtResult;

				expect(result.position.x).toBeCloseTo(0, 1);
				expect(result.position.y).toBeCloseTo(1.6, 1);
				expect(result.position.z).toBeCloseTo(-8, 1);
			});
		});

		describe('animate_to with reference space offset', () => {
			test('should transform target position from XR-origin-relative to GlobalSpace', async () => {
				// Reference space offset at (0, 1.6, 0)
				mockActiveSessionWithReferenceSpace(0, 1.6, 0);

				// Start headset at (0, 1.6, 0) in GlobalSpace
				device.position.set(0, 1.6, 0);

				// Animate to (0, 0, -2) relative to XR origin
				// After transformation: (0, 1.6, -2) in GlobalSpace
				const promise = remote.dispatch('animate_to', {
					device: 'headset',
					position: { x: 0, y: 0, z: -2 },
					duration: 0.1,
				});

				// Complete the animation
				remote.update(100);
				const result = (await promise) as AnimateToResult;

				// Final position should be transformed to GlobalSpace
				expect(result.position.x).toBeCloseTo(0, 1);
				expect(result.position.y).toBeCloseTo(1.6, 1);
				expect(result.position.z).toBeCloseTo(-2, 1);
			});

			test('should interpolate correctly with transformed target', async () => {
				// Reference space offset at (5, 0, 0)
				mockActiveSessionWithReferenceSpace(5, 0, 0);

				// Start headset at (5, 1.6, 0) in GlobalSpace
				device.position.set(5, 1.6, 0);

				// Animate to (0, 1.6, 0) relative to XR origin
				// After transformation: (5, 1.6, 0) in GlobalSpace (same position!)
				// Wait, that's the same... let's use a different target
				// Animate to (2, 1.6, 0) relative to XR origin
				// After transformation: (7, 1.6, 0) in GlobalSpace
				const promise = remote.dispatch('animate_to', {
					device: 'headset',
					position: { x: 2, y: 1.6, z: 0 },
					duration: 0.1,
				});

				// Halfway through animation
				remote.update(50);
				// Should be at (6, 1.6, 0) - halfway from (5,1.6,0) to (7,1.6,0)
				expect(device.position.x).toBeCloseTo(6, 1);

				// Complete the animation
				remote.update(50);
				await promise;

				// Final position
				expect(device.position.x).toBeCloseTo(7, 1);
			});
		});
	});

	describe('Duration Actions - animate_to', () => {
		beforeEach(() => {
			mockActiveSession();
		});

		test('should animate position over duration', async () => {
			device.position.set(0, 1.6, 0);

			const promise = remote.dispatch('animate_to', {
				device: 'headset',
				position: { x: 0, y: 1.6, z: -2 },
				duration: 0.1, // 100ms
			});

			// First update - starts animation
			remote.update(50); // 50ms
			expect(remote.queueLength).toBe(1); // Still in progress
			expect(device.position.z).toBeCloseTo(-1, 1); // Halfway

			// Second update - completes animation
			remote.update(60); // 60ms more = 110ms total
			const result = (await promise) as AnimateToResult;

			expect(result.device).toBe('headset');
			expect(result.position.z).toBe(-2);
			expect(result.actualDuration).toBeGreaterThanOrEqual(0.1);
		});

		test('should animate orientation over duration', async () => {
			device.quaternion.set(0, 0, 0, 1);

			const promise = remote.dispatch('animate_to', {
				device: 'headset',
				orientation: { x: 0, y: 0.707, z: 0, w: 0.707 },
				duration: 0.1,
			});

			remote.update(50);
			expect(remote.queueLength).toBe(1);

			remote.update(60);
			const result = (await promise) as AnimateToResult;

			expect(result.orientation.y).toBeCloseTo(0.707, 2);
		});

		test('should animate with euler angles', async () => {
			device.quaternion.set(0, 0, 0, 1);

			const promise = remote.dispatch('animate_to', {
				device: 'headset',
				orientation: { pitch: 0, yaw: 45, roll: 0 },
				duration: 0.1,
			});

			remote.update(150);
			const result = (await promise) as AnimateToResult;

			expect(result.device).toBe('headset');
		});

		test('should handle slerp with opposite hemisphere quaternions', async () => {
			// Set initial quaternion to identity
			device.quaternion.set(0, 0, 0, 1);

			// Animate to the same rotation represented with negative quaternion
			// This gives dot product of -1 (a.w * b.w = 1 * -1)
			const promise = remote.dispatch('animate_to', {
				device: 'headset',
				orientation: { x: 0, y: 0, z: 0, w: -1 }, // Same rotation, opposite hemisphere
				duration: 0.1,
			});

			remote.update(50);
			// Just verify it doesn't crash and progresses
			expect(remote.queueLength).toBe(1);

			remote.update(60);
			const result = (await promise) as AnimateToResult;
			expect(result.device).toBe('headset');
		});

		test('should handle slerp with very close quaternions (linear fallback)', async () => {
			// Set initial quaternion
			device.quaternion.set(0, 0, 0, 1);

			// Animate to a quaternion that's almost identical (dot > 0.9995)
			// Tiny rotation - almost no difference
			const promise = remote.dispatch('animate_to', {
				device: 'headset',
				orientation: { x: 0, y: 0.001, z: 0, w: 0.9999995 },
				duration: 0.1,
			});

			remote.update(50);
			expect(remote.queueLength).toBe(1);

			remote.update(60);
			const result = (await promise) as AnimateToResult;
			expect(result.device).toBe('headset');
		});

		test('should use default duration of 0.5s', async () => {
			const promise = remote.dispatch('animate_to', {
				device: 'headset',
				position: { x: 1, y: 1, z: 1 },
			});

			// 250ms - halfway through default 500ms
			remote.update(250);
			expect(remote.queueLength).toBe(1);

			// Complete
			remote.update(300);
			const result = (await promise) as AnimateToResult;
			expect(result.actualDuration).toBeGreaterThanOrEqual(0.5);
		});

		test('should block queue during duration action', async () => {
			const promise1 = remote.dispatch('animate_to', {
				device: 'headset',
				position: { x: 1, y: 1, z: 1 },
				duration: 0.1,
			});

			// Queue a set_transform (which is queued, unlike get_transform which is immediate)
			const promise2 = remote.dispatch('set_transform', {
				device: 'headset',
				position: { x: 2, y: 2, z: 2 },
			});

			expect(remote.queueLength).toBe(2);

			// First update processes duration action partway
			remote.update(50);
			expect(remote.queueLength).toBe(2); // Both still pending, duration action not complete

			// Second update completes duration action AND processes discrete action in same frame
			remote.update(60);
			// Once duration action completes, the loop continues and processes discrete action immediately
			expect(remote.queueLength).toBe(0);

			await Promise.all([promise1, promise2]);
		});
	});

	describe('Input Control Tools', () => {
		beforeEach(() => {
			mockActiveSession();
		});

		describe('set_input_mode', () => {
			test('should switch to controller mode', async () => {
				device.primaryInputMode = 'hand';

				const promise = remote.dispatch('set_input_mode', {
					mode: 'controller',
				});
				remote.update(16.67);
				const result = (await promise) as SetInputModeResult;

				expect(result.mode).toBe('controller');
				expect(device.primaryInputMode).toBe('controller');
			});

			test('should switch to hand mode', async () => {
				device.primaryInputMode = 'controller';

				const promise = remote.dispatch('set_input_mode', { mode: 'hand' });
				remote.update(16.67);
				const result = (await promise) as SetInputModeResult;

				expect(result.mode).toBe('hand');
				expect(device.primaryInputMode).toBe('hand');
			});

			test('should return active devices', async () => {
				device.controllers.left!.connected = true;
				device.controllers.right!.connected = true;

				const promise = remote.dispatch('set_input_mode', {
					mode: 'controller',
				});
				remote.update(16.67);
				const result = (await promise) as SetInputModeResult;

				expect(result.activeDevices).toContain('controller-left');
				expect(result.activeDevices).toContain('controller-right');
			});
		});

		describe('set_connected', () => {
			test('should disconnect controller', async () => {
				device.controllers.left!.connected = true;

				const promise = remote.dispatch('set_connected', {
					device: 'controller-left',
					connected: false,
				});
				remote.update(16.67);
				const result = (await promise) as SetConnectedResult;

				expect(result.device).toBe('controller-left');
				expect(result.connected).toBe(false);
				expect(device.controllers.left!.connected).toBe(false);
			});

			test('should connect controller', async () => {
				device.controllers.right!.connected = false;

				const promise = remote.dispatch('set_connected', {
					device: 'controller-right',
					connected: true,
				});
				remote.update(16.67);
				const result = (await promise) as SetConnectedResult;

				expect(result.connected).toBe(true);
				expect(device.controllers.right!.connected).toBe(true);
			});

			test('should disconnect hand', async () => {
				device.hands.left!.connected = true;

				const promise = remote.dispatch('set_connected', {
					device: 'hand-left',
					connected: false,
				});
				remote.update(16.67);
				const result = (await promise) as SetConnectedResult;

				expect(result.connected).toBe(false);
				expect(device.hands.left!.connected).toBe(false);
			});
		});

		describe('get_select_value', () => {
			test('should get controller trigger value', async () => {
				// Use getButtonValue to check value that was set
				device.controllers.left!.updateButtonValue('trigger', 0.5);
				// Note: This sets pendingValue, which gets applied on frame update

				// get_select_value is immediate - no update() needed
				const result = (await remote.dispatch('get_select_value', {
					device: 'controller-left',
				})) as GetSelectValueResult;

				expect(result.device).toBe('controller-left');
				// Value may be 0 or 0.5 depending on frame processing
				expect(result.value).toBeDefined();
			});

			test('should get hand pinch value', async () => {
				// Note: updatePinchValue sets pendingValue, actual value needs frame update
				device.hands.right!.updatePinchValue(0.8);

				// get_select_value is immediate
				const result = (await remote.dispatch('get_select_value', {
					device: 'hand-right',
				})) as GetSelectValueResult;

				// Value may not be updated yet due to pending value mechanism
				expect(result.value).toBeDefined();
			});
		});

		describe('set_select_value', () => {
			test('should set controller trigger value', async () => {
				const promise = remote.dispatch('set_select_value', {
					device: 'controller-right',
					value: 0.75,
				});
				remote.update(16.67);
				const result = (await promise) as SetSelectValueResult;

				expect(result.value).toBe(0.75);
				// Note: Value is set as pendingValue, not immediately applied
			});

			test('should set hand pinch value', async () => {
				const promise = remote.dispatch('set_select_value', {
					device: 'hand-left',
					value: 1.0,
				});
				remote.update(16.67);
				const result = (await promise) as SetSelectValueResult;

				expect(result.value).toBe(1.0);
				// Note: Value is set as pendingValue, actual pinchValue is updated on frame
			});
		});

		describe('select', () => {
			test('should perform select action with default duration', async () => {
				const promise = remote.dispatch('select', {
					device: 'controller-left',
				});

				// Process set_select_value to 1
				remote.update(16.67);

				// Process wait duration action
				remote.update(200); // > 150ms default

				// Process set_select_value to 0
				remote.update(16.67);

				const result = (await promise) as SelectResult;

				expect(result.device).toBe('controller-left');
				expect(result.duration).toBe(0.15);
			});

			test('should perform select with custom duration', async () => {
				const promise = remote.dispatch('select', {
					device: 'hand-right',
					duration: 0.5,
				});

				remote.update(16.67); // set to 1
				remote.update(600); // wait > 500ms
				remote.update(16.67); // set to 0

				const result = (await promise) as SelectResult;
				expect(result.duration).toBe(0.5);
			});
		});
	});

	describe('Gamepad Tools', () => {
		describe('get_gamepad_state', () => {
			test('should get left controller gamepad state', async () => {
				device.controllers.left!.updateButtonValue('trigger', 0.5);
				device.controllers.left!.updateAxes('thumbstick', 0.2, -0.3);

				// get_gamepad_state is immediate - no update() needed
				const result = (await remote.dispatch('get_gamepad_state', {
					device: 'controller-left',
				})) as GetGamepadStateResult;

				expect(result.device).toBe('controller-left');
				expect(result.connected).toBe(true);
				expect(result.buttons).toBeDefined();
				expect(result.buttons.length).toBeGreaterThan(0);
				expect(result.axes).toBeDefined();
			});

			test('should get right controller gamepad state', async () => {
				const result = (await remote.dispatch('get_gamepad_state', {
					device: 'controller-right',
				})) as GetGamepadStateResult;

				expect(result.device).toBe('controller-right');
			});
		});

		describe('set_gamepad_state', () => {
			beforeEach(() => {
				mockActiveSession();
			});

			test('should set buttons by index', async () => {
				const promise = remote.dispatch('set_gamepad_state', {
					device: 'controller-left',
					buttons: [
						{ index: 0, value: 0.8 }, // trigger
						{ index: 1, value: 0.5, touched: true }, // squeeze
					],
				});
				remote.update(16.67);
				const result = (await promise) as SetGamepadStateResult;

				// Verify dispatch succeeded and reported correct count
				expect(result.buttonsSet).toBe(2);
				// Note: Button values are set as pendingValue, not applied until next frame start.
				// We can verify the dispatch succeeded but not the immediate value.
			});

			test('should set axes by index', async () => {
				const promise = remote.dispatch('set_gamepad_state', {
					device: 'controller-right',
					axes: [
						{ index: 0, value: 0.5 }, // thumbstick-x
						{ index: 1, value: -0.7 }, // thumbstick-y
					],
				});
				remote.update(16.67);
				const result = (await promise) as SetGamepadStateResult;

				expect(result.axesSet).toBe(2);
				const axes = device.controllers.right!.getAxes('thumbstick');
				expect(axes.x).toBe(0.5);
				expect(axes.y).toBe(-0.7);
			});
		});
	});

	describe('State Tools', () => {
		describe('get_device_state', () => {
			test('should return complete device state', async () => {
				device.position.set(1, 2, 3);
				device.primaryInputMode = 'hand';
				device.stereoEnabled = true;

				// get_device_state is immediate - no update() needed
				const result = (await remote.dispatch(
					'get_device_state',
					{},
				)) as RemoteDeviceState;

				expect(result.headset.position).toEqual({ x: 1, y: 2, z: 3 });
				expect(result.inputMode).toBe('hand');
				expect(result.stereoEnabled).toBe(true);
				expect(result.controllers).toBeDefined();
				expect(result.hands).toBeDefined();
			});
		});

		describe('set_device_state', () => {
			beforeEach(() => {
				mockActiveSession();
			});

			test('should reset to initial state when called with no params', async () => {
				device.position.set(10, 20, 30);
				device.primaryInputMode = 'hand';

				const promise = remote.dispatch('set_device_state', {});
				remote.update(16.67);
				const result = (await promise) as SetDeviceStateResult;

				// Use toBeCloseTo for floating point comparison
				expect(result.state.headset.position.x).toBeCloseTo(0, 5);
				expect(result.state.headset.position.y).toBeCloseTo(1.6, 5);
				expect(result.state.headset.position.z).toBeCloseTo(0, 5);
				expect(result.state.inputMode).toBe('controller');
			});

			test('should apply partial state', async () => {
				const promise = remote.dispatch('set_device_state', {
					state: {
						headset: {
							position: { x: 5, y: 5, z: 5 },
							orientation: { x: 0, y: 0, z: 0, w: 1 },
						},
						inputMode: 'hand',
					},
				});
				remote.update(16.67);
				const result = (await promise) as SetDeviceStateResult;

				expect(result.state.headset.position).toEqual({ x: 5, y: 5, z: 5 });
				expect(result.state.inputMode).toBe('hand');
			});

			test('should set stereo enabled', async () => {
				const promise = remote.dispatch('set_device_state', {
					state: { stereoEnabled: true },
				});
				remote.update(16.67);
				const result = (await promise) as SetDeviceStateResult;

				expect(result.state.stereoEnabled).toBe(true);
			});

			test('should set FOV', async () => {
				const promise = remote.dispatch('set_device_state', {
					state: { fov: 100 },
				});
				remote.update(16.67);
				await promise;

				// FOV is stored in radians
				expect(device.fovy).toBeCloseTo((100 * Math.PI) / 180, 3);
			});

			test('should set controller positions in device state', async () => {
				const promise = remote.dispatch('set_device_state', {
					state: {
						controllers: {
							left: { position: { x: -0.5, y: 1, z: -0.3 } },
							right: { position: { x: 0.5, y: 1, z: -0.3 } },
						},
					},
				});
				remote.update(16.67);
				const result = (await promise) as SetDeviceStateResult;

				expect(result.state.controllers.left?.position.x).toBeCloseTo(-0.5, 3);
				expect(result.state.controllers.right?.position.x).toBeCloseTo(0.5, 3);
			});

			test('should set hand positions in device state', async () => {
				device.primaryInputMode = 'hand';

				const promise = remote.dispatch('set_device_state', {
					state: {
						hands: {
							left: { position: { x: -0.4, y: 0.9, z: -0.2 } },
							right: { position: { x: 0.4, y: 0.9, z: -0.2 } },
						},
					},
				});
				remote.update(16.67);
				const result = (await promise) as SetDeviceStateResult;

				expect(result.state.hands.left?.position.x).toBeCloseTo(-0.4, 3);
				expect(result.state.hands.right?.position.x).toBeCloseTo(0.4, 3);
			});

			test('should set controller connected state in device state', async () => {
				device.controllers.left!.connected = true;
				device.controllers.right!.connected = true;

				const promise = remote.dispatch('set_device_state', {
					state: {
						controllers: {
							left: { connected: false },
							right: { connected: false },
						},
					},
				});
				remote.update(16.67);
				const result = (await promise) as SetDeviceStateResult;

				expect(result.state.controllers.left?.connected).toBe(false);
				expect(result.state.controllers.right?.connected).toBe(false);
			});
		});
	});

	describe('dispatch error handling', () => {
		test('should reject unknown method', async () => {
			const promise = remote.dispatch('unknown_method', {});
			remote.update(16.67);

			await expect(promise).rejects.toThrow('Unknown method');
		});
	});

	describe('acceptSession async method', () => {
		test('should throw when no session offered', async () => {
			await expect(remote.acceptSession()).rejects.toThrow(
				'No session has been offered',
			);
		});
	});

	describe('Bug fixes', () => {
		describe('get_gamepad_state right controller button names (fix #1)', () => {
			test('should use a-button/b-button for right controller lookup', async () => {
				// Set a-button value on right controller
				device.controllers.right!.updateButtonValue('a-button', 1);

				const result = (await remote.dispatch('get_gamepad_state', {
					device: 'controller-right',
				})) as GetGamepadStateResult;

				// Button at index 3 should be 'a' for right controller with value 1
				const aButton = result.buttons.find((b) => b.index === 3);
				expect(aButton).toBeDefined();
				expect(aButton!.name).toBe('a');
				expect(aButton!.value).toBe(1);
				expect(aButton!.pressed).toBe(true);
			});

			test('should use x-button/y-button for left controller lookup', async () => {
				device.controllers.left!.updateButtonValue('x-button', 1);

				const result = (await remote.dispatch('get_gamepad_state', {
					device: 'controller-left',
				})) as GetGamepadStateResult;

				const xButton = result.buttons.find((b) => b.index === 3);
				expect(xButton).toBeDefined();
				expect(xButton!.name).toBe('x');
				expect(xButton!.value).toBe(1);
			});

			test('should round-trip set_gamepad_state index 3 on right controller', async () => {
				mockActiveSession();

				// Set button at index 3 (a-button) on right controller
				const setPromise = remote.dispatch('set_gamepad_state', {
					device: 'controller-right',
					buttons: [{ index: 3, value: 1 }],
				});
				remote.update(16.67);
				await setPromise;

				// Read back via get_gamepad_state
				const result = (await remote.dispatch('get_gamepad_state', {
					device: 'controller-right',
				})) as GetGamepadStateResult;

				const aButton = result.buttons.find((b) => b.index === 3);
				expect(aButton!.value).toBe(1);
			});
		});

		describe('set_gamepad_state uses updateButtonValue (fix #2)', () => {
			beforeEach(() => {
				mockActiveSession();
			});

			test('should set trigger value readable via get_gamepad_state', async () => {
				const setPromise = remote.dispatch('set_gamepad_state', {
					device: 'controller-left',
					buttons: [{ index: 0, value: 0.9 }],
				});
				remote.update(16.67);
				await setPromise;

				const result = (await remote.dispatch('get_gamepad_state', {
					device: 'controller-left',
				})) as GetGamepadStateResult;

				expect(result.buttons[0].value).toBe(0.9);
			});
		});

		describe('getDeviceTransform null guards (fix #3)', () => {
			test('should throw descriptive error for missing controller', async () => {
				// Create a device without controllers by nulling them
				Object.defineProperty(device.controllers, 'left', {
					get: () => null,
					configurable: true,
				});

				await expect(
					remote.dispatch('get_transform', { device: 'controller-left' }),
				).rejects.toThrow('Left controller not available');
			});

			test('should throw descriptive error for missing right controller', async () => {
				Object.defineProperty(device.controllers, 'right', {
					get: () => null,
					configurable: true,
				});

				await expect(
					remote.dispatch('get_transform', { device: 'controller-right' }),
				).rejects.toThrow('Right controller not available');
			});

			test('should throw descriptive error for missing hand', async () => {
				Object.defineProperty(device.hands, 'left', {
					get: () => null,
					configurable: true,
				});

				await expect(
					remote.dispatch('get_transform', { device: 'hand-left' }),
				).rejects.toThrow('Left hand not available');
			});

			test('should throw descriptive error for missing right hand', async () => {
				Object.defineProperty(device.hands, 'right', {
					get: () => null,
					configurable: true,
				});

				await expect(
					remote.dispatch('get_transform', { device: 'hand-right' }),
				).rejects.toThrow('Right hand not available');
			});
		});

		describe('release timer race condition (fix #4)', () => {
			beforeEach(() => {
				jest.useFakeTimers();
				mockActiveSession();
			});

			test('should cancel release timer when queue has items after accept_session', async () => {
				// Simulate accept_session which starts a release timer via activateCaptureMode
				Object.defineProperty(device, 'sessionOffered', {
					get: () => true,
					configurable: true,
				});
				await remote.dispatch('accept_session', {});
				expect(remote.isCaptured).toBe(true);

				// Enqueue an animate_to action
				const promise = remote.dispatch('animate_to', {
					device: 'headset',
					position: { x: 0, y: 1.6, z: -1 },
					duration: 0.1,
				});

				// Advance timer past the release timeout
				jest.advanceTimersByTime(remote.RELEASE_TIMEOUT_MS + 1000);

				// Process the queue - this should have cancelled the timer
				remote.update(150);
				await promise;

				// Should still be captured because queue was active
				expect(remote.isCaptured).toBe(true);
			});
		});

		describe('forceRelease resets select values (fix #5)', () => {
			beforeEach(() => {
				mockActiveSession();
			});

			test('should reset trigger to 0 on forceRelease during select', async () => {
				// Start select action
				const selectPromise = remote.dispatch('select', {
					device: 'controller-left',
				});

				// Process the _select_press action (sets trigger to 1)
				remote.update(16.67);

				// Verify trigger is at 1 (pending)
				expect(device.controllers.left!.getButtonValue('trigger')).toBe(1);

				// Force release mid-select
				remote.forceRelease();

				// Trigger should be reset to 0
				expect(device.controllers.left!.getButtonValue('trigger')).toBe(0);

				// The select promise should be rejected
				await expect(selectPromise).rejects.toThrow('Capture released');
			});
		});

		describe('set_transform with position AND orientation (fix #8)', () => {
			beforeEach(() => {
				mockActiveSession();
			});

			test('should set both position and orientation simultaneously', async () => {
				const promise = remote.dispatch('set_transform', {
					device: 'headset',
					position: { x: 1, y: 2, z: 3 },
					orientation: { x: 0, y: 0.707, z: 0, w: 0.707 },
				});
				remote.update(16.67);
				const result = (await promise) as SetTransformResult;

				expect(result.position).toEqual({ x: 1, y: 2, z: 3 });
				expect(result.orientation.y).toBeCloseTo(0.707, 2);
				expect(result.orientation.w).toBeCloseTo(0.707, 2);
			});
		});

		describe('select action trigger values (fix #8)', () => {
			beforeEach(() => {
				mockActiveSession();
			});

			test('should set trigger to 1 after press and back to 0 after release', async () => {
				const promise = remote.dispatch('select', {
					device: 'controller-right',
				});

				// Process _select_press
				remote.update(16.67);
				expect(device.controllers.right!.getButtonValue('trigger')).toBe(1);

				// Process _select_wait (complete the duration)
				remote.update(200);

				// Process _select_release
				remote.update(16.67);
				expect(device.controllers.right!.getButtonValue('trigger')).toBe(0);

				const result = (await promise) as SelectResult;
				expect(result.device).toBe('controller-right');
			});
		});

		describe('get_select_value with actual assertions (fix #8)', () => {
			test('should return 0 for controller with no trigger input', async () => {
				const result = (await remote.dispatch('get_select_value', {
					device: 'controller-left',
				})) as GetSelectValueResult;

				expect(result.value).toBe(0);
			});

			test('should return pending trigger value after updateButtonValue', async () => {
				device.controllers.right!.updateButtonValue('trigger', 0.75);

				const result = (await remote.dispatch('get_select_value', {
					device: 'controller-right',
				})) as GetSelectValueResult;

				expect(result.value).toBe(0.75);
			});
		});
	});
});
