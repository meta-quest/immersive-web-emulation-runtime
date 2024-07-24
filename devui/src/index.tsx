import { DEFAULT_KEYMAP, KeyMapMenu, KeyMapType } from './components/mapper.js';
import React, { useEffect, useState } from 'react';

import { ControlsUI } from './components/controls.js';
import { FOVMenu } from './components/fov.js';
import { HeaderUI } from './components/header.js';
import { InputLayer } from './scene.js';
import { XRDevice } from 'iwer';
import { createRoot } from 'react-dom/client';

const PRIVATE = Symbol('@@iwer/devui/devui');

export class DevUI {
	[PRIVATE]: {
		xrDevice: XRDevice;
		inputLayer: InputLayer;
	};

	constructor(xrDevice: XRDevice) {
		xrDevice.ipd = 0;
		const canvasContainer = xrDevice.canvasContainer;
		const devuiContainer = document.createElement('div');
		devuiContainer.style.position = 'fixed';
		devuiContainer.style.width = '100%';
		devuiContainer.style.height = '100%';
		devuiContainer.style.top = '0';
		devuiContainer.style.left = '0';
		devuiContainer.style.display = 'flex';
		devuiContainer.style.justifyContent = 'center';
		devuiContainer.style.alignItems = 'center';
		devuiContainer.style.overflow = 'hidden';
		devuiContainer.style.pointerEvents = 'none';
		devuiContainer.style.zIndex = '3';
		canvasContainer.appendChild(devuiContainer);
		const inputLayer = new InputLayer(xrDevice);
		const inputLayerElement = inputLayer.domElement;
		inputLayerElement.style.position = 'fixed';
		inputLayerElement.style.width = '100%';
		inputLayerElement.style.height = '100%';
		inputLayerElement.style.top = '0';
		inputLayerElement.style.left = '0';
		inputLayerElement.style.zIndex = '2';
		canvasContainer.appendChild(inputLayerElement);
		const root = createRoot(devuiContainer);
		root.render(<Overlay xrDevice={xrDevice} inputLayer={inputLayer} />);
		this[PRIVATE] = {
			xrDevice,
			inputLayer,
		};
	}
}

interface OverlayProps {
	xrDevice: XRDevice;
	inputLayer: InputLayer;
}

const Overlay: React.FC<OverlayProps> = ({ xrDevice, inputLayer }) => {
	const [pointerLocked, setPointerLocked] = useState(false);
	const [keyMap, setKeyMap] = useState<KeyMapType>(DEFAULT_KEYMAP);
	const [keyMapOpen, setKeyMapOpen] = useState(false);
	const [fovSettingOpen, setFovSettingOpen] = useState(false);

	useEffect(() => {
		const pointerLockChangeHandler = () => {
			const locked =
				document.pointerLockElement ||
				// @ts-ignore
				document.mozPointerLockElement ||
				// @ts-ignore
				document.webkitPointerLockElement;
			setPointerLocked(!!locked);
		};
		document.addEventListener(
			'pointerlockchange',
			pointerLockChangeHandler,
			false,
		);
		document.addEventListener(
			'mozpointerlockchange',
			pointerLockChangeHandler,
			false,
		);
		document.addEventListener(
			'webkitpointerlockchange',
			pointerLockChangeHandler,
			false,
		);

		return () => {
			document.removeEventListener(
				'pointerlockchange',
				pointerLockChangeHandler,
				false,
			);
			document.removeEventListener(
				'mozpointerlockchange',
				pointerLockChangeHandler,
				false,
			);
			document.removeEventListener(
				'webkitpointerlockchange',
				pointerLockChangeHandler,
				false,
			);
		};
	}, []);

	return (
		<div
			style={{
				width: '100vw',
				height: '100vh',
				display: 'flex',
				flexDirection: 'column',
				justifyContent: 'space-between',
			}}
		>
			<HeaderUI
				xrDevice={xrDevice}
				inputLayer={inputLayer}
				keyMapOpen={keyMapOpen}
				setKeyMapOpen={setKeyMapOpen}
				fovSettingOpen={fovSettingOpen}
				setFovSettingOpen={setFovSettingOpen}
			/>
			{keyMapOpen && <KeyMapMenu keyMap={keyMap} setKeyMap={setKeyMap} />}
			{fovSettingOpen && (
				<FOVMenu xrDevice={xrDevice} inputLayer={inputLayer} />
			)}
			<ControlsUI
				xrDevice={xrDevice}
				keyMap={keyMap}
				pointerLocked={pointerLocked}
			/>
		</div>
	);
};
