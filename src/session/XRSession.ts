/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
	P_ANCHOR,
	P_DEVICE,
	P_FRAME,
	P_SESSION,
	P_SPACE,
	P_WEBGL_LAYER,
} from '../private.js';
import type { WebXRFeature, XRDevice } from '../device/XRDevice.js';
import { XRAnchor, XRAnchorSet, XRAnchorUtils } from '../anchors/XRAnchor.js';
import { XRInputSource, XRInputSourceArray } from '../input/XRInputSource.js';
import {
	XRInputSourcesChangeEvent,
	XRInputSourcesChangeEventHandler,
} from '../events/XRInputSourcesChangeEvent.js';
import {
	XRReferenceSpace,
	XRReferenceSpaceType,
} from '../spaces/XRReferenceSpace.js';
import { XRRenderState, XRRenderStateInit } from './XRRenderState.js';
import {
	XRSessionEvent,
	XRSessionEventHandler,
} from '../events/XRSessionEvent.js';

import { XREye } from '../views/XRView.js';
import { XRFrame } from '../frameloop/XRFrame.js';
import { XRInputSourceEventHandler } from '../events/XRInputSourceEvent.js';
import { mat4 } from 'gl-matrix';

export type XRVisibilityState = 'visible' | 'visible-blurred' | 'hidden';

export type XRSessionMode = 'inline' | 'immersive-vr' | 'immersive-ar';

export type XRSessionInit = {
	requiredFeatures?: WebXRFeature[];
	optionalFeatures?: WebXRFeature[];
};

export enum XREnvironmentBlendMode {
	Opaque = 'opaque',
	AlphaBlend = 'alpha-blend',
	Additive = 'additive',
}

export enum XRInteractionMode {
	ScreenSpace = 'screen-space',
	WorldSpace = 'world-space',
}

type XRFrameRequestCallback = (
	time: DOMHighResTimeStamp,
	frame: XRFrame,
) => void;

type CallbackData = {
	handle: number;
	callback: XRFrameRequestCallback;
	cancelled: boolean;
};

export class XRSession extends EventTarget {
	[P_SESSION]: {
		device: XRDevice;
		enabledFeatures: Array<string>;
		isSystemKeyboardSupported: boolean;
		mode: XRSessionMode;
		ended: boolean;
		referenceSpaceIsSupported: (
			referenceSpaceType: XRReferenceSpaceType,
		) => boolean;
		// projection matrices
		projectionMatrices: { [key in XREye]: mat4 };
		getProjectionMatrix: (eye: XREye) => mat4;
		// XRFrames produced by this session
		frameHandle: number;
		frameCallbacks: CallbackData[];
		currentFrameCallbacks: CallbackData[] | null;
		// actual frameloop of the device this is running on
		onDeviceFrame: () => void;
		deviceFrameHandle?: number;
		// render state
		renderState: XRRenderState;
		pendingRenderState: XRRenderState | null;
		// framerate
		nominalFrameRate: number;
		// reference spaces
		referenceSpaces: XRReferenceSpace[];
		// tracked inputs
		inputSourceArray: XRInputSourceArray;
		activeInputSources: XRInputSource[];
		updateActiveInputSources: () => void;
		// tracked anchors
		trackedAnchors: XRAnchorSet;
		persistentAnchors: Map<string, XRAnchor>;
		newAnchors: Map<
			XRAnchor,
			{
				resolve: (value: XRAnchor | PromiseLike<XRAnchor>) => void;
				reject: (reason?: any) => void;
			}
		>;
		frameTrackedAnchors: XRAnchorSet; // https://immersive-web.github.io/anchors/#anchor-updates specifies same object
		updateTrackedAnchors: () => void;
		// event handlers
		onend: XRSessionEventHandler | null;
		oninputsourceschange: XRInputSourcesChangeEventHandler | null;
		onselect: XRInputSourceEventHandler | null;
		onselectstart: XRInputSourceEventHandler | null;
		onselectend: XRInputSourceEventHandler | null;
		onsqueeze: XRInputSourceEventHandler | null;
		onsqueezestart: XRInputSourceEventHandler | null;
		onsqueezeend: XRInputSourceEventHandler | null;
		onvisibilitychange: XRSessionEventHandler | null;
		onframeratechange: XRSessionEventHandler | null;
	};

