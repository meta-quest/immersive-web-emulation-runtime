/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Gamepad, GamepadButton, GamepadMappingType } from '../../src/gamepad/Gamepad.js';
import { P_GAMEPAD } from '../../src/private.js';

describe('GamepadButton', () => {
	test('should handle manual type button pressed state', () => {
		const button = new GamepadButton('manual', null);
		
		// For manual type, pressed should return the internal pressed state
		expect(button.pressed).toBe(false);
		
		// Manually set pressed state (this would normally be done internally)
		button[P_GAMEPAD].pressed = true;
		expect(button.pressed).toBe(true);
	});

	test('should handle manual type button touched state', () => {
		const button = new GamepadButton('manual', null);
		
		// For manual type, touched should return the internal touched state
		expect(button.touched).toBe(false);
		
		// Manually set touched state
		button[P_GAMEPAD].touched = true;
		expect(button.touched).toBe(true);
	});

	test('should handle analog type button pressed based on value', () => {
		const button = new GamepadButton('analog', 'select');
		
		// For analog type, pressed should be based on value > 0
		expect(button.pressed).toBe(false);
		
		// Set value > 0
		button[P_GAMEPAD].value = 0.5;
		expect(button.pressed).toBe(true);
	});

	test('should handle analog type button touched state', () => {
		const button = new GamepadButton('analog', 'select');
		
		// For analog type, touched should return touched OR pressed
		expect(button.touched).toBe(false);
		
		// Set touched directly
		button[P_GAMEPAD].touched = true;
		expect(button.touched).toBe(true);
		
		// Reset touched and set value > 0 (which makes pressed true)
		button[P_GAMEPAD].touched = false;
		button[P_GAMEPAD].value = 0.5;
		expect(button.touched).toBe(true); // Should be true because pressed is true
	});

	test('should handle binary type button behavior', () => {
		const button = new GamepadButton('binary', 'squeeze');
		
		// Binary type should behave like analog for pressed/touched
		expect(button.pressed).toBe(false);
		expect(button.touched).toBe(false);
		
		button[P_GAMEPAD].value = 1;
		expect(button.pressed).toBe(true);
		expect(button.touched).toBe(true);
	});

	test('should get button value', () => {
		const button = new GamepadButton('analog', 'select');
		expect(button.value).toBe(0);
		
		button[P_GAMEPAD].value = 0.75;
		expect(button.value).toBe(0.75);
	});
});

describe('Gamepad', () => {
	test('should get gamepad properties', () => {
		const config = {
			mapping: GamepadMappingType.Standard,
			buttons: [
				{ id: 'trigger', type: 'analog' as const, eventTrigger: 'select' as const },
				null
			],
			axes: [
				{ id: 'thumbstick', type: 'x-axis' as const },
				{ id: 'thumbstick', type: 'y-axis' as const }
			]
		};

		const gamepad = new Gamepad(config, 'test-gamepad', 0);

		expect(gamepad.id).toBe('test-gamepad');
		expect(gamepad.index).toBe(0);
		expect(gamepad.connected).toBe(false);
		expect(gamepad.mapping).toBe(GamepadMappingType.Standard);
		expect(typeof gamepad.timestamp).toBe('number');
	});

	test('should handle axes array with null values and different axis types', () => {
		const config = {
			mapping: GamepadMappingType.XRStandard,
			buttons: [],
			axes: [
				{ id: 'thumbstick', type: 'x-axis' as const },
				{ id: 'thumbstick', type: 'y-axis' as const },
				null,
				{ id: 'touchpad', type: 'x-axis' as const }
			]
		};

		const gamepad = new Gamepad(config, 'test-gamepad', 0);
		const axes = gamepad.axes;

		expect(axes).toHaveLength(4);
		expect(typeof axes[0]).toBe('number'); // x-axis
		expect(typeof axes[1]).toBe('number'); // y-axis 
		expect(axes[2]).toBeNull(); // null axis
		expect(typeof axes[3]).toBe('number'); // another x-axis
	});

	test('should handle buttons array with null values', () => {
		const config = {
			mapping: GamepadMappingType.None,
			buttons: [
				{ id: 'trigger', type: 'analog' as const, eventTrigger: 'select' as const },
				null,
				{ id: 'squeeze', type: 'binary' as const, eventTrigger: 'squeeze' as const }
			],
			axes: []
		};

		const gamepad = new Gamepad(config, 'test-gamepad', 0);
		const buttons = gamepad.buttons;

		expect(buttons).toHaveLength(3);
		expect(buttons[0]).toBeInstanceOf(GamepadButton);
		expect(buttons[1]).toBeDefined(); // EmptyGamepadButton
		expect(buttons[2]).toBeInstanceOf(GamepadButton);
	});

	test('should get hapticActuators', () => {
		const config = {
			mapping: GamepadMappingType.Standard,
			buttons: [],
			axes: []
		};

		const gamepad = new Gamepad(config, 'test-gamepad', 0);
		
		// hapticActuators should return the internal array
		expect(Array.isArray(gamepad.hapticActuators)).toBe(true);
	});

	test('should return null for vibrationActuator', () => {
		const config = {
			mapping: GamepadMappingType.Standard,
			buttons: [],
			axes: []
		};

		const gamepad = new Gamepad(config, 'test-gamepad', 0);
		
		// vibrationActuator should always return null
		expect(gamepad.vibrationActuator).toBeNull();
	});

	test('should handle different axis types correctly', () => {
		const config = {
			mapping: GamepadMappingType.XRStandard,
			buttons: [],
			axes: [
				{ id: 'stick1', type: 'x-axis' as const },
				{ id: 'stick1', type: 'y-axis' as const },
				{ id: 'stick2', type: 'x-axis' as const }
			]
		};

		const gamepad = new Gamepad(config, 'test-gamepad', 0);
		
		// Set some values to test axis reading
		const axesMap = gamepad[P_GAMEPAD].axesMap;
		axesMap['stick1'] = { x: 0.5, y: -0.3 };
		axesMap['stick2'] = { x: 0.8, y: 0.1 };
		
		const axes = gamepad.axes;
		expect(axes[0]).toBe(0.5);  // stick1 x-axis
		expect(axes[1]).toBe(-0.3); // stick1 y-axis  
		expect(axes[2]).toBe(0.8);  // stick2 x-axis
	});
});