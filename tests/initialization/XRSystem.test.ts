/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { WebXRFeatures, XRDevice } from '../../src/device/XRDevice';

import { XRSessionMode } from '../../src/session/XRSession';
import { XRSystem } from '../../src/initialization/XRSystem';
import { metaQuestTouchPlus } from '../../src/device/configs/controller/meta';

describe('XRSystem', () => {
	let xrDevice: XRDevice;
	let xrSystem: XRSystem;
	const arvrDeviceConfig = {
		name: 'AR VR Device',
		controllerConfig: metaQuestTouchPlus,
		supportedSessionModes: [
			XRSessionMode.Inline,
			XRSessionMode.ImmersiveVR,
			XRSessionMode.ImmersiveAR,
		],
		supportedFeatures: [
			WebXRFeatures.Viewer,
			WebXRFeatures.Local,
			WebXRFeatures.LocalFloor,
			WebXRFeatures.HandTracking,
		],
		supportedFrameRates: [72, 80, 90, 120],
		isSystemKeyboardSupported: true,
		internalNominalFrameRate: 90,
		userAgent: 'Test user agent',
	};

	const vrOnlyDeviceConfig = {
		name: 'VR Device',
		controllerConfig: metaQuestTouchPlus,
		supportedSessionModes: [XRSessionMode.Inline, XRSessionMode.ImmersiveVR],
		supportedFeatures: arvrDeviceConfig.supportedFeatures,
		supportedFrameRates: arvrDeviceConfig.supportedFrameRates,
		isSystemKeyboardSupported: true,
		internalNominalFrameRate: 90,
		userAgent: 'Test user agent',
	};

	test('isSessionSupported should resolve with correct value for ARVR device', async () => {
		xrDevice = new XRDevice(arvrDeviceConfig);
		xrSystem = new XRSystem(xrDevice);

		const vrSupportPromise = xrSystem.isSessionSupported(
			'immersive-vr' as XRSessionMode,
		);
		await expect(vrSupportPromise).resolves.toBeTruthy();
		const arSupportPromise = xrSystem.isSessionSupported(
			'immersive-ar' as XRSessionMode,
		);
		await expect(arSupportPromise).resolves.toBeTruthy();
	});

	test('isSessionSupported should resolve with correct value for VR-only device', async () => {
		xrDevice = new XRDevice(vrOnlyDeviceConfig);
		xrSystem = new XRSystem(xrDevice);
		const vrSupportPromise = xrSystem.isSessionSupported(
			'immersive-vr' as XRSessionMode,
		);
		await expect(vrSupportPromise).resolves.toBeTruthy();
		const arSupportPromise = xrSystem.isSessionSupported(
			'immersive-ar' as XRSessionMode,
		);
		await expect(arSupportPromise).resolves.toBeFalsy();
	});

	test('requestSession should reject unsupported session mode', async () => {
		xrDevice = new XRDevice(vrOnlyDeviceConfig);
		xrSystem = new XRSystem(xrDevice);
		await expect(
			xrSystem.requestSession('immersive-ar' as XRSessionMode),
		).rejects.toMatchObject({ name: 'NotSupportedError' });
	});

	test('requestSession should reject when active session is detected', async () => {
		xrDevice = new XRDevice(arvrDeviceConfig);
		xrSystem = new XRSystem(xrDevice);
		const activeSession = await xrSystem.requestSession(
			'immersive-ar' as XRSessionMode,
		);
		expect(activeSession).not.toBeNull();
		await expect(
			xrSystem.requestSession('immersive-ar' as XRSessionMode),
		).rejects.toMatchObject({ name: 'InvalidStateError' });
	});

	test('requestSession should reject when one or more required features are not supported', async () => {
		xrDevice = new XRDevice(arvrDeviceConfig);
		xrSystem = new XRSystem(xrDevice);
		await expect(
			xrSystem.requestSession('immersive-ar' as XRSessionMode, {
				requiredFeatures: [WebXRFeatures.Anchors],
			}),
		).rejects.toThrow();
	});

	test('requestSession should return XRSession with default features', async () => {
		xrDevice = new XRDevice(arvrDeviceConfig);
		xrSystem = new XRSystem(xrDevice);
		const session = await xrSystem.requestSession(
			'immersive-ar' as XRSessionMode,
		);
		expect(session).not.toBeNull();
		expect(session.enabledFeatures).toContain(WebXRFeatures.Viewer);
		expect(session.enabledFeatures).toContain(WebXRFeatures.Local);
	});

	test('requestSession should return XRSession with correct list of enabled features', async () => {
		xrDevice = new XRDevice(arvrDeviceConfig);
		xrSystem = new XRSystem(xrDevice);
		const session = await xrSystem.requestSession(
			'immersive-ar' as XRSessionMode,
			{
				requiredFeatures: [WebXRFeatures.HandTracking],
				optionalFeatures: [WebXRFeatures.Anchors],
			},
		);
		expect(session).not.toBeNull();
		expect(session.enabledFeatures).toContain(WebXRFeatures.HandTracking);
		expect(session.enabledFeatures).not.toContain(WebXRFeatures.Anchors);
	});
});
