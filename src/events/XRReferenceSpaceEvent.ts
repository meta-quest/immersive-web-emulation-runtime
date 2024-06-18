/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRReferenceSpace } from '../spaces/XRReferenceSpace.js';
import { XRRigidTransform } from '../primitives/XRRigidTransform.js';

interface XRReferenceSpaceEventInit extends EventInit {
	referenceSpace: XRReferenceSpace;
	transform?: XRRigidTransform;
}

export class XRReferenceSpaceEvent extends Event {
	public readonly referenceSpace: XRReferenceSpace;
	public readonly transform?: XRRigidTransform;

	constructor(type: string, eventInitDict: XRReferenceSpaceEventInit) {
		super(type, eventInitDict);
		if (!eventInitDict.referenceSpace) {
			throw new Error('XRReferenceSpaceEventInit.referenceSpace is required');
		}
		this.referenceSpace = eventInitDict.referenceSpace;
		this.transform = eventInitDict.transform;
	}
}

export interface XRReferenceSpaceEventHandler {
	(evt: XRReferenceSpaceEvent): any;
}
