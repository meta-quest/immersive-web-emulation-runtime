/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
	WebXRFeatures,
	PRIVATE as XRDEVICE_PRIVATE,
	XRDevice,
} from '../device/XRDevice.js';
import { PRIVATE as XRFRAME_PRIVATE, XRFrame } from '../frameloop/XRFrame.js';
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
import { XRInputSourceEventHandler } from '../events/XRInputSourceEvent.js';
import { PRIVATE as XRSPACE_PRIVATE } from '../spaces/XRSpace.js';
import { PRIVATE as XRWEBGLLAYER_PRIVATE } from '../layers/XRWebGLLayer.js';
import { mat4 } from 'gl-matrix';

export enum XRVisibilityState {
	Visible = 'visible',
	VisibleBlurred = 'visible-blurred',
	Hidden = 'hidden',
}

export enum XRSessionMode {
	Inline = 'inline',
	ImmersiveVR = 'immersive-vr',
	ImmersiveAR = 'immersive-ar',
}

export type XRSessionInit = {
	requiredFeatures?: string[];
	optionalFeatures?: string[];
};

type XRFrameRequestCallback = (
	time: DOMHighResTimeStamp,
	frame: XRFrame,
) => void;

type CallbackData = {
	handle: number;
	callback: XRFrameRequestCallback;
	cancelled: boolean;
};

export const PRIVATE = Symbol('@immersive-web-emulation-runtime/xr-session');

