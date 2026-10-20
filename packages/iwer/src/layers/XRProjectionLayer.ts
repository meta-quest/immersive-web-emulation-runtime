/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  P_COMPOSITION_LAYER,
  P_PROJECTION_LAYER,
  P_SESSION,
} from '../private.js';
import { XRLayer } from './XRWebGLLayer.js';
import type { XRRigidTransform } from '../primitives/XRRigidTransform.js';
import type { XRSession } from '../session/XRSession.js';
import type { WebGPUDevice, WebGPUTexture } from '../types/webgpu.js';

export type XRLayerLayout =
  | 'default'
  | 'mono'
  | 'stereo'
  | 'stereo-left-right'
  | 'stereo-top-bottom';

export type XRLayerQuality =
  | 'default'
  | 'text-optimized'
  | 'graphics-optimized';

export class XRCompositionLayer extends XRLayer {
  [P_COMPOSITION_LAYER]: {
    session: XRSession;
    destroyed: boolean;
    blendTextureSourceAlpha: boolean;
    forceMonoPresentation: boolean;
    opacity: number;
    quality: XRLayerQuality;
  };

  constructor(session: XRSession) {
    super();
    this[P_COMPOSITION_LAYER] = {
      session,
      destroyed: false,
      blendTextureSourceAlpha: true,
      forceMonoPresentation: false,
      opacity: 1.0,
      quality: 'default',
    };
  }

  get layout(): XRLayerLayout {
    return 'default';
  }

  get isStatic(): boolean {
    return false;
  }

  get needsRedraw(): boolean {
    return true;
  }

  get mipLevels(): number {
    return 1;
  }

  get blendTextureSourceAlpha(): boolean {
    return this[P_COMPOSITION_LAYER].blendTextureSourceAlpha;
  }

  set blendTextureSourceAlpha(value: boolean) {
    this[P_COMPOSITION_LAYER].blendTextureSourceAlpha = value;
  }

  get forceMonoPresentation(): boolean {
    return this[P_COMPOSITION_LAYER].forceMonoPresentation;
  }

  set forceMonoPresentation(value: boolean) {
    this[P_COMPOSITION_LAYER].forceMonoPresentation = value;
  }

  get opacity(): number {
    return this[P_COMPOSITION_LAYER].opacity;
  }

  set opacity(value: number) {
    this[P_COMPOSITION_LAYER].opacity = Math.min(1, Math.max(0, value));
  }

  get quality(): XRLayerQuality {
    return this[P_COMPOSITION_LAYER].quality;
  }

  set quality(value: XRLayerQuality) {
    this[P_COMPOSITION_LAYER].quality = value;
  }

  destroy(): void {
    this[P_COMPOSITION_LAYER].destroyed = true;
  }
}

/**
 * A projection layer backed by a WebGPU texture array with one array layer per
 * view, created by XRGPUBinding.createProjectionLayer.
 */
export class XRProjectionLayer extends XRCompositionLayer {
  [P_PROJECTION_LAYER]: {
    device: WebGPUDevice;
    colorTexture: WebGPUTexture;
    depthStencilTexture: WebGPUTexture | null;
    fixedFoveation: number;
    // Latched when each frame starts, so a change applies from the next frame.
    frameFixedFoveation: number;
  };

  constructor(
    session: XRSession,
    device: WebGPUDevice,
    colorTexture: WebGPUTexture,
    depthStencilTexture: WebGPUTexture | null,
  ) {
    super(session);
    this[P_PROJECTION_LAYER] = {
      device,
      colorTexture,
      depthStencilTexture,
      fixedFoveation: 0,
      frameFixedFoveation: 0,
    };
    // Tracked so the session can release every layer's textures when it ends.
    session[P_SESSION].projectionLayers.add(this);
  }

  get textureWidth(): number {
    return this[P_PROJECTION_LAYER].colorTexture.width;
  }

  get textureHeight(): number {
    return this[P_PROJECTION_LAYER].colorTexture.height;
  }

  get textureArrayLength(): number {
    return this[P_PROJECTION_LAYER].colorTexture.depthOrArrayLayers;
  }

  get ignoreDepthValues(): boolean {
    return true;
  }

  // 0 is no foveation and 1 the most. IWER lowers the resolution away from
  // the centre of each view when it draws the layer.
  get fixedFoveation(): number | null {
    return this[P_PROJECTION_LAYER].fixedFoveation;
  }

  set fixedFoveation(value: number | null) {
    if (value === null) {
      return;
    }
    const level = Number(value);
    if (!Number.isFinite(level)) {
      throw new TypeError('fixedFoveation must be a finite number.');
    }
    this[P_PROJECTION_LAYER].fixedFoveation = Math.min(1, Math.max(0, level));
  }

  // Space warp isn't emulated, so deltaPose stays null and setting it has no
  // effect, as the spec describes for unsupporting devices.
  get deltaPose(): XRRigidTransform | null {
    return null;
  }

  set deltaPose(_value: XRRigidTransform | null) {}

  destroy(): void {
    if (this[P_COMPOSITION_LAYER].destroyed) {
      return;
    }
    super.destroy();
    this[P_PROJECTION_LAYER].colorTexture.destroy();
    this[P_PROJECTION_LAYER].depthStencilTexture?.destroy();
    this[P_COMPOSITION_LAYER].session[P_SESSION].projectionLayers.delete(this);
  }
}
