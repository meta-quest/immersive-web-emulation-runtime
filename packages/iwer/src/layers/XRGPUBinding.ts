/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  P_COMPOSITION_LAYER,
  P_DEPTH_INFO,
  P_DEVICE,
  P_FRAME,
  P_GPU_BINDING,
  P_GPU_SUB_IMAGE,
  P_PROJECTION_LAYER,
  P_SESSION,
  P_SUB_IMAGE,
  P_VIEW,
} from '../private.js';
import { XREye, type XRView } from '../views/XRView.js';
import { XRProjectionLayer } from './XRProjectionLayer.js';
import { clearArrayLayers } from './XRGPUPresenter.js';
import { XRViewport } from '../views/XRViewport.js';
import { XRRigidTransform } from '../primitives/XRRigidTransform.js';
import type { XRFrame } from '../frameloop/XRFrame.js';
import type { XRSession } from '../session/XRSession.js';

export interface XRGPUProjectionLayerInit {
  colorFormat: GPUTextureFormat;
  depthStencilFormat?: GPUTextureFormat;
  textureUsage?: GPUTextureUsageFlags;
  scaleFactor?: number;
}

// GPUTextureUsage flags, inlined so this module loads without WebGPU globals.
const COPY_DST = 0x02;
const STORAGE_BINDING = 0x08;
const TEXTURE_BINDING = 0x04;
const RENDER_ATTACHMENT = 0x10;
const KNOWN_TEXTURE_USAGE = 0x1f;

const COLOR_FORMATS: GPUTextureFormat[] = [
  'rgba8unorm',
  'bgra8unorm',
  'rgba16float',
];
const DEPTH_STENCIL_FORMATS: GPUTextureFormat[] = [
  'stencil8',
  'depth16unorm',
  'depth24plus',
  'depth24plus-stencil8',
  'depth32float',
  'depth32float-stencil8',
];

const MIN_SCALE_FACTOR = 0.2;

// Immersive sessions always report a left and a right view.
const VIEW_COUNT = 2;

// Array layer of an eye's view in the layer and depth textures.
const arrayLayer = (eye: XREye) => (eye === XREye.Right ? 1 : 0);

const lostDevices = new WeakSet<GPUDevice>();

export class XRSubImage {
  [P_SUB_IMAGE]: {
    viewport: XRViewport;
  };

  constructor(viewport: XRViewport) {
    this[P_SUB_IMAGE] = { viewport };
  }

  get viewport(): XRViewport {
    return this[P_SUB_IMAGE].viewport;
  }
}

export class XRGPUSubImage extends XRSubImage {
  [P_GPU_SUB_IMAGE]: {
    colorTexture: GPUTexture;
    depthStencilTexture: GPUTexture | null;
    viewIndex: number;
  };

  constructor(
    viewport: XRViewport,
    colorTexture: GPUTexture,
    depthStencilTexture: GPUTexture | null,
    viewIndex: number,
  ) {
    super(viewport);
    this[P_GPU_SUB_IMAGE] = { colorTexture, depthStencilTexture, viewIndex };
  }

  get colorTexture(): GPUTexture {
    return this[P_GPU_SUB_IMAGE].colorTexture;
  }

  get depthStencilTexture(): GPUTexture | null {
    return this[P_GPU_SUB_IMAGE].depthStencilTexture;
  }

  get motionVectorTexture(): GPUTexture | null {
    return null;
  }

  getViewDescriptor(): GPUTextureViewDescriptor {
    return {
      dimension: '2d',
      mipLevelCount: 1,
      arrayLayerCount: 1,
      baseArrayLayer: this[P_GPU_SUB_IMAGE].viewIndex,
    };
  }
}

export class XRGPUDepthInformation {
  [P_DEPTH_INFO]: {
    texture: GPUTexture;
    width: number;
    height: number;
    normDepthBufferFromNormView: XRRigidTransform;
    rawValueToMeters: number;
    arrayLayer: number;
  };

  constructor(
    texture: GPUTexture,
    width: number,
    height: number,
    rawValueToMeters: number,
    arrayLayer: number,
  ) {
    this[P_DEPTH_INFO] = {
      texture,
      width,
      height,
      normDepthBufferFromNormView: new XRRigidTransform(),
      rawValueToMeters,
      arrayLayer,
    };
  }

