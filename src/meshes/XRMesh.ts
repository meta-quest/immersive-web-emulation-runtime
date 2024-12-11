/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRSemanticLabels } from '../labels/labels';
import { XRSpace } from '../spaces/XRSpace';

export const PRIVATE = Symbol('@immersive-web-emulation-runtime/xr-mesh');

export class XRMesh {
	[PRIVATE]: {
		meshSpace: XRSpace;
		vertices: Float32Array;
		indices: Uint32Array;
		lastChangedTime: DOMHighResTimeStamp;
		semanticLabel?: XRSemanticLabels;
	};

	constructor(
		meshSpace: XRSpace,
		vertices: Float32Array,
		indices: Uint32Array,
		semanticLabel?: XRSemanticLabels,
	) {
		this[PRIVATE] = {
			meshSpace,
			vertices,
			indices,
			lastChangedTime: performance.now(),
			semanticLabel,
		};
	}

	get meshSpace() {
		return this[PRIVATE].meshSpace;
	}

	get vertices(): Readonly<Float32Array> {
		return this[PRIVATE].vertices;
	}

	get indices(): Readonly<Uint32Array> {
		return this[PRIVATE].indices;
	}

	get lastChangedTime() {
		return this[PRIVATE].lastChangedTime;
	}

	get semanticLabel() {
		return this[PRIVATE].semanticLabel;
	}
}

export type XRMeshSet = Set<XRMesh>;
