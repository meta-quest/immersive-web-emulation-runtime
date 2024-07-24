import { Button, ButtonGroup, RangeSelector } from './styled.js';
import React, { useState } from 'react';

import { InputLayer } from '../scene.js';
import { XRDevice } from 'iwer';
import styled from 'styled-components';

interface FOVMenuProps {
	xrDevice: XRDevice;
	inputLayer: InputLayer;
}

const FovSettingContainer = styled.div`
	display: flex;
	justify-content: center;
	pointer-events: all;
	position: fixed;
	display: flex;
	top: 40px;
	left: calc(50vw - 156px);
	width: 312px;
`;

export const FOVMenu: React.FC<FOVMenuProps> = ({ xrDevice, inputLayer }) => {
	const [fovy, setFovy] = useState(xrDevice.fovy);
	return (
		<FovSettingContainer>
			<ButtonGroup $reverse={false}>
				<Button $reverse={false} disabled={true}>
					FOV-Y
				</Button>
				<RangeSelector
					$reverse={false}
					value={fovy}
					style={{ width: '100px', borderRadius: '2px' }}
					onChange={(e) => {
						const value = Number(e.target.value);
						setFovy(value);
						xrDevice.fovy = value;
						inputLayer.syncFovy();
						inputLayer.renderScene();
					}}
					min={Math.PI / 6}
					max={Math.PI / 1.5}
					step={Math.PI / 48}
				/>
				<Button $reverse={false} disabled={true}>
					{((fovy / Math.PI) * 180).toFixed(2)}°
				</Button>
			</ButtonGroup>
		</FovSettingContainer>
	);
};
