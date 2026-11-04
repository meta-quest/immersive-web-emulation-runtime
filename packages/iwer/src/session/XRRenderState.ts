/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_RENDER_STATE } from '../private.js';
import type { XRCompositionLayer } from '../layers/XRProjectionLayer.js';
import { XRWebGLLayer } from '../layers/XRWebGLLayer.js';

const NO_LAYERS: readonly XRCompositionLayer[] = Object.freeze([]);

export class XRRenderState {
  [P_RENDER_STATE]: {
    depthNear: number;
    depthFar: number;
    inlineVerticalFieldOfView: number | null;
    baseLayer: XRWebGLLayer | null;
    // WebXR Layers. Stays undefined unless a host-mode session sets it: IWSDK
    // and three.js treat a defined `layers` attribute as "this runtime
    // supports layers", which the emulator does not.
    layers: readonly XRCompositionLayer[] | undefined;
    // Meta extension: the page promises to cover every pixel, so an
    // immersive-ar compositor need not show the camera feed underneath.
    passthroughFullyObscured: boolean | undefined;
  };

  constructor(init: Partial<XRRenderStateInit> = {}, oldState?: XRRenderState) {
    const previous = oldState?.[P_RENDER_STATE];
    let baseLayer = init.baseLayer ?? oldState?.baseLayer ?? null;
    let layers = previous?.layers;
    if (init.layers) {
      layers = Object.freeze([...init.layers]);
      // a non-empty layer list displaces the base layer unless one is given
      if (layers.length > 0 && init.baseLayer === undefined) {
        baseLayer = null;
      }
    } else if (
      init.layers === undefined &&
      init.baseLayer &&
      layers !== undefined
    ) {
      // a new base layer displaces an earlier layer list
      layers = NO_LAYERS;
    }
    this[P_RENDER_STATE] = {
      // Use nullish coalescing so a legitimate 0 (e.g.
      // inlineVerticalFieldOfView=0) is not replaced by the default.
      depthNear: init.depthNear ?? oldState?.depthNear ?? 0.1,
      depthFar: init.depthFar ?? oldState?.depthFar ?? 1000.0,
      inlineVerticalFieldOfView:
        init.inlineVerticalFieldOfView ??
        oldState?.inlineVerticalFieldOfView ??
        null,
      baseLayer,
      layers,
      // carried over from the previous state until a new value is given
      passthroughFullyObscured:
        init.passthroughFullyObscured ?? previous?.passthroughFullyObscured,
    };
  }

  get depthNear(): number {
    return this[P_RENDER_STATE].depthNear;
  }

  get depthFar(): number {
    return this[P_RENDER_STATE].depthFar;
  }

  get inlineVerticalFieldOfView(): number | null {
    return this[P_RENDER_STATE].inlineVerticalFieldOfView;
  }

  get baseLayer(): XRWebGLLayer | null {
    return this[P_RENDER_STATE].baseLayer;
  }

  get layers(): readonly XRCompositionLayer[] | undefined {
    return this[P_RENDER_STATE].layers;
  }

  get passthroughFullyObscured(): boolean | undefined {
    return this[P_RENDER_STATE].passthroughFullyObscured;
  }
}

// XRRenderStateInit interface definition for TypeScript
export interface XRRenderStateInit {
  depthNear?: number;
  depthFar?: number;
  inlineVerticalFieldOfView?: number;
  baseLayer?: XRWebGLLayer;
  layers?: readonly XRCompositionLayer[] | null;
  passthroughFullyObscured?: boolean;
}
