/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

class PolyfillDOMPointReadOnly {
	readonly x: number;
	readonly y: number;
	readonly z: number;
	readonly w: number;

	constructor(x = 0, y = 0, z = 0, w = 1) {
		this.x = x;
		this.y = y;
		this.z = z;
		this.w = w;
		Object.freeze(this);
	}

	static fromPoint(other: DOMPointInit): PolyfillDOMPointReadOnly {
		return new PolyfillDOMPointReadOnly(other.x, other.y, other.z, other.w);
	}

	matrixTransform(_matrix: DOMMatrixReadOnly): DOMPointReadOnly {
		// Implement matrix transformation logic here
		// This is a placeholder implementation
		return new PolyfillDOMPointReadOnly();
	}

	toJSON(): any {
		// Implement toJSON logic here
		// This is a placeholder implementation
		return { x: this.x, y: this.y, z: this.z, w: this.w };
	}
}

export const DOMPointReadOnly =
	typeof globalThis.DOMPointReadOnly !== 'undefined'
		? globalThis.DOMPointReadOnly
		: PolyfillDOMPointReadOnly;
