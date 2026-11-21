/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_CONTENT_LAYER } from '../private.js';
import type {
  XRHostContentLayerKind,
  XRHostLayer,
  XRHostLayerLayout,
} from '../host/types.js';
import { XRCompositionLayer, XRWebGLSubImage } from './XRProjectionLayer.js';
import { XRRigidTransform } from '../primitives/XRRigidTransform.js';
import type { XRSession } from '../session/XRSession.js';
import { XRSpace } from '../spaces/XRSpace.js';

type GLContext = WebGLRenderingContext | WebGL2RenderingContext;

/** WebXR Layers `XRLayerLayout`. */
export type XRLayerLayout =
  | 'default'
  | 'mono'
  | 'stereo'
  | 'stereo-left-right'
  | 'stereo-top-bottom';

/** WebXR Layers `XRLayerInit`, the members quad and cylinder layers share. */
export interface XRLayerInit {
  space: XRSpace;
  colorFormat?: number;
  depthFormat?: number | null;
  mipLevels?: number;
  viewPixelWidth: number;
  viewPixelHeight: number;
  layout?: XRLayerLayout;
  isStatic?: boolean;
  clearOnAccess?: boolean;
  textureType?: 'texture' | 'texture-array';
  transform?: XRRigidTransform;
}

/**
 * The layer's own copy of a transform the page passes (init or attribute),
 * TypeError for anything else. A copy because IWER rewrites the transforms
 * of its pooled poses in place (host/frame.ts): a layer placed from
 * `getPose(...).transform` would otherwise follow that pose. WebXR
 * transforms never change, so the copy reads the same.
 */
export function layerTransform(
  transform: unknown,
  member: string,
): XRRigidTransform {
  if (!(transform instanceof XRRigidTransform)) {
    throw new TypeError(`${member} must be an XRRigidTransform.`);
  }
  return new XRRigidTransform(transform.position, transform.orientation);
}

/** The state of a quad or cylinder layer, filled in by the host session. */
export interface XRContentLayerState {
  kind: XRHostContentLayerKind;
  session: XRSession;
  context: GLContext;
  /** The host's id for the layer's swapchain. */
  id: number;
  /** How the views share the images (the resolved WebXR layout). */
  layout: XRHostLayerLayout;
  textureType: 'texture' | 'texture-array';
  /** Size of one swapchain image and its array layers. */
  textureWidth: number;
  textureHeight: number;
  arraySize: number;
  colorFormat: number;
  isStatic: boolean;
  clearOnAccess: boolean;
  mipLevels: number;
  space: XRSpace;
  transform: XRRigidTransform;
  /** Quad: the page's half-extents (WebXR `width` / `height`). */
  width: number;
  height: number;
  radius: number;
  centralAngle: number;
  aspectRatio: number;
  blendTextureSourceAlpha: boolean;
  forceMonoPresentation: boolean;
  needsRedraw: boolean;
  destroyed: boolean;
  /** Host frame id of the last `getSubImage` (the image then holds new content). */
  drawnInFrame: number;
  /** Host frame id of the last clear on access. */
  clearedInFrame: number;
  /** One sub-image per view (one for mono), handed out every frame. */
  subImages: XRWebGLSubImage[];
  /** The layer's entry in the host's per-frame layer list (rewritten each frame). */
  entry: XRHostLayer;
  /** The framebuffer clearOnAccess clears through, made on first use. */
  clearFramebuffer: WebGLFramebuffer | null;
  /** Releases the host swapchain (destroy()). */
  release: (layer: XRContentLayer) => void;
}

/**
 * Composition-layer attributes a quad or cylinder layer keeps for real
 * (the host compositor honours them or, for forceMonoPresentation, at least
 * keeps what the page set). The rest keep XRCompositionLayer's fixed values.
 */
const LIVE_ATTRIBUTES: ReadonlyArray<
  [name: keyof XRContentLayerState, writable: boolean]
> = [
  ['blendTextureSourceAlpha', true],
  ['forceMonoPresentation', true],
  ['mipLevels', false],
  ['needsRedraw', false],
];

/**
 * The part WebXR Layers' `XRQuadLayer` and `XRCylinderLayer` share: a layer
 * with a swapchain of its own that the page draws through
 * `XRWebGLBinding.getSubImage`, placed in a space by a transform. Host mode
 * only: the host session creates it (host/content-layers.ts).
 */
