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
	faCircleXmark,
	faGear,
	faHand,
	faPlug,
} from '@fortawesome/free-solid-svg-icons';

import { PinchControl } from './pinch.js';
import { PoseSelector } from './pose.js';
import React from 'react';
import { TransformHandles } from '@pmndrs/handle';
import { Vector3Input } from './vec3.js';
import type { XRHandInput } from 'iwer/lib/device/XRHandInput.js';

interface HandProps {
	hand: XRHandInput;
	handle: TransformHandles;
	handedness: string;
	pointerLocked: boolean;
}

export const HandUI: React.FC<HandProps> = ({
	hand,
	handle,
	handedness,
	pointerLocked,
}) => {
	const { keyMap } = useKeyMapStore();
	const [connected, setConnected] = React.useState(hand.connected);
	const [settingsOpen, setSettingsOpen] = React.useState(false);
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
							<FAIcon
								icon={faHand}
								$reverse={handedness === 'left'}
								style={{ marginRight: '5px' }}
							/>
							Hand&nbsp;
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
											hand.connected = false;
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
										hand.connected = true;
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
					<ControlsMapper
						handedness={handedness as any}
						actions={['pose', 'pinch']}
					/>
				) : (
					<>
						<PoseSelector
							hand={hand}
							pointerLocked={pointerLocked}
							mappedKey={keyMap[handedness as XRHandedness]!.pose}
						/>
						<PinchControl
							hand={hand}
							pointerLocked={pointerLocked}
							mappedKey={keyMap[handedness as XRHandedness]!.pinch}
						/>
					</>
				))}
		</ControlPanel>
	);
};