	constructor(
		device: XRDevice,
		mode: XRSessionMode,
		enabledFeatures: string[],
	) {
		super();
		this[P_SESSION] = {
			device,
			mode,
			renderState: new XRRenderState(),
			pendingRenderState: null,
			enabledFeatures: enabledFeatures,
			isSystemKeyboardSupported: false,
			ended: false,
			projectionMatrices: {
				[XREye.Left]: mat4.create(),
				[XREye.Right]: mat4.create(),
				[XREye.None]: mat4.create(),
			},
			getProjectionMatrix: (eye: XREye) => {
				return this[P_SESSION].projectionMatrices[eye];
			},
			referenceSpaceIsSupported: (referenceSpaceType: XRReferenceSpaceType) => {
				if (!this[P_SESSION].enabledFeatures.includes(referenceSpaceType)) {
					return false;
				}
				switch (referenceSpaceType) {
					case XRReferenceSpaceType.Viewer:
						return true;
					case XRReferenceSpaceType.Local:
					case XRReferenceSpaceType.LocalFloor:
					case XRReferenceSpaceType.BoundedFloor:
					case XRReferenceSpaceType.Unbounded:
						return this[P_SESSION].mode != 'inline';
				}
			},
			frameHandle: 0,
			frameCallbacks: [],
			currentFrameCallbacks: null,
			onDeviceFrame: () => {
				if (this[P_SESSION].ended) {
					return;
				}

				this[P_SESSION].deviceFrameHandle = globalThis.requestAnimationFrame(
					this[P_SESSION].onDeviceFrame,
				);

				if (this[P_SESSION].pendingRenderState != null) {
					this[P_SESSION].renderState = this[P_SESSION].pendingRenderState;
					this[P_SESSION].pendingRenderState = null;
					this[P_SESSION].device[P_DEVICE].onBaseLayerSet(
						this[P_SESSION].renderState.baseLayer,
					);
				}

				const baseLayer = this[P_SESSION].renderState.baseLayer;
				if (baseLayer === null) {
					return;
				}
				const context = baseLayer.context;
				const canvas = context.canvas;

				/**
				 * This code snippet is designed to clear the buffers attached to an opaque framebuffer
				 * at the beginning of each XR animation frame, but it only applies to immersive XR sessions.
				 * The process is as follows:
				 *
				 * 1. Check if the session is immersive: It verifies if `session.immersive` is true.
				 *    This ensures that the buffer clearing operations are only performed for immersive
				 *    sessions, which have exclusive access to the XR device's display.
				 *
				 * 2. Save current clear values: The current clear values for the color, depth, and
				 *    stencil buffers are stored. These values need to be restored after clearing the
				 *    buffers to maintain the application's rendering state as expected.
				 *
				 * 3. Set clear values to defaults: The clear color is set to transparent black, the
				 *    clear depth to the maximum depth value (1.0), and the clear stencil to 0. This
				 *    ensures that the buffers are reset to a known state, free from any residual data.
				 *
				 * 4. Clear the buffers: The depth, color, and stencil buffers are cleared, removing
				 *    any content from previous frames and preparing them for new rendering operations.
				 *
				 * 5. Restore previous clear values: The original clear values are reinstated to return
				 *    the WebGL context to its state prior to this operation, allowing subsequent rendering
				 *    to proceed without interference.
				 *
				 * This clearing process is crucial for some XR devices to function correctly and to
				 * prevent rendering artifacts from past frames. It ensures that each new frame starts
				 * with a clean slate.
				 */
				if (this[P_SESSION].mode != 'inline') {
					const currentClearColor = context.getParameter(
						context.COLOR_CLEAR_VALUE,
					);
					const currentClearDepth = context.getParameter(
						context.DEPTH_CLEAR_VALUE,
					);
					const currentClearStencil = context.getParameter(
						context.STENCIL_CLEAR_VALUE,
					);
					context.clearColor(0.0, 0.0, 0.0, 0.0);
					context.clearDepth(1);
					context.clearStencil(0.0);
					context.clear(
						context.DEPTH_BUFFER_BIT |
							context.COLOR_BUFFER_BIT |
							context.STENCIL_BUFFER_BIT,
					);
					context.clearColor(
						currentClearColor[0],
						currentClearColor[1],
						currentClearColor[2],
						currentClearColor[3],
					);
					context.clearDepth(currentClearDepth);
					context.clearStencil(currentClearStencil);
				}

				// Calculate projection matrices
				const { depthNear, depthFar } = this[P_SESSION].renderState;
				const { width, height } = canvas;
				if (this[P_SESSION].mode !== 'inline') {
					const aspect =
						(width * (this[P_SESSION].device.stereoEnabled ? 0.5 : 1.0)) /
						height;
					mat4.perspective(
						this[P_SESSION].projectionMatrices[XREye.Left],
						this[P_SESSION].device.fovy,
						aspect,
						depthNear,
						depthFar,
					);
					mat4.copy(
						this[P_SESSION].projectionMatrices[XREye.Right],
						this[P_SESSION].projectionMatrices[XREye.Left],
					);
				} else {
					const aspect = width / height;
					mat4.perspective(
						this[P_SESSION].projectionMatrices[XREye.None],
						this[P_SESSION].renderState.inlineVerticalFieldOfView!,
						aspect,
						depthNear,
						depthFar,
					);
				}

				this[P_SESSION].updateTrackedAnchors();

				const frame = new XRFrame(
					this,
					this[P_SESSION].frameHandle,
					true,
					true,
					performance.now(),
				);

				this[P_SESSION].device[P_DEVICE].onFrameStart(frame);
				this[P_SESSION].updateActiveInputSources();

				/*
				 * For each entry in callbacks, in order:
				 * - If the entry’s cancelled boolean is true, continue to the next entry.
				 * - Invoke the Web IDL callback function, passing now and frame as the arguments.
				 * - If an exception is thrown, report the exception.
				 */
				// - Let callbacks be a list of the entries in session’s list of animation frame
				//   callback, in the order in which they were added to the list.
				const callbacks = (this[P_SESSION].currentFrameCallbacks =
					this[P_SESSION].frameCallbacks);
				// - Set session’s list of animation frame callbacks to the empty list.
				this[P_SESSION].frameCallbacks = [];
				const rightNow = performance.now();
				for (let i = 0; i < callbacks.length; i++) {
					try {
						if (!callbacks[i].cancelled) {
							callbacks[i].callback(rightNow, frame);
						}
					} catch (err) {
						console.error(err);
					}
				}
				this[P_SESSION].currentFrameCallbacks = null;

				// - Set frame’s active boolean to false.
				frame[P_FRAME].active = false;
			},
			nominalFrameRate: device.internalNominalFrameRate,
			referenceSpaces: [],
			inputSourceArray: [],
			activeInputSources: [],
			updateActiveInputSources: () => {
				const handTrackingOn =
					this[P_SESSION].enabledFeatures.includes('hand-tracking');
				const prevInputs = this[P_SESSION].activeInputSources;
				const currInputs = this[P_SESSION].device.inputSources.filter(
					(inputSource) => !inputSource.hand || handTrackingOn,
				);

				const added = currInputs.filter((item) => !prevInputs.includes(item));
				const removed = prevInputs.filter((item) => !currInputs.includes(item));

				this[P_SESSION].activeInputSources = currInputs;

				if (added.length > 0 || removed.length > 0) {
					this.dispatchEvent(
						new XRInputSourcesChangeEvent('inputsourceschange', {
							session: this,
							added,
							removed,
						}),
					);
				}
			},
			trackedAnchors: new XRAnchorSet(),
			persistentAnchors: new Map(),
			newAnchors: new Map(),
			frameTrackedAnchors: new XRAnchorSet(),
			updateTrackedAnchors: () => {
				if (this[P_SESSION].enabledFeatures.includes('anchors')) {
					this[P_SESSION].frameTrackedAnchors.clear();
					Array.from(this[P_SESSION].trackedAnchors).forEach((anchor) => {
						if (anchor[P_ANCHOR].deleted) {
							this[P_SESSION].trackedAnchors.delete(anchor);
							if (this[P_SESSION].newAnchors.has(anchor)) {
								const { reject } = this[P_SESSION].newAnchors.get(anchor)!;
								reject(
									new DOMException(
										'Anchor is no longer tracked',
										'InvalidStateError',
									),
								);
							}
						} else {
							this[P_SESSION].frameTrackedAnchors.add(anchor);
							if (this[P_SESSION].newAnchors.has(anchor)) {
								const { resolve } = this[P_SESSION].newAnchors.get(anchor)!;
								resolve(anchor);
								this[P_SESSION].newAnchors.delete(anchor);
							}
						}
					});
				}
			},
			onend: null,
			oninputsourceschange: null,
			onselect: null,
			onselectstart: null,
			onselectend: null,
			onsqueeze: null,
			onsqueezestart: null,
			onsqueezeend: null,
			onvisibilitychange: null,
			onframeratechange: null,
		};

		XRAnchorUtils.recoverPersistentAnchorsFromStorage(this);

		// start the frameloop
		this[P_SESSION].onDeviceFrame();
	}

