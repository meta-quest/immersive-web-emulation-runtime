/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
	PRIVATE as XRSESSION_PRIVATE,
	XRSession,
} from '../session/XRSession.js';
import { PRIVATE as XRVIEW_PRIVATE, XRView } from '../views/XRView.js';

import { PRIVATE as XRDEVICE_PRIVATE } from '../device/XRDevice.js';

export class XRLayer extends EventTarget {}

export const PRIVATE = Symbol('@immersive-web-emulation-runtime/XRWebGLLayer');

type LayerInit = {
	antialias?: boolean;
	depth?: boolean;
	stencil?: boolean;
	alpha?: boolean;
	ignoreDepthValues?: boolean;
	framebufferScaleFactor?: number;
};

const defaultLayerInit: LayerInit = {
	antialias: true,
	depth: true,
	stencil: false,
	alpha: true,
	ignoreDepthValues: false,
	framebufferScaleFactor: 1.0,
};

export class XRWebGLLayer extends XRLayer {
	[PRIVATE]: {
		session: XRSession;
		context: WebGLRenderingContext | WebGL2RenderingContext;
		antialias: boolean;
	};

	constructor(
		session: XRSession,
		context: WebGLRenderingContext | WebGL2RenderingContext,
		layerInit: LayerInit = {},
	) {
		super();

		if (session[XRSESSION_PRIVATE].ended) {
			throw new DOMException('Session has ended', 'InvalidStateError');
		}

		// TO-DO: Check that the context attribute has xrCompatible set to true
		// may require polyfilling the context and perhaps canvas.getContext

		// Default values for XRWebGLLayerInit, can be overridden by layerInit
		const config = { ...defaultLayerInit, ...layerInit };

		this[PRIVATE] = {
			session,
			context,
			antialias: config.antialias!,
		};
	}

	get context() {
		return this[PRIVATE].context;
	}

	get antialias() {
		return this[PRIVATE].antialias;
	}

	get ignoreDepthValues() {
		return true;
	}

	get framebuffer() {
		return null;
	}

	get framebufferWidth() {
		return this[PRIVATE].context.drawingBufferWidth;
	}

	get framebufferHeight() {
		return this[PRIVATE].context.drawingBufferHeight;
	}

	getViewport(view: XRView) {
		if (view[XRVIEW_PRIVATE].session !== this[PRIVATE].session) {
			throw new DOMException(
				"View's session differs from Layer's session",
				'InvalidStateError',
			);
		}
		// TO-DO: check frame
		return this[PRIVATE].session[XRSESSION_PRIVATE].device[
			XRDEVICE_PRIVATE
		].getViewport(this, view);
	}

	static getNativeFramebufferScaleFactor(session: XRSession): number {
		if (!(session instanceof XRSession)) {
			throw new TypeError(
				'getNativeFramebufferScaleFactor must be passed a session.',
			);
		}

		if (session[XRSESSION_PRIVATE].ended) {
			return 0.0;
		}

		// Return 1.0 for simplicity, actual implementation might vary based on the device capabilities
		return 1.0;
	}
}