  get texture(): GPUTexture {
    return this[P_DEPTH_INFO].texture;
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

  getViewDescriptor(): GPUTextureViewDescriptor {
    return {
      dimension: '2d',
      baseMipLevel: 0,
      mipLevelCount: 1,
      baseArrayLayer: this[P_DEPTH_INFO].arrayLayer,
      arrayLayerCount: 1,
    };
  }
}

export class XRGPUBinding {
  [P_GPU_BINDING]: {
    session: XRSession;
    device: GPUDevice;
    depthTextures: WeakMap<XRFrame, GPUTexture>;
  };

  constructor(session: XRSession, device: GPUDevice) {
    if (session[P_SESSION].ended) {
      throw new DOMException(
        'XRSession has already ended.',
        'InvalidStateError',
      );
    }
    if (!session[P_SESSION].hasWebGPU) {
      throw new DOMException(
        "XRGPUBinding requires an immersive session with the 'webgpu' feature.",
        'InvalidStateError',
      );
    }
    if (lostDevices.has(device)) {
      throw new DOMException('GPUDevice is lost.', 'InvalidStateError');
    }
    device.lost?.then(() => lostDevices.add(device));
    this[P_GPU_BINDING] = { session, device, depthTextures: new WeakMap() };
  }

  get nativeProjectionScaleFactor(): number {
    return 1.0;
  }

  get usesDepthValues(): boolean {
    return false;
  }

  getPreferredColorFormat(): GPUTextureFormat {
    return navigator.gpu.getPreferredCanvasFormat();
  }

  createProjectionLayer(init: XRGPUProjectionLayerInit): XRProjectionLayer {
    if (init?.colorFormat === undefined) {
      throw new TypeError(
        "XRGPUProjectionLayerInit is missing the required 'colorFormat'.",
      );
    }
    const { session, device } = this[P_GPU_BINDING];
    if (session[P_SESSION].ended) {
      throw new DOMException(
        'XRSession has already ended.',
        'InvalidStateError',
      );
    }
    if (lostDevices.has(device)) {
      throw new DOMException('GPUDevice is lost.', 'InvalidStateError');
    }
    const {
      colorFormat,
      depthStencilFormat,
      textureUsage = RENDER_ATTACHMENT,
      scaleFactor = 1.0,
    } = init;
    if (!COLOR_FORMATS.includes(colorFormat)) {
      throw new DOMException(
        `Unsupported colorFormat '${colorFormat}'.`,
        'NotSupportedError',
      );
    }
    if (
      depthStencilFormat !== undefined &&
      !DEPTH_STENCIL_FORMATS.includes(depthStencilFormat)
    ) {
      throw new DOMException(
        `Unsupported depthStencilFormat '${depthStencilFormat}'.`,
        'NotSupportedError',
      );
    }
    // createTexture() reports validation errors asynchronously, so reject the
    // combinations it would refuse up front.
    if (
      depthStencilFormat === 'depth32float-stencil8' &&
      !device.features.has('depth32float-stencil8')
    ) {
      throw new DOMException(
        "depth32float-stencil8 requires the 'depth32float-stencil8' device feature.",
        'NotSupportedError',
      );
    }
    if (textureUsage & ~KNOWN_TEXTURE_USAGE) {
      throw new DOMException(
        `Unsupported textureUsage ${textureUsage}.`,
        'NotSupportedError',
      );
    }
    if (
      textureUsage & STORAGE_BINDING &&
      (depthStencilFormat !== undefined ||
        (colorFormat === 'bgra8unorm' &&
          !device.features.has('bgra8unorm-storage')))
    ) {
      throw new DOMException(
        'STORAGE_BINDING is not supported for these layer formats.',
        'NotSupportedError',
      );
    }

    const viewSize =
      session[P_SESSION].device[P_DEVICE].getRecommendedViewResolution();
    const scale = Math.min(
      Math.max(scaleFactor, MIN_SCALE_FACTOR),
      Math.max(this.nativeProjectionScaleFactor, 1.0),
    );
    let width = Math.max(1, Math.floor(viewSize.width * scale));
    let height = Math.max(1, Math.floor(viewSize.height * scale));
    const maxDimension = device.limits.maxTextureDimension2D;
    if (width > maxDimension || height > maxDimension) {
      const fit = maxDimension / Math.max(width, height);
      width = Math.max(1, Math.floor(width * fit));
      height = Math.max(1, Math.floor(height * fit));
    }

    // IWER composites from and clears these textures itself, so they always
    // need RENDER_ATTACHMENT and TEXTURE_BINDING.
    const createTexture = (format: GPUTextureFormat, label: string) =>
      device.createTexture({
        label,
        size: [width, height, VIEW_COUNT],
        format,
        usage: textureUsage | RENDER_ATTACHMENT | TEXTURE_BINDING,
        dimension: '2d',
        mipLevelCount: 1,
        sampleCount: 1,
      });
    const colorTexture = createTexture(colorFormat, 'XRProjectionLayer color');
    const depthStencilTexture = depthStencilFormat
      ? createTexture(depthStencilFormat, 'XRProjectionLayer depth/stencil')
      : null;
    if (depthStencilTexture) {
      // New textures are zero-filled, but the layer's depth must start at 1.0
      // like after the per-frame clears. Submitted before any app GPU work.
      const encoder = device.createCommandEncoder({
        label: 'IWER layer initial clear',
      });
      clearArrayLayers(encoder, colorTexture, depthStencilTexture);
      device.queue.submit([encoder.finish()]);
    }
    return new XRProjectionLayer(
      session,
      device,
      colorTexture,
      depthStencilTexture,
    );
  }

