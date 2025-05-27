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
	static fromPoint(other: DOMPointInit): DOMPointReadOnly {
		return new PolyfillDOMPointReadOnly(other.x, other.y, other.z, other.w);
	}

	matrixTransform(matrix: DOMMatrixReadOnly): DOMPointReadOnly {
		const x =
			matrix.m11 * this.x +
			matrix.m21 * this.y +
			matrix.m31 * this.z +
			matrix.m41 * this.w;
		const y =
			matrix.m12 * this.x +
			matrix.m22 * this.y +
			matrix.m32 * this.z +
			matrix.m42 * this.w;
		const z =
			matrix.m13 * this.x +
			matrix.m23 * this.y +
			matrix.m33 * this.z +
			matrix.m43 * this.w;
		const w =
			matrix.m14 * this.x +
			matrix.m24 * this.y +
			matrix.m34 * this.z +
			matrix.m44 * this.w;
		return new PolyfillDOMPointReadOnly(x, y, z, w);
	}

	toJSON(): any {
		return { x: this.x, y: this.y, z: this.z, w: this.w };
	}
}

if (typeof globalThis.DOMPointReadOnly === 'undefined') {
	// @ts-ignore
	globalThis.DOMPointReadOnly = PolyfillDOMPointReadOnly as any;
}
