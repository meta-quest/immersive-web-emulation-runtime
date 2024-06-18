/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

export const PRIVATE = Symbol('@immersive-web-emulation-runtime/xr-viewport');

export class XRViewport {
	[PRIVATE]: {
		x: number;
		y: number;
		width: number;
		height: number;
	};

	constructor(x: number, y: number, width: number, height: number) {
		this[PRIVATE] = { x, y, width, height };
	}

	get x(): number {
		return this[PRIVATE].x;
	}

	get y(): number {
		return this[PRIVATE].y;
	}

	get width(): number {
		return this[PRIVATE].width;
	}

	get height(): number {
		return this[PRIVATE].height;
	}
}
