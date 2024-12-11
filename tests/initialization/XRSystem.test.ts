/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRDevice, XRDeviceConfig } from '../../src/device/XRDevice';
import {
	XREnvironmentBlendMode,
	XRInteractionMode,
	XRSessionMode,
} from '../../src/session/XRSession';

import { XRSystem } from '../../src/initialization/XRSystem';
import { metaQuestTouchPlus } from '../../src/device/configs/controller/meta';

describe('XRSystem', () => {
	let xrDevice: XRDevice;
	let xrSystem: XRSystem;
	const arvrDeviceConfig: XRDeviceConfig = {
		name: 'AR VR Device',
		controllerConfig: metaQuestTouchPlus,
		supportedSessionModes: ['inline', 'immersive-vr', 'immersive-ar'],
		supportedFeatures: ['viewer', 'local', 'local-floor', 'hand-tracking'],
		supportedFrameRates: [72, 80, 90, 120],
		isSystemKeyboardSupported: true,
		internalNominalFrameRate: 90,
		environmentBlendModes: {
			'immersive-vr': XREnvironmentBlendMode.Opaque,
			'immersive-ar': XREnvironmentBlendMode.AlphaBlend,
		},
		interactionMode: XRInteractionMode.WorldSpace,
		userAgent: 'Test user agent',
	};

	const vrOnlyDeviceConfig: XRDeviceConfig = {
		name: 'VR Device',
		controllerConfig: metaQuestTouchPlus,
		supportedSessionModes: ['inline', 'immersive-vr'],
		supportedFeatures: arvrDeviceConfig.supportedFeatures,
		supportedFrameRates: arvrDeviceConfig.supportedFrameRates,
		isSystemKeyboardSupported: true,
		internalNominalFrameRate: 90,
		environmentBlendModes: {
			'immersive-vr': XREnvironmentBlendMode.Opaque,
			'immersive-ar': XREnvironmentBlendMode.AlphaBlend,
		},
		interactionMode: XRInteractionMode.WorldSpace,
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
				requiredFeatures: ['anchors'],
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
		expect(session.enabledFeatures).toContain('viewer');
		expect(session.enabledFeatures).toContain('local');
	});

	test('requestSession should return XRSession with correct list of enabled features', async () => {
		xrDevice = new XRDevice(arvrDeviceConfig);
		xrSystem = new XRSystem(xrDevice);
		const session = await xrSystem.requestSession(
			'immersive-ar' as XRSessionMode,
			{
				requiredFeatures: ['hand-tracking'],
				optionalFeatures: ['anchors'],
			},
		);
		expect(session).not.toBeNull();
		expect(session.enabledFeatures).toContain('hand-tracking');
		expect(session.enabledFeatures).not.toContain('anchors');
	});
});
