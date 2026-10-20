/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// WebGPU types used in IWER's public declarations. They resolve to the
// standard types when the consumer's TypeScript has them (TypeScript 6, or
// @webgpu/types on TypeScript 5) and fall back to loose types otherwise, so
// the declarations compile either way.
type Global = typeof globalThis;

export type WebGPUDevice = Global extends {
  GPUDevice: { prototype: infer T };
}
  ? T
  : unknown;

export type WebGPUTexture = Global extends {
  GPUTexture: { prototype: infer T };
}
  ? T
  : unknown;

export type WebGPUCommandEncoder = Global extends {
  GPUCommandEncoder: { prototype: infer T };
}
  ? T
  : unknown;

export type WebGPUTextureFormat = WebGPUTexture extends {
  readonly format: infer T;
}
  ? T
  : string;

export type WebGPUTextureViewDescriptor = WebGPUTexture extends {
  createView(descriptor?: infer T): unknown;
}
  ? NonNullable<T>
  : {
      dimension?: string;
      baseMipLevel?: number;
      mipLevelCount?: number;
      baseArrayLayer?: number;
      arrayLayerCount?: number;
    };
