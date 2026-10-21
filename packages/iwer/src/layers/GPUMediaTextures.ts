/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { GPULayerTextureSet } from './GPULayerTextures.js';
import type { WebGPUDevice, WebGPUTexture } from '../types/webgpu.js';

// GPUTextureUsage flags, inlined so this module loads without WebGPU globals.
const COPY_DST = 0x02;
const TEXTURE_BINDING = 0x04;
const RENDER_ATTACHMENT = 0x10;
// HTMLMediaElement.HAVE_CURRENT_DATA
const HAVE_CURRENT_DATA = 2;

// No app device draws media layers, so IWER composites them on its own one.
const compositorDevices = new WeakMap<GPU, Promise<WebGPUDevice | null>>();

const requestCompositorDevice = (): Promise<WebGPUDevice | null> => {
  const gpu = navigator.gpu;
  if (!gpu) {
    return Promise.resolve(null);
  }
  let device = compositorDevices.get(gpu);
  if (!device) {
    device = Promise.resolve()
      .then(() => gpu.requestAdapter())
      .then((adapter) => adapter?.requestDevice() ?? null)
      .catch(() => null);
    compositorDevices.set(gpu, device);
  }
  return device;
};

/**
 * The image of a media layer. Each time IWER composites, it copies the video's
 * current frame into a texture on its own GPUDevice.
 */
export class GPUMediaTextures {
  readonly video: HTMLVideoElement;
  readonly invertStereo: boolean;
  device: WebGPUDevice | null = null;
  // There are no frames for the app to draw.
  readonly current = null;
  readonly releasedFrame = null;
  released: GPULayerTextureSet | null = null;
  destroyed = false;
  private texture: WebGPUTexture | null = null;
  private warned = false;

  constructor(video: HTMLVideoElement, invertStereo: boolean) {
    this.video = video;
    this.invertStereo = invertStereo;
    requestCompositorDevice().then((device) => {
      this.device = device;
    });
  }

  /**
   * Copies the video's current frame for the compositor. A video with no frame
   * to show leaves the layer transparent, as the Layers spec describes.
   */
  update(): void {
    const { device, video } = this;
    this.released = null;
    if (
      !device ||
      this.destroyed ||
      video.readyState < HAVE_CURRENT_DATA ||
      !video.videoWidth ||
      !video.videoHeight
    ) {
      return;
    }
    const { videoWidth: width, videoHeight: height } = video;
    if (this.texture?.width !== width || this.texture?.height !== height) {
      this.texture?.destroy();
      this.texture = device.createTexture({
        label: 'IWER media layer',
        size: [width, height, 1],
        format: 'rgba8unorm',
        usage: TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT,
        textureBindingViewDimension: '2d-array',
      } as GPUTextureDescriptor);
    }
    try {
      device.queue.copyExternalImageToTexture(
        { source: video },
        { texture: this.texture },
        [width, height],
      );
    } catch (error) {
      // WebGPU only takes same-origin or CORS-enabled video.
      if (!this.warned) {
        this.warned = true;
        console.warn('IWER cannot show this media layer:', error);
      }
      return;
    }
    this.released = {
      color: this.texture,
      depthStencil: null,
      motionVector: null,
    };
  }

  destroy(): void {
    this.destroyed = true;
    this.texture?.destroy();
    this.texture = null;
    this.released = null;
  }
}
