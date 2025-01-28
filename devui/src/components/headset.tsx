/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
	Colors,
	ControlButtonStyles,
	ControlPanel,
	FAIcon,
	InputSuffix,
	SectionBreak,
	ValueInput,
	ValuesContainer,
} from './styled.js';
import {
	faStreetView,
	faVideo,
	faVrCardboard,
} from '@fortawesome/free-solid-svg-icons';

import { InputLayer } from '../scene.js';
import React from 'react';
import { Vector3Input } from './vec3.js';
import { XRDevice } from 'iwer';
import { styled } from 'styled-components';

interface HeadsetProps {
	xrDevice: XRDevice;
	inputLayer: InputLayer;
	pointerLocked: boolean;
}

const HeadsetOptionContainer = styled.div`
	width: 100%;
	display: flex;
	flex-direction: row;
	justify-content: space-between;
	align-items: center;
	margin-top: ${ControlButtonStyles.gap};
	font-size: 12px;
`;

const RangeSelector = styled.input.attrs({ type: 'range' })`
	-webkit-appearance: none;
	appearance: none;
	background: ${Colors.gradientGrey};
	border: 1px solid transparent;
	height: 25px;
	color: ${Colors.textWhite};
	width: ${ControlButtonStyles.widthLong};
	cursor: pointer;
	margin: 0;
	border-radius: 5px;
	padding: 0 10px 0 5px;
	box-sizing: border-box;
	font-size: 10px;

	&::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 8px;
		height: 25px;
		background-color: ${Colors.textWhite};
		border-radius: ${ControlButtonStyles.radiusMiddle};
	}

	&::-moz-range-thumb {
		width: 8px;
		height: 25px;
		background-color: ${Colors.textWhite};
		border-radius: ${ControlButtonStyles.radiusMiddle};
	}

	&::-ms-thumb {
		width: 8px;
		height: 25px;
		background-color: ${Colors.textWhite};
		border-radius: ${ControlButtonStyles.radiusMiddle};
	}
`;

export const HeadsetUI: React.FC<HeadsetProps> = ({
	xrDevice,
	inputLayer,
	pointerLocked,
}) => {
	const [fovy, setFovy] = React.useState(xrDevice.fovy);
	return (
		<ControlPanel style={{ left: '8px', top: '8px' }}>
			<div
				style={{
					display: 'flex',
					flexDirection: 'row',
					justifyContent: 'space-between',
					alignItems: 'center',
					height: '20px',
				}}
			>
				<div
					style={{
						fontSize: '13px',
						display: 'flex',
						flexDirection: 'row',
						alignItems: 'center',
						justifyItems: 'start',
					}}
				>
					<FAIcon icon={faVrCardboard} style={{ marginRight: '5px' }} />
					<div style={{ alignItems: 'end' }}>{xrDevice.name}</div>
				</div>
				<div
					style={{
						display: 'flex',
						flexDirection: 'row',
						gap: '1px',
					}}
				></div>
			</div>
			<SectionBreak />
			<Vector3Input
				vector={inputLayer.combinedCameraPosition}
				icon={faStreetView}
			/>

			{!pointerLocked && (
				<HeadsetOptionContainer>
					<FAIcon icon={faVideo} style={{ marginRight: '5px' }} />
					<ValuesContainer>
						<div
							style={{
								position: 'relative',
								display: 'inline-block',
								height: '25px',
							}}
						>
							<ValueInput
								type="text"
								value={((fovy / Math.PI) * 180).toFixed(0) + '°'}
								readOnly={true}
								style={{ width: '73px' }}
							/>
							<InputSuffix>FOV-Y</InputSuffix>
						</div>
						<div
							style={{
								position: 'relative',
								display: 'inline-block',
							}}
						>
							<RangeSelector
								value={fovy}
								onChange={(e) => {
									const value = Number(e.target.value);
									setFovy(value);
									xrDevice.fovy = value;
								}}
								min={Math.PI / 6}
								max={Math.PI / 1.5}
								step={Math.PI / 48}
								style={{ width: '80px' }}
							/>
						</div>
					</ValuesContainer>
				</HeadsetOptionContainer>
			)}
		</ControlPanel>
	);
};
