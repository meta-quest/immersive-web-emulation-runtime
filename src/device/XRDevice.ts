/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
	GlobalSpace,
	PRIVATE as XRSPACE_PRIVATE,
	XRSpace,
} from '../spaces/XRSpace.js';
import { Quaternion, Vector3 } from '../utils/Math.js';
import { XRController, XRControllerConfig } from './XRController.js';
import { XREye, XRView } from '../views/XRView.js';
import { XRHandInput, oculusHandConfig } from './XRHandInput.js';
import {
	XRHandedness,
	XRInputSource,
	XRInputSourceArray,
} from '../input/XRInputSource.js';
import { XRLayer, XRWebGLLayer } from '../layers/XRWebGLLayer.js';
import {
	PRIVATE as XRREFERENCESPACE_PRIVATE,
	XRReferenceSpace,
	XRReferenceSpaceType,
} from '../spaces/XRReferenceSpace.js';
import {
	PRIVATE as XRSESSION_PRIVATE,
	XRSession,
	XRSessionMode,
	XRVisibilityState,
} from '../session/XRSession.js';
import { mat4, vec3 } from 'gl-matrix';

import { ActionPlayer } from '../action/ActionPlayer.js';
import { InputSchema } from '../action/ActionRecorder.js';
import { VERSION } from '../version.js';
import { XRFrame } from '../frameloop/XRFrame.js';
import { XRHand } from '../input/XRHand.js';
import { XRInputSourceEvent } from '../events/XRInputSourceEvent.js';
import { XRInputSourcesChangeEvent } from '../events/XRInputSourcesChangeEvent.js';
import { XRJointPose } from '../pose/XRJointPose.js';
import { XRJointSpace } from '../spaces/XRJointSpace.js';
import { XRPose } from '../pose/XRPose.js';
import { XRReferenceSpaceEvent } from '../events/XRReferenceSpaceEvent.js';
import { XRRenderState } from '../session/XRRenderState.js';
import { XRRigidTransform } from '../primitives/XRRigidTransform.js';
import { XRSessionEvent } from '../events/XRSessionEvent.js';
import { XRSystem } from '../initialization/XRSystem.js';
import { XRTrackedInput } from './XRTrackedInput.js';
import { XRViewerPose } from '../pose/XRViewerPose.js';
import { XRViewport } from '../views/XRViewport.js';

export enum WebXRFeatures {
	Viewer = 'viewer',
	Local = 'local',
	LocalFloor = 'local-floor',
	BoundedFloor = 'bounded-floor',
	Unbounded = 'unbounded',
	DomOverlay = 'dom-overlay',
	Anchors = 'anchors',
	PlaneDetection = 'plane-detection',
	MeshDetection = 'mesh-detection',
	HitTest = 'hit-test',
	HandTracking = 'hand-tracking',
	DepthSensing = 'depth-sensing',
}

export interface XRDeviceConfig {
	name: string;
	controllerConfig: XRControllerConfig | undefined;
	supportedSessionModes: XRSessionMode[];
	supportedFeatures: WebXRFeatures[];
	supportedFrameRates: number[];
	isSystemKeyboardSupported: boolean;
	internalNominalFrameRate: number;
	userAgent: string;
}

export interface XRDeviceOptions {
	ipd: number;
	fovy: number;
	stereoEnabled: boolean;
	headsetPosition: Vector3;
	headsetQuaternion: Quaternion;
	canvasContainer: HTMLDivElement;
}

export const PRIVATE = Symbol('@immersive-web-emulation-runtime/xr-device');

const DEFAULTS = {
	ipd: 0.063,
	fovy: Math.PI / 2,
	headsetPosition: new Vector3(0, 1.6, 0),
	headsetQuaternion: new Quaternion(),
	stereoEnabled: false,
};

/**
 * XRDevice is not a standard API class outlined in the WebXR Device API Specifications
 * Instead, it serves as an user-facing interface to control the emulated XR Device
 */