  getViewSubImage(layer: XRProjectionLayer, view: XRView): XRGPUSubImage {
    const { session, device } = this[P_GPU_BINDING];
    if (view[P_VIEW].session !== session) {
      throw new DOMException(
        "View's session differs from the binding's session.",
        'InvalidStateError',
      );
    }
    if (
      !(layer instanceof XRProjectionLayer) ||
      layer[P_COMPOSITION_LAYER].destroyed ||
      layer[P_COMPOSITION_LAYER].session !== session ||
      layer[P_PROJECTION_LAYER].device !== device ||
      lostDevices.has(device)
    ) {
      throw new DOMException(
        'Layer is not a valid WebGPU layer for this binding.',
        'InvalidStateError',
      );
    }
    if (session[P_SESSION].activeFrame === null) {
      throw new DOMException(
        'getViewSubImage must be called during an XRFrame callback.',
        'InvalidStateError',
      );
    }
    if (!session[P_SESSION].renderState.layers?.includes(layer)) {
      throw new TypeError("Layer is not in the session's renderState.layers.");
    }

    const { colorTexture, depthStencilTexture } = layer[P_PROJECTION_LAYER];
    return new XRGPUSubImage(
      new XRViewport(0, 0, colorTexture.width, colorTexture.height),
      colorTexture,
      depthStencilTexture,
      arrayLayer(view[P_VIEW].eye),
    );
  }

  getDepthInformation(view: XRView): XRGPUDepthInformation | null {
    const { session, device, depthTextures } = this[P_GPU_BINDING];
    if (view[P_VIEW].session !== session) {
      throw new DOMException(
        "View's session differs from the binding's session.",
        'InvalidStateError',
      );
    }
    if (!session[P_SESSION].enabledFeatures.includes('depth-sensing')) {
      throw new DOMException(
        'depth-sensing feature is not enabled on this session.',
        'NotSupportedError',
      );
    }
    if (session[P_SESSION].depthSensingUsage !== 'gpu-optimized') {
      throw new DOMException(
        'getDepthInformation on XRGPUBinding requires gpu-optimized depth sensing usage.',
        'InvalidStateError',
      );
    }
    if (lostDevices.has(device)) {
      throw new DOMException('GPUDevice is lost.', 'InvalidStateError');
    }
    const frame = session[P_SESSION].activeFrame;
    if (!frame?.[P_FRAME].active || !frame[P_FRAME].animationFrame) {
      throw new DOMException(
        'getDepthInformation must be called during an XRFrame callback.',
        'InvalidStateError',
      );
    }

    const depthData = frame[P_FRAME].webgpuDepthDataMap;
    const viewDepth = depthData.get(view[P_VIEW].eye);
    if (!viewDepth) {
      return null;
    }
    let texture = depthTextures.get(frame);
    if (!texture) {
      texture = device.createTexture({
        label: 'XRGPUDepthInformation',
        size: [viewDepth.width, viewDepth.height, VIEW_COUNT],
        format: 'r32float',
        usage: TEXTURE_BINDING | COPY_DST,
        dimension: '2d',
        mipLevelCount: 1,
        sampleCount: 1,
      });
      // Linear depth, rows from the top like normalized view coordinates.
      for (const [eye, { data, width, height }] of depthData) {
        device.queue.writeTexture(
          { texture, origin: [0, 0, arrayLayer(eye)] },
          data,
          { bytesPerRow: width * 4, rowsPerImage: height },
          [width, height, 1],
        );
      }
      depthTextures.set(frame, texture);
      frame[P_FRAME].webgpuDepthTextures.push(texture);
    }
    return new XRGPUDepthInformation(
      texture,
      viewDepth.width,
      viewDepth.height,
      viewDepth.rawValueToMeters,
      arrayLayer(view[P_VIEW].eye),
    );
  }
}
