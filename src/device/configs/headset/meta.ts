/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { WebXRFeatures, XRDeviceConfig } from '../../XRDevice.js';
import {
	metaQuestTouchPlus,
	metaQuestTouchPro,
	oculusTouchV2,
	oculusTouchV3,
} from '../controller/meta.js';

import { XRSessionMode } from '../../../session/XRSession.js';

export const oculusQuest1: XRDeviceConfig = {
	name: 'Oculus Quest 1',
	controllerConfig: oculusTouchV2,
	supportedSessionModes: [
		XRSessionMode.Inline,
		XRSessionMode.ImmersiveVR,
		XRSessionMode.ImmersiveAR,
	],
	supportedFeatures: [
		WebXRFeatures.Viewer,
		WebXRFeatures.Local,
		WebXRFeatures.LocalFloor,
		WebXRFeatures.BoundedFloor,
		WebXRFeatures.Unbounded,
		WebXRFeatures.Anchors,
		WebXRFeatures.PlaneDetection,
		WebXRFeatures.HandTracking,
	],
	supportedFrameRates: [72, 80, 90],
	isSystemKeyboardSupported: true,
	internalNominalFrameRate: 72,
};

export const metaQuest2: XRDeviceConfig = {
	name: 'Meta Quest 2',
	controllerConfig: oculusTouchV3,
	supportedSessionModes: [
		XRSessionMode.Inline,
		XRSessionMode.ImmersiveVR,
		XRSessionMode.ImmersiveAR,
	],
	supportedFeatures: [
		WebXRFeatures.Viewer,
		WebXRFeatures.Local,
		WebXRFeatures.LocalFloor,
		WebXRFeatures.BoundedFloor,
		WebXRFeatures.Unbounded,
		WebXRFeatures.Anchors,
		WebXRFeatures.PlaneDetection,
		WebXRFeatures.MeshDetection,
		WebXRFeatures.HitTest,
		WebXRFeatures.HandTracking,
	],
	supportedFrameRates: [72, 80, 90, 120],
	isSystemKeyboardSupported: true,
	internalNominalFrameRate: 72,
};

export const metaQuestPro: XRDeviceConfig = {
	name: 'Meta Quest Pro',
	controllerConfig: metaQuestTouchPro,
	supportedSessionModes: [
		XRSessionMode.Inline,
		XRSessionMode.ImmersiveVR,
		XRSessionMode.ImmersiveAR,
	],
	supportedFeatures: [
		WebXRFeatures.Viewer,
		WebXRFeatures.Local,
		WebXRFeatures.LocalFloor,
		WebXRFeatures.BoundedFloor,
		WebXRFeatures.Unbounded,
		WebXRFeatures.Anchors,
		WebXRFeatures.PlaneDetection,
		WebXRFeatures.MeshDetection,
		WebXRFeatures.HitTest,
		WebXRFeatures.HandTracking,
	],
	supportedFrameRates: [72, 80, 90, 120],
	isSystemKeyboardSupported: true,
	internalNominalFrameRate: 90,
};

export const metaQuest3: XRDeviceConfig = {
	name: 'Meta Quest 3',
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
		WebXRFeatures.BoundedFloor,
		WebXRFeatures.Unbounded,
		WebXRFeatures.Anchors,
		WebXRFeatures.PlaneDetection,
		WebXRFeatures.MeshDetection,
		WebXRFeatures.HitTest,
		WebXRFeatures.HandTracking,
		WebXRFeatures.DepthSensing,
	],
	supportedFrameRates: [72, 80, 90, 120],
	isSystemKeyboardSupported: true,
	internalNominalFrameRate: 90,
};
