/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
	XRHandedness,
	XRInputSource,
	XRTargetRayMode,
} from '../../src/input/XRInputSource';

import { Gamepad } from '../../src/gamepad/Gamepad';
import { XRSpace } from '../../src/spaces/XRSpace';

describe('XRInputSource', () => {
	let targetRaySpace: XRSpace;
	let gripSpace: XRSpace;
	let gamepad: Gamepad;

	beforeEach(() => {
		targetRaySpace = new XRSpace();
		gripSpace = new XRSpace();
		gamepad = {} as Gamepad;
	});

	test('should properly initialize with given parameters', () => {
		const handedness = XRHandedness.Left;
		const targetRayMode = XRTargetRayMode.TrackedPointer;
		const profiles = ['profile1', 'profile2'];

		const inputSource = new XRInputSource(
			handedness,
			targetRayMode,
			profiles,
			targetRaySpace,
			gamepad,
			gripSpace,
		);

		expect(inputSource.handedness).toBe(handedness);
		expect(inputSource.targetRayMode).toBe(targetRayMode);
		expect(inputSource.targetRaySpace).toBe(targetRaySpace);
		expect(inputSource.gripSpace).toBe(gripSpace);
		expect(inputSource.profiles).toEqual(profiles);
		expect(inputSource.gamepad).toBe(gamepad);
	});

	// Test for different handedness
	test.each([[XRHandedness.None], [XRHandedness.Left], [XRHandedness.Right]])(
		'should handle handedness: %s',
		(handedness) => {
			const inputSource = new XRInputSource(
				handedness,
				XRTargetRayMode.TrackedPointer,
				[],
				targetRaySpace,
				gamepad,
				gripSpace,
			);
			expect(inputSource.handedness).toBe(handedness);
		},
	);

	// Test for different target ray modes
	test.each([
		[XRTargetRayMode.Gaze],
		[XRTargetRayMode.TrackedPointer],
		[XRTargetRayMode.Screen],
		[XRTargetRayMode.TransientPointer],
	])('should handle targetRayMode: %s', (targetRayMode) => {
		const inputSource = new XRInputSource(
			XRHandedness.None,
			targetRayMode,
			[],
			targetRaySpace,
			gamepad,
			gripSpace,
		);
		expect(inputSource.targetRayMode).toBe(targetRayMode);
	});
});
