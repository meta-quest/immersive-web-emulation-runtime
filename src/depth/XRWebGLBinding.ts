/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_FRAME, P_SESSION, P_VIEW } from '../private.js';
import { XRRigidTransform } from '../primitives/XRRigidTransform.js';
import { XRSession } from '../session/XRSession.js';
import { XRView } from '../views/XRView.js';

import type { XRFrame } from '../frameloop/XRFrame.js';

export type XRTextureType = 'texture' | 'texture-array';

export class XRWebGLDepthInformation {
	readonly texture: WebGLTexture;
	readonly depthNear: number;
	readonly depthFar: number;
	readonly width: number;
	readonly height: number;
	readonly normDepthBufferFromNormView: XRRigidTransform;
	readonly rawValueToMeters: number;
	readonly textureType: XRTextureType;
	readonly imageIndex: number | null;
	readonly isValid: boolean;

	constructor(
		texture: WebGLTexture,
		width: number,
		height: number,
		normDepthBufferFromNormView: XRRigidTransform,
		rawValueToMeters: number,
		depthNear: number,
		depthFar: number,
		textureType: XRTextureType,
		imageIndex: number | null,
	) {
		this.texture = texture;
		this.width = width;
		this.height = height;
		this.normDepthBufferFromNormView = normDepthBufferFromNormView;
		this.rawValueToMeters = rawValueToMeters;
		this.depthNear = depthNear;
		this.depthFar = depthFar;
		this.textureType = textureType;
		this.imageIndex = imageIndex;
		this.isValid = true;
	}
}

export class XRWebGLBinding {
	private _session: XRSession;

	constructor(session: XRSession, _context: WebGL2RenderingContext) {
		this._session = session;
	}

	getDepthInformation(view: XRView): XRWebGLDepthInformation | null {
		if (this._session[P_SESSION].depthSensingUsage !== 'gpu-optimized') {
			return null;
		}

		const frame: XRFrame | null = this._session[P_SESSION].activeFrame;
		if (!frame || !frame[P_FRAME].active) {
			return null;
		}

		const eye = view[P_VIEW].eye;
		return frame[P_FRAME].gpuDepthDataMap.get(eye) ?? null;
	}
}
