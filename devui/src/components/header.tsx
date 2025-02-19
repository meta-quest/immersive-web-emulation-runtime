/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { BoxIcon, IWERIcon, MeshIcon, PlaneIcon } from './icons.js';
import {
	Button,
	Colors,
	ControlButtonStyles,
	ControlPanel,
	FAIcon,
	HeaderButton,
	HeaderButtonsContainer,
	PanelHeaderButton,
	SectionBreak,
} from './styled.js';
import {
	faBug,
	faCirclePlay,
	faCircleXmark,
	faGamepad,
	faHand,
	faPersonShelter,
	faRightFromBracket,
	faRotateLeft,
} from '@fortawesome/free-solid-svg-icons';

import { InputLayer } from '../scene.js';
import React from 'react';
import { XRDevice } from 'iwer';
import { create } from 'zustand';
import { styled } from 'styled-components';
import { useInputModeStore } from './controls.js';

const VersionTableCol1 = styled.td`
	text-align: right;
	color: ${Colors.textWhite};
	padding: 0 8px 0 0;
	font-weight: bold;
`;

const VersionTableCol2 = styled.td`
	text-align: left;
	color: ${Colors.textGrey};
	padding: 0;
`;

const envNames = [
	'meeting_room',
	'living_room',
	'music_room',
	'office_large',
	'office_small',
];

type HeaderStateStore = {
	infoPanelOpen: boolean;
	envDropDownOpen: boolean;
	setInfoPanelOpen: (open: boolean) => void;
	setEnvDropDownOpen: (open: boolean) => void;
};

export const useHeaderStateStore = create<HeaderStateStore>((set) => ({
	infoPanelOpen: false,
	envDropDownOpen: false,
	setInfoPanelOpen: (open: boolean) => set(() => ({ infoPanelOpen: open })),
	setEnvDropDownOpen: (open: boolean) => set(() => ({ envDropDownOpen: open })),
}));

function underscoreToTitleCase(str: string): string {
	return str
		.split('_')
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ');
}

interface HeaderUIProps {
	xrDevice: XRDevice;
	inputLayer: InputLayer;
}

