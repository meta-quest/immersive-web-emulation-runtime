/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
	XRReferenceSpace,
	XRReferenceSpaceType,
} from '../../src/spaces/XRReferenceSpace';
import { XRSession, XRSessionMode } from '../../src/session/XRSession';

import { XRDevice } from '../../src/device/XRDevice';
import { XRFrame } from '../../src/frameloop/XRFrame';
import { XRPose } from '../../src/pose/XRPose';
import { XRRenderStateInit } from '../../src/session/XRRenderState';
import { XRSpace } from '../../src/spaces/XRSpace';
import { XRSystem } from '../../src/initialization/XRSystem';
import { XRViewerPose } from '../../src/pose/XRViewerPose';
import { XRWebGLLayer } from '../../src/layers/XRWebGLLayer';
import { metaQuest3 } from '../../src/device/configs/headset/meta';

describe('XRFrame', () => {
	let xrDevice: XRDevice;
	let xrSystem: XRSystem;
	let xrSession: XRSession;
	let xrRenderStateInit: XRRenderStateInit;
	let refSpace: XRReferenceSpace;
	let testSpace: XRSpace;

	beforeEach(async () => {
		jest.useFakeTimers();
		// Mocking the WebGL2RenderingContext
		const mockGetParameter = jest.fn((param) => {
			switch (param) {
				case 0:
					return [0, 0, 0, 0]; // Dummy clear color value
				case 1:
					return 1; // Dummy clear depth value
				case 2:
					return 0; // Dummy clear stencil value
				default:
					return null;
			}
		});
		const MockWebGL2RenderingContext = {
			getParameter: mockGetParameter,
			clearColor: jest.fn(),
			clearDepth: jest.fn(),
			clearStencil: jest.fn(),
			clear: jest.fn(),
			COLOR_CLEAR_VALUE: 0,
			DEPTH_CLEAR_VALUE: 1,
			STENCIL_CLEAR_VALUE: 2,
			DEPTH_BUFFER_BIT: 3,
			COLOR_BUFFER_BIT: 4,
			STENCIL_BUFFER_BIT: 5,
			canvas: document.createElement('canvas'),
		};
		xrDevice = new XRDevice(metaQuest3);
		xrSystem = new XRSystem(xrDevice);
		xrSession = await xrSystem.requestSession(XRSessionMode.ImmersiveVR);
		refSpace = await xrSession.requestReferenceSpace(
			XRReferenceSpaceType.Local,
		);
		testSpace = new XRSpace(refSpace);
		xrRenderStateInit = {};
		xrRenderStateInit.baseLayer = new XRWebGLLayer(
			xrSession,
			MockWebGL2RenderingContext as any,
		);
		xrSession.updateRenderState(xrRenderStateInit);
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	test('XRFrame.getPose methods should return value when accessed inside the requestAnimationFrame callback', () => {
		let viewerPose: XRViewerPose | null = null;
		let testPose: XRPose | null = null;
		const onFrame = (_time: number, frame: XRFrame) => {
			viewerPose = frame.getViewerPose(refSpace);
			testPose = frame.getPose(testSpace, refSpace);
			xrSession.end();
		};
		xrSession.requestAnimationFrame(onFrame);
		jest.runAllTimers();
		expect(viewerPose).toBeDefined();
		expect(testPose).toBeDefined();
	});

	test('XRFrame.getPose methods should throw InvalidStateError when accessed outside the requestAnimationFrame callback', () => {
		let lastFrame: XRFrame | null = null;
		const onFrame = (_time: number, frame: XRFrame) => {
			lastFrame = frame;
			xrSession.end();
		};
		xrSession.requestAnimationFrame(onFrame);
		jest.runAllTimers();
		expect(lastFrame).toBeDefined();
		expect(() => lastFrame!.getViewerPose(refSpace)).toThrow();
		expect(() => lastFrame!.getPose(testSpace, refSpace)).toThrow();
	});
});
