import { Button, FAIcon, MappedKeyBlock } from './styled.js';
import {
	faArrowsUpDown,
	faCaretDown,
	faCaretUp,
	faCirclePlay,
	faKeyboard,
	faRightFromBracket,
	faRotateLeft,
	faSquareArrowUpRight,
	faVideo,
} from '@fortawesome/free-solid-svg-icons';

import { IWERIcon } from './icons.js';
import { InputLayer } from '../scene.js';
import React from 'react';
import { XRDevice } from 'iwer';
import styled from 'styled-components';

const HeaderButtonsContainer = styled.div`
	padding: 6px 5px;
	display: flex;
	background-color: rgba(43, 43, 43, 0.5);
	backdrop-filter: blur(10px);
	-webkit-backdrop-filter: blur(10px);
	justify-content: center;
	pointer-events: all;
	border-radius: 0 0 12px 12px;
	align-items: center;
	height: 24px;
`;

const MovementInstructionsContainer = styled.div<{ $reverse: boolean }>`
	background-color: rgba(43, 43, 43, 0.5);
	backdrop-filter: blur(10px);
	-webkit-backdrop-filter: blur(10px);
	border: none;
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	justify-content: center;
	cursor: pointer;
	color: white;
	white-space: nowrap;
	font-size: 14px;
	text-transform: none;
	box-shadow: none;
	font-family: Arial, sans-serif;
	border-radius: ${({ $reverse }) => ($reverse ? '0 0 0 12px' : '0 0 12px 0')};
	padding: 5px;

	> div {
		display: flex;
		flex-direction: row;
		align-items: center;
		gap: 2px;
		margin: 2px;
	}
`;

interface HeaderUIProps {
	xrDevice: XRDevice;
	inputLayer: InputLayer;
	keyMapOpen: boolean;
	setKeyMapOpen: React.Dispatch<React.SetStateAction<boolean>>;
	fovSettingOpen: boolean;
	setFovSettingOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

export const HeaderUI: React.FC<HeaderUIProps> = ({
	xrDevice,
	inputLayer,
	keyMapOpen,
	setKeyMapOpen,
	fovSettingOpen,
	setFovSettingOpen,
}) => {
	return (
		<div
			style={{
				display: 'flex',
				justifyContent: 'center',
			}}
		>
			<HeaderButtonsContainer>
				<IWERIcon />
				<div
					style={{
						display: 'flex',
						flexDirection: 'row',
						marginLeft: '4px',
					}}
				>
					<Button
						$reverse={false}
						onClick={() => {
							inputLayer.resetDeviceTransforms();
						}}
					>
						<FAIcon icon={faRotateLeft} />
					</Button>
					<Button
						$reverse={false}
						onClick={() => {
							inputLayer.lockPointer();
							setKeyMapOpen(false);
							setFovSettingOpen(false);
						}}
					>
						<FAIcon icon={faCirclePlay} />
					</Button>
					<Button
						$reverse={false}
						onClick={() => {
							setKeyMapOpen(!keyMapOpen);
							setFovSettingOpen(false);
						}}
					>
						<FAIcon icon={faKeyboard} />
					</Button>
					<Button
						$reverse={false}
						onClick={() => {
							setFovSettingOpen(!fovSettingOpen);
							setKeyMapOpen(false);
						}}
					>
						<FAIcon icon={faVideo} />
					</Button>
					<Button
						$reverse={false}
						onClick={() => {
							const xrSession = xrDevice.activeSession;
							xrSession?.end();
						}}
					>
						<FAIcon icon={faRightFromBracket} />
					</Button>
				</div>
			</HeaderButtonsContainer>
			<MovementInstructionsContainer
				$reverse={false}
				style={{ position: 'fixed', left: '0', top: '0' }}
			>
				<div>
					<FAIcon icon={faSquareArrowUpRight} style={{ marginRight: '4px' }} />{' '}
					Roomscale Movement
				</div>
				<div>
					<MappedKeyBlock $pressed={false} style={{ width: '50px' }}>
						L Shift
					</MappedKeyBlock>
					<span style={{ margin: '0 4px' }}>+</span>
					<MappedKeyBlock $pressed={false}>W</MappedKeyBlock>
					<MappedKeyBlock $pressed={false}>A</MappedKeyBlock>
					<MappedKeyBlock $pressed={false}>S</MappedKeyBlock>
					<MappedKeyBlock $pressed={false}>D</MappedKeyBlock>
				</div>
			</MovementInstructionsContainer>
			<MovementInstructionsContainer
				$reverse={true}
				style={{ position: 'fixed', right: '0', top: '0' }}
			>
				<div>
					<FAIcon icon={faArrowsUpDown} style={{ marginRight: '4px' }} /> Camera
					Height
				</div>
				<div>
					<MappedKeyBlock $pressed={false} style={{ width: '50px' }}>
						L Shift
					</MappedKeyBlock>
					<span style={{ margin: '0 4px' }}>+</span>
					<MappedKeyBlock $pressed={false}>
						<FAIcon icon={faCaretUp} />
					</MappedKeyBlock>
					<MappedKeyBlock $pressed={false}>
						<FAIcon icon={faCaretDown} />
					</MappedKeyBlock>
				</div>
			</MovementInstructionsContainer>
		</div>
	);
};
