/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { HeaderButton, HeaderButtonsContainer } from './components/styled.js';
import React, { useEffect, useState } from 'react';

import { ControlsUI } from './components/controls.js';
import { HeaderUI } from './components/header.js';
import { HeadsetUI } from './components/headset.js';
import { IWERIcon } from './components/icons.js';
import { InputLayer } from './scene.js';
import { VERSION } from './version.js';
import { XRDevice } from 'iwer';
import { createRoot } from 'react-dom/client';

export class DevUI {
	private inputLayer: InputLayer;
	public devUIContainer: HTMLDivElement;
	public readonly version = VERSION;

	constructor(xrDevice: XRDevice) {
		xrDevice.ipd = 0;
		this.devUIContainer = document.createElement('div');
		this.devUIContainer.style.position = 'fixed';
		this.devUIContainer.style.width = '100vw';
		this.devUIContainer.style.height = '100vh';
		this.devUIContainer.style.top = '50vh';
		this.devUIContainer.style.left = '50vw';
		this.devUIContainer.style.transform = 'translate(-50%, -50%)';
		this.devUIContainer.style.pointerEvents = 'none';
		this.inputLayer = new InputLayer(xrDevice);
		const root = createRoot(this.devUIContainer);
		root.render(<Overlay xrDevice={xrDevice} inputLayer={this.inputLayer} />);

		const installOfferSessionUI = () => {
			const offerSessionUIContainer = document.createElement('div');
			document.body.appendChild(offerSessionUIContainer);
			const offerSessionRoot = createRoot(offerSessionUIContainer);
			offerSessionRoot.render(<OfferSessionUI xrDevice={xrDevice} />);
		};

		if (document.body) {
			installOfferSessionUI();
		} else {
			window.onload = installOfferSessionUI;
		}
	}

	render(time: number) {
		this.inputLayer.renderScene(time);
	}

	get devUICanvas() {
		return this.inputLayer.domElement;
	}
}

interface OverlayProps {
	xrDevice: XRDevice;
	inputLayer: InputLayer;
}

const Overlay: React.FC<OverlayProps> = ({ xrDevice, inputLayer }) => {
	const [pointerLocked, setPointerLocked] = useState(false);

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
				pointerEvents: 'none',
			}}
		>
			<HeaderUI xrDevice={xrDevice} inputLayer={inputLayer} />
			<HeadsetUI
				xrDevice={xrDevice}
				inputLayer={inputLayer}
				pointerLocked={pointerLocked}
			/>
			<ControlsUI
				xrDevice={xrDevice}
				inputLayer={inputLayer}
				pointerLocked={pointerLocked}
			/>
		</div>
	);
};

interface OfferSessionProps {
	xrDevice: XRDevice;
}

const OfferSessionUI: React.FC<OfferSessionProps> = ({ xrDevice }) => {
	const [showOffer, setShowOffer] = React.useState(
		xrDevice.sessionOffered && !xrDevice.activeSession,
	);

	React.useEffect(() => {
		setInterval(() => {
			setShowOffer(xrDevice.sessionOffered && !xrDevice.activeSession);
		}, 1000);
	}, []);

	return (
		<HeaderButtonsContainer
			style={{
				zIndex: 899,
				position: 'fixed',
				top: showOffer ? '8px' : '-30px',
				display: 'flex',
				flexDirection: 'row',
				alignItems: 'center',
				justifyItems: 'space-between',
				left: '50vw',
				transform: 'translateX(-50%)',
				transition: 'all 0.2s ease-in-out',
				paddingLeft: '5px',
				gap: '3px',
			}}
		>
			<IWERIcon size={24} />
			<HeaderButton
				onClick={() => {
					xrDevice.grantOfferedSession();
				}}
				style={{
					fontSize: '16px',
				}}
			>
				Enter XR
			</HeaderButton>
		</HeaderButtonsContainer>
	);
};

export { VERSION };
