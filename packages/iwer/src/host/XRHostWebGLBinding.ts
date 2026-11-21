/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  P_PROJECTION_LAYER,
  P_SESSION,
  P_VIEW,
  P_WEBGL_BINDING,
} from '../private.js';
import {
  XRProjectionLayer,
  XRProjectionLayerInit,
  XRTextureType,
  XRWebGLSubImage,
} from '../layers/XRProjectionLayer.js';
import type {
  XRCylinderLayer,
  XRCylinderLayerInit,
  XRQuadLayer,
  XRQuadLayerInit,
} from '../layers/XRContentLayer.js';
import type { XRCompositionLayer } from '../layers/XRProjectionLayer.js';
import type { XRFrame } from '../frameloop/XRFrame.js';
import { XREye, XRView } from '../views/XRView.js';
import { XRSession } from '../session/XRSession.js';
import { XRWebGLBinding } from '../depth/XRWebGLBinding.js';
import type { XRHostSession } from './XRHostSession.js';

type GLContext = WebGLRenderingContext | WebGL2RenderingContext;

/** Swapchain array size needed by each supported `XRTextureType`. */
const ARRAY_SIZE_FOR: Readonly<Record<XRTextureType, number>> = {
  texture: 1,
  'texture-array': 2,
};

function isTextureType(value: unknown): value is XRTextureType {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(ARRAY_SIZE_FOR, value)
  );
}

/** Throws the WebXR error for a binding used after its session ended. */
function assertLive(session: XRSession): void {
  if (session[P_SESSION].ended) {
    throw new DOMException(
      'The XRSession of this XRWebGLBinding has already ended.',
      'InvalidStateError',
    );
  }
}

/**
 * WebXR Layers' `XRWebGLBinding` (projection, quad and cylinder layers). Host mode
 * installs it as the global `XRWebGLBinding`; the emulator does not, because
 * three.js chooses its layers path as soon as `createProjectionLayer` is on
 * the prototype, and only a host has a compositor to back such layers.
 */
export class XRHostWebGLBinding extends XRWebGLBinding {
  [P_WEBGL_BINDING]: {
    session: XRSession;
    context: GLContext;
  };

  constructor(session: XRSession, context: GLContext) {
    if (!(session instanceof XRSession)) {
      throw new TypeError(
        'XRWebGLBinding needs an XRSession as its first argument.',
      );
    }
    assertLive(session);
    super(session, context as WebGL2RenderingContext);
    this[P_WEBGL_BINDING] = { context, session };
  }

  /** 1: the host already sizes swapchains at the runtime's recommendation. */
  get nativeProjectionScaleFactor(): number {
    return 1;
  }

  /** False: depth never reaches the host compositor. */
  get usesDepthValues(): boolean {
    return false;
  }

  /** The host side of the session, or NotSupportedError for an emulated one. */
  private hostSession(): XRHostSession {
    const host = this[P_WEBGL_BINDING].session[P_SESSION].host;
    if (host === null || host === undefined) {
      throw new DOMException(
        'Layers need a session driven by an IWER host.',
        'NotSupportedError',
      );
    }
    return host;
  }

  createProjectionLayer(init: XRProjectionLayerInit = {}): XRProjectionLayer {
    const binding = this[P_WEBGL_BINDING];
    assertLive(binding.session);
    const host = this.hostSession();
    const requested: unknown = init.textureType ?? 'texture';
    if (!isTextureType(requested)) {
      throw new TypeError(
        `XRTextureType '${String(requested)}' is not supported by createProjectionLayer.`,
      );
    }
    const swapchain = host.acquireSwapchain({
      context: binding.context,
      arraySize: ARRAY_SIZE_FOR[requested],
      colorFormat: init.colorFormat,
      scale: init.scaleFactor ?? 1,
    });
    return new XRProjectionLayer(binding.session, init, swapchain, requested);
  }

  /**
   * WebXR Layers `createQuadLayer`: a quad layer with a host swapchain of
   * its own (host/content-layers.ts).
   */
  createQuadLayer(init: XRQuadLayerInit): XRQuadLayer {
    const binding = this[P_WEBGL_BINDING];
    assertLive(binding.session);
    return this.hostSession().layers.create(
      'quad',
      binding.context,
      init,
    ) as XRQuadLayer;
  }

  /** WebXR Layers `createCylinderLayer` (see createQuadLayer). */
  createCylinderLayer(init: XRCylinderLayerInit): XRCylinderLayer {
    const binding = this[P_WEBGL_BINDING];
    assertLive(binding.session);
    return this.hostSession().layers.create(
      'cylinder',
      binding.context,
      init,
    ) as XRCylinderLayer;
  }

  /**
   * WebXR Layers `getSubImage(layer, frame, eye)` for a quad or cylinder
   * layer: the same object for a view every frame, its `colorTexture` the
   * layer's texture, which the host points at the image of this frame.
   */
  getSubImage(
    layer: XRCompositionLayer,
    frame: XRFrame,
    eye: XREye | 'none' | 'left' | 'right' = 'none',
  ): XRWebGLSubImage {
    assertLive(this[P_WEBGL_BINDING].session);
    return this.hostSession().layers.subImage(layer, frame, eye);
  }

  /**
   * One eye's sub-image of `layer`: the right eye gets the second region,
   * any other view the first. The object is the same every frame; its
   * `colorTexture` is the session's single opaque texture, which the host
   * re-points at each frame's swapchain image.
   */
  getViewSubImage(layer: XRProjectionLayer, view: XRView): XRWebGLSubImage {
    if (!(layer instanceof XRProjectionLayer)) {
      throw new TypeError('getViewSubImage expects an XRProjectionLayer.');
    }
    if (!(view instanceof XRView)) {
      throw new TypeError('getViewSubImage expects an XRView.');
    }
    const regions = layer[P_PROJECTION_LAYER].subImages;
    const subImage = regions[view[P_VIEW].eye === XREye.Right ? 1 : 0];
    const host = this[P_WEBGL_BINDING].session[P_SESSION].host;
    subImage.colorTexture = host?.getOpaqueColorTexture() ?? null;
    return subImage;
  }
}
