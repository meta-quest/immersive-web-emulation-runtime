/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { vec3 } from 'gl-matrix';

import type { XRDevice } from '../device/XRDevice.js';
import type { Vec3, Quat } from '../types/state.js';
import { P_SESSION, P_SPACE } from '../private.js';
import type {
	DeviceId,
	InputDeviceId,
	Action,
	DiscreteAction,
	DurationAction,
	GetTransformParams,
	GetTransformResult,
	SetTransformParams,
	SetTransformResult,
	LookAtParams,
	LookAtResult,
	AnimateToParams,
	AnimateToResult,
	SetInputModeParams,
	SetInputModeResult,
	SetConnectedParams,
	SetConnectedResult,
	GetSelectValueParams,
	GetSelectValueResult,
	SetSelectValueParams,
	SetSelectValueResult,
	SelectParams,
	SelectResult,
	GetGamepadStateParams,
	GetGamepadStateResult,
	SetGamepadStateParams,
	SetGamepadStateResult,
	CaptureCanvasParams,
	CaptureCanvasResult,
	RemoteSessionStatus,
	AcceptSessionResult,
	EndSessionResult,
	RemoteDeviceState,
	SetDeviceStateParams,
	SetDeviceStateResult,
	OrientationInput,
} from './types.js';
import {
	vec3ToObj,
	quatToObj,
	quatToEuler,
	eulerToQuat,
	directionTo,
	lookRotation,
	lookRotationGimbal,
	waitForCondition,
} from '../utils/control-math.js';

/**
 * Check if an orientation input is euler angles (has any of pitch, yaw, or roll)
 */
function isEulerRotation(
	orientation: OrientationInput,
): orientation is { pitch?: number; yaw?: number; roll?: number } {
	return 'pitch' in orientation || 'yaw' in orientation || 'roll' in orientation;
}

/**
 * Normalize an orientation input to a quaternion
 */
function normalizeOrientation(orientation: OrientationInput): Quat {
	if (isEulerRotation(orientation)) {
		return eulerToQuat(orientation);
	}
	return orientation;
}

/**
 * Linear interpolation for numbers
 */
function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

/**
 * Linear interpolation for Vec3
 */
function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
	return {
		x: lerp(a.x, b.x, t),
		y: lerp(a.y, b.y, t),
		z: lerp(a.z, b.z, t),
	};
}

/**
 * Spherical linear interpolation for quaternions
 */
function slerpQuat(a: Quat, b: Quat, t: number): Quat {
	// Compute dot product
	let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;

	// If dot is negative, negate one quaternion to take shorter path
	let bx = b.x,
		by = b.y,
		bz = b.z,
		bw = b.w;
	if (dot < 0) {
		dot = -dot;
		bx = -bx;
		by = -by;
		bz = -bz;
		bw = -bw;
	}

	// If quaternions are very close, use linear interpolation
	if (dot > 0.9995) {
		const result = {
			x: lerp(a.x, bx, t),
			y: lerp(a.y, by, t),
			z: lerp(a.z, bz, t),
			w: lerp(a.w, bw, t),
		};
		// Normalize
		const len = Math.sqrt(
			result.x * result.x +
				result.y * result.y +
				result.z * result.z +
				result.w * result.w,
		);
		return {
			x: result.x / len,
			y: result.y / len,
			z: result.z / len,
			w: result.w / len,
		};
	}

	// Standard slerp
	const theta0 = Math.acos(dot);
	const theta = theta0 * t;
	const sinTheta = Math.sin(theta);
	const sinTheta0 = Math.sin(theta0);

	const s0 = Math.cos(theta) - (dot * sinTheta) / sinTheta0;
	const s1 = sinTheta / sinTheta0;

	return {
		x: s0 * a.x + s1 * bx,
		y: s0 * a.y + s1 * by,
		z: s0 * a.z + s1 * bz,
		w: s0 * a.w + s1 * bw,
	};
}

/**
 * RemoteControlInterface provides frame-synchronized programmatic control of an XRDevice.
 *
 * This class implements a command queue that processes actions during each frame update,
 * enabling smooth animations and coordinated control with DevUI.
 *
 * Key features:
 * - Frame-synchronized execution: Commands are queued and processed during frame update
 * - Duration-based actions: Smooth animations via lerp over multiple frames
 * - Automatic capture/release: Captures device on first command, releases 30s after queue empties
 * - Unified device identifiers: 'headset', 'controller-left', 'hand-right', etc.
 *
 * Usage:
 * ```typescript
 * import { XRDevice, metaQuest3 } from 'iwer';
 *
 * const device = new XRDevice(metaQuest3);
 * device.installRuntime();
 *
 * // Get transform
 * const result = await device.remote.dispatch('get_transform', { device: 'headset' });
 *
 * // Animate headset to new position over 1 second
 * await device.remote.dispatch('animate_to', {
 *   device: 'headset',
 *   position: { x: 0, y: 1.6, z: -1 },
 *   duration: 1.0
 * });
 * ```
 */
export class RemoteControlInterface {
	private device: XRDevice;
	private commandQueue: Action[] = [];
	private _isCaptured: boolean = false;
	private releaseTimer: ReturnType<typeof setTimeout> | null = null;
	private actionIdCounter: number = 0;