export class XRSession extends EventTarget {
	[PRIVATE]: {
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
		this[PRIVATE] = {
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
				return this[PRIVATE].projectionMatrices[eye];
			},
			referenceSpaceIsSupported: (referenceSpaceType: XRReferenceSpaceType) => {
				if (!this[PRIVATE].enabledFeatures.includes(referenceSpaceType)) {
					return false;
				}
				switch (referenceSpaceType) {
					case XRReferenceSpaceType.Viewer:
						return true;
					case XRReferenceSpaceType.Local:
					case XRReferenceSpaceType.LocalFloor:
					case XRReferenceSpaceType.BoundedFloor:
					case XRReferenceSpaceType.Unbounded:
						return this[PRIVATE].mode != XRSessionMode.Inline;
				}
			},
			frameHandle: 0,
			frameCallbacks: [],
			currentFrameCallbacks: null,
			onDeviceFrame: () => {
				if (this[PRIVATE].ended) {
					return;
				}

				this[PRIVATE].deviceFrameHandle = globalThis.requestAnimationFrame(
					this[PRIVATE].onDeviceFrame,
				);

				if (this[PRIVATE].pendingRenderState != null) {
					this[PRIVATE].renderState = this[PRIVATE].pendingRenderState;
					this[PRIVATE].pendingRenderState = null;
					this[PRIVATE].device[XRDEVICE_PRIVATE].onBaseLayerSet(
						this[PRIVATE].renderState.baseLayer,
					);
				}

				const baseLayer = this[PRIVATE].renderState.baseLayer;
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
				if (this[PRIVATE].mode != XRSessionMode.Inline) {
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
				const { depthNear, depthFar } = this[PRIVATE].renderState;
				const { width, height } = canvas;
				if (this[PRIVATE].mode !== XRSessionMode.Inline) {
					const aspect =
						(width * (this[PRIVATE].device.stereoEnabled ? 0.5 : 1.0)) / height;
					mat4.perspective(
						this[PRIVATE].projectionMatrices[XREye.Left],
						this[PRIVATE].device.fovy,
						aspect,
						depthNear,
						depthFar,
					);
					mat4.copy(
						this[PRIVATE].projectionMatrices[XREye.Right],
						this[PRIVATE].projectionMatrices[XREye.Left],
					);
				} else {
					const aspect = width / height;
					mat4.perspective(
						this[PRIVATE].projectionMatrices[XREye.None],
						this[PRIVATE].renderState.inlineVerticalFieldOfView!,
						aspect,
						depthNear,
						depthFar,
					);
				}

				const frame = new XRFrame(
					this,
					this[PRIVATE].frameHandle,
					true,
					true,
					performance.now(),
				);

				this[PRIVATE].device[XRDEVICE_PRIVATE].onFrameStart(frame);
				this[PRIVATE].updateActiveInputSources();

				/*
				 * For each entry in callbacks, in order:
				 * - If the entry’s cancelled boolean is true, continue to the next entry.
				 * - Invoke the Web IDL callback function, passing now and frame as the arguments.
				 * - If an exception is thrown, report the exception.
				 */
				// - Let callbacks be a list of the entries in session’s list of animation frame
				//   callback, in the order in which they were added to the list.
				const callbacks = (this[PRIVATE].currentFrameCallbacks =
					this[PRIVATE].frameCallbacks);
				// - Set session’s list of animation frame callbacks to the empty list.
				this[PRIVATE].frameCallbacks = [];
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
				this[PRIVATE].currentFrameCallbacks = null;

				// - Set frame’s active boolean to false.
				frame[XRFRAME_PRIVATE].active = false;
			},
			nominalFrameRate: device.internalNominalFrameRate,
			referenceSpaces: [],
			inputSourceArray: [],
			activeInputSources: [],
			updateActiveInputSources: () => {
				const handTrackingOn = this[PRIVATE].enabledFeatures.includes(
					WebXRFeatures.HandTracking,
				);
				const prevInputs = this[PRIVATE].activeInputSources;
				const currInputs = this[PRIVATE].device.inputSources.filter(
					(inputSource) => !inputSource.hand || handTrackingOn,
				);

				const added = currInputs.filter((item) => !prevInputs.includes(item));
				const removed = prevInputs.filter((item) => !currInputs.includes(item));

				if (added.length > 0 || removed.length > 0) {
					this.dispatchEvent(
						new XRInputSourcesChangeEvent('inputsourceschange', {
							session: this,
							added,
							removed,
						}),
					);
				}

				this[PRIVATE].activeInputSources = currInputs;
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

		// start the frameloop
		this[PRIVATE].onDeviceFrame();
	}

	get visibilityState(): XRVisibilityState {
		return this[PRIVATE].device.visibilityState;
	}

	get frameRate(): number | undefined {
		return this[PRIVATE].nominalFrameRate;
	}

	get supportedFrameRates(): Float32Array | undefined {
		return new Float32Array(this[PRIVATE].device.supportedFrameRates);
	}

	get renderState(): XRRenderState {
		return this[PRIVATE].renderState;
	}

	get inputSources(): XRInputSourceArray {
		// use the same array object
		this[PRIVATE].inputSourceArray.length = 0;
		if (!this[PRIVATE].ended && this[PRIVATE].mode !== XRSessionMode.Inline) {
			this[PRIVATE].inputSourceArray.push(...this[PRIVATE].activeInputSources);
		}
		return this[PRIVATE].inputSourceArray;
	}

	get enabledFeatures(): Array<string> {
		return this[PRIVATE].enabledFeatures;
	}

	get isSystemKeyboardSupported(): boolean {
		return this[PRIVATE].isSystemKeyboardSupported;
	}

	updateRenderState(state: XRRenderStateInit = {}): void {
		if (this[PRIVATE].ended) {
			throw new DOMException(
				'XRSession has already ended.',
				'InvalidStateError',
			);
		}

		if (
			state.baseLayer &&
			state.baseLayer[XRWEBGLLAYER_PRIVATE].session !== this
		) {
			throw new DOMException(
				'Base layer was created by a different XRSession',
				'InvalidStateError',
			);
		}

		if (
			state.inlineVerticalFieldOfView != null &&
			this[PRIVATE].mode !== XRSessionMode.Inline
		) {
			throw new DOMException(
				'InlineVerticalFieldOfView must not be set for an immersive session',
				'InvalidStateError',
			);
		}

		const compoundStateInit: XRRenderStateInit = {
			baseLayer:
				state.baseLayer ||
				this[PRIVATE].pendingRenderState?.baseLayer ||
				undefined,
			depthFar:
				state.depthFar ||
				this[PRIVATE].pendingRenderState?.depthFar ||
				undefined,
			depthNear:
				state.depthNear ||
				this[PRIVATE].pendingRenderState?.depthNear ||
				undefined,
			inlineVerticalFieldOfView:
				state.inlineVerticalFieldOfView ||
				this[PRIVATE].pendingRenderState?.inlineVerticalFieldOfView ||
				undefined,
		};

		this[PRIVATE].pendingRenderState = new XRRenderState(
			compoundStateInit,
			this[PRIVATE].renderState,
		);
	}

	// the nominal frame rate updates are emulated, no actual update to the
	// display frame rate of the device will be executed
	async updateTargetFrameRate(rate: number): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			if (this[PRIVATE].ended) {
				reject(
					new DOMException('XRSession has already ended.', 'InvalidStateError'),
				);
			} else if (!this[PRIVATE].device.supportedFrameRates.includes(rate)) {
				reject(
					new DOMException(
						'Requested frame rate not supported.',
						'InvalidStateError',
					),
				);
			} else {
				if (this[PRIVATE].nominalFrameRate === rate) {
					console.log(
						`Requested frame rate is the same as the current nominal frame rate, no update made`,
					);
				} else {
					this[PRIVATE].nominalFrameRate = rate;
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
				this[PRIVATE].ended ||
				!this[PRIVATE].referenceSpaceIsSupported(type)
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
					referenceSpace = this[PRIVATE].device.viewerSpace;
					break;
				case XRReferenceSpaceType.Local:
					// creating an XRReferenceSpace with the current headset transform in global space
					referenceSpace = new XRReferenceSpace(
						type,
						this[PRIVATE].device[XRDEVICE_PRIVATE].globalSpace,
						this[PRIVATE].device.viewerSpace[XRSPACE_PRIVATE].offsetMatrix,
					);
					break;
				case XRReferenceSpaceType.LocalFloor:
				case XRReferenceSpaceType.BoundedFloor:
				case XRReferenceSpaceType.Unbounded:
					// TO-DO: add boundary geometry for bounded-floor
					referenceSpace = new XRReferenceSpace(
						type,
						this[PRIVATE].device[XRDEVICE_PRIVATE].globalSpace,
					);
					break;
			}
			this[PRIVATE].referenceSpaces.push(referenceSpace);
			resolve(referenceSpace);
		});
	}