export class XRDevice {
	[PRIVATE]: {
		// device config
		name: string;
		supportedSessionModes: string[];
		supportedFeatures: string[];
		supportedFrameRates: number[];
		isSystemKeyboardSupported: boolean;
		internalNominalFrameRate: number;
		userAgent: string;

		// device state
		position: Vector3;
		quaternion: Quaternion;
		stereoEnabled: boolean;
		ipd: number;
		fovy: number;
		controllers: { [key in XRHandedness]?: XRController };
		hands: { [key in XRHandedness]?: XRHandInput };
		primaryInputMode: 'controller' | 'hand';
		pendingReferenceSpaceReset: boolean;
		visibilityState: XRVisibilityState;
		pendingVisibilityState: XRVisibilityState | null;

		matrix: mat4;
		globalSpace: GlobalSpace;
		viewerSpace: XRReferenceSpace;
		viewSpaces: { [key in XREye]: XRSpace };

		canvasData?: {
			canvas: HTMLCanvasElement;
			parent: HTMLElement | null;
			width: number;
			height: number;
		};
		canvasContainer: HTMLDivElement;

		getViewport: (layer: XRWebGLLayer, view: XRView) => XRViewport;
		updateViews: () => void;
		onBaseLayerSet: (baseLayer: XRWebGLLayer | null) => void;
		onSessionEnd: () => void;
		onFrameStart: (frame: XRFrame) => void;

		// action playback
		actionPlayer?: ActionPlayer;
	};

