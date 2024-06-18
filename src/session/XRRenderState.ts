/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRWebGLLayer } from '../layers/XRWebGLLayer.js';

export const PRIVATE = Symbol(
	'@immersive-web-emulation-runtime/xr-render-state',
);

export class XRRenderState {
	[PRIVATE]: {
		depthNear: number;
		depthFar: number;
		inlineVerticalFieldOfView: number | null;
		baseLayer: XRWebGLLayer | null;
	};

	constructor(init: Partial<XRRenderStateInit> = {}, oldState?: XRRenderState) {
		this[PRIVATE] = {
			depthNear: init.depthNear || oldState?.depthNear || 0.1,
			depthFar: init.depthFar || oldState?.depthFar || 1000.0,
			inlineVerticalFieldOfView:
				init.inlineVerticalFieldOfView ||
				oldState?.inlineVerticalFieldOfView ||
				null,
			baseLayer: init.baseLayer || oldState?.baseLayer || null,
		};
	}

	get depthNear(): number {
		return this[PRIVATE].depthNear;
	}

	get depthFar(): number {
		return this[PRIVATE].depthFar;
	}

	get inlineVerticalFieldOfView(): number | null {
		return this[PRIVATE].inlineVerticalFieldOfView;
	}

	get baseLayer(): XRWebGLLayer | null {
		return this[PRIVATE].baseLayer;
	}
}

// XRRenderStateInit interface definition for TypeScript
export interface XRRenderStateInit {
	depthNear?: number;
	depthFar?: number;
	inlineVerticalFieldOfView?: number;
	baseLayer?: XRWebGLLayer;
}