	/** Release timeout in milliseconds (default: 30000 = 30 seconds) */
	readonly RELEASE_TIMEOUT_MS = 30000;

	constructor(device: XRDevice) {
		this.device = device;
	}

	private generateActionId(): string {
		return `action_${++this.actionIdCounter}`;
	}

	// =============================================================================
	// Public Properties
	// =============================================================================

	/**
	 * Whether the device is currently captured for programmatic control.
	 * When true, DevUI should go into passive mode (sync FROM device only).
	 */
	get isCaptured(): boolean {
		return this._isCaptured;
	}

	/**
	 * Number of pending actions in the queue
	 */
	get queueLength(): number {
		return this.commandQueue.length;
	}

	// =============================================================================
	// Queue Management
	// =============================================================================

	/**
	 * Enqueue a discrete action for processing
	 */
	private enqueueDiscrete(
		method: string,
		params: Record<string, unknown>,
	): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const action: DiscreteAction = {
				type: 'discrete',
				id: this.generateActionId(),
				method,
				params,
				resolve,
				reject,
			};
			this.commandQueue.push(action);
		});
	}

	/**
	 * Enqueue a duration action for processing
	 */
	private enqueueDuration(
		method: string,
		params: Record<string, unknown>,
		durationMs: number,
		startState: { position?: Vec3; orientation?: Quat },
		targetState: { position?: Vec3; orientation?: Quat },
	): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const action: DurationAction = {
				type: 'duration',
				id: this.generateActionId(),
				method,
				params,
				durationMs,
				elapsedMs: 0,
				startState,
				targetState,
				resolve,
				reject,
			};
			this.commandQueue.push(action);
		});
	}

	/**
	 * Update method called each frame by XRDevice.
	 * Processes the command queue and handles duration-based animations.
	 *
	 * @param deltaTimeMs - Time since last frame in milliseconds
	 */
	update(deltaTimeMs: number): void {
		if (this.commandQueue.length === 0) {
			return;
		}

		// Always cancel pending release while queue is active
		this.cancelReleaseTimer();

		// Activate capture mode
		if (!this._isCaptured) {
			this._isCaptured = true;
			this.device.controlMode = 'programmatic';
		}

		while (this.commandQueue.length > 0) {
			const action = this.commandQueue[0];

			if (action.type === 'discrete') {
				// Execute discrete action immediately
				try {
					const result = this.executeDiscreteAction(action);
					action.resolve(result);
				} catch (error) {
					action.reject(error as Error);
				}
				this.commandQueue.shift();
				// Continue to next action
			} else {
				// Duration action - lerp by delta time
				action.elapsedMs += deltaTimeMs;

				if (action.elapsedMs >= action.durationMs) {
					// Complete - apply final state
					this.applyDurationFinalState(action);
					action.resolve(this.getDurationResult(action));
					this.commandQueue.shift();
					// Continue to next action
				} else {
					// In progress - lerp
					const t = action.elapsedMs / action.durationMs;
					this.applyDurationLerpState(action, t);
					// Stop processing - wait for next frame
					break;
				}
			}
		}

		// Notify state change
		this.device.notifyStateChange();

		// Start release timer if queue is empty
		if (this.commandQueue.length === 0) {
			this.startReleaseTimer();
		}
	}

	private startReleaseTimer(): void {
		this.cancelReleaseTimer();
		this.releaseTimer = setTimeout(() => {
			this._isCaptured = false;
			this.device.controlMode = 'manual';
			this.releaseTimer = null;
		}, this.RELEASE_TIMEOUT_MS);
	}

	private cancelReleaseTimer(): void {
		if (this.releaseTimer !== null) {
			clearTimeout(this.releaseTimer);
			this.releaseTimer = null;
		}
	}

	// =============================================================================
	// Device Resolution
	// =============================================================================

	/**
	 * Get the transform (position, quaternion) for a device
	 */
	private getDeviceTransform(deviceId: DeviceId): {
		position: Vec3;
		orientation: Quat;
	} {
		switch (deviceId) {
			case 'headset':
				return {
					position: vec3ToObj(this.device.position),
					orientation: quatToObj(this.device.quaternion),
				};
			case 'controller-left': {
				const controller = this.device.controllers.left;
				if (!controller) throw new Error('Left controller not available');
				return {
					position: vec3ToObj(controller.position),
					orientation: quatToObj(controller.quaternion),
				};
			}
			case 'controller-right': {
				const controller = this.device.controllers.right;
				if (!controller) throw new Error('Right controller not available');
				return {
					position: vec3ToObj(controller.position),
					orientation: quatToObj(controller.quaternion),
				};
			}
			case 'hand-left': {
				const hand = this.device.hands.left;
				if (!hand) throw new Error('Left hand not available');
				return {
					position: vec3ToObj(hand.position),
					orientation: quatToObj(hand.quaternion),
				};
			}
			case 'hand-right': {
				const hand = this.device.hands.right;
				if (!hand) throw new Error('Right hand not available');
				return {
					position: vec3ToObj(hand.position),
					orientation: quatToObj(hand.quaternion),
				};
			}
			default:
				throw new Error(`Unknown device: ${deviceId}`);
		}
	}

	/**
	 * Set the transform for a device
	 */
	private setDeviceTransform(
		deviceId: DeviceId,
		position?: Vec3,
		orientation?: Quat,
	): void {
		switch (deviceId) {
			case 'headset':
				if (position) {
					this.device.position.set(position.x, position.y, position.z);
				}
				if (orientation) {
					this.device.quaternion.set(
						orientation.x,
						orientation.y,
						orientation.z,
						orientation.w,
					);
				}
				break;
			case 'controller-left': {
				const controller = this.device.controllers.left;
				if (!controller) throw new Error('Left controller not available');
				if (position) {
					controller.position.set(position.x, position.y, position.z);
				}
				if (orientation) {
					controller.quaternion.set(
						orientation.x,
						orientation.y,
						orientation.z,
						orientation.w,
					);
				}
				break;
			}
			case 'controller-right': {
				const controller = this.device.controllers.right;
				if (!controller) throw new Error('Right controller not available');
				if (position) {
					controller.position.set(position.x, position.y, position.z);
				}
				if (orientation) {
					controller.quaternion.set(
						orientation.x,
						orientation.y,
						orientation.z,
						orientation.w,
					);
				}
				break;
			}
			case 'hand-left': {
				const hand = this.device.hands.left;
				if (!hand) throw new Error('Left hand not available');
				if (position) {
					hand.position.set(position.x, position.y, position.z);
				}
				if (orientation) {
					hand.quaternion.set(
						orientation.x,
						orientation.y,
						orientation.z,
						orientation.w,
					);
				}
				break;
			}
			case 'hand-right': {
				const hand = this.device.hands.right;
				if (!hand) throw new Error('Right hand not available');
				if (position) {
					hand.position.set(position.x, position.y, position.z);
				}
				if (orientation) {
					hand.quaternion.set(
						orientation.x,
						orientation.y,
						orientation.z,
						orientation.w,
					);
				}
				break;
			}
			default:
				throw new Error(`Unknown device: ${deviceId}`);
		}
	}

	/**
	 * Transform a position from XR-origin-relative coordinates to GlobalSpace.
	 * The XR origin is defined by the first reference space requested by the app.
	 * This is necessary because device positions are in GlobalSpace, but positions
	 * from get_object_transform are relative to the XR origin.
	 */
	private transformXROriginToGlobal(position: Vec3): Vec3 {
		const session = this.device.activeSession;
		if (!session) {
			return position;
		}

		const refSpaces = (session as any)[P_SESSION]?.referenceSpaces;
		if (!refSpaces || refSpaces.length === 0) {
			return position;
		}

		// Use the first reference space (primary one requested by app)
		const primaryRefSpace = refSpaces[0];
		const offsetMatrix = primaryRefSpace[P_SPACE]?.offsetMatrix;

		if (!offsetMatrix) {
			return position;
		}

		// Transform position from XR-origin space to GlobalSpace
		const posVec = vec3.fromValues(position.x, position.y, position.z);
		vec3.transformMat4(posVec, posVec, offsetMatrix);

		return {
			x: posVec[0],
			y: posVec[1],
			z: posVec[2],
		};
	}

	/**
	 * Get the select value for an input device (trigger for controller, pinch for hand)
	 */
	private getDeviceSelectValue(deviceId: InputDeviceId): number {
		switch (deviceId) {
			case 'controller-left':
				return this.device.controllers.left?.getButtonValue('trigger') ?? 0;
			case 'controller-right':
				return this.device.controllers.right?.getButtonValue('trigger') ?? 0;
			case 'hand-left':
				return this.device.hands.left?.pinchValue ?? 0;
			case 'hand-right':
				return this.device.hands.right?.pinchValue ?? 0;
			default:
				throw new Error(`Unknown input device: ${deviceId}`);
		}
	}

	/**
	 * Set the select value for an input device
	 */
	private setDeviceSelectValue(deviceId: InputDeviceId, value: number): void {
		switch (deviceId) {
			case 'controller-left':
				this.device.controllers.left?.updateButtonValue('trigger', value);
				break;
			case 'controller-right':
				this.device.controllers.right?.updateButtonValue('trigger', value);
				break;
			case 'hand-left':
				this.device.hands.left?.updatePinchValue(value);
				break;
			case 'hand-right':
				this.device.hands.right?.updatePinchValue(value);
				break;
			default:
				throw new Error(`Unknown input device: ${deviceId}`);
		}
	}

	/**
	 * Set connected state for an input device
	 */
	private setDeviceConnected(deviceId: InputDeviceId, connected: boolean): void {
		switch (deviceId) {
			case 'controller-left':
				if (this.device.controllers.left) {
					this.device.controllers.left.connected = connected;
				}
				break;
			case 'controller-right':
				if (this.device.controllers.right) {
					this.device.controllers.right.connected = connected;
				}
				break;
			case 'hand-left':
				if (this.device.hands.left) {
					this.device.hands.left.connected = connected;
				}
				break;
			case 'hand-right':
				if (this.device.hands.right) {
					this.device.hands.right.connected = connected;
				}
				break;
			default:
				throw new Error(`Unknown input device: ${deviceId}`);
		}
	}

	// =============================================================================
	// Discrete Action Execution
	// =============================================================================

	private executeDiscreteAction(action: DiscreteAction): unknown {
		const { method, params } = action;

		switch (method) {
			// Session tools
			case 'get_session_status':
				return this.executeGetSessionStatus();
			case 'accept_session':
				return this.executeAcceptSession();
			case 'end_session':
				return this.executeEndSession();

			// Transform tools
			case 'get_transform':
				return this.executeGetTransform(params as unknown as GetTransformParams);
			case 'set_transform':
				return this.executeSetTransform(params as unknown as SetTransformParams);
			case 'look_at':
				return this.executeLookAt(params as unknown as LookAtParams);

			// Input tools
			case 'set_input_mode':
				return this.executeSetInputMode(params as unknown as SetInputModeParams);
			case 'set_connected':
				return this.executeSetConnected(params as unknown as SetConnectedParams);
			case 'get_select_value':
				return this.executeGetSelectValue(params as unknown as GetSelectValueParams);
			case 'set_select_value':
				return this.executeSetSelectValue(params as unknown as SetSelectValueParams);

			// Gamepad tools
			case 'get_gamepad_state':
				return this.executeGetGamepadState(params as unknown as GetGamepadStateParams);
			case 'set_gamepad_state':
				return this.executeSetGamepadState(params as unknown as SetGamepadStateParams);

			// State tools
			case 'get_device_state':
				return this.executeGetDeviceState();
			case 'set_device_state':
				return this.executeSetDeviceState(params as unknown as SetDeviceStateParams);
			case 'capture_canvas':
				return this.executeCaptureCanvas(params as unknown as CaptureCanvasParams);

			// Internal select sequence actions
			case '_select_press': {
				const deviceId = (params as unknown as { device: InputDeviceId }).device;
				this.setDeviceSelectValue(deviceId, 1);
				return undefined;
			}
			case '_select_release': {
				const deviceId = (params as unknown as { device: InputDeviceId }).device;
				this.setDeviceSelectValue(deviceId, 0);
				return undefined;
			}

			default:
				throw new Error(`Unknown method: ${method}`);
		}
	}

	// =============================================================================
	// Session Tool Implementations
	// =============================================================================

	private executeGetSessionStatus(): RemoteSessionStatus {
		const session = this.device.activeSession;
		return {
			deviceName: this.device.name,
			isRuntimeInstalled: true,
			sessionActive: !!session,
			sessionOffered: this.device.sessionOffered,
			sessionMode: session ? ((session as any).mode as any) : null,
			enabledFeatures: session
				? Array.from((session as any).enabledFeatures || [])
				: [],
			visibilityState: this.device.visibilityState,
		};
	}

	private executeAcceptSession(): AcceptSessionResult {
		if (!this.device.sessionOffered) {
			throw new Error('No session has been offered');
		}
		this.device.grantOfferedSession();
		// Session activation is async - caller should use get_session_status to poll
		return { success: true };
	}

	private executeEndSession(): EndSessionResult {
		const session = this.device.activeSession;
		if (!session) {
			throw new Error('No active session');
		}
		session.end();
		return { success: true };
	}

	// =============================================================================
	// Transform Tool Implementations
	// =============================================================================

	private executeGetTransform(params: GetTransformParams): GetTransformResult {
		const { device: deviceId } = params;
		const transform = this.getDeviceTransform(deviceId);
		return {
			device: deviceId,
			position: transform.position,
			orientation: transform.orientation,
			euler: quatToEuler(transform.orientation),
		};
	}

	private executeSetTransform(params: SetTransformParams): SetTransformResult {
		const { device: deviceId, position, orientation } = params;

		const targetOrientation = orientation
			? normalizeOrientation(orientation)
			: undefined;

		this.setDeviceTransform(deviceId, position, targetOrientation);

		const newTransform = this.getDeviceTransform(deviceId);
		return {
			device: deviceId,
			position: newTransform.position,
			orientation: newTransform.orientation,
		};
	}

	private executeLookAt(params: LookAtParams): LookAtResult {
		const { device: deviceId, target, moveToDistance } = params;
		const currentTransform = this.getDeviceTransform(deviceId);

		// Transform target from XR-origin-relative to GlobalSpace
		const targetInGlobal = this.transformXROriginToGlobal(target);

		// Calculate direction to target
		const direction = directionTo(currentTransform.position, targetInGlobal);

		// Calculate look rotation
		// Use gimbal rotation for headset (keeps it level, no roll)
		// Use standard lookRotation for controllers/hands (can tilt freely)
		const lookQuat =
			deviceId === 'headset'
				? lookRotationGimbal(direction)
				: lookRotation(direction);

		// Optionally move to a specific distance from target
		let newPosition: Vec3 | undefined;
		if (moveToDistance !== undefined) {
			newPosition = {
				x: targetInGlobal.x - direction.x * moveToDistance,
				y: targetInGlobal.y - direction.y * moveToDistance,
				z: targetInGlobal.z - direction.z * moveToDistance,
			};
		}

		this.setDeviceTransform(deviceId, newPosition, lookQuat);

		const newTransform = this.getDeviceTransform(deviceId);
		return {
			device: deviceId,
			position: newTransform.position,
			orientation: newTransform.orientation,
		};
	}

	// =============================================================================
	// Input Tool Implementations
	// =============================================================================

	private executeSetInputMode(params: SetInputModeParams): SetInputModeResult {
		const { mode } = params;
		this.device.primaryInputMode = mode;

		const activeDevices: DeviceId[] = [];
		if (mode === 'controller') {
			if (this.device.controllers.left?.connected) {
				activeDevices.push('controller-left');
			}
			if (this.device.controllers.right?.connected) {
				activeDevices.push('controller-right');
			}
		} else {
			if (this.device.hands.left?.connected) {
				activeDevices.push('hand-left');
			}
			if (this.device.hands.right?.connected) {
				activeDevices.push('hand-right');
			}
		}

		return { mode, activeDevices };
	}

	private executeSetConnected(params: SetConnectedParams): SetConnectedResult {
		const { device: deviceId, connected } = params;
		this.setDeviceConnected(deviceId, connected);
		return { device: deviceId, connected };
	}

	private executeGetSelectValue(
		params: GetSelectValueParams,
	): GetSelectValueResult {
		const { device: deviceId } = params;
		const value = this.getDeviceSelectValue(deviceId);
		return { device: deviceId, value };
	}

	private executeSetSelectValue(
		params: SetSelectValueParams,
	): SetSelectValueResult {
		const { device: deviceId, value } = params;
		this.setDeviceSelectValue(deviceId, value);
		return { device: deviceId, value };
	}

	// =============================================================================
	// Gamepad Tool Implementations
	// =============================================================================

	private executeGetGamepadState(
		params: GetGamepadStateParams,
	): GetGamepadStateResult {
		const { device: deviceId } = params;
		const hand = deviceId === 'controller-left' ? 'left' : 'right';
		const controller = this.device.controllers[hand];

		if (!controller) {
			throw new Error(`Controller ${hand} not available`);
		}

		// Button layout for Meta Quest Touch Plus controllers
		// Use hand-conditional internal names for lookup
		const buttonInternalNames = [
			'trigger',
			'squeeze',
			'thumbstick',
			hand === 'left' ? 'x-button' : 'a-button',
			hand === 'left' ? 'y-button' : 'b-button',
			'thumbrest',
		];

		const buttons = buttonInternalNames.map((name, index) => ({
			index,
			name: name
				.replace('x-button', 'x')
				.replace('y-button', 'y')
				.replace('a-button', 'a')
				.replace('b-button', 'b'),
			value: controller.getButtonValue(name),
			touched: controller.getButtonTouched(name),
			pressed: controller.getButtonValue(name) > 0.5,
		}));

		const axesData = controller.getAxes();
		const axes = [
			{ index: 0, name: 'thumbstick-x', value: axesData.x },
			{ index: 1, name: 'thumbstick-y', value: axesData.y },
		];

		return {
			device: deviceId,
			connected: controller.connected,
			buttons,
			axes,
		};
	}

	private executeSetGamepadState(
		params: SetGamepadStateParams,
	): SetGamepadStateResult {
		const { device: deviceId, buttons, axes } = params;
		const hand = deviceId === 'controller-left' ? 'left' : 'right';
		const controller = this.device.controllers[hand];

		if (!controller) {
			throw new Error(`Controller ${hand} not available`);
		}

		let buttonsSet = 0;
		let axesSet = 0;

		// Button index to name mapping
		const buttonIndexToName = [
			'trigger',
			'squeeze',
			'thumbstick',
			hand === 'left' ? 'x-button' : 'a-button',
			hand === 'left' ? 'y-button' : 'b-button',
			'thumbrest',
		];

		if (buttons) {
			for (const btn of buttons) {
				const buttonName = buttonIndexToName[btn.index];
				if (buttonName) {
					// Use updateButtonValue for proper event triggering
					controller.updateButtonValue(buttonName, btn.value);
					if (btn.touched !== undefined) {
						controller.updateButtonTouch(buttonName, btn.touched);
					}
					buttonsSet++;
				}
			}
		}

		if (axes) {
			let xValue: number | undefined;
			let yValue: number | undefined;
			for (const axis of axes) {
				if (axis.index === 0) {
					xValue = axis.value;
					axesSet++;
				} else if (axis.index === 1) {
					yValue = axis.value;
					axesSet++;
				}
			}
			if (xValue !== undefined || yValue !== undefined) {
				const currentAxes = controller.getAxes();
				controller.updateAxes(
					'thumbstick',
					xValue ?? currentAxes.x,
					yValue ?? currentAxes.y,
				);
			}
		}

		return { device: deviceId, buttonsSet, axesSet };
	}

	// =============================================================================
	// State Tool Implementations
	// =============================================================================

	private executeGetDeviceState(): RemoteDeviceState {
		return {
			headset: {
				position: vec3ToObj(this.device.position),
				orientation: quatToObj(this.device.quaternion),
			},
			inputMode: this.device.primaryInputMode,
			controllers: {
				left: {
					connected: this.device.controllers.left?.connected ?? false,
					position: vec3ToObj(
						this.device.controllers.left?.position ?? { x: 0, y: 0, z: 0 },
					),
					orientation: quatToObj(
						this.device.controllers.left?.quaternion ?? {
							x: 0,
							y: 0,
							z: 0,
							w: 1,
						},
					),
				},
				right: {
					connected: this.device.controllers.right?.connected ?? false,
					position: vec3ToObj(
						this.device.controllers.right?.position ?? { x: 0, y: 0, z: 0 },
					),
					orientation: quatToObj(
						this.device.controllers.right?.quaternion ?? {
							x: 0,
							y: 0,
							z: 0,
							w: 1,
						},
					),
				},
			},
			hands: {
				left: {
					connected: this.device.hands.left?.connected ?? false,
					position: vec3ToObj(
						this.device.hands.left?.position ?? { x: 0, y: 0, z: 0 },
					),
					orientation: quatToObj(
						this.device.hands.left?.quaternion ?? { x: 0, y: 0, z: 0, w: 1 },
					),
				},
				right: {
					connected: this.device.hands.right?.connected ?? false,
					position: vec3ToObj(
						this.device.hands.right?.position ?? { x: 0, y: 0, z: 0 },
					),
					orientation: quatToObj(
						this.device.hands.right?.quaternion ?? { x: 0, y: 0, z: 0, w: 1 },
					),
				},
			},
			stereoEnabled: this.device.stereoEnabled,
			fov: this.device.fovy * (180 / Math.PI), // Convert to degrees
		};
	}

	private executeSetDeviceState(
		params: SetDeviceStateParams,
	): SetDeviceStateResult {
		const { state } = params;

		if (!state) {
			// Reset to initial state
			this.device.position.set(0, 1.6, 0);
			this.device.quaternion.set(0, 0, 0, 1);
			this.device.primaryInputMode = 'controller';
			this.device.stereoEnabled = false;
			// Reset controllers and hands to default positions
			if (this.device.controllers.left) {
				this.device.controllers.left.position.set(-0.2, 1.4, -0.3);
				this.device.controllers.left.quaternion.set(0, 0, 0, 1);
				this.device.controllers.left.connected = true;
			}
			if (this.device.controllers.right) {
				this.device.controllers.right.position.set(0.2, 1.4, -0.3);
				this.device.controllers.right.quaternion.set(0, 0, 0, 1);
				this.device.controllers.right.connected = true;
			}
			if (this.device.hands.left) {
				this.device.hands.left.position.set(-0.15, 1.3, -0.4);
				this.device.hands.left.quaternion.set(0, 0, 0, 1);
				this.device.hands.left.connected = true;
			}
			if (this.device.hands.right) {
				this.device.hands.right.position.set(0.15, 1.3, -0.4);
				this.device.hands.right.quaternion.set(0, 0, 0, 1);
				this.device.hands.right.connected = true;
			}
		} else {
			// Apply partial state
			if (state.headset) {
				if (state.headset.position) {
					this.device.position.set(
						state.headset.position.x,
						state.headset.position.y,
						state.headset.position.z,
					);
				}
				if (state.headset.orientation) {
					this.device.quaternion.set(
						state.headset.orientation.x,
						state.headset.orientation.y,
						state.headset.orientation.z,
						state.headset.orientation.w,
					);
				}
			}
			if (state.inputMode !== undefined) {
				this.device.primaryInputMode = state.inputMode;
			}
			if (state.stereoEnabled !== undefined) {
				this.device.stereoEnabled = state.stereoEnabled;
			}
			if (state.fov !== undefined) {
				this.device.fovy = state.fov * (Math.PI / 180); // Convert to radians
			}
			if (state.controllers) {
				this.applyInputState('controller-left', state.controllers.left);
				this.applyInputState('controller-right', state.controllers.right);
			}
			if (state.hands) {
				this.applyInputState('hand-left', state.hands.left);
				this.applyInputState('hand-right', state.hands.right);
			}
		}

		return { state: this.executeGetDeviceState() };
	}

	private applyInputState(
		deviceId: DeviceId,
		state?: { connected?: boolean; position?: Vec3; orientation?: Quat },
	): void {
		if (!state) return;

		if (state.connected !== undefined) {
			this.setDeviceConnected(deviceId as InputDeviceId, state.connected);
		}
		if (state.position || state.orientation) {
			this.setDeviceTransform(deviceId, state.position, state.orientation);
		}
	}

	private executeCaptureCanvas(
		params: CaptureCanvasParams,
	): CaptureCanvasResult {
		const { maxWidth = 800, format = 'png', quality = 0.92 } = params;

		// Get the app canvas - try device first, then fallback to DOM query
		let canvas: HTMLCanvasElement | null | undefined = this.device.appCanvas;

		if (!canvas) {
			// No active session - try to find the canvas in the DOM
			// Before XR session, only the app's canvas is in the DOM
			// (IWER's canvases are not added until session starts)
			const canvases = document.querySelectorAll('canvas');
			if (canvases.length === 1) {
				canvas = canvases[0];
			} else if (canvases.length > 1) {
				// Multiple canvases - try to find the most likely app canvas
				// Prefer the largest visible canvas
				let bestCanvas: HTMLCanvasElement | null = null;
				let bestArea = 0;
				canvases.forEach((c) => {
					const rect = c.getBoundingClientRect();
					const area = rect.width * rect.height;
					if (area > bestArea && rect.width > 0 && rect.height > 0) {
						bestArea = area;
						bestCanvas = c;
					}
				});
				canvas = bestCanvas;
			}
		}

		if (!canvas) {
			throw new Error(
				'No canvas available. Either start an XR session or ensure an app canvas is in the DOM.',
			);
		}

		// Create a temporary canvas for scaling
		const tempCanvas = document.createElement('canvas');
		const ctx = tempCanvas.getContext('2d');

		if (!ctx) {
			throw new Error('Failed to create canvas context');
		}

		// Calculate scaled dimensions
		const aspectRatio = canvas.height / canvas.width;
		const targetWidth = Math.min(canvas.width, maxWidth);
		const targetHeight = Math.round(targetWidth * aspectRatio);

		tempCanvas.width = targetWidth;
		tempCanvas.height = targetHeight;

		// Draw scaled image
		ctx.drawImage(canvas, 0, 0, targetWidth, targetHeight);

		// Convert to base64
		const mimeType = `image/${format}`;
		const dataUrl = tempCanvas.toDataURL(mimeType, quality);
		const imageData = dataUrl.split(',')[1]; // Remove data URL prefix

		return {
			imageData,
			width: targetWidth,
			height: targetHeight,
			format,
			timestamp: Date.now(),
		};
	}

	// =============================================================================
	// Duration Action Handling
	// =============================================================================

	private applyDurationLerpState(action: DurationAction, t: number): void {
		const { startState, targetState, params } = action;
		const deviceId = (params as unknown as AnimateToParams).device;

		let newPosition: Vec3 | undefined;
		let newOrientation: Quat | undefined;

		if (startState.position && targetState.position) {
			newPosition = lerpVec3(startState.position, targetState.position, t);
		}

		if (startState.orientation && targetState.orientation) {
			newOrientation = slerpQuat(
				startState.orientation,
				targetState.orientation,
				t,
			);
		}

		this.setDeviceTransform(deviceId, newPosition, newOrientation);
	}

	private applyDurationFinalState(action: DurationAction): void {
		const { targetState, params } = action;
		const deviceId = (params as unknown as AnimateToParams).device;

		this.setDeviceTransform(
			deviceId,
			targetState.position,
			targetState.orientation,
		);
	}

	private getDurationResult(action: DurationAction): AnimateToResult {
		const { params, elapsedMs } = action;
		const deviceId = (params as unknown as AnimateToParams).device;
		const transform = this.getDeviceTransform(deviceId);

		return {
			device: deviceId,
			position: transform.position,
			orientation: transform.orientation,
			actualDuration: elapsedMs / 1000,
		};
	}

	// =============================================================================
	// Public API - Dispatch
	// =============================================================================

	/**
	 * Set of methods that execute immediately (synchronously) without going through the queue.
	 * These are queries and session management commands that need to work outside of XR frames.
	 */
	private static readonly IMMEDIATE_METHODS = new Set([
		// Session management - must work before/after XR session
		'get_session_status',
		'accept_session',
		'end_session',
		// Pure queries - just read current state
		'get_transform',
		'get_select_value',
		'get_gamepad_state',
		'get_device_state',
		// Canvas capture - reads current canvas state
		'capture_canvas',
	]);

	/**
	 * Set of immediate methods that are "active" - they modify state and should trigger capture mode.
	 * Passive methods (queries) should NOT trigger capture mode.
	 */
	private static readonly ACTIVE_IMMEDIATE_METHODS = new Set([
		'accept_session',
		'end_session',
	]);

	/**
	 * Set of methods that require an active XR session.
	 * These are state-modifying methods that are processed during frame updates.
	 */
	private static readonly SESSION_REQUIRED_METHODS = new Set([
		'set_transform',
		'look_at',
		'animate_to',
		'set_input_mode',
		'set_connected',
		'set_select_value',
		'select',
		'set_gamepad_state',
		'set_device_state',
	]);

	/**
	 * Activate capture mode for programmatic control.
	 * Called when active methods are executed.
	 */
	private activateCaptureMode(): void {
		if (!this._isCaptured) {
			this._isCaptured = true;
			this.cancelReleaseTimer();
			this.device.controlMode = 'programmatic';
		}
		// Reset the release timer
		this.startReleaseTimer();
	}

	/**
	 * Dispatch a method call.
	 *
	 * Immediate methods (queries, session management) execute synchronously.
	 * State-modifying methods require an active session and are queued for frame-synchronized execution.
	 *
	 * @param method - The method name (e.g., 'get_transform', 'animate_to')
	 * @param params - The method parameters
	 * @returns Promise that resolves with the method result
	 */
	async dispatch(
		method: string,
		params: Record<string, unknown> = {},
	): Promise<unknown> {
		// Immediate methods execute synchronously without queue
		if (RemoteControlInterface.IMMEDIATE_METHODS.has(method)) {
			// Active immediate methods trigger capture mode
			if (RemoteControlInterface.ACTIVE_IMMEDIATE_METHODS.has(method)) {
				this.activateCaptureMode();
			}
			return this.executeImmediateMethod(method, params);
		}

		// Methods that modify state require an active session
		if (RemoteControlInterface.SESSION_REQUIRED_METHODS.has(method)) {
			if (!this.device.activeSession) {
				throw new Error(
					`Cannot execute '${method}': No active XR session. ` +
						`Use 'get_session_status' to check session state, and 'accept_session' to start a session.`,
				);
			}
		}

		// Handle animate_to specially - it's a duration action
		if (method === 'animate_to') {
			const animateParams = params as unknown as AnimateToParams;
			const currentTransform = this.getDeviceTransform(animateParams.device);
			const durationMs = (animateParams.duration ?? 0.5) * 1000;

			const targetOrientation = animateParams.orientation
				? normalizeOrientation(animateParams.orientation)
				: undefined;

			// Transform target position from XR-origin-relative to GlobalSpace
			const targetPosition = animateParams.position
				? this.transformXROriginToGlobal(animateParams.position)
				: undefined;

			return this.enqueueDuration(
				method,
				params,
				durationMs,
				{
					position: animateParams.position
						? currentTransform.position
						: undefined,
					orientation: targetOrientation
						? currentTransform.orientation
						: undefined,
				},
				{
					position: targetPosition,
					orientation: targetOrientation,
				},
			);
		}

		// Handle select specially - it's a discrete action that enqueues multiple sub-actions
		if (method === 'select') {
			const selectParams = params as unknown as SelectParams;
			return this.executeSelectSequence(selectParams);
		}

		// All other methods are discrete actions that go through the queue
		return this.enqueueDiscrete(method, params);
	}

	/**
	 * Execute an immediate method synchronously (not queued).
	 * Used for queries and session management that must work outside XR frames.
	 */
	private executeImmediateMethod(
		method: string,
		params: Record<string, unknown>,
	): unknown {
		switch (method) {
			case 'get_session_status':
				return this.executeGetSessionStatus();
			case 'accept_session':
				return this.executeAcceptSession();
			case 'end_session':
				return this.executeEndSession();
			case 'get_transform':
				return this.executeGetTransform(params as unknown as GetTransformParams);
			case 'get_select_value':
				return this.executeGetSelectValue(params as unknown as GetSelectValueParams);
			case 'get_gamepad_state':
				return this.executeGetGamepadState(params as unknown as GetGamepadStateParams);
			case 'get_device_state':
				return this.executeGetDeviceState();
			case 'capture_canvas':
				return this.executeCaptureCanvas(params as unknown as CaptureCanvasParams);
			default:
				throw new Error(`Unknown immediate method: ${method}`);
		}
	}

	/**
	 * Execute select action - this directly enqueues the three sub-actions without awaiting
	 * The caller's promise resolves when all sub-actions complete
	 */
	private executeSelectSequence(params: SelectParams): Promise<SelectResult> {
		const { device: deviceId, duration = 0.15 } = params;

		return new Promise((resolve, reject) => {
			// Track completion of all three actions
			let actionsCompleted = 0;
			const totalActions = 3;

			const checkComplete = () => {
				actionsCompleted++;
				if (actionsCompleted === totalActions) {
					resolve({
						device: deviceId,
						duration,
					});
				}
			};

			// Enqueue: set value to 1
			const action1: DiscreteAction = {
				type: 'discrete',
				id: this.generateActionId(),
				method: '_select_press',
				params: { device: deviceId },
				resolve: checkComplete,
				reject,
			};

			// Enqueue: wait for duration
			const action2: DurationAction = {
				type: 'duration',
				id: this.generateActionId(),
				method: '_select_wait',
				params: { device: deviceId },
				durationMs: duration * 1000,
				elapsedMs: 0,
				startState: {},
				targetState: {},
				resolve: checkComplete,
				reject,
			};

			// Enqueue: set value to 0
			const action3: DiscreteAction = {
				type: 'discrete',
				id: this.generateActionId(),
				method: '_select_release',
				params: { device: deviceId },
				resolve: checkComplete,
				reject,
			};

			this.commandQueue.push(action1, action2, action3);
		});
	}

	/**
	 * Accept an offered XR session (async wrapper for proper session activation)
	 */
	async acceptSession(): Promise<AcceptSessionResult> {
		if (!this.device.sessionOffered) {
			throw new Error('No session has been offered');
		}

		this.device.grantOfferedSession();

		// Wait for session to become active
		await waitForCondition(() => !!this.device.activeSession, 5000);

		// Just return success - caller can use get_session_status for details
		return { success: true };
	}

	/**
	 * Force release capture mode (for testing/cleanup)
	 */
	forceRelease(): void {
		this.cancelReleaseTimer();
		this._isCaptured = false;
		this.device.controlMode = 'manual';
		// Clear pending actions
		for (const action of this.commandQueue) {
			action.reject(new Error('Capture released'));
		}
		this.commandQueue = [];

		// Reset any stuck select/trigger values
		for (const hand of ['left', 'right'] as const) {
			const controller = this.device.controllers[hand];
			if (controller) {
				controller.updateButtonValue('trigger', 0);
				controller.updateButtonValue('squeeze', 0);
			}
		}
	}
}
