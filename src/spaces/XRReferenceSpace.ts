/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRReferenceSpaceEventHandler } from '../events/XRReferenceSpaceEvent.js';
import { XRSpace } from './XRSpace.js';
import { mat4 } from 'gl-matrix';

export const PRIVATE = Symbol(
	'@immersive-web-emulation-runtime/xr-reference-space',
);

export enum XRReferenceSpaceType {
	Viewer = 'viewer',
	Local = 'local',
	LocalFloor = 'local-floor',
	BoundedFloor = 'bounded-floor',
	Unbounded = 'unbounded',
}

export class XRReferenceSpace extends XRSpace {
	[PRIVATE]: {
		type: XRReferenceSpaceType;
		onreset: XRReferenceSpaceEventHandler | null;
	} = {
		type: null as any,
		onreset: () => {},
	};

	constructor(
		type: XRReferenceSpaceType,
		parentSpace: XRSpace,
		offsetMatrix?: mat4,
	) {
		super(parentSpace, offsetMatrix);
		this[PRIVATE].type = type;
	}

	get onreset(): XRReferenceSpaceEventHandler {
		return this[PRIVATE].onreset ?? (() => {});
	}

	set onreset(callback: XRReferenceSpaceEventHandler) {
		if (this[PRIVATE].onreset) {
			this.removeEventListener('reset', this[PRIVATE].onreset as EventListener);
		}
		this[PRIVATE].onreset = callback;
		if (callback) {
			this.addEventListener('reset', callback as EventListener);
		}
	}

	// Create a new XRReferenceSpace with an offset from the current space
	getOffsetReferenceSpace(originOffset: mat4): XRReferenceSpace {
		// Create a new XRReferenceSpace with the originOffset as its offsetMatrix
		// The new space's parent is set to 'this' (the current XRReferenceSpace)
		return new XRReferenceSpace(this[PRIVATE].type, this, originOffset);
	}
}