export const HeaderUI: React.FC<HeaderUIProps> = ({ xrDevice, inputLayer }) => {
	const [planesVisible, setPlanesVisible] = React.useState(
		Boolean(xrDevice.sem?.planesVisible),
	);
	const [boxesVisible, setBoxesVisible] = React.useState(
		Boolean(xrDevice.sem?.boundingBoxesVisible),
	);
	const [meshesVisible, setMeshesVisible] = React.useState(
		Boolean(xrDevice.sem?.meshesVisible),
	);
	const { inputMode, setInputMode } = useInputModeStore();
	const {
		infoPanelOpen,
		setInfoPanelOpen,
		envDropDownOpen,
		setEnvDropDownOpen,
	} = useHeaderStateStore();

	return (
		<div
			style={{
				display: 'flex',
				justifyContent: 'center',
				flexDirection: 'row',
				alignItems: 'center',
				gap: '6px',
				padding: '8px',
			}}
		>
			<HeaderButtonsContainer>
				<div
					style={{
						display: 'flex',
						flexDirection: 'row',
						gap: '1px',
					}}
				>
					<HeaderButton
						title="Click to reset device transforms"
						onClick={() => {
							inputLayer.resetDeviceTransforms();
						}}
					>
						<FAIcon icon={faRotateLeft} $size={16} />
					</HeaderButton>
					<HeaderButton
						title="Click to activate play mode"
						onClick={() => {
							inputLayer.lockPointer();
							setEnvDropDownOpen(false);
							setInfoPanelOpen(false);
						}}
					>
						<FAIcon icon={faCirclePlay} $size={16} />
					</HeaderButton>
					<HeaderButton
						title="Click to toggle input mode"
						onClick={() => {
							if (inputMode === 'controller') {
								setInputMode('hand');
								xrDevice.primaryInputMode = 'hand';
							} else {
								setInputMode('controller');
								xrDevice.primaryInputMode = 'controller';
							}
						}}
					>
						<FAIcon
							icon={inputMode === 'controller' ? faGamepad : faHand}
							$size={16}
						/>
					</HeaderButton>
					{xrDevice.sem && (
						<>
							<SectionBreak $horizontal={false} />
							<HeaderButton
								title="Click to select/change emulated environment"
								onClick={() => setEnvDropDownOpen(!envDropDownOpen)}
							>
								<FAIcon icon={faPersonShelter} $size={16} />
							</HeaderButton>
							<HeaderButton
								title="Click to toggle visibility of planes"
								onClick={() => {
									xrDevice.sem!.planesVisible = !planesVisible;
									setPlanesVisible(!planesVisible);
								}}
							>
								<PlaneIcon
									size={16}
									color={planesVisible ? Colors.textWhite : Colors.textGrey}
								/>
							</HeaderButton>
							<HeaderButton
								title="Click to toggle visibility of bounding boxes"
								onClick={() => {
									xrDevice.sem!.boundingBoxesVisible = !boxesVisible;
									setBoxesVisible(!boxesVisible);
								}}
							>
								<BoxIcon
									size={16}
									color={boxesVisible ? Colors.textWhite : Colors.textGrey}
								/>
							</HeaderButton>
							<HeaderButton
								title="Click to toggle visibility of meshes"
								onClick={() => {
									xrDevice.sem!.meshesVisible = !meshesVisible;
									setMeshesVisible(!meshesVisible);
								}}
							>
								<MeshIcon
									size={16}
									color={meshesVisible ? Colors.textWhite : Colors.textGrey}
								/>
							</HeaderButton>
						</>
					)}
					<SectionBreak $horizontal={false} />
					<HeaderButton
						title="Click to exit XR session"
						onClick={() => {
							const xrSession = xrDevice.activeSession;
							xrSession?.end();
						}}
					>
						<FAIcon icon={faRightFromBracket} $size={16} />
					</HeaderButton>
				</div>
			</HeaderButtonsContainer>
			<HeaderButtonsContainer>
				<div
					style={{
						display: 'flex',
						flexDirection: 'row',
						gap: '1px',
					}}
				>
					<HeaderButton
						title="About IWER"
						onClick={() => {
							setInfoPanelOpen(!infoPanelOpen);
						}}
					>
						<IWERIcon size={16} />
					</HeaderButton>
					<HeaderButton
						title="Report issues"
						onClick={() => {
							window.open(
								'https://github.com/meta-quest/immersive-web-emulation-runtime/issues',
								'_blank',
							);
						}}
					>
						<FAIcon icon={faBug} $size={16} />
					</HeaderButton>
				</div>
			</HeaderButtonsContainer>
			{infoPanelOpen && (
				<ControlPanel
					style={{
						top: '50vh',
						left: '50vw',
						transform: 'translate(-50%, -50%)',
						maxWidth: '240px',
						gap: '4px',
					}}
				>
					<div style={{ display: 'flex', justifyContent: 'end' }}>
						<PanelHeaderButton
							$isRed={true}
							onClick={() => {
								setInfoPanelOpen(false);
							}}
						>
							<FAIcon icon={faCircleXmark} />
						</PanelHeaderButton>
					</div>
					<div style={{ display: 'flex', justifyContent: 'center' }}>
						<IWERIcon size={100} />
					</div>
					<p style={{ textAlign: 'center', padding: '0 5px', margin: '0' }}>
						<b>Immersive Web Emulation Runtime</b> (IWER) is a free, open-source
						WebXR developer tool created by Meta Platforms, Inc.
					</p>
					<table
						style={{
							width: '100%',
							borderCollapse: 'collapse',
							display: 'flex',
							justifyContent: 'center',
							fontSize: '12px',
							padding: '8px',
						}}
					>
						<tbody>
							<tr>
								<VersionTableCol1>IWER</VersionTableCol1>
								<VersionTableCol2>v{xrDevice.version}</VersionTableCol2>
							</tr>
							<tr>
								<VersionTableCol1>DevUI</VersionTableCol1>
								<VersionTableCol2>v{xrDevice.devui!.version}</VersionTableCol2>
							</tr>
							{xrDevice.sem && (
								<tr>
									<VersionTableCol1>SEM</VersionTableCol1>
									<VersionTableCol2>v{xrDevice.sem.version}</VersionTableCol2>
								</tr>
							)}
						</tbody>
					</table>
					<Button
						style={{
							borderRadius: ControlButtonStyles.radiusSolo,
						}}
						onClick={() => {
							window.open(
								'https://github.com/meta-quest/immersive-web-emulation-runtime/blob/main/LICENSE',
								'_blank',
							);
						}}
					>
						MIT License
					</Button>
					<Button
						style={{
							borderRadius: ControlButtonStyles.radiusSolo,
						}}
						onClick={() => {
							window.open(
								'https://github.com/meta-quest/immersive-web-emulation-runtime',
								'_blank',
							);
						}}
					>
						View Source on GitHub
					</Button>
				</ControlPanel>
			)}
			{envDropDownOpen && (
				<ControlPanel
					style={{
						position: 'absolute',
						top: '40px',
					}}
				>
					{envNames.map((name) => (
						<div key={name}>
							<HeaderButton
								style={{
									fontSize: '12px',
									width: '100%',
									justifyContent: 'start',
									borderRadius: '8px',
								}}
								onClick={() => {
									// @ts-ignore
									xrDevice.sem!.loadDefaultEnvironment(name);
								}}
							>
								{underscoreToTitleCase(name)}
							</HeaderButton>
						</div>
					))}
				</ControlPanel>
			)}
		</div>
	);
};
