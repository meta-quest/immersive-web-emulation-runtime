/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_DEPTH_INFO } from '../private.js';
import { XRRigidTransform } from '../primitives/XRRigidTransform.js';

export type XRDepthUsage = 'cpu-optimized' | 'gpu-optimized';
export type XRDepthDataFormat =
  | 'luminance-alpha'
  | 'float32'
  | 'unsigned-short';

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

// Depth configurations offered to WebGPU sessions, in IWER's preferred order.
// GPU-optimized luminance-alpha depth isn't allowed in WebGPU sessions.
const WEBGPU_DEPTH_FORMATS: Record<XRDepthUsage, XRDepthDataFormat[]> = {
  'cpu-optimized': ['float32', 'unsigned-short', 'luminance-alpha'],
  'gpu-optimized': ['float32', 'unsigned-short'],
};

/**
 * Picks the first supported usage and data format from the app's preferences,
 * usage first, or null when none of them is supported.
 */
export const findWebGPUDepthConfiguration = (
  init: XRDepthStateInit | undefined,
): { usage: XRDepthUsage; dataFormat: XRDepthDataFormat } | null => {
  const usages: XRDepthUsage[] = init?.usagePreference?.length
    ? init.usagePreference
    : ['cpu-optimized', 'gpu-optimized'];
  for (const usage of usages) {
    const supported = WEBGPU_DEPTH_FORMATS[usage] ?? [];
    const formats = init?.dataFormatPreference?.length
      ? init.dataFormatPreference
      : supported;
    const dataFormat = formats.find((format) => supported.includes(format));
    if (dataFormat) {
      return { usage, dataFormat };
    }
  }
  return null;
};

// 16-bit millimeters, the layout of both 'unsigned-short' and
// 'luminance-alpha' depth.
export const toMillimeterDepth = (
  depth: DepthSensingData,
): DepthSensingData => {
  const meters = new Float32Array(depth.data);
  const millimeters = new Uint16Array(meters.length);
  for (let i = 0; i < meters.length; i++) {
    millimeters[i] = Math.min(
      0xffff,
      Math.max(0, Math.round(meters[i] * depth.rawValueToMeters * 1000)),
    );
  }
  return {
    data: millimeters.buffer,
    width: depth.width,
    height: depth.height,
    rawValueToMeters: 0.001,
  };
};

export class XRCPUDepthInformation {
  [P_DEPTH_INFO]: {
    data: ArrayBuffer;
    width: number;
    height: number;
    normDepthBufferFromNormView: XRRigidTransform;
    rawValueToMeters: number;
    dataFormat: XRDepthDataFormat;
    view: Float32Array | Uint8Array;
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
      view:
        dataFormat === 'float32'
          ? new Float32Array(data)
          : new Uint8Array(data),
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

  get dataFormat(): XRDepthDataFormat {
    return this[P_DEPTH_INFO].dataFormat;
  }

  getDepthInMeters(x: number, y: number): number {
    const { width, height, rawValueToMeters, dataFormat, view } =
      this[P_DEPTH_INFO];

    if (x < 0 || x >= 1 || y < 0 || y >= 1) {
      throw new RangeError('Normalized coordinates must be in [0, 1) range.');
    }

    const col = Math.floor(x * width);
    const row = Math.floor(y * height);

    if (dataFormat === 'float32') {
      const floatView = view as Float32Array;
      const index = row * width + col;
      return floatView[index] * rawValueToMeters;
    } else {
      // luminance-alpha and unsigned-short: 16-bit unsigned int in two bytes
      const byteView = view as Uint8Array;
      const index = (row * width + col) * 2;
      const rawValue = byteView[index] + byteView[index + 1] * 256;
      return rawValue * rawValueToMeters;
    }
  }
}
