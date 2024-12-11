/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRSemanticLabels } from '../labels/labels';
import { XRSpace } from '../spaces/XRSpace';

export const PRIVATE = Symbol('@immersive-web-emulation-runtime/xr-plane');

export enum XRPlaneOrientation {
	Horizontal = 'horizontal',
	Vertical = 'vertical',
}

/**
 * XRPlane orientation mapping from semantic labels.
 * For more details, see the {@link https://github.com/immersive-web/semantic-labels | Semantic Labels Documentation}.
 */
export const XREntityOrientation: Partial<
	Record<XRSemanticLabels, XRPlaneOrientation>
> = {
	[XRSemanticLabels.Desk]: XRPlaneOrientation.Horizontal,
	[XRSemanticLabels.Couch]: XRPlaneOrientation.Horizontal,
	[XRSemanticLabels.Floor]: XRPlaneOrientation.Horizontal,
	[XRSemanticLabels.Ceiling]: XRPlaneOrientation.Horizontal,
	[XRSemanticLabels.Wall]: XRPlaneOrientation.Vertical,
	[XRSemanticLabels.Door]: XRPlaneOrientation.Vertical,
	[XRSemanticLabels.Window]: XRPlaneOrientation.Vertical,
	[XRSemanticLabels.Table]: XRPlaneOrientation.Horizontal,
	[XRSemanticLabels.Shelf]: XRPlaneOrientation.Horizontal,
	[XRSemanticLabels.Bed]: XRPlaneOrientation.Horizontal,
	[XRSemanticLabels.Screen]: XRPlaneOrientation.Horizontal,
	[XRSemanticLabels.Lamp]: XRPlaneOrientation.Horizontal,
	[XRSemanticLabels.Plant]: XRPlaneOrientation.Horizontal,
	[XRSemanticLabels.WallArt]: XRPlaneOrientation.Vertical,
};

export class XRPlane {
	[PRIVATE]: {
		planeSpace: XRSpace;
		polygon: DOMPointReadOnly[];
		lastChangedTime: DOMHighResTimeStamp;
		semanticLabel?: XRSemanticLabels;
		orientation?: XRPlaneOrientation;
	};

	constructor(
		planeSpace: XRSpace,
		polygon: DOMPointReadOnly[],
		semanticLabel?: XRSemanticLabels,
	) {
		this[PRIVATE] = {
			planeSpace,
			polygon,
			lastChangedTime: performance.now(),
			semanticLabel,
			orientation: semanticLabel
				? XREntityOrientation[semanticLabel]
				: undefined,
		};
	}

	get planeSpace() {
		return this[PRIVATE].planeSpace;
	}

	get polygon(): ReadonlyArray<DOMPointReadOnly> {
		return this[PRIVATE].polygon;
	}

	get orientation() {
		return this[PRIVATE].orientation;
	}

	get lastChangedTime() {
		return this[PRIVATE].lastChangedTime;
	}

	get semanticLabel() {
		return this[PRIVATE].semanticLabel;
	}
}

export type XRPlaneSet = Set<XRPlane>;