	get visibilityState(): XRVisibilityState {
		return this[P_SESSION].device.visibilityState;
	}

	get frameRate(): number | undefined {
		return this[P_SESSION].nominalFrameRate;
	}

	get supportedFrameRates(): Float32Array | undefined {
		return new Float32Array(this[P_SESSION].device.supportedFrameRates);
	}

	get renderState(): XRRenderState {
		return this[P_SESSION].renderState;
	}

	get inputSources(): XRInputSourceArray {
		// use the same array object
		this[P_SESSION].inputSourceArray.length = 0;
		if (!this[P_SESSION].ended && this[P_SESSION].mode !== 'inline') {
			this[P_SESSION].inputSourceArray.push(
				...this[P_SESSION].activeInputSources,
			);
		}
		return this[P_SESSION].inputSourceArray;
	}

	get enabledFeatures(): Array<string> {
		return this[P_SESSION].enabledFeatures;
	}

	get isSystemKeyboardSupported(): boolean {
		return this[P_SESSION].isSystemKeyboardSupported;
	}

	get environmentBlendMode(): XREnvironmentBlendMode {
		return (
			this[P_SESSION].device[P_DEVICE].environmentBlendModes[
				this[P_SESSION].mode
			] ?? XREnvironmentBlendMode.Opaque
		);
	}

