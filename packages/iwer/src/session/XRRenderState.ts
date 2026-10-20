/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_RENDER_STATE } from '../private.js';
import { XRLayer, XRWebGLLayer } from '../layers/XRWebGLLayer.js';

export class XRRenderState {
  [P_RENDER_STATE]: {
    depthNear: number;
    depthFar: number;
    inlineVerticalFieldOfView: number | null;
    baseLayer: XRWebGLLayer | null;
    layers: readonly XRLayer[] | undefined;
  };

  // Defined only on render states of WebGPU sessions, so `'layers' in
  // renderState` stays false for WebGL sessions as before.
  declare readonly layers?: readonly XRLayer[];

  constructor(init: Partial<XRRenderStateInit> = {}, oldState?: XRRenderState) {
    this[P_RENDER_STATE] = {
      // Use nullish coalescing so a legitimate 0 (e.g.
      // inlineVerticalFieldOfView=0) is not replaced by the default.
      depthNear: init.depthNear ?? oldState?.depthNear ?? 0.1,
      depthFar: init.depthFar ?? oldState?.depthFar ?? 1000.0,
      inlineVerticalFieldOfView:
        init.inlineVerticalFieldOfView ??
        oldState?.inlineVerticalFieldOfView ??
        null,
      baseLayer: init.baseLayer ?? oldState?.baseLayer ?? null,
      // Only WebGPU sessions have layers; frozen like the IDL FrozenArray.
      layers: init.layers
        ? Object.freeze([...init.layers])
        : oldState?.[P_RENDER_STATE].layers,
    };
    if (this[P_RENDER_STATE].layers !== undefined) {
      Object.defineProperty(this, 'layers', {
        get: () => this[P_RENDER_STATE].layers,
        enumerable: true,
      });
    }
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
}

// XRRenderStateInit interface definition for TypeScript
export interface XRRenderStateInit {
  depthNear?: number;
  depthFar?: number;
  inlineVerticalFieldOfView?: number;
  baseLayer?: XRWebGLLayer;
  layers?: readonly XRLayer[];
}