export class XRContentLayer extends XRCompositionLayer {
  [P_CONTENT_LAYER]: XRContentLayerState;
  private redrawHandler: ((event: Event) => void) | null = null;

  declare blendTextureSourceAlpha: boolean;
  declare forceMonoPresentation: boolean;
  declare readonly mipLevels: number;
  declare readonly needsRedraw: boolean;

  constructor(state: XRContentLayerState) {
    super({ session: state.session, layout: state.layout });
    this[P_CONTENT_LAYER] = state;
  }

  get space(): XRSpace {
    return this[P_CONTENT_LAYER].space;
  }

  // non-nullable WebIDL attributes: anything else is a TypeError, as in a
  // browser, rather than a layer that fails every frame
  set space(space: XRSpace) {
    if (!(space instanceof XRSpace)) {
      throw new TypeError('The layer space must be an XRSpace.');
    }
    this[P_CONTENT_LAYER].space = space;
  }

  get transform(): XRRigidTransform {
    return this[P_CONTENT_LAYER].transform;
  }

  set transform(transform: XRRigidTransform) {
    this[P_CONTENT_LAYER].transform = layerTransform(
      transform,
      'The layer transform',
    );
  }

  /** WebXR Layers `redraw`: never fired, the host keeps layer content. */
  get onredraw(): ((event: Event) => void) | null {
    return this.redrawHandler;
  }

  set onredraw(handler: ((event: Event) => void) | null) {
    if (this.redrawHandler) {
      this.removeEventListener('redraw', this.redrawHandler);
    }
    this.redrawHandler = typeof handler === 'function' ? handler : null;
    if (this.redrawHandler) {
      this.addEventListener('redraw', this.redrawHandler);
    }
  }

  /** Releases the layer's swapchain; the layer is not shown any more. */
  destroy(): void {
    const state = this[P_CONTENT_LAYER];
    if (state.destroyed) {
      return;
    }
    state.destroyed = true;
    state.release(this);
  }
}

for (const [name, writable] of LIVE_ATTRIBUTES) {
  Object.defineProperty(XRContentLayer.prototype, name, {
    configurable: true,
    enumerable: false,
    get(this: XRContentLayer) {
      return this[P_CONTENT_LAYER][name];
    },
    set: writable
      ? function (this: XRContentLayer, value: unknown) {
          (this[P_CONTENT_LAYER] as unknown as Record<string, unknown>)[name] =
            !!value;
        }
      : undefined,
  });
}

/** WebXR Layers `XRQuadLayerInit`. */
export interface XRQuadLayerInit extends XRLayerInit {
  width?: number;
  height?: number;
}

/**
 * WebXR Layers `XRQuadLayer`: a flat rectangle facing +z at `transform`.
 * `width` and `height` are half-extents (see XRHostLayer.width).
 */
export class XRQuadLayer extends XRContentLayer {
  get width(): number {
    return this[P_CONTENT_LAYER].width;
  }

  set width(value: number) {
    this[P_CONTENT_LAYER].width = Number(value);
  }

  get height(): number {
    return this[P_CONTENT_LAYER].height;
  }

  set height(value: number) {
    this[P_CONTENT_LAYER].height = Number(value);
  }
}

/** WebXR Layers `XRCylinderLayerInit`. */
export interface XRCylinderLayerInit extends XRLayerInit {
  radius?: number;
  centralAngle?: number;
  aspectRatio?: number;
}

/**
 * WebXR Layers `XRCylinderLayer`: the inside of a section of a cylinder
 * around `transform`'s +y axis, centred on its -z direction.
 */
export class XRCylinderLayer extends XRContentLayer {
  get radius(): number {
    return this[P_CONTENT_LAYER].radius;
  }

  set radius(value: number) {
    this[P_CONTENT_LAYER].radius = Number(value);
  }

  get centralAngle(): number {
    return this[P_CONTENT_LAYER].centralAngle;
  }

  set centralAngle(value: number) {
    this[P_CONTENT_LAYER].centralAngle = Number(value);
  }

  get aspectRatio(): number {
    return this[P_CONTENT_LAYER].aspectRatio;
  }

  set aspectRatio(value: number) {
    this[P_CONTENT_LAYER].aspectRatio = Number(value);
  }
}
