/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// value pulled from https://felixtrz.github.io/webxr-device-config/
// on Oculus Quest 1, Meta Quest 2, Meta Quest Pro, Meta Quest 3

import { GamepadConfig, GamepadMappingType } from '../../../gamepad/Gamepad.js';

import { XRControllerConfig } from '../../XRController.js';

const gamepadConfigLeft: GamepadConfig = {
	mapping: GamepadMappingType.XRStandard,
	buttons: [
		{ id: 'trigger', type: 'analog', eventTrigger: 'select' },
		{ id: 'squeeze', type: 'analog', eventTrigger: 'squeeze' },
		null,
		{ id: 'thumbstick', type: 'binary' },
		{ id: 'x-button', type: 'binary' },
		{ id: 'y-button', type: 'binary' },
		{ id: 'thumbrest', type: 'binary' },
	],
	axes: [
		null,
		null,
		{ id: 'thumbstick', type: 'x-axis' },
		{ id: 'thumbstick', type: 'y-axis' },
	],
};

const gamepadConfigRight: GamepadConfig = {
	mapping: GamepadMappingType.XRStandard,
	buttons: [
		{ id: 'trigger', type: 'analog', eventTrigger: 'select' },
		{ id: 'squeeze', type: 'analog', eventTrigger: 'squeeze' },
		null,
		{ id: 'thumbstick', type: 'binary' },
		{ id: 'a-button', type: 'binary' },
		{ id: 'b-button', type: 'binary' },
		{ id: 'thumbrest', type: 'binary' },
	],
	axes: [
		null,
		null,
		{ id: 'thumbstick', type: 'x-axis' },
		{ id: 'thumbstick', type: 'y-axis' },
	],
};

export const oculusTouchV2: XRControllerConfig = {
	profileId: 'oculus-touch-v2',
	fallbackProfileIds: ['oculus-touch', 'generic-trigger-squeeze-thumbstick'],
	layout: {
		left: {
			gamepad: gamepadConfigLeft,
			gripOffsetMatrix: [
				0.9925461411476135, 4.673031295254759e-9, -0.12186938524246216, 0,
				0.08617470413446426, 0.7071065306663513, 0.7018362283706665, 0,
				0.0861746296286583, -0.70710688829422, 0.7018358707427979, 0,
				-0.003979847766458988, -0.01585787907242775, 0.04964185878634453, 1,
			],
			numHapticActuators: 1,
		},
		right: {
			gamepad: gamepadConfigRight,
			gripOffsetMatrix: [
				0.9925461411476135, 3.688163374704345e-8, 0.12186937034130096, 0,
				-0.08617469668388367, 0.7071066498756409, 0.7018361687660217, 0,
				-0.0861746147274971, -0.7071068286895752, 0.7018359899520874, 0,
				0.003979853354394436, -0.01585787907242775, 0.04964182525873184, 1,
			],
			numHapticActuators: 1,
		},
	},
};

export const oculusTouchV3: XRControllerConfig = {
	profileId: 'oculus-touch-v3',
	fallbackProfileIds: ['oculus-touch', 'generic-trigger-squeeze-thumbstick'],
	layout: {
		left: {
			gamepad: gamepadConfigLeft,
			gripOffsetMatrix: [
				0.9925461411476135, 2.0823669899527886e-8, -0.12186937034130096, 0,
				0.08617465198040009, 0.7071067094802856, 0.701836109161377, 0,
				0.08617466688156128, -0.7071067690849304, 0.7018360495567322, 0,
				-0.003979838453233242, -0.015857907012104988, 0.04964181408286095, 1,
			],
			numHapticActuators: 1,
		},
		right: {
			gamepad: gamepadConfigRight,
			gripOffsetMatrix: [
				0.9925461411476135, -8.329467959811154e-8, 0.12186941504478455, 0,
				-0.08617465943098068, 0.7071066498756409, 0.7018361687660217, 0,
				-0.08617471158504486, -0.7071068286895752, 0.7018359303474426, 0,
				0.003979798872023821, -0.015857888385653496, 0.049641866236925125, 1,
			],
			numHapticActuators: 1,
		},
	},
};

export const metaQuestTouchPro: XRControllerConfig = {
	profileId: 'meta-quest-touch-pro',
	fallbackProfileIds: [
		'oculus-touch-v2',
		'oculus-touch',
		'generic-trigger-squeeze-thumbstick',
	],
	layout: {
		left: {
			gamepad: gamepadConfigLeft,
			gripOffsetMatrix: [
				0.9925461411476135, -1.5779937356796836e-8, -0.12186935544013977, 0,
				0.08617467433214188, 0.7071067094802856, 0.701836109161377, 0,
				0.0861746296286583, -0.7071067690849304, 0.7018360495567322, 0,
				-0.003979836590588093, -0.015857847407460213, 0.049641840159893036, 1,
			],
			numHapticActuators: 3,
		},
		right: {
			gamepad: gamepadConfigRight,
			gripOffsetMatrix: [
				0.9925461411476135, 9.267653311439972e-11, 0.12186937034130096, 0,
				-0.08617467433214188, 0.7071067094802856, 0.7018361687660217, 0,
				-0.08617464452981949, -0.7071067690849304, 0.7018360495567322, 0,
				0.003979847766458988, -0.01585782691836357, 0.04964186251163483, 1,
			],
			numHapticActuators: 3,
		},
	},
};

export const metaQuestTouchPlus: XRControllerConfig = {
	profileId: 'meta-quest-touch-plus',
	fallbackProfileIds: [
		'oculus-touch-v3',
		'oculus-touch',
		'generic-trigger-squeeze-thumbstick',
	],
	layout: {
		left: {
			gamepad: gamepadConfigLeft,
			gripOffsetMatrix: [
				0.9925461411476135, 1.0736208366779465e-8, -0.12186933308839798, 0,
				0.08617459982633591, 0.70710688829422, 0.7018360495567322, 0,
				0.08617466688156128, -0.7071067094802856, 0.7018362283706665, 0,
				-0.003979803062975407, -0.015857873484492302, 0.04964187368750572, 1,
			],
			numHapticActuators: 1,
		},
		right: {
			gamepad: gamepadConfigRight,
			gripOffsetMatrix: [
				0.9925461411476135, -2.6238110351073374e-8, 0.12186934053897858, 0,
				-0.0861746147274971, 0.7071067690849304, 0.7018360495567322, 0,
				-0.08617465943098068, -0.7071067094802856, 0.701836109161377, 0,
				0.003979838453233242, -0.015857869759202003, 0.04964182525873184, 1,
			],
			numHapticActuators: 1,
		},
	},
};
