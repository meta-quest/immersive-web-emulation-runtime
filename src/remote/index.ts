/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

export { RemoteControlInterface } from './RemoteControlInterface.js';
export type {
	DeviceId,
	InputDeviceId,
	ControllerId,
	Action,
	DiscreteAction,
	DurationAction,
	OrientationInput,
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
	GamepadButtonInfo,
	GamepadAxisInfo,
	GetGamepadStateParams,
	GetGamepadStateResult,
	GamepadButtonInput,
	GamepadAxisInput,
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
} from './types.js';
