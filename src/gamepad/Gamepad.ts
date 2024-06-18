/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

export const PRIVATE = Symbol('@immersive-web-emulation-runtime/gamepad');

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
	[PRIVATE]: {
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
		this[PRIVATE] = {
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
		if (this[PRIVATE].type === 'manual') {
			return this[PRIVATE].pressed;
		} else {
			return this[PRIVATE].value > 0;
		}
	}

	get touched() {
		if (this[PRIVATE].type === 'manual') {
			return this[PRIVATE].touched;
		} else {
			return this[PRIVATE].touched || this.pressed;
		}
	}

	get value() {
		return this[PRIVATE].value;
	}
}

export class EmptyGamepadButton {
	pressed = false;
	touched = false;
	value = 0;
}

export class Gamepad {
	[PRIVATE]: {
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
		this[PRIVATE] = {
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
				this[PRIVATE].buttonsSequence.push(null);
			} else {
				this[PRIVATE].buttonsSequence.push(buttonConfig.id);
				this[PRIVATE].buttonsMap[buttonConfig.id] = new GamepadButton(
					buttonConfig.type,
					buttonConfig.eventTrigger ?? null,
				);
			}
		});
		gamepadConfig.axes.forEach((axisConfig) => {
			if (axisConfig === null) {
				this[PRIVATE].axesSequence.push(null);
			} else {
				this[PRIVATE].axesSequence.push(axisConfig.id + axisConfig.type);
				if (!this[PRIVATE].axesMap[axisConfig.id]) {
					this[PRIVATE].axesMap[axisConfig.id] = { x: 0, y: 0 };
				}
			}
		});
	}

	get id() {
		return this[PRIVATE].id;
	}

	get index() {
		return this[PRIVATE].index;
	}

	get connected() {
		return this[PRIVATE].connected;
	}

	get timestamp() {
		return this[PRIVATE].timestamp;
	}

	get mapping() {
		return this[PRIVATE].mapping;
	}

	get axes() {
		const axes: (number | null)[] = [];
		this[PRIVATE].axesSequence.forEach((id) => {
			if (id === null) {
				axes.push(null);
			} else {
				const axisId = id.substring(0, id.length - 6);
				const axisType = id.substring(id.length - 6);
				axes.push(
					// if axis type is manual, then return the x value
					axisType === 'y-axis'
						? this[PRIVATE].axesMap[axisId].y
						: this[PRIVATE].axesMap[axisId].x,
				);
			}
		});
		return axes;
	}

	get buttons() {
		return this[PRIVATE].buttonsSequence.map((id) =>
			id === null ? new EmptyGamepadButton() : this[PRIVATE].buttonsMap[id],
		);
	}

	get hapticActuators() {
		return this[PRIVATE].hapticActuators;
	}

	get vibrationActuator() {
		return null;
	}
}
