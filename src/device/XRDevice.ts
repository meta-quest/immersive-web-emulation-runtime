/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { GlobalSpace, XRSpace } from '../spaces/XRSpace.js';
import {
	P_DEVICE,
	P_REF_SPACE,
	P_SESSION,
	P_SPACE,
	P_SYSTEM,
} from '../private.js';
import { Quaternion, Vector3 } from '../utils/Math.js';
import { XRController, XRControllerConfig } from './XRController.js';
import {
	XREnvironmentBlendMode,
	XRInteractionMode,
	XRSession,
	XRSessionMode,
	XRVisibilityState,
} from '../session/XRSession.js';
import { XREye, XRView } from '../views/XRView.js';
import { XRHandInput, oculusHandConfig } from './XRHandInput.js';
import {
	XRHandedness,
	XRInputSource,
	XRInputSourceArray,
} from '../input/XRInputSource.js';
import { XRLayer, XRWebGLLayer } from '../layers/XRWebGLLayer.js';
import {
	XRReferenceSpace,
	XRReferenceSpaceType,
} from '../spaces/XRReferenceSpace.js';
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
import { NativePlane } from '../planes/XRPlane.js';
import { NativeMesh } from '../meshes/XRMesh.js';

export type WebXRFeature =
	| 'viewer'
	| 'local'
	| 'local-floor'
	| 'bounded-floor'
	| 'unbounded'
	| 'dom-overlay'
	| 'anchors'
	| 'plane-detection'
	| 'mesh-detection'
	| 'hit-test'
	| 'hand-tracking'
	| 'depth-sensing';

export interface XRDeviceConfig {
	name: string;
	controllerConfig: XRControllerConfig | undefined;
	supportedSessionModes: XRSessionMode[];
	supportedFeatures: WebXRFeature[];
	supportedFrameRates: number[];
	isSystemKeyboardSupported: boolean;
	internalNominalFrameRate: number;
	environmentBlendModes: Partial<{
		[sessionMode in XRSessionMode]: XREnvironmentBlendMode;
	}>;
	interactionMode: XRInteractionMode;
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

const DEFAULTS = {
	ipd: 0.063,
	fovy: Math.PI / 2,
	headsetPosition: new Vector3(0, 1.6, 0),
	headsetQuaternion: new Quaternion(),
	stereoEnabled: false,
};

export interface DevUIConstructor {
	new (xrDevice: XRDevice): DevUI;
}
export interface DevUI {
	version: string;
	render(time: number): void;
	get devUICanvas(): HTMLCanvasElement;
	get devUIContainer(): HTMLDivElement;
}

export interface SEMConstructor {
	new (xrDevice: XRDevice): SyntheticEnvironmentModule;
}
export interface SyntheticEnvironmentModule {
	version: string;
	render(time: number): void;
	loadEnvironment(json: any): void;
	planesVisible: boolean;
	boundingBoxesVisible: boolean;
	meshesVisible: boolean;
	get environmentCanvas(): HTMLCanvasElement;
	get trackedPlanes(): Set<NativePlane>;
	get trackedMeshes(): Set<NativeMesh>;
	computeHitTestResults(rayMatrix: mat4): mat4[];
}

const Z_INDEX_SEM_CANVAS = 1;
const Z_INDEX_APP_CANVAS = 2;
const Z_INDEX_DEVUI_CANVAS = 3;
const Z_INDEX_DEVUI_CONTAINER = 4;

/**
 * XRDevice is not a standard API class outlined in the WebXR Device API Specifications
 * Instead, it serves as an user-facing interface to control the emulated XR Device
 */
export class XRDevice {
	public readonly version = VERSION;

