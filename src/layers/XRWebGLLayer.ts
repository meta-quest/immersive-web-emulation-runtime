/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_DEVICE, P_SESSION, P_VIEW, P_WEBGL_LAYER } from '../private.js';

import { XRSession } from '../session/XRSession.js';
import { XRView } from '../views/XRView.js';

export class XRLayer extends EventTarget {}

type LayerInit = {
  antialias?: boolean;
  depth?: boolean;
  stencil?: boolean;
  alpha?: boolean;
  ignoreDepthValues?: boolean;
  framebufferScaleFactor?: number;
};

const defaultLayerInit: LayerInit = {
  antialias: true,
  depth: true,
  stencil: false,
  alpha: true,
  ignoreDepthValues: false,
  framebufferScaleFactor: 1.0,
};

export class XRWebGLLayer extends XRLayer {
  [P_WEBGL_LAYER]: {
    session: XRSession;
    context: WebGLRenderingContext | WebGL2RenderingContext;
    antialias: boolean;
  };

  constructor(
    session: XRSession,
    context: WebGLRenderingContext | WebGL2RenderingContext,
    layerInit: LayerInit = {},
  ) {
    super();

    if (session[P_SESSION].ended) {
      throw new DOMException('Session has ended', 'InvalidStateError');
    }

    // TO-DO: Check that the context attribute has xrCompatible set to true
    // may require polyfilling the context and perhaps canvas.getContext

    // Default values for XRWebGLLayerInit, can be overridden by layerInit
    const config = { ...defaultLayerInit, ...layerInit };

    this[P_WEBGL_LAYER] = {
      session,
      context,
      antialias: config.antialias!,
    };
  }

  get context() {
    return this[P_WEBGL_LAYER].context;
  }

  get antialias() {
    return this[P_WEBGL_LAYER].antialias;
  }

  get ignoreDepthValues() {
    return true;
  }

  get framebuffer() {
    return null;
  }

  get framebufferWidth() {
    return this[P_WEBGL_LAYER].context.drawingBufferWidth;
  }

  get framebufferHeight() {
    return this[P_WEBGL_LAYER].context.drawingBufferHeight;
  }

  getViewport(view: XRView) {
    if (view[P_VIEW].session !== this[P_WEBGL_LAYER].session) {
      throw new DOMException(
        "View's session differs from Layer's session",
        'InvalidStateError',
      );
    }
    // TO-DO: check frame
    return this[P_WEBGL_LAYER].session[P_SESSION].device[P_DEVICE].getViewport(
      this,
      view,
    );
  }

  static getNativeFramebufferScaleFactor(session: XRSession): number {
    if (!(session instanceof XRSession)) {
      throw new TypeError(
        'getNativeFramebufferScaleFactor must be passed a session.',
      );
    }

    if (session[P_SESSION].ended) {
      return 0.0;
    }

    // Return 1.0 for simplicity, actual implementation might vary based on the device capabilities
    return 1.0;
  }
}