	constructor(
		deviceConfig: XRDeviceConfig,
		deviceOptions: Partial<XRDeviceOptions> = {},
	) {
		const globalSpace = new GlobalSpace();
		const viewerSpace = new XRReferenceSpace(
			XRReferenceSpaceType.Viewer,
			globalSpace,
		);
		const viewSpaces: { [key in XREye]: XRSpace } = {
			[XREye.Left]: new XRSpace(viewerSpace),
			[XREye.Right]: new XRSpace(viewerSpace),
			[XREye.None]: new XRSpace(viewerSpace),
		};
		const controllerConfig = deviceConfig.controllerConfig;
		const controllers: { [key in XRHandedness]?: XRController } = {};
		if (controllerConfig) {
			Object.values(XRHandedness).forEach((handedness) => {
				if (controllerConfig.layout[handedness]) {
					controllers[handedness] = new XRController(
						controllerConfig,
						handedness,
						globalSpace,
					);
				}
			});
		}
		const hands = {
			[XRHandedness.Left]: new XRHandInput(
				oculusHandConfig,
				XRHandedness.Left,
				globalSpace,
			),
			[XRHandedness.Right]: new XRHandInput(
				oculusHandConfig,
				XRHandedness.Right,
				globalSpace,
			),
		};
		const canvasContainer =
			deviceOptions.canvasContainer ?? document.createElement('div');
		canvasContainer.dataset.webxr_runtime = `Immersive Web Emulation Runtime v${VERSION}`;
		canvasContainer.style.position = 'fixed';
		canvasContainer.style.width = '100%';
		canvasContainer.style.height = '100%';
		canvasContainer.style.top = '0';
		canvasContainer.style.left = '0';
		canvasContainer.style.display = 'flex';
		canvasContainer.style.justifyContent = 'center';
		canvasContainer.style.alignItems = 'center';
		canvasContainer.style.overflow = 'hidden';
		canvasContainer.style.zIndex = '999';

		this[PRIVATE] = {
			name: deviceConfig.name,
			supportedSessionModes: deviceConfig.supportedSessionModes,
			supportedFeatures: deviceConfig.supportedFeatures,
			supportedFrameRates: deviceConfig.supportedFrameRates,
			isSystemKeyboardSupported: deviceConfig.isSystemKeyboardSupported,
			internalNominalFrameRate: deviceConfig.internalNominalFrameRate,
			userAgent: deviceConfig.userAgent,

			position:
				deviceOptions.headsetPosition ?? DEFAULTS.headsetPosition.clone(),
			quaternion:
				deviceOptions.headsetQuaternion ?? DEFAULTS.headsetQuaternion.clone(),
			stereoEnabled: deviceOptions.stereoEnabled ?? DEFAULTS.stereoEnabled,
			ipd: deviceOptions.ipd ?? DEFAULTS.ipd,
			fovy: deviceOptions.fovy ?? DEFAULTS.fovy,
			controllers,
			hands,
			primaryInputMode: 'controller',
			pendingReferenceSpaceReset: false,
			visibilityState: XRVisibilityState.Visible,
			pendingVisibilityState: null,

			matrix: mat4.create(),
			globalSpace,
			viewerSpace,
			viewSpaces,
			canvasContainer,

			getViewport: (layer: XRWebGLLayer, view: XRView) => {
				const canvas = layer.context.canvas;
				const { width, height } = canvas;
				switch (view.eye) {
					case XREye.None:
						return new XRViewport(0, 0, width, height);
					case XREye.Left:
						return new XRViewport(
							0,
							0,
							this[PRIVATE].stereoEnabled ? width / 2 : width,
							height,
						);
					case XREye.Right:
						return new XRViewport(
							width / 2,
							0,
							this[PRIVATE].stereoEnabled ? width / 2 : 0,
							height,
						);
				}
			},
			updateViews: () => {
				// update viewerSpace
				const viewerSpace = this[PRIVATE].viewerSpace;
				mat4.fromRotationTranslation(
					viewerSpace[XRSPACE_PRIVATE].offsetMatrix,
					this[PRIVATE].quaternion.quat,
					this[PRIVATE].position.vec3,
				);

				// update viewSpaces
				mat4.fromTranslation(
					this[PRIVATE].viewSpaces[XREye.Left][XRSPACE_PRIVATE].offsetMatrix,
					vec3.fromValues(-this[PRIVATE].ipd / 2, 0, 0),
				);
				mat4.fromTranslation(
					this[PRIVATE].viewSpaces[XREye.Right][XRSPACE_PRIVATE].offsetMatrix,
					vec3.fromValues(this[PRIVATE].ipd / 2, 0, 0),
				);
			},
			onBaseLayerSet: (baseLayer: XRWebGLLayer | null) => {
				if (!baseLayer) return;

				// backup canvas data
				const canvas = baseLayer.context.canvas as HTMLCanvasElement;
				if (canvas.parentElement !== this[PRIVATE].canvasContainer) {
					this[PRIVATE].canvasData = {
						canvas,
						parent: canvas.parentElement,
						width: canvas.width,
						height: canvas.height,
					};
					this[PRIVATE].canvasContainer.appendChild(canvas);
					document.body.appendChild(this[PRIVATE].canvasContainer);
				}

				canvas.width = window.innerWidth;
				canvas.height = window.innerHeight;
			},
			onSessionEnd: () => {
				if (this[PRIVATE].canvasData) {
					const { canvas, parent, width, height } = this[PRIVATE].canvasData;
					canvas.width = width;
					canvas.height = height;
					if (parent) {
						parent.appendChild(canvas);
					} else {
						this[PRIVATE].canvasContainer.removeChild(canvas);
					}
					document.body.removeChild(this[PRIVATE].canvasContainer);
					window.dispatchEvent(new Event('resize'));
				}
			},
			onFrameStart: (frame: XRFrame) => {
				if (this[PRIVATE].actionPlayer?.playing) {
					this[PRIVATE].actionPlayer.playFrame();
				} else {
					const session = frame.session;
					this[PRIVATE].updateViews();

					if (this[PRIVATE].pendingVisibilityState) {
						this[PRIVATE].visibilityState =
							this[PRIVATE].pendingVisibilityState;
						this[PRIVATE].pendingVisibilityState = null;
						session.dispatchEvent(
							new XRSessionEvent('visibilitychange', { session }),
						);
					}
					if (this[PRIVATE].visibilityState === XRVisibilityState.Visible) {
						this.activeInputs.forEach((activeInput) => {
							activeInput.onFrameStart(frame);
						});
					}

					if (this[PRIVATE].pendingReferenceSpaceReset) {
						session[XRSESSION_PRIVATE].referenceSpaces.forEach(
							(referenceSpace) => {
								switch (referenceSpace[XRREFERENCESPACE_PRIVATE].type) {
									case XRReferenceSpaceType.Local:
									case XRReferenceSpaceType.LocalFloor:
									case XRReferenceSpaceType.BoundedFloor:
									case XRReferenceSpaceType.Unbounded:
										referenceSpace.dispatchEvent(
											new XRReferenceSpaceEvent('reset', { referenceSpace }),
										);
										break;
								}
							},
						);
						this[PRIVATE].pendingReferenceSpaceReset = false;
					}
				}

				this[PRIVATE].updateViews();
			},
		};

		this[PRIVATE].updateViews();
		globalThis;
	}

