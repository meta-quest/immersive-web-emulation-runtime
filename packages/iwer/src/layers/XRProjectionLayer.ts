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
import { XRRenderState } from '../session/XRRenderState.js';
import { XRRigidTransform } from '../primitives/XRRigidTransform.js';
import type { GPULayerTextures } from './GPULayerTextures.js';
import type { XRSession } from '../session/XRSession.js';

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

const QUALITIES: XRLayerQuality[] = [
  'default',
  'text-optimized',
  'graphics-optimized',
];

export type XRCompositionLayerInit = {
  layout: XRLayerLayout;
  isStatic: boolean;
  mipLevels: number;
  textures: GPULayerTextures;
};

/**
 * Base class of the layers created by XRGPUBinding. Each is backed by WebGPU
 * textures on the binding's device.
 */
export class XRCompositionLayer extends XRLayer {
  [P_COMPOSITION_LAYER]: {
    session: XRSession;
    destroyed: boolean;
    blendTextureSourceAlpha: boolean;
    forceMonoPresentation: boolean;
    opacity: number;
    quality: XRLayerQuality;
    layout: XRLayerLayout;
    isStatic: boolean;
    mipLevels: number;
    needsRedraw: boolean;
    textures: GPULayerTextures;
  };

  constructor(session: XRSession, init: XRCompositionLayerInit) {
    super();
    this[P_COMPOSITION_LAYER] = {
      session,
      destroyed: false,
      blendTextureSourceAlpha: true,
      forceMonoPresentation: false,
      opacity: 1.0,
      quality: 'default',
      ...init,
      needsRedraw: true,
    };
    // Tracked so the session can release and free the layer's textures.
    session[P_SESSION].gpuLayers.add(this);
  }

  get layout(): XRLayerLayout {
    return this[P_COMPOSITION_LAYER].layout;
  }

  get isStatic(): boolean {
    return this[P_COMPOSITION_LAYER].isStatic;
  }

  get needsRedraw(): boolean {
    return this[P_COMPOSITION_LAYER].needsRedraw;
  }

  get mipLevels(): number {
    return this[P_COMPOSITION_LAYER].mipLevels;
  }

  get blendTextureSourceAlpha(): boolean {
    return this[P_COMPOSITION_LAYER].blendTextureSourceAlpha;
  }

  set blendTextureSourceAlpha(value: boolean) {
    this[P_COMPOSITION_LAYER].blendTextureSourceAlpha = Boolean(value);
  }

  get forceMonoPresentation(): boolean {
    return this[P_COMPOSITION_LAYER].forceMonoPresentation;
  }

  set forceMonoPresentation(value: boolean) {
    this[P_COMPOSITION_LAYER].forceMonoPresentation = Boolean(value);
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
    // Like any WebIDL enum attribute, unknown values are ignored.
    if (QUALITIES.includes(value)) {
      this[P_COMPOSITION_LAYER].quality = value;
    }
  }

  destroy(): void {
    const state = this[P_COMPOSITION_LAYER];
    if (state.destroyed) {
      return;
    }
    state.destroyed = true;
    state.textures.destroy();
    const session = state.session[P_SESSION];
    session.gpuLayers.delete(this);
    // A destroyed layer leaves the pending render state, as the Layers spec
    // describes.
    if (session.pendingRenderState === null) {
      if (!session.renderState.layers?.includes(this)) {
        return;
      }
      session.pendingRenderState = new XRRenderState({}, session.renderState);
    }
    const pending = session.pendingRenderState;
    if (!pending.layers?.includes(this)) {
      return;
    }
    session.pendingRenderState = new XRRenderState(
      { layers: pending.layers.filter((layer) => layer !== this) },
      pending,
    );
  }
}

/**
 * A projection layer backed by a WebGPU texture array with one array layer per
 * view, created by XRGPUBinding.createProjectionLayer.
 */
export class XRProjectionLayer extends XRCompositionLayer {
  [P_PROJECTION_LAYER]: {
    ignoreDepthValues: boolean;
    fixedFoveation: number;
    // Latched when each frame starts, so a change applies from the next frame.
    frameFixedFoveation: number;
    // Each view's viewport scale this frame, and in the last released frame.
    frameViewportScales: number[];
    viewportScales: number[];
    deltaPose: XRRigidTransform | null;
  };

  constructor(
    session: XRSession,
    textures: GPULayerTextures,
    ignoreDepthValues: boolean,
  ) {
    super(session, {
      layout: 'default',
      isStatic: false,
      mipLevels: 1,
      textures,
    });
    this[P_PROJECTION_LAYER] = {
      ignoreDepthValues,
      fixedFoveation: 0,
      frameFixedFoveation: 0,
      frameViewportScales: [1, 1],
      viewportScales: [1, 1],
      deltaPose: null,
    };
  }

  get textureWidth(): number {
    return (
      this[P_COMPOSITION_LAYER].textures.descriptors.color.size as number[]
    )[0];
  }

  get textureHeight(): number {
    return (
      this[P_COMPOSITION_LAYER].textures.descriptors.color.size as number[]
    )[1];
  }

  get textureArrayLength(): number {
    return (
      this[P_COMPOSITION_LAYER].textures.descriptors.color.size as number[]
    )[2];
  }

  get ignoreDepthValues(): boolean {
    return this[P_PROJECTION_LAYER].ignoreDepthValues;
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

  // With space warp, the app's own motion of the view since the last frame,
  // such as artificial locomotion. Without it, deltaPose stays null and
  // setting it does nothing, as the Layers spec describes. IWER's frame
  // synthesis doesn't need it: the motion vectors include that motion.
  get deltaPose(): XRRigidTransform | null {
    return this[P_PROJECTION_LAYER].deltaPose;
  }

  set deltaPose(value: XRRigidTransform | null) {
    const transform = value ?? null;
    if (transform !== null && !(transform instanceof XRRigidTransform)) {
      throw new TypeError('deltaPose must be an XRRigidTransform or null.');
    }
    const { session } = this[P_COMPOSITION_LAYER];
    if (session[P_SESSION].enabledFeatures.includes('space-warp')) {
      this[P_PROJECTION_LAYER].deltaPose = transform;
    }
  }
}
