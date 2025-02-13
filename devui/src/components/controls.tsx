/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { ControllerUI } from './controller.js';
import { HandUI } from './hand.js';
import { InputLayer } from '../scene.js';
import React from 'react';
import { XRDevice } from 'iwer';
import { create } from 'zustand';

interface ControlsProps {
	xrDevice: XRDevice;
	inputLayer: InputLayer;
	pointerLocked: boolean;
}

type InputModeStore = {
	inputMode: string;
	setInputMode: (mode: 'controller' | 'hand') => void;
};

export const useInputModeStore = create<InputModeStore>((set) => ({
	inputMode: 'controller',
	setInputMode: (mode: 'controller' | 'hand') =>
		set(() => ({
			inputMode: mode,
		})),
}));

export const ControlsUI: React.FC<ControlsProps> = ({
	xrDevice,
	inputLayer,
	pointerLocked,
}) => {
	const { inputMode } = useInputModeStore();
	return (
		<>
			{inputMode === 'controller'
				? Object.entries(xrDevice.controllers).map(
						([handedness, controller]) => (
							<ControllerUI
								key={`controller-${handedness}`}
								controller={controller}
								handle={
									inputLayer.transformHandles.get(
										handedness as 'left' | 'right',
									)!
								}
								handedness={handedness}
								pointerLocked={pointerLocked}
							/>
						),
				  )
				: Object.entries(xrDevice.hands).map(([handedness, hand]) => (
						<HandUI
							key={`hand-${handedness}`}
							hand={hand}
							handle={
								inputLayer.transformHandles.get(handedness as 'left' | 'right')!
							}
							handedness={handedness}
							pointerLocked={pointerLocked}
						/>
				  ))}
		</>
	);
};
