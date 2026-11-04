/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_DEVICE, P_SESSION, P_VIEW, P_WEBGL_LAYER } from '../private.js';

import { XRSession } from '../session/XRSession.js';
import { XREye, XRView } from '../views/XRView.js';
import { XRHostLayerTarget } from '../host/layer-target.js';

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
    // host mode only: the framebuffer over the host's swapchain
    host: XRHostLayerTarget | null;
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
      host: null,
    };

    const host = session[P_SESSION].host;
    if (host) {
      // an XRWebGLLayer renders both eyes side by side into one image
      const swapchain = host.acquireSwapchain({
        arraySize: 1,
        scale: config.framebufferScaleFactor ?? 1,
        colorFormat: undefined,
        context,
      });
      const backend = host.backend;
      this[P_WEBGL_LAYER].host = new XRHostLayerTarget(context, {
        width: swapchain.width,
        height: swapchain.height,
        depth: config.depth ?? true,
        stencil: config.stencil ?? false,
        discardDepth: backend.invalidateDepth !== false,
        wrapTexture: (name) => backend.wrapTexture?.(name) ?? null,
      });
    }
  }

  /** Host mode, before the frame's callbacks: target swapchain image `name`. */
  hostBindFrame(name: number): void {
    this[P_WEBGL_LAYER].host?.beginFrame(name);
  }

  /** Host mode, after the frame's last draw (see XRHostLayerTarget.endFrame). */
  hostEndFrame(): void {
    this[P_WEBGL_LAYER].host?.endFrame();
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
    return this[P_WEBGL_LAYER].host?.framebuffer ?? null;
  }

  get framebufferWidth() {
    return (
      this[P_WEBGL_LAYER].host?.width ??
      this[P_WEBGL_LAYER].context.drawingBufferWidth
    );
  }

  get framebufferHeight() {
    return (
      this[P_WEBGL_LAYER].host?.height ??
      this[P_WEBGL_LAYER].context.drawingBufferHeight
    );
  }

  // host mode only; undefined when emulating (three.js checks for that)
  get fixedFoveation(): number | undefined {
    return this[P_WEBGL_LAYER].session[P_SESSION].host?.foveation;
  }

  set fixedFoveation(value: number | undefined) {
    if (value === undefined || value === null) return;
    this[P_WEBGL_LAYER].session[P_SESSION].host?.setFoveation(value);
  }

  getViewport(view: XRView) {
    if (view[P_VIEW].session !== this[P_WEBGL_LAYER].session) {
      throw new DOMException(
        "View's session differs from Layer's session",
        'InvalidStateError',
      );
    }
    const host = this[P_WEBGL_LAYER].host;
    if (host) {
      return host.viewports[view[P_VIEW].eye === XREye.Right ? 1 : 0];
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