	requestAnimationFrame(callback: XRFrameRequestCallback): number {
		if (this[PRIVATE].ended) {
			return 0;
		}
		const frameHandle = ++this[PRIVATE].frameHandle;
		this[PRIVATE].frameCallbacks.push({
			handle: frameHandle,
			callback,
			cancelled: false,
		});
		return frameHandle;
	}

	cancelAnimationFrame(handle: number): void {
		// Remove the callback with that handle from the queue
		let callbacks: CallbackData[] | null = this[PRIVATE].frameCallbacks;
		let index = callbacks.findIndex((d) => d && d.handle === handle);
		if (index > -1) {
			callbacks[index].cancelled = true;
			callbacks.splice(index, 1);
		}
		// If cancelAnimationFrame is called from within a frame callback, also check
		// the remaining callbacks for the current frame:
		callbacks = this[PRIVATE].currentFrameCallbacks;
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
			if (this[PRIVATE].ended || this[PRIVATE].deviceFrameHandle === null) {
				reject(
					new DOMException('XRSession has already ended.', 'InvalidStateError'),
				);
			} else {
				globalThis.cancelAnimationFrame(this[PRIVATE].deviceFrameHandle!);
				this[PRIVATE].device[XRDEVICE_PRIVATE].onSessionEnd();
				this.dispatchEvent(new XRSessionEvent('end', { session: this }));
				resolve();
			}
		});
	}

	// events
	get onend() {
		return this[PRIVATE].onend ?? (() => {});
	}

	set onend(callback: XRSessionEventHandler) {
		if (this[PRIVATE].onend) {
			this.removeEventListener('end', this[PRIVATE].onend as EventListener);
		}
		this[PRIVATE].onend = callback;
		if (callback) {
			this.addEventListener('end', callback as EventListener);
		}
	}

	get oninputsourceschange() {
		return this[PRIVATE].oninputsourceschange ?? (() => {});
	}

	set oninputsourceschange(callback: XRInputSourcesChangeEventHandler) {
		if (this[PRIVATE].oninputsourceschange) {
			this.removeEventListener(
				'inputsourceschange',
				this[PRIVATE].oninputsourceschange as EventListener,
			);
		}
		this[PRIVATE].oninputsourceschange = callback;
		if (callback) {
			this.addEventListener('inputsourceschange', callback as EventListener);
		}
	}

	get onselect() {
		return this[PRIVATE].onselect ?? (() => {});
	}

	set onselect(callback: XRInputSourceEventHandler) {
		if (this[PRIVATE].onselect) {
			this.removeEventListener(
				'select',
				this[PRIVATE].onselect as EventListener,
			);
		}
		this[PRIVATE].onselect = callback;
		if (callback) {
			this.addEventListener('select', callback as EventListener);
		}
	}

	get onselectstart() {
		return this[PRIVATE].onselectstart ?? (() => {});
	}

	set onselectstart(callback: XRInputSourceEventHandler) {
		if (this[PRIVATE].onselectstart) {
			this.removeEventListener(
				'selectstart',
				this[PRIVATE].onselectstart as EventListener,
			);
		}
		this[PRIVATE].onselectstart = callback;
		if (callback) {
			this.addEventListener('selectstart', callback as EventListener);
		}
	}

	get onselectend() {
		return this[PRIVATE].onselectend ?? (() => {});
	}

	set onselectend(callback: XRInputSourceEventHandler) {
		if (this[PRIVATE].onselectend) {
			this.removeEventListener(
				'selectend',
				this[PRIVATE].onselectend as EventListener,
			);
		}
		this[PRIVATE].onselectend = callback;
		if (callback) {
			this.addEventListener('selectend', callback as EventListener);
		}
	}

	get onsqueeze() {
		return this[PRIVATE].onsqueeze ?? (() => {});
	}

	set onsqueeze(callback: XRInputSourceEventHandler) {
		if (this[PRIVATE].onsqueeze) {
			this.removeEventListener(
				'squeeze',
				this[PRIVATE].onsqueeze as EventListener,
			);
		}
		this[PRIVATE].onsqueeze = callback;
		if (callback) {
			this.addEventListener('squeeze', callback as EventListener);
		}
	}

	get onsqueezestart() {
		return this[PRIVATE].onsqueezestart ?? (() => {});
	}

	set onsqueezestart(callback: XRInputSourceEventHandler) {
		if (this[PRIVATE].onsqueezestart) {
			this.removeEventListener(
				'squeezestart',
				this[PRIVATE].onsqueezestart as EventListener,
			);
		}
		this[PRIVATE].onsqueezestart = callback;
		if (callback) {
			this.addEventListener('squeezestart', callback as EventListener);
		}
	}

	get onsqueezeend() {
		return this[PRIVATE].onsqueezeend ?? (() => {});
	}

	set onsqueezeend(callback: XRInputSourceEventHandler) {
		if (this[PRIVATE].onsqueezeend) {
			this.removeEventListener(
				'squeezeend',
				this[PRIVATE].onsqueezeend as EventListener,
			);
		}
		this[PRIVATE].onsqueezeend = callback;
		if (callback) {
			this.addEventListener('squeezeend', callback as EventListener);
		}
	}

	get onvisibilitychange() {
		return this[PRIVATE].onvisibilitychange ?? (() => {});
	}

	set onvisibilitychange(callback: XRSessionEventHandler) {
		if (this[PRIVATE].onvisibilitychange) {
			this.removeEventListener(
				'visibilitychange',
				this[PRIVATE].onvisibilitychange as EventListener,
			);
		}
		this[PRIVATE].onvisibilitychange = callback;
		if (callback) {
			this.addEventListener('visibilitychange', callback as EventListener);
		}
	}

	get onframeratechange() {
		return this[PRIVATE].onframeratechange ?? (() => {});
	}

	set onframeratechange(callback: XRSessionEventHandler) {
		if (this[PRIVATE].onframeratechange) {
			this.removeEventListener(
				'frameratechange',
				this[PRIVATE].onframeratechange as EventListener,
			);
		}
		this[PRIVATE].onframeratechange = callback;
		if (callback) {
			this.addEventListener('frameratechange', callback as EventListener);
		}
	}
}