	get interactionMode(): XRInteractionMode {
		return this[P_SESSION].device[P_DEVICE].interactionMode;
	}

	updateRenderState(state: XRRenderStateInit = {}): void {
		if (this[P_SESSION].ended) {
			throw new DOMException(
				'XRSession has already ended.',
				'InvalidStateError',
			);
		}

		if (state.baseLayer && state.baseLayer[P_WEBGL_LAYER].session !== this) {
			throw new DOMException(
				'Base layer was created by a different XRSession',
				'InvalidStateError',
			);
		}

		if (
			state.inlineVerticalFieldOfView != null &&
			this[P_SESSION].mode !== 'inline'
		) {
			throw new DOMException(
				'InlineVerticalFieldOfView must not be set for an immersive session',
				'InvalidStateError',
			);
		}

		const compoundStateInit: XRRenderStateInit = {
			baseLayer:
				state.baseLayer ||
				this[P_SESSION].pendingRenderState?.baseLayer ||
				undefined,
			depthFar:
				state.depthFar ||
				this[P_SESSION].pendingRenderState?.depthFar ||
				undefined,
			depthNear:
				state.depthNear ||
				this[P_SESSION].pendingRenderState?.depthNear ||
				undefined,
			inlineVerticalFieldOfView:
				state.inlineVerticalFieldOfView ||
				this[P_SESSION].pendingRenderState?.inlineVerticalFieldOfView ||
				undefined,
		};

		this[P_SESSION].pendingRenderState = new XRRenderState(
			compoundStateInit,
			this[P_SESSION].renderState,
		);
	}

