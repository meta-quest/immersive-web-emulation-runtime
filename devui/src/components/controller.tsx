/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
	ControlButtonStyles,
	ControlPanel,
	FAIcon,
	PanelHeaderButton,
	SectionBreak,
} from './styled.js';
import { ControlsMapper, useKeyMapStore } from './mapper.js';
import {
	Button as GamepadButton,
	GamepadConfig,
} from 'iwer/lib/gamepad/Gamepad.js';
import {
	faCircleXmark,
	faGamepad,
	faGear,
	faPlug,
} from '@fortawesome/free-solid-svg-icons';

import { AnalogButton } from './analog.js';
import { BinaryButton } from './binary.js';
import { Joystick } from './joystick.js';
import React from 'react';
import { TransformHandles } from '@pmndrs/handle';
import { Vector3Input } from './vec3.js';
import type { XRController } from 'iwer/lib/device/XRController.js';

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
		.filter((button): button is GamepadButton => button !== null) // Filter out null values
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

interface ControllerProps {
	controller: XRController;
	handle: TransformHandles;
	handedness: string;
	pointerLocked: boolean;
}

export const ControllerUI: React.FC<ControllerProps> = ({
	controller,
	handle,
	handedness,
	pointerLocked,
}) => {
	const { keyMap } = useKeyMapStore();
	const [connected, setConnected] = React.useState(controller.connected);
	const [settingsOpen, setSettingsOpen] = React.useState(false);
	const transformedConfig = transformGamepadConfig(controller.gamepadConfig);
	const actions = transformedConfig.flatMap((config) => {
		if (config.hasAxes) {
			return [
				`${config.id}-left`,
				`${config.id}-right`,
				`${config.id}-up`,
				`${config.id}-down`,
				config.id,
			];
		} else {
			return config.id;
		}
	});
	React.useEffect(() => {
		if (pointerLocked) {
			setSettingsOpen(false);
		}
	}, [pointerLocked]);
	return (
		<ControlPanel
			key={handedness}
			style={
				handedness === 'left'
					? { left: '8px', bottom: '8px' }
					: { right: '8px', bottom: '8px' }
			}
		>
			{!pointerLocked && (
				<>
					<div
						style={{
							display: 'flex',
							flexDirection: 'row',
							justifyContent: 'space-between',
							alignItems: 'center',
						}}
					>
						<div
							style={{
								fontSize: '13px',
								display: 'flex',
								flexDirection: 'row',
								alignItems: 'center',
							}}
						>
							<FAIcon icon={faGamepad} style={{ marginRight: '5px' }} />
							Controller&nbsp;
							<span style={{ fontWeight: 'bold' }}>
								[{handedness === 'left' ? 'L' : 'R'}]
							</span>
						</div>
						<div
							style={{
								display: 'flex',
								flexDirection: 'row',
								gap: '1px',
							}}
						>
							{connected ? (
								<>
									<PanelHeaderButton
										title={`Click to ${
											settingsOpen ? 'close' : 'change'
										} key bindings`}
										onClick={() => {
											setSettingsOpen(!settingsOpen);
										}}
									>
										<FAIcon icon={faGear} />
									</PanelHeaderButton>
									<PanelHeaderButton
										title={`Click to disconnect ${handedness} controller`}
										$isRed={true}
										onClick={() => {
											controller.connected = false;
											setConnected(false);
										}}
									>
										<FAIcon icon={faCircleXmark} />
									</PanelHeaderButton>
								</>
							) : (
								<PanelHeaderButton
									title={`Click to reconnect ${handedness} controller`}
									onClick={() => {
										controller.connected = true;
										setConnected(true);
									}}
									style={{ marginLeft: '5px' }}
								>
									<FAIcon icon={faPlug} />
								</PanelHeaderButton>
							)}
						</div>
					</div>
				</>
			)}
			{connected && !pointerLocked && (
				<>
					{!settingsOpen && (
						<>
							<SectionBreak />
							<Vector3Input
								vector={handle.position}
								label="Position"
								marginBottom={ControlButtonStyles.gap}
							/>
							<Vector3Input vector={handle.rotation} label="Rotation" />
						</>
					)}
					<SectionBreak />
				</>
			)}
			{connected &&
				(settingsOpen ? (
					<ControlsMapper handedness={handedness as any} actions={actions} />
				) : (
					transformedConfig.map((buttonConfig) => {
						const mapping = keyMap[handedness as XRHandedness]!;
						if (buttonConfig.hasAxes) {
							return (
								<Joystick
									xrController={controller}
									pointerLocked={pointerLocked}
									buttonId={buttonConfig.id}
									mappedKeyUp={
										keyMap[handedness as XRHandedness]![`${buttonConfig.id}-up`]
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
					})
				))}
		</ControlPanel>
	);
};