	installRuntime(globalObject: any = globalThis) {
		Object.defineProperty(
			WebGL2RenderingContext.prototype,
			'makeXRCompatible',
			{
				value: function () {
					return new Promise((resolve, _reject) => {
						resolve(true);
					});
				},
				configurable: true,
			},
		);
		Object.defineProperty(globalThis.navigator, 'xr', {
			value: new XRSystem(this),
			configurable: true,
		});
		Object.defineProperty(navigator, 'userAgent', {
			value: this[PRIVATE].userAgent,
			writable: false,
			configurable: false,
			enumerable: true,
		});
		globalObject['XRSystem'] = XRSystem;
		globalObject['XRSession'] = XRSession;
		globalObject['XRRenderState'] = XRRenderState;
		globalObject['XRFrame'] = XRFrame;
		globalObject['XRSpace'] = XRSpace;
		globalObject['XRReferenceSpace'] = XRReferenceSpace;
		globalObject['XRJointSpace'] = XRJointSpace;
		globalObject['XRView'] = XRView;
		globalObject['XRViewport'] = XRViewport;
		globalObject['XRRigidTransform'] = XRRigidTransform;
		globalObject['XRPose'] = XRPose;
		globalObject['XRViewerPose'] = XRViewerPose;
		globalObject['XRJointPose'] = XRJointPose;
		globalObject['XRInputSource'] = XRInputSource;
		globalObject['XRInputSourceArray'] = XRInputSourceArray;
		globalObject['XRHand'] = XRHand;
		globalObject['XRLayer'] = XRLayer;
		globalObject['XRWebGLLayer'] = XRWebGLLayer;
		globalObject['XRSessionEvent'] = XRSessionEvent;
		globalObject['XRInputSourceEvent'] = XRInputSourceEvent;
		globalObject['XRInputSourcesChangeEvent'] = XRInputSourcesChangeEvent;
		globalObject['XRReferenceSpaceEvent'] = XRReferenceSpaceEvent;
	}

	get supportedSessionModes() {
		return this[PRIVATE].supportedSessionModes;
	}

	get supportedFeatures() {
		return this[PRIVATE].supportedFeatures;
	}

	get supportedFrameRates() {
		return this[PRIVATE].supportedFrameRates;
	}

	get isSystemKeyboardSupported() {
		return this[PRIVATE].isSystemKeyboardSupported;
	}

	get internalNominalFrameRate() {
		return this[PRIVATE].internalNominalFrameRate;
	}

	get stereoEnabled() {
		return this[PRIVATE].stereoEnabled;
	}

	set stereoEnabled(value: boolean) {
		this[PRIVATE].stereoEnabled = value;
	}

	get ipd() {
		return this[PRIVATE].ipd;
	}

