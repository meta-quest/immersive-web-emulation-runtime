/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { XRFrame } from '../frameloop/XRFrame.js';
import type {
  WebGPUCommandEncoder,
  WebGPUDevice,
  WebGPUTexture,
} from '../types/webgpu.js';

// GPUTextureUsage flags, inlined so this module loads without WebGPU globals.
const COPY_SRC = 0x01;
const COPY_DST = 0x02;
const TEXTURE_BINDING = 0x04;
const RENDER_ATTACHMENT = 0x10;

export type GPULayerTextureSet = {
  color: WebGPUTexture;
  depthStencil: WebGPUTexture | null;
  motionVector: WebGPUTexture | null;
};

export type GPULayerTextureDescriptors = {
  color: GPUTextureDescriptor;
  depthStencil: GPUTextureDescriptor | null;
  motionVector: GPUTextureDescriptor | null;
};

const textureSize = (descriptor: GPUTextureDescriptor) => {
  const [width, height = 1, layers = 1] = descriptor.size as number[];
  return { width, height, layers };
};

/**
 * The textures of a WebGPU-backed layer, following the WebGPU binding's
 * texture lifecycle. The first subimage request in a frame gets new, cleared
 * "current" textures, which every subimage of the layer shares for that frame.
 * When the frame ends they're released: IWER copies them into textures of its
 * own for the compositor and destroys them, so retained subimages only see
 * destroyed textures and the compositor keeps showing the last released
 * content.
 */
export class GPULayerTextures {
  readonly device: WebGPUDevice;
  readonly descriptors: GPULayerTextureDescriptors;
  // Whether the compositor reads the depth and motion vectors (space warp).
  readonly releaseDepth: boolean;
  // How the compositor samples its copy; compatibility-mode devices only allow
  // the view dimension given when the texture is created.
  readonly compositorViewDimension: GPUTextureViewDimension;
  current: (GPULayerTextureSet & { frame: XRFrame }) | null = null;
  // The compositor's copy of the last released textures, if any.
  released: GPULayerTextureSet | null = null;
  destroyed = false;
  private compositorTextures: GPULayerTextureSet | null = null;

  constructor(
    device: WebGPUDevice,
    descriptors: GPULayerTextureDescriptors,
    releaseDepth = false,
    compositorViewDimension: GPUTextureViewDimension = '2d-array',
  ) {
    this.device = device;
    this.descriptors = descriptors;
    this.releaseDepth = releaseDepth;
    this.compositorViewDimension = compositorViewDimension;
  }

  acquire(frame: XRFrame): GPULayerTextureSet & { frame: XRFrame } {
    if (this.current?.frame === frame) {
      return this.current;
    }
    const { color, depthStencil, motionVector } = this.descriptors;
    const copied = this.releaseDepth ? COPY_SRC : 0;
    const create = (descriptor: GPUTextureDescriptor, usage: number) =>
      this.device.createTexture({
        ...descriptor,
        usage: descriptor.usage | usage,
      });
    // New textures start zeroed, which is the cleared color, motion vector and
    // stencil value; depth is cleared to 1.0 below.
    this.current = {
      color: create(color, COPY_SRC),
      depthStencil: depthStencil
        ? create(depthStencil, RENDER_ATTACHMENT | copied)
        : null,
      motionVector: motionVector ? create(motionVector, copied) : null,
      frame,
    };
    if (this.current.depthStencil && depthStencil) {
      const encoder = this.device.createCommandEncoder({
        label: 'IWER layer depth clear',
      });
      clearDepthStencil(encoder, this.current.depthStencil, depthStencil);
      this.device.queue.submit([encoder.finish()]);
    }
    return this.current;
  }

  /**
   * Hands the frame's current textures to the compositor by copying them into
   * its own textures. Returns false if the layer wasn't drawn in this frame.
   */
  release(frame: XRFrame, encoder: WebGPUCommandEncoder): boolean {
    const current = this.current;
    if (!current || current.frame !== frame) {
      return false;
    }
    this.compositorTextures ??= this.createCompositorTextures();
    const target = this.compositorTextures;
    copyAllMips(encoder, current.color, target.color, this.descriptors.color);
    if (this.releaseDepth) {
      if (current.depthStencil && target.depthStencil) {
        copyAllMips(
          encoder,
          current.depthStencil,
          target.depthStencil,
          this.descriptors.depthStencil!,
        );
      }
      if (current.motionVector && target.motionVector) {
        copyAllMips(
          encoder,
          current.motionVector,
          target.motionVector,
          this.descriptors.motionVector!,
        );
      }
    }
    this.released = target;
    return true;
  }

  // Ends write access to the frame's current textures.
  expire(): void {
    const current = this.current;
    if (!current) {
      return;
    }
    current.color.destroy();
    current.depthStencil?.destroy();
    current.motionVector?.destroy();
    this.current = null;
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.expire();
    const target = this.compositorTextures;
    target?.color.destroy();
    target?.depthStencil?.destroy();
    target?.motionVector?.destroy();
    this.compositorTextures = null;
    this.released = null;
  }

  private createCompositorTextures(): GPULayerTextureSet {
    const { color, depthStencil, motionVector } = this.descriptors;
    const create = (descriptor: GPUTextureDescriptor) =>
      this.device.createTexture({
        ...descriptor,
        label: `IWER compositor ${descriptor.label ?? 'layer texture'}`,
        usage: TEXTURE_BINDING | COPY_DST,
        textureBindingViewDimension: this.compositorViewDimension,
      } as GPUTextureDescriptor);
    return {
      color: create(color),
      depthStencil:
        this.releaseDepth && depthStencil ? create(depthStencil) : null,
      motionVector:
        this.releaseDepth && motionVector ? create(motionVector) : null,
    };
  }
}

const copyAllMips = (
  encoder: WebGPUCommandEncoder,
  source: WebGPUTexture,
  destination: WebGPUTexture,
  descriptor: GPUTextureDescriptor,
) => {
  const { width, height, layers } = textureSize(descriptor);
  for (let mip = 0; mip < (descriptor.mipLevelCount ?? 1); mip++) {
    encoder.copyTextureToTexture(
      { texture: source, mipLevel: mip },
      { texture: destination, mipLevel: mip },
      [Math.max(1, width >> mip), Math.max(1, height >> mip), layers],
    );
  }
};

// Clears depth to 1.0 and stencil to 0 in every mip level and array layer.
const clearDepthStencil = (
  encoder: WebGPUCommandEncoder,
  texture: WebGPUTexture,
  descriptor: GPUTextureDescriptor,
) => {
  const { layers } = textureSize(descriptor);
  const format = descriptor.format;
  for (let mip = 0; mip < (descriptor.mipLevelCount ?? 1); mip++) {
    for (let layer = 0; layer < layers; layer++) {
      const attachment: GPURenderPassDepthStencilAttachment = {
        view: texture.createView({
          dimension: '2d',
          baseMipLevel: mip,
          mipLevelCount: 1,
          baseArrayLayer: layer,
          arrayLayerCount: 1,
        }),
      };
      // Load and store ops may only be set for aspects the format has.
      if (format !== 'stencil8') {
        attachment.depthClearValue = 1.0;
        attachment.depthLoadOp = 'clear';
        attachment.depthStoreOp = 'store';
      }
      if (format.includes('stencil')) {
        attachment.stencilClearValue = 0;
        attachment.stencilLoadOp = 'clear';
        attachment.stencilStoreOp = 'store';
      }
      encoder
        .beginRenderPass({
          colorAttachments: [],
          depthStencilAttachment: attachment,
        })
        .end();
    }
  }
};
