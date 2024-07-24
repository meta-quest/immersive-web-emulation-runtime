import { Button, GamepadConfig } from 'iwer/lib/gamepad/Gamepad.js';

import { AnalogButton } from './analog.js';
import { BinaryButton } from './binary.js';
import { Joystick } from './joystick.js';
import { KeyMapType } from './mapper.js';
import React from 'react';
import { XRDevice } from 'iwer';
import styled from 'styled-components';

const ControlsContainer = styled.div<{ $reverse: boolean }>`
	padding: ${({ $reverse }) =>
		$reverse ? '6px 2px 3px 5px' : '6px 5px 3px 2px'};
	pointer-events: all;
	background-color: rgba(43, 43, 43, 0.5);
	backdrop-filter: blur(10px);
	-webkit-backdrop-filter: blur(10px);
	border-radius: ${({ $reverse }) => ($reverse ? '12px 0 0 0' : '0 12px 0 0')};
`;

interface ControlsProps {
	xrDevice: XRDevice;
	keyMap: KeyMapType;
	pointerLocked: boolean;
}

type TransformedConfig = {
	id: string;
	type: 'analog' | 'binary' | 'manual';
	hasAxes: boolean;
};

function transformGamepadConfig(
	gamepadConfig: GamepadConfig,
): TransformedConfig[] {
	const axesSet = new Set<string>();

	// Add all axis ids to the set
	for (const axis of gamepadConfig.axes) {
		if (axis && axis.id) {
			axesSet.add(axis.id);
		}
	}

	// Transform buttons to the desired format
	const transformed = gamepadConfig.buttons
		.filter((button): button is Button => button !== null) // Filter out null values
		.map((button) => ({
			id: button.id,
			type: button.type,
			hasAxes: axesSet.has(button.id),
		}));

	// Sort the array by hasAxes
	transformed.sort((a, b) => {
		if (a.hasAxes && !b.hasAxes) return -1;
		if (!a.hasAxes && b.hasAxes) return 1;
		return 0;
	});

	return transformed;
}

export const ControlsUI: React.FC<ControlsProps> = ({
	xrDevice,
	keyMap,
	pointerLocked,
}) => {
	return (
		<div
			style={{
				display: 'flex',
				justifyContent: 'space-between',
				flexDirection: 'row',
			}}
		>
			{Object.entries(xrDevice.controllers).map(([handedness, controller]) => (
				<ControlsContainer $reverse={handedness !== 'left'} key={handedness}>
					{transformGamepadConfig(controller.gamepadConfig).map(
						(buttonConfig) => {
							const mapping = keyMap[handedness as XRHandedness]!;
							if (buttonConfig.hasAxes) {
								return (
									<Joystick
										xrController={controller}
										pointerLocked={pointerLocked}
										buttonId={buttonConfig.id}
										mappedKeyUp={
											keyMap[handedness as XRHandedness]![
												`${buttonConfig.id}-up`
											]
										}
										mappedKeyDown={mapping[`${buttonConfig.id}-down`]}
										mappedKeyLeft={mapping[`${buttonConfig.id}-left`]}
										mappedKeyRight={mapping[`${buttonConfig.id}-right`]}
										mappedKeyPressed={mapping[buttonConfig.id]}
										key={buttonConfig.id}
									/>
								);
							} else if (buttonConfig.type === 'analog') {
								return (
									<AnalogButton
										xrController={controller}
										buttonId={buttonConfig.id}
										mappedKey={mapping[buttonConfig.id]}
										pointerLocked={pointerLocked}
										key={buttonConfig.id}
									/>
								);
							} else {
								return (
									<BinaryButton
										xrController={controller}
										buttonId={buttonConfig.id}
										mappedKey={mapping[buttonConfig.id]}
										pointerLocked={pointerLocked}
										key={buttonConfig.id}
									/>
								);
							}
						},
					)}
				</ControlsContainer>
			))}
		</div>
	);
};
