/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { ControlsUI, useInputModeStore } from './components/controls.js';
import { HeaderButton, HeaderButtonsContainer } from './components/styled.js';
import React, { useEffect, useState } from 'react';

import { HeaderUI } from './components/header.js';
import { HeadsetUI } from './components/headset.js';
import { IWERIcon } from './components/icons.js';
import { InputLayer } from './scene.js';
import { StyleSheetManager } from 'styled-components';
import { VERSION } from './version.js';
import { XRDevice } from 'iwer';
import { createRoot } from 'react-dom/client';

export class DevUI {
	private inputLayer: InputLayer;
	public devUIContainer: HTMLDivElement;
	public readonly version = VERSION;

	constructor(xrDevice: XRDevice) {
		xrDevice.ipd = 0;
		useInputModeStore.getState().setInputMode(xrDevice.primaryInputMode);
		this.devUIContainer = document.createElement('div');
		this.devUIContainer.style.position = 'fixed';
		this.devUIContainer.style.width = '100vw';
		this.devUIContainer.style.height = '100vh';
		this.devUIContainer.style.top = '50vh';
		this.devUIContainer.style.left = '50vw';
		this.devUIContainer.style.transform = 'translate(-50%, -50%)';
		this.devUIContainer.style.pointerEvents = 'none';
		const devUIShadowRoot = this.devUIContainer.attachShadow({
			mode: 'open',
		});
		this.inputLayer = new InputLayer(xrDevice);
		const root = createRoot(devUIShadowRoot);
		root.render(
			<Overlay
				xrDevice={xrDevice}
				inputLayer={this.inputLayer}
				shadowRoot={devUIShadowRoot}
			/>,
		);

		const installOfferSessionUI = () => {
			const offerSessionUIContainer = document.createElement('div');
			document.body.appendChild(offerSessionUIContainer);
			const offerSessionShadowRoot = offerSessionUIContainer.attachShadow({
				mode: 'open',
			});
			const offerSessionRoot = createRoot(offerSessionShadowRoot);
			offerSessionRoot.render(
				<OfferSessionUI
					xrDevice={xrDevice}
					shadowRoot={offerSessionShadowRoot}
				/>,
			);
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
	shadowRoot: ShadowRoot;
}

const Overlay: React.FC<OverlayProps> = ({
	xrDevice,
	inputLayer,
	shadowRoot,
}) => {
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
		<StyleSheetManager target={shadowRoot} disableCSSOMInjection={true}>
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
		</StyleSheetManager>
	);
};

interface OfferSessionProps {
	xrDevice: XRDevice;
	shadowRoot: ShadowRoot;
}

const OfferSessionUI: React.FC<OfferSessionProps> = ({
	xrDevice,
	shadowRoot,
}) => {
	const [showOffer, setShowOffer] = React.useState(
		xrDevice.sessionOffered && !xrDevice.activeSession,
	);

	React.useEffect(() => {
		const intervalId = setInterval(() => {
			setShowOffer(xrDevice.sessionOffered && !xrDevice.activeSession);
		}, 1000);

		return () => {
			clearInterval(intervalId);
		};
	}, []);

	return (
		<StyleSheetManager target={shadowRoot} disableCSSOMInjection={true}>
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
		</StyleSheetManager>
	);
};

export { VERSION };
