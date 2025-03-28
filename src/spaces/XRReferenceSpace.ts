/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_REF_SPACE } from '../private.js';
import { XRReferenceSpaceEventHandler } from '../events/XRReferenceSpaceEvent.js';
import { XRSpace } from './XRSpace.js';
import { mat4 } from 'gl-matrix';

export enum XRReferenceSpaceType {
	Viewer = 'viewer',
	Local = 'local',
	LocalFloor = 'local-floor',
	BoundedFloor = 'bounded-floor',
	Unbounded = 'unbounded',
}

export class XRReferenceSpace extends XRSpace {
	[P_REF_SPACE]: {
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
		this[P_REF_SPACE].type = type;
	}

	get onreset(): XRReferenceSpaceEventHandler {
		return this[P_REF_SPACE].onreset ?? (() => {});
	}

	set onreset(callback: XRReferenceSpaceEventHandler) {
		if (this[P_REF_SPACE].onreset) {
			this.removeEventListener(
				'reset',
				this[P_REF_SPACE].onreset as EventListener,
			);
		}
		this[P_REF_SPACE].onreset = callback;
		if (callback) {
			this.addEventListener('reset', callback as EventListener);
		}
	}

	// Create a new XRReferenceSpace with an offset from the current space
	getOffsetReferenceSpace(originOffset: mat4): XRReferenceSpace {
		// Create a new XRReferenceSpace with the originOffset as its offsetMatrix
		// The new space's parent is set to 'this' (the current XRReferenceSpace)
		return new XRReferenceSpace(this[P_REF_SPACE].type, this, originOffset);
	}
}