	[P_DEVICE]: {
		// device config
		name: string;
		supportedSessionModes: string[];
		supportedFeatures: string[];
		supportedFrameRates: number[];
		isSystemKeyboardSupported: boolean;
		internalNominalFrameRate: number;
		environmentBlendModes: Partial<{
			[sessionMode in XRSessionMode]: XREnvironmentBlendMode;
		}>;
		interactionMode: XRInteractionMode;
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
		xrSystem: XRSystem | null;

		matrix: mat4;
		globalSpace: GlobalSpace;
		viewerSpace: XRReferenceSpace;
		viewSpaces: { [key in XREye]: XRSpace };

		canvasData?: {
			canvas: HTMLCanvasElement;
			parent: HTMLElement | null;
			width: number;
			height: number;
			zIndex: string;
		};
		canvasContainer: HTMLDivElement;

		getViewport: (layer: XRWebGLLayer, view: XRView) => XRViewport;
		updateViews: () => void;
		onBaseLayerSet: (baseLayer: XRWebGLLayer | null) => void;
		onSessionEnd: () => void;
		onFrameStart: (frame: XRFrame) => void;

		// action playback
		actionPlayer?: ActionPlayer;

		// add-on modules:
		devui?: DevUI;
		sem?: SyntheticEnvironmentModule;
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

		this[P_DEVICE] = {
			name: deviceConfig.name,
			supportedSessionModes: deviceConfig.supportedSessionModes,
			supportedFeatures: deviceConfig.supportedFeatures,
			supportedFrameRates: deviceConfig.supportedFrameRates,
			isSystemKeyboardSupported: deviceConfig.isSystemKeyboardSupported,
			internalNominalFrameRate: deviceConfig.internalNominalFrameRate,
			environmentBlendModes: deviceConfig.environmentBlendModes,
			interactionMode: deviceConfig.interactionMode,
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
			visibilityState: 'visible',
			pendingVisibilityState: null,
			xrSystem: null,

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
							this[P_DEVICE].stereoEnabled ? width / 2 : width,
							height,
						);
					case XREye.Right:
						return new XRViewport(
							width / 2,
							0,
							this[P_DEVICE].stereoEnabled ? width / 2 : 0,
							height,
						);
				}
			},
			updateViews: () => {
				// update viewerSpace
				const viewerSpace = this[P_DEVICE].viewerSpace;
				mat4.fromRotationTranslation(
					viewerSpace[P_SPACE].offsetMatrix,
					this[P_DEVICE].quaternion.quat,
					this[P_DEVICE].position.vec3,
				);

				// update viewSpaces
				mat4.fromTranslation(
					this[P_DEVICE].viewSpaces[XREye.Left][P_SPACE].offsetMatrix,
					vec3.fromValues(-this[P_DEVICE].ipd / 2, 0, 0),
				);
				mat4.fromTranslation(
					this[P_DEVICE].viewSpaces[XREye.Right][P_SPACE].offsetMatrix,
					vec3.fromValues(this[P_DEVICE].ipd / 2, 0, 0),
				);
			},
			onBaseLayerSet: (baseLayer: XRWebGLLayer | null) => {
				if (!baseLayer) return;

				// backup canvas data
				const canvas = baseLayer.context.canvas as HTMLCanvasElement;
				if (canvas.parentElement !== this[P_DEVICE].canvasContainer) {
					const devui = this[P_DEVICE].devui;
					if (devui) {
						const { devUICanvas, devUIContainer } = devui;
						devUICanvas.style.zIndex = Z_INDEX_DEVUI_CANVAS.toString();
						devUIContainer.style.zIndex = Z_INDEX_DEVUI_CONTAINER.toString();
						this[P_DEVICE].canvasContainer.appendChild(devui.devUICanvas);
						this[P_DEVICE].canvasContainer.appendChild(devui.devUIContainer);
					}
					const sem = this[P_DEVICE].sem;
					if (sem) {
						sem.environmentCanvas.style.zIndex = Z_INDEX_SEM_CANVAS.toString();
						this[P_DEVICE].canvasContainer.appendChild(sem.environmentCanvas);
					}
					this[P_DEVICE].canvasData = {
						canvas,
						parent: canvas.parentElement,
						width: canvas.width,
						height: canvas.height,
						zIndex: canvas.style.zIndex,
					};
					canvas.style.zIndex = Z_INDEX_APP_CANVAS.toString();
					this[P_DEVICE].canvasContainer.appendChild(canvas);
					document.body.appendChild(this[P_DEVICE].canvasContainer);
				}

				canvas.width = window.innerWidth;
				canvas.height = window.innerHeight;
			},
			onSessionEnd: () => {
				if (this[P_DEVICE].canvasData) {
					const { canvas, parent, width, height, zIndex } =
						this[P_DEVICE].canvasData;
					canvas.width = width;
					canvas.height = height;
					canvas.style.zIndex = zIndex;
					if (parent) {
						parent.appendChild(canvas);
					} else {
						this[P_DEVICE].canvasContainer.removeChild(canvas);
					}
					const devui = this[P_DEVICE].devui;
					if (devui) {
						this[P_DEVICE].canvasContainer.removeChild(devui.devUICanvas);
						this[P_DEVICE].canvasContainer.removeChild(devui.devUIContainer);
					}
					const sem = this[P_DEVICE].sem;
					if (sem) {
						this[P_DEVICE].canvasContainer.removeChild(sem.environmentCanvas);
					}
					document.body.removeChild(this[P_DEVICE].canvasContainer);
					this[P_DEVICE].canvasData = undefined;
					window.dispatchEvent(new Event('resize'));
				}
			},
			onFrameStart: (frame: XRFrame) => {
				if (this[P_DEVICE].actionPlayer?.playing) {
					this[P_DEVICE].actionPlayer.playFrame();
				} else {
					const session = frame.session;
					this[P_DEVICE].updateViews();

					if (this[P_DEVICE].pendingVisibilityState) {
						this[P_DEVICE].visibilityState =
							this[P_DEVICE].pendingVisibilityState;
						this[P_DEVICE].pendingVisibilityState = null;
						session.dispatchEvent(
							new XRSessionEvent('visibilitychange', { session }),
						);
					}
					if (this[P_DEVICE].visibilityState === 'visible') {
						this.activeInputs.forEach((activeInput) => {
							activeInput.onFrameStart(frame);
						});
					}

					if (this[P_DEVICE].pendingReferenceSpaceReset) {
						session[P_SESSION].referenceSpaces.forEach((referenceSpace) => {
							switch (referenceSpace[P_REF_SPACE].type) {
								case XRReferenceSpaceType.Local:
								case XRReferenceSpaceType.LocalFloor:
								case XRReferenceSpaceType.BoundedFloor:
								case XRReferenceSpaceType.Unbounded:
									referenceSpace.dispatchEvent(
										new XRReferenceSpaceEvent('reset', { referenceSpace }),
									);
									break;
							}
						});
						this[P_DEVICE].pendingReferenceSpaceReset = false;
					}
				}

				this[P_DEVICE].updateViews();
			},
		};

		this[P_DEVICE].updateViews();
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
		this[P_DEVICE].xrSystem = new XRSystem(this);
		Object.defineProperty(globalThis.navigator, 'xr', {
			value: this[P_DEVICE].xrSystem,
			configurable: true,
		});
		Object.defineProperty(navigator, 'userAgent', {
			value: this[P_DEVICE].userAgent,
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

	installDevUI(devUIConstructor: DevUIConstructor) {
		this[P_DEVICE].devui = new devUIConstructor(this);
	}

	installSEM(semConstructor: SEMConstructor) {
		this[P_DEVICE].sem = new semConstructor(this);
	}

	get supportedSessionModes() {
		return this[P_DEVICE].supportedSessionModes;
	}

	get supportedFeatures() {
		return this[P_DEVICE].supportedFeatures;
	}

	get supportedFrameRates() {
		return this[P_DEVICE].supportedFrameRates;
	}

	get isSystemKeyboardSupported() {
		return this[P_DEVICE].isSystemKeyboardSupported;
	}

	get internalNominalFrameRate() {
		return this[P_DEVICE].internalNominalFrameRate;
	}

	get stereoEnabled() {
		return this[P_DEVICE].stereoEnabled;
	}

	set stereoEnabled(value: boolean) {
		this[P_DEVICE].stereoEnabled = value;
	}

	get ipd() {
		return this[P_DEVICE].ipd;
	}

	set ipd(value: number) {
		this[P_DEVICE].ipd = value;
	}

	get fovy() {
		return this[P_DEVICE].fovy;
	}

	set fovy(value: number) {
		this[P_DEVICE].fovy = value;
	}

	get position(): Vector3 {
		return this[P_DEVICE].position;
	}

	get quaternion(): Quaternion {
		return this[P_DEVICE].quaternion;
	}

	get viewerSpace() {
		if (this[P_DEVICE].actionPlayer?.playing) {
			return this[P_DEVICE].actionPlayer.viewerSpace;
		} else {
			return this[P_DEVICE].viewerSpace;
		}
	}

	get viewSpaces() {
		if (this[P_DEVICE].actionPlayer?.playing) {
			return this[P_DEVICE].actionPlayer.viewSpaces;
		} else {
			return this[P_DEVICE].viewSpaces;
		}
	}

	get controllers() {
		return this[P_DEVICE].controllers;
	}

	get hands() {
		return this[P_DEVICE].hands;
	}

	get primaryInputMode() {
		return this[P_DEVICE].primaryInputMode;
	}

	set primaryInputMode(mode: 'controller' | 'hand') {
		if (mode !== 'controller' && mode !== 'hand') {
			console.warn('primary input mode can only be "controller" or "hand"');
			return;
		}
		this[P_DEVICE].primaryInputMode = mode;
	}

	get activeInputs(): XRTrackedInput[] {
		if (this[P_DEVICE].visibilityState !== 'visible') {
			return [];
		}
		const activeInputs: XRTrackedInput[] =
			this[P_DEVICE].primaryInputMode === 'controller'
				? Object.values(this[P_DEVICE].controllers)
				: Object.values(this[P_DEVICE].hands);
		return activeInputs.filter((input) => input.connected);
	}

	get inputSources(): XRInputSource[] {
		if (this[P_DEVICE].actionPlayer?.playing) {
			return this[P_DEVICE].actionPlayer.inputSources;
		} else {
			return this.activeInputs.map((input) => input.inputSource);
		}
	}

	get canvasContainer(): HTMLDivElement {
		return this[P_DEVICE].canvasContainer;
	}

	get canvasDimensions(): { width: number; height: number } | undefined {
		if (this[P_DEVICE].canvasData) {
			const { width, height } = this[P_DEVICE].canvasData.canvas;
			return { width, height };
		}
		return;
	}

	get activeSession(): XRSession | undefined {
		return this[P_DEVICE].xrSystem?.[P_SYSTEM].activeSession;
	}

	get sessionOffered(): boolean {
		return Boolean(this[P_DEVICE].xrSystem?.[P_SYSTEM].offeredSessionConfig);
	}

	get name() {
		return this[P_DEVICE].name;
	}

	grantOfferedSession(): void {
		const pSystem = this[P_DEVICE].xrSystem?.[P_SYSTEM];
		if (pSystem && pSystem.offeredSessionConfig) {
			pSystem.grantSession(pSystem.offeredSessionConfig);
			pSystem.offeredSessionConfig = undefined;
		}
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
			...Object.values(this[P_DEVICE].controllers),
			...Object.values(this[P_DEVICE].hands),
		].forEach((activeInput) => {
			activeInput.position.add(deltaVec);
			activeInput.quaternion.multiply(deltaQuat);
			activeInput.position.applyQuaternion(deltaQuat);
		});

		this[P_DEVICE].pendingReferenceSpaceReset = true;
	}

	get visibilityState() {
		return this[P_DEVICE].visibilityState;
	}

	// visibility state updates are queued until the XRSession produces frames
	updateVisibilityState(state: XRVisibilityState) {
		if (
			!Object.values(['visible', 'visible-blurred', 'hidden']).includes(state)
		) {
			throw new DOMException(
				'Invalid XRVisibilityState value',
				'NotSupportedError',
			);
		}
		if (state !== this[P_DEVICE].visibilityState) {
			this[P_DEVICE].pendingVisibilityState = state;
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
		this[P_DEVICE].actionPlayer = new ActionPlayer(
			refSpace,
			recording,
			this[P_DEVICE].ipd,
		);
		return this[P_DEVICE].actionPlayer;
	}

	get devui() {
		return this[P_DEVICE].devui;
	}

	get sem() {
		return this[P_DEVICE].sem;
	}
}
