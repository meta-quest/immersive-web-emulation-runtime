/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_DEPTH_INFO } from '../private.js';
import { XRRigidTransform } from '../primitives/XRRigidTransform.js';

export type XRDepthUsage = 'cpu-optimized' | 'gpu-optimized';
export type XRDepthDataFormat = 'luminance-alpha' | 'float32';

export interface XRDepthStateInit {
	usagePreference: XRDepthUsage[];
	dataFormatPreference: XRDepthDataFormat[];
}

export interface DepthSensingData {
	data: ArrayBuffer;
	width: number;
	height: number;
	rawValueToMeters: number;
}

export class XRCPUDepthInformation {
	[P_DEPTH_INFO]: {
		data: ArrayBuffer;
		width: number;
		height: number;
		normDepthBufferFromNormView: XRRigidTransform;
		rawValueToMeters: number;
		dataFormat: XRDepthDataFormat;
	};

	constructor(
		data: ArrayBuffer,
		width: number,
		height: number,
		normDepthBufferFromNormView: XRRigidTransform,
		rawValueToMeters: number,
		dataFormat: XRDepthDataFormat,
	) {
		this[P_DEPTH_INFO] = {
			data,
			width,
			height,
			normDepthBufferFromNormView,
			rawValueToMeters,
			dataFormat,
		};
	}

	get data(): ArrayBuffer {
		return this[P_DEPTH_INFO].data;
	}

	get width(): number {
		return this[P_DEPTH_INFO].width;
	}

	get height(): number {
		return this[P_DEPTH_INFO].height;
	}

	get normDepthBufferFromNormView(): XRRigidTransform {
		return this[P_DEPTH_INFO].normDepthBufferFromNormView;
	}

	get rawValueToMeters(): number {
		return this[P_DEPTH_INFO].rawValueToMeters;
	}

	getDepthInMeters(x: number, y: number): number {
		const { width, height, rawValueToMeters, data, dataFormat } =
			this[P_DEPTH_INFO];

		if (x < 0 || x >= 1 || y < 0 || y >= 1) {
			throw new RangeError(
				'Normalized coordinates must be in [0, 1) range.',
			);
		}

		const col = Math.floor(x * width);
		const row = Math.floor(y * height);

		if (dataFormat === 'float32') {
			const floatView = new Float32Array(data);
			const index = row * width + col;
			return floatView[index] * rawValueToMeters;
		} else {
			// luminance-alpha: 16-bit unsigned int packed as two bytes
			const byteView = new Uint8Array(data);
			const index = (row * width + col) * 2;
			const rawValue = byteView[index] + byteView[index + 1] * 256;
			return rawValue * rawValueToMeters;
		}
	}
}
