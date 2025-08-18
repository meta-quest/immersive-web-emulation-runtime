/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_RENDER_STATE } from '../private.js';
import { XRWebGLLayer } from '../layers/XRWebGLLayer.js';

export class XRRenderState {
  [P_RENDER_STATE]: {
    depthNear: number;
    depthFar: number;
    inlineVerticalFieldOfView: number | null;
    baseLayer: XRWebGLLayer | null;
  };

  constructor(init: Partial<XRRenderStateInit> = {}, oldState?: XRRenderState) {
    this[P_RENDER_STATE] = {
      depthNear: init.depthNear || oldState?.depthNear || 0.1,
      depthFar: init.depthFar || oldState?.depthFar || 1000.0,
      inlineVerticalFieldOfView:
        init.inlineVerticalFieldOfView ||
        oldState?.inlineVerticalFieldOfView ||
        null,
      baseLayer: init.baseLayer || oldState?.baseLayer || null,
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
}

// XRRenderStateInit interface definition for TypeScript
export interface XRRenderStateInit {
  depthNear?: number;
  depthFar?: number;
  inlineVerticalFieldOfView?: number;
  baseLayer?: XRWebGLLayer;
}
