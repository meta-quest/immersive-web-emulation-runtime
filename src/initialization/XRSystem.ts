/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { WebXRFeatures, XRDevice } from '../device/XRDevice.js';
import {
	XRSession,
	XRSessionInit,
	XRSessionMode,
} from '../session/XRSession.js';

export const PRIVATE = Symbol('@immersive-web-emulation-runtime/xr-system');

export class XRSystem extends EventTarget {
	[PRIVATE]: {
		device: XRDevice;
		activeSession?: XRSession;
	};

	constructor(device: XRDevice) {
		super();
		this[PRIVATE] = { device };
		// Initialize device change monitoring here if applicable
	}

	isSessionSupported(mode: XRSessionMode): Promise<boolean> {
		return new Promise<boolean>((resolve, _reject) => {
			if (mode === XRSessionMode.Inline) {
				resolve(true);
			} else {
				// Check for spatial tracking permission if necessary
				resolve(this[PRIVATE].device.supportedSessionModes.includes(mode));
			}
		});
	}

	requestSession(
		mode: XRSessionMode,
		options: XRSessionInit = {},
	): Promise<XRSession> {
		return new Promise<XRSession>((resolve, reject) => {
			this.isSessionSupported(mode)
				.then((isSupported) => {
					if (!isSupported) {
						reject(
							new DOMException(
								'The requested XRSession mode is not supported.',
								'NotSupportedError',
							),
						);
						return;
					}

					// Check for active sessions and other constraints here
					if (this[PRIVATE].activeSession) {
						reject(
							new DOMException(
								'An active XRSession already exists.',
								'InvalidStateError',
							),
						);
						return;
					}

					// Handle required and optional features
					const { requiredFeatures = [], optionalFeatures = [] } = options;
					const { supportedFeatures } = this[PRIVATE].device;

					// Check if all required features are supported
					const allRequiredSupported = requiredFeatures.every((feature) =>
						supportedFeatures.includes(feature),
					);
					if (!allRequiredSupported) {
						reject(
							new Error(
								'One or more required features are not supported by the device.',
							),
						);
						return;
					}

					// Filter out unsupported optional features
					const supportedOptionalFeatures = optionalFeatures.filter((feature) =>
						supportedFeatures.includes(feature),
					);

					// Combine required and supported optional features into enabled features
					const enabledFeatures = Array.from(
						new Set([
							...requiredFeatures,
							...supportedOptionalFeatures,
							WebXRFeatures.Viewer,
							WebXRFeatures.Local,
						]),
					);

					// Proceed with session creation
					const session = new XRSession(
						this[PRIVATE].device,
						mode,
						enabledFeatures,
					);
					this[PRIVATE].activeSession = session;

					// Listen for session end to clear the active session
					session.addEventListener('end', () => {
						this[PRIVATE].activeSession = undefined;
					});

					resolve(session);
				})
				.catch(reject);
		});
	}
}