	set ipd(value: number) {
		this[PRIVATE].ipd = value;
	}

	get fovy() {
		return this[PRIVATE].fovy;
	}

	set fovy(value: number) {
		this[PRIVATE].fovy = value;
	}

	get position(): Vector3 {
		return this[PRIVATE].position;
	}

	get quaternion(): Quaternion {
		return this[PRIVATE].quaternion;
	}

	get viewerSpace() {
		if (this[PRIVATE].actionPlayer?.playing) {
			return this[PRIVATE].actionPlayer.viewerSpace;
		} else {
			return this[PRIVATE].viewerSpace;
		}
	}

	get viewSpaces() {
		if (this[PRIVATE].actionPlayer?.playing) {
			return this[PRIVATE].actionPlayer.viewSpaces;
		} else {
			return this[PRIVATE].viewSpaces;
		}
	}

	get controllers() {
		return this[PRIVATE].controllers;
	}

	get hands() {
		return this[PRIVATE].hands;
	}

	get primaryInputMode() {
		return this[PRIVATE].primaryInputMode;
	}

	set primaryInputMode(mode: 'controller' | 'hand') {
		if (mode !== 'controller' && mode !== 'hand') {
			console.warn('primary input mode can only be "controller" or "hand"');
			return;
		}
		this[PRIVATE].primaryInputMode = mode;
	}

	get activeInputs(): XRTrackedInput[] {
		if (this[PRIVATE].visibilityState !== XRVisibilityState.Visible) {
			return [];
		}
		const activeInputs: XRTrackedInput[] =
			this[PRIVATE].primaryInputMode === 'controller'
				? Object.values(this[PRIVATE].controllers)
				: Object.values(this[PRIVATE].hands);
		return activeInputs.filter((input) => input.connected);
	}

	get inputSources(): XRInputSource[] {
		if (this[PRIVATE].actionPlayer?.playing) {
			return this[PRIVATE].actionPlayer.inputSources;
		} else {
			return this.activeInputs.map((input) => input.inputSource);
		}
	}

	get canvasContainer(): HTMLDivElement {
		return this[PRIVATE].canvasContainer;
	}

	recenter() {
		const deltaVec = new Vector3(-this.position.x, 0, -this.position.z);
		const forward = new Vector3(0, 0, -1).applyQuaternion(this.quaternion);
		forward.y = 0;
		forward.normalize();
		const angle = Math.atan2(forward.x, -forward.z);
		const deltaQuat = new Quaternion().setFromAxisAngle(
			new Vector3(0, 1, 0),
			angle,
		);
		this.position.add(deltaVec);
		this.quaternion.multiply(deltaQuat);

		[
			...Object.values(this[PRIVATE].controllers),
			...Object.values(this[PRIVATE].hands),
		].forEach((activeInput) => {
			activeInput.position.add(deltaVec);
			activeInput.quaternion.multiply(deltaQuat);
			activeInput.position.applyQuaternion(deltaQuat);
		});

		this[PRIVATE].pendingReferenceSpaceReset = true;
	}

	get visibilityState() {
		return this[PRIVATE].visibilityState;
	}

	// visibility state updates are queued until the XRSession produces frames
	updateVisibilityState(state: XRVisibilityState) {
		if (!Object.values(XRVisibilityState).includes(state)) {
			throw new DOMException(
				'Invalid XRVisibilityState value',
				'NotSupportedError',
			);
		}
		if (state !== this[PRIVATE].visibilityState) {
			this[PRIVATE].pendingVisibilityState = state;
		}
	}

	createActionPlayer(
		refSpace: XRReferenceSpace,
		recording: {
			schema: {
				0: number;
				1: InputSchema;
			}[];
			frames: any[];
		},
	) {
		this[PRIVATE].actionPlayer = new ActionPlayer(
			refSpace,
			recording,
			this[PRIVATE].ipd,
		);
		return this[PRIVATE].actionPlayer;
	}
}