	// the nominal frame rate updates are emulated, no actual update to the
	// display frame rate of the device will be executed
	async updateTargetFrameRate(rate: number): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			if (this[P_SESSION].ended) {
				reject(
					new DOMException('XRSession has already ended.', 'InvalidStateError'),
				);
			} else if (!this[P_SESSION].device.supportedFrameRates.includes(rate)) {
				reject(
					new DOMException(
						'Requested frame rate not supported.',
						'InvalidStateError',
					),
				);
			} else {
				if (this[P_SESSION].nominalFrameRate === rate) {
					console.log(
						`Requested frame rate is the same as the current nominal frame rate, no update made`,
					);
				} else {
					this[P_SESSION].nominalFrameRate = rate;
					this.dispatchEvent(
						new XRSessionEvent('frameratechange', { session: this }),
					);
					console.log(`Nominal frame rate updated to ${rate}`);
				}
				resolve();
			}
		});
	}

	async requestReferenceSpace(
		type: XRReferenceSpaceType,
	): Promise<XRReferenceSpace> {
		return new Promise<XRReferenceSpace>((resolve, reject) => {
			if (
				this[P_SESSION].ended ||
				!this[P_SESSION].referenceSpaceIsSupported(type)
			) {
				reject(
					new DOMException(
						'The requested reference space type is not supported.',
						'NotSupportedError',
					),
				);
				return;
			}
			let referenceSpace: XRReferenceSpace;
			switch (type) {
				case XRReferenceSpaceType.Viewer:
					referenceSpace = this[P_SESSION].device.viewerSpace;
					break;
				case XRReferenceSpaceType.Local:
					// creating an XRReferenceSpace with the current headset transform in global space
					referenceSpace = new XRReferenceSpace(
						type,
						this[P_SESSION].device[P_DEVICE].globalSpace,
						this[P_SESSION].device.viewerSpace[P_SPACE].offsetMatrix,
					);
					break;
				case XRReferenceSpaceType.LocalFloor:
				case XRReferenceSpaceType.BoundedFloor:
				case XRReferenceSpaceType.Unbounded:
					// TO-DO: add boundary geometry for bounded-floor
					referenceSpace = new XRReferenceSpace(
						type,
						this[P_SESSION].device[P_DEVICE].globalSpace,
					);
					break;
			}
			this[P_SESSION].referenceSpaces.push(referenceSpace);
			resolve(referenceSpace);
		});
	}

	requestAnimationFrame(callback: XRFrameRequestCallback): number {
		if (this[P_SESSION].ended) {
			return 0;
		}
		const frameHandle = ++this[P_SESSION].frameHandle;
		this[P_SESSION].frameCallbacks.push({
			handle: frameHandle,
			callback,
			cancelled: false,
		});
		return frameHandle;
	}

	cancelAnimationFrame(handle: number): void {
		// Remove the callback with that handle from the queue
		let callbacks: CallbackData[] | null = this[P_SESSION].frameCallbacks;
		let index = callbacks.findIndex((d) => d && d.handle === handle);
		if (index > -1) {
			callbacks[index].cancelled = true;
			callbacks.splice(index, 1);
		}
		// If cancelAnimationFrame is called from within a frame callback, also check
		// the remaining callbacks for the current frame:
		callbacks = this[P_SESSION].currentFrameCallbacks;
		if (callbacks) {
			index = callbacks.findIndex((d) => d && d.handle === handle);
			if (index > -1) {
				callbacks[index].cancelled = true;
				// Rely on cancelled flag only; don't mutate this array while it's being iterated
			}
		}
	}

	async end(): Promise<void> {
		return new Promise((resolve, reject) => {
			if (this[P_SESSION].ended || this[P_SESSION].deviceFrameHandle === null) {
				reject(
					new DOMException('XRSession has already ended.', 'InvalidStateError'),
				);
			} else {
				globalThis.cancelAnimationFrame(this[P_SESSION].deviceFrameHandle!);
				this[P_SESSION].device[P_DEVICE].onSessionEnd();
				this.dispatchEvent(new XRSessionEvent('end', { session: this }));
				resolve();
			}
		});
	}

	// anchors
	get persistentAnchors(): Readonly<string[]> {
		return Array.from(this[P_SESSION].persistentAnchors.keys());
	}

	restorePersistentAnchor(uuid: string): Promise<XRAnchor> {
		return new Promise<XRAnchor>((resolve, reject) => {
			if (!this[P_SESSION].persistentAnchors.has(uuid)) {
				reject(
					new DOMException(
						`Persistent anchor with uuid ${uuid} not found.`,
						'InvalidStateError',
					),
				);
			} else if (this[P_SESSION].ended) {
				reject(
					new DOMException('XRSession has already ended.', 'InvalidStateError'),
				);
			} else {
				const anchor = this[P_SESSION].persistentAnchors.get(uuid)!;
				if (this[P_SESSION].newAnchors.has(anchor)) {
					reject(
						new DOMException(
							`Multiple concurrent attempts detected to restore the anchor with UUID: ${uuid}.`,
							'InvalidStateError',
						),
					);
				} else {
					this[P_SESSION].trackedAnchors.add(anchor);
					this[P_SESSION].newAnchors.set(anchor, { resolve, reject });
				}
			}
		});
	}

	deletePersistentAnchor(uuid: string): Promise<undefined> {
		return new Promise<undefined>((resolve, reject) => {
			if (!this[P_SESSION].persistentAnchors.has(uuid)) {
				reject(
					new DOMException(
						`Persistent anchor with uuid ${uuid} not found.`,
						'InvalidStateError',
					),
				);
			} else {
				const anchor = this[P_SESSION].persistentAnchors.get(uuid)!;
				this[P_SESSION].persistentAnchors.delete(uuid);
				anchor.delete();
				resolve(undefined);
			}
		});
	}

	// events
	get onend() {
		return this[P_SESSION].onend ?? (() => {});
	}

	set onend(callback: XRSessionEventHandler) {
		if (this[P_SESSION].onend) {
			this.removeEventListener('end', this[P_SESSION].onend as EventListener);
		}
		this[P_SESSION].onend = callback;
		if (callback) {
			this.addEventListener('end', callback as EventListener);
		}
	}

	get oninputsourceschange() {
		return this[P_SESSION].oninputsourceschange ?? (() => {});
	}

	set oninputsourceschange(callback: XRInputSourcesChangeEventHandler) {
		if (this[P_SESSION].oninputsourceschange) {
			this.removeEventListener(
				'inputsourceschange',
				this[P_SESSION].oninputsourceschange as EventListener,
			);
		}
		this[P_SESSION].oninputsourceschange = callback;
		if (callback) {
			this.addEventListener('inputsourceschange', callback as EventListener);
		}
	}

	get onselect() {
		return this[P_SESSION].onselect ?? (() => {});
	}

	set onselect(callback: XRInputSourceEventHandler) {
		if (this[P_SESSION].onselect) {
			this.removeEventListener(
				'select',
				this[P_SESSION].onselect as EventListener,
			);
		}
		this[P_SESSION].onselect = callback;
		if (callback) {
			this.addEventListener('select', callback as EventListener);
		}
	}

	get onselectstart() {
		return this[P_SESSION].onselectstart ?? (() => {});
	}

	set onselectstart(callback: XRInputSourceEventHandler) {
		if (this[P_SESSION].onselectstart) {
			this.removeEventListener(
				'selectstart',
				this[P_SESSION].onselectstart as EventListener,
			);
		}
		this[P_SESSION].onselectstart = callback;
		if (callback) {
			this.addEventListener('selectstart', callback as EventListener);
		}
	}

	get onselectend() {
		return this[P_SESSION].onselectend ?? (() => {});
	}

	set onselectend(callback: XRInputSourceEventHandler) {
		if (this[P_SESSION].onselectend) {
			this.removeEventListener(
				'selectend',
				this[P_SESSION].onselectend as EventListener,
			);
		}
		this[P_SESSION].onselectend = callback;
		if (callback) {
			this.addEventListener('selectend', callback as EventListener);
		}
	}

	get onsqueeze() {
		return this[P_SESSION].onsqueeze ?? (() => {});
	}

	set onsqueeze(callback: XRInputSourceEventHandler) {
		if (this[P_SESSION].onsqueeze) {
			this.removeEventListener(
				'squeeze',
				this[P_SESSION].onsqueeze as EventListener,
			);
		}
		this[P_SESSION].onsqueeze = callback;
		if (callback) {
			this.addEventListener('squeeze', callback as EventListener);
		}
	}

	get onsqueezestart() {
		return this[P_SESSION].onsqueezestart ?? (() => {});
	}

	set onsqueezestart(callback: XRInputSourceEventHandler) {
		if (this[P_SESSION].onsqueezestart) {
			this.removeEventListener(
				'squeezestart',
				this[P_SESSION].onsqueezestart as EventListener,
			);
		}
		this[P_SESSION].onsqueezestart = callback;
		if (callback) {
			this.addEventListener('squeezestart', callback as EventListener);
		}
	}

	get onsqueezeend() {
		return this[P_SESSION].onsqueezeend ?? (() => {});
	}

	set onsqueezeend(callback: XRInputSourceEventHandler) {
		if (this[P_SESSION].onsqueezeend) {
			this.removeEventListener(
				'squeezeend',
				this[P_SESSION].onsqueezeend as EventListener,
			);
		}
		this[P_SESSION].onsqueezeend = callback;
		if (callback) {
			this.addEventListener('squeezeend', callback as EventListener);
		}
	}

	get onvisibilitychange() {
		return this[P_SESSION].onvisibilitychange ?? (() => {});
	}

	set onvisibilitychange(callback: XRSessionEventHandler) {
		if (this[P_SESSION].onvisibilitychange) {
			this.removeEventListener(
				'visibilitychange',
				this[P_SESSION].onvisibilitychange as EventListener,
			);
		}
		this[P_SESSION].onvisibilitychange = callback;
		if (callback) {
			this.addEventListener('visibilitychange', callback as EventListener);
		}
	}

	get onframeratechange() {
		return this[P_SESSION].onframeratechange ?? (() => {});
	}

	set onframeratechange(callback: XRSessionEventHandler) {
		if (this[P_SESSION].onframeratechange) {
			this.removeEventListener(
				'frameratechange',
				this[P_SESSION].onframeratechange as EventListener,
			);
		}
		this[P_SESSION].onframeratechange = callback;
		if (callback) {
			this.addEventListener('frameratechange', callback as EventListener);
		}
	}
}
