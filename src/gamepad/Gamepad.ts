/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_GAMEPAD } from '../private.js';

export enum GamepadMappingType {
	None = '',
	Standard = 'standard',
	XRStandard = 'xr-standard',
}

export interface Button {
	id: string;
	type: 'binary' | 'analog' | 'manual';
	eventTrigger?: 'select' | 'squeeze';
}

export interface Axis {
	id: string;
	type: 'x-axis' | 'y-axis' | 'manual';
}

export interface GamepadConfig {
	mapping: GamepadMappingType;
	buttons: (Button | null)[];
	axes: (Axis | null)[];
}

export class GamepadButton {
	[P_GAMEPAD]: {
		type: 'analog' | 'binary' | 'manual';
		eventTrigger: 'select' | 'squeeze' | null;
		pressed: boolean;
		touched: boolean;
		value: number;
		lastFrameValue: number;
		pendingValue: number | null;
	};

	constructor(
		type: 'analog' | 'binary' | 'manual',
		eventTrigger: 'select' | 'squeeze' | null,
	) {
		this[P_GAMEPAD] = {
			type,
			eventTrigger,
			pressed: false,
			touched: false,
			value: 0,
			lastFrameValue: 0,
			pendingValue: null,
		};
	}

	get pressed() {
		if (this[P_GAMEPAD].type === 'manual') {
			return this[P_GAMEPAD].pressed;
		} else {
			return this[P_GAMEPAD].value > 0;
		}
	}

	get touched() {
		if (this[P_GAMEPAD].type === 'manual') {
			return this[P_GAMEPAD].touched;
		} else {
			return this[P_GAMEPAD].touched || this.pressed;
		}
	}

	get value() {
		return this[P_GAMEPAD].value;
	}
}

export class EmptyGamepadButton {
	pressed = false;
	touched = false;
	value = 0;
}

export class Gamepad {
	[P_GAMEPAD]: {
		id: string;
		index: number;
		connected: boolean;
		timestamp: DOMHighResTimeStamp;
		mapping: GamepadMappingType;
		buttonsMap: {
			[id: string]: GamepadButton | null;
		};
		buttonsSequence: (string | null)[];
		axesMap: {
			[id: string]: { x: number; y: number };
		};
		axesSequence: (string | null)[];
		hapticActuators: GamepadHapticActuator[];
	};

	constructor(
		gamepadConfig: GamepadConfig,
		id: string = '',
		index: number = -1,
	) {
		this[P_GAMEPAD] = {
			id,
			index,
			connected: false,
			timestamp: performance.now(),
			mapping: gamepadConfig.mapping,
			buttonsMap: {},
			buttonsSequence: [],
			axesMap: {},
			axesSequence: [],
			hapticActuators: [],
		};
		gamepadConfig.buttons.forEach((buttonConfig) => {
			if (buttonConfig === null) {
				this[P_GAMEPAD].buttonsSequence.push(null);
			} else {
				this[P_GAMEPAD].buttonsSequence.push(buttonConfig.id);
				this[P_GAMEPAD].buttonsMap[buttonConfig.id] = new GamepadButton(
					buttonConfig.type,
					buttonConfig.eventTrigger ?? null,
				);
			}
		});
		gamepadConfig.axes.forEach((axisConfig) => {
			if (axisConfig === null) {
				this[P_GAMEPAD].axesSequence.push(null);
			} else {
				this[P_GAMEPAD].axesSequence.push(axisConfig.id + axisConfig.type);
				if (!this[P_GAMEPAD].axesMap[axisConfig.id]) {
					this[P_GAMEPAD].axesMap[axisConfig.id] = { x: 0, y: 0 };
				}
			}
		});
	}

	get id() {
		return this[P_GAMEPAD].id;
	}

	get index() {
		return this[P_GAMEPAD].index;
	}

	get connected() {
		return this[P_GAMEPAD].connected;
	}

	get timestamp() {
		return this[P_GAMEPAD].timestamp;
	}

	get mapping() {
		return this[P_GAMEPAD].mapping;
	}

	get axes() {
		const axes: (number | null)[] = [];
		this[P_GAMEPAD].axesSequence.forEach((id) => {
			if (id === null) {
				axes.push(null);
			} else {
				const axisId = id.substring(0, id.length - 6);
				const axisType = id.substring(id.length - 6);
				axes.push(
					// if axis type is manual, then return the x value
					axisType === 'y-axis'
						? this[P_GAMEPAD].axesMap[axisId].y
						: this[P_GAMEPAD].axesMap[axisId].x,
				);
			}
		});
		return axes;
	}

	get buttons() {
		return this[P_GAMEPAD].buttonsSequence.map((id) =>
			id === null ? new EmptyGamepadButton() : this[P_GAMEPAD].buttonsMap[id],
		);
	}

	get hapticActuators() {
		return this[P_GAMEPAD].hapticActuators;
	}

	get vibrationActuator() {
		return null;
	}
}
