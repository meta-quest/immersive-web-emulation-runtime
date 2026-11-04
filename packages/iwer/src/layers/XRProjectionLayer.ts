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
import type { XRSession } from '../session/XRSession.js';
import { XRViewport } from '../views/XRViewport.js';

export type XRTextureType = 'texture' | 'texture-array';

/** WebXR Layers `XRProjectionLayerInit`. */
export interface XRProjectionLayerInit {
  textureType?: XRTextureType;
  colorFormat?: number;
  depthFormat?: number;
  scaleFactor?: number;
  clearOnAccess?: boolean;
}

/** GL enums used as `XRProjectionLayerInit` defaults (WebXR Layers IDL). */
const GL_RGBA8 = 0x8058;
const GL_DEPTH_COMPONENT24 = 0x81a6;

/**
 * Layout reported for each texture type. A texture array is the layout the
 * user agent would choose on its own ('default'); a single texture holds both
 * eyes next to each other ('stereo', left eye first).
 */
const LAYOUT_OF: Readonly<Record<XRTextureType, string>> = {
  'texture-array': 'default',
  texture: 'stereo',
};

/** Where in the layer's texture(s) one view is drawn. */
interface SubImageRegion {
  /** Pixel rectangle of the view inside its texture (or array layer). */
  viewport: XRViewport;
  /** Array layer holding the view; always 0 for a plain texture. */
  arrayLayer: number;
  /** Full size of the colour texture the region belongs to. */
  textureSize: { width: number; height: number };
}

/**
 * WebXR Layers `XRWebGLSubImage`. Host mode builds one per eye when a layer
 * is created and hands out the same object every frame; `colorTexture` is
 * the only field it refreshes.
 */
export class XRWebGLSubImage {
  readonly colorTextureWidth: number;
  readonly colorTextureHeight: number;
  readonly imageIndex: number;
  readonly viewport: XRViewport;
  colorTexture: WebGLTexture | null = null;
  /** Depth is never handed to the host compositor, so none is exposed. */
  depthStencilTexture: WebGLTexture | null = null;
  motionVectorTexture: WebGLTexture | null = null;

  constructor(region: SubImageRegion) {
    const { textureSize } = region;
    this.colorTextureWidth = textureSize.width;
    this.colorTextureHeight = textureSize.height;
    this.imageIndex = region.arrayLayer;
    this.viewport = region.viewport;
  }

  /** Name used for the colour texture size by older Layers drafts. */
  get textureWidth(): number {
    return this.colorTextureWidth;
  }

  get textureHeight(): number {
    return this.colorTextureHeight;
  }

  get depthStencilTextureWidth(): number | null {
    return null;
  }

  get depthStencilTextureHeight(): number | null {
    return null;
  }
}

/**
 * Composition-layer attributes the host compositor has no way to honour.
 * Each reads as its IDL default; the writable ones accept and drop writes.
 */
const FIXED_ATTRIBUTES: ReadonlyArray<
  [name: string, value: unknown, writable: boolean]
> = [
  ['blendTextureSourceAlpha', false, true],
  ['forceMonoPresentation', false, true],
  ['opacity', 1, true],
  ['quality', 'default', true],
  // only some Layers drafts have it; null leaves the choice to the UA
  ['chromaticAberrationCorrection', null, true],
  ['mipLevels', 1, false],
  ['needsRedraw', false, false],
];

const ignoreWrite = () => {};

/**
 * WebXR Layers `XRCompositionLayer`. IWER offers projection layers only, and
 * only in host mode; the host's compositor presents them.
 */
export class XRCompositionLayer extends XRLayer {
  [P_COMPOSITION_LAYER]: {
    session: XRSession;
    layout: string;
  };

  declare blendTextureSourceAlpha: boolean;
  declare forceMonoPresentation: boolean;
  declare opacity: number;
  declare quality: string;
  declare chromaticAberrationCorrection: boolean | null;
  declare readonly mipLevels: number;
  declare readonly needsRedraw: boolean;

  constructor(owner: { session: XRSession; layout: string }) {
    super();
    this[P_COMPOSITION_LAYER] = {
      layout: owner.layout,
      session: owner.session,
    };
  }

  get layout(): string {
    return this[P_COMPOSITION_LAYER].layout;
  }

  destroy(): void {}
}

for (const [name, value, writable] of FIXED_ATTRIBUTES) {
  Object.defineProperty(XRCompositionLayer.prototype, name, {
    configurable: true,
    enumerable: false,
    get: () => value,
    set: writable ? ignoreWrite : undefined,
  });
}

/** The swapchain image dimensions a projection layer covers. */
type SwapchainSize = { width: number; height: number; arraySize: number };

/**
 * The two eye regions of a layer, left (or the only view) first. A texture
 * array gives every eye a whole layer of its own; a single texture is cut
 * at floor(width / 2), the right eye taking the remaining columns.
 */
function eyeRegions(
  textureType: XRTextureType,
  size: SwapchainSize,
): [XRWebGLSubImage, XRWebGLSubImage] {
  const textureSize = { width: size.width, height: size.height };
  const arrayed = textureType === 'texture-array';
  const split = Math.floor(size.width / 2);
  const regionFor = (eye: 0 | 1): XRWebGLSubImage => {
    const x = arrayed || eye === 0 ? 0 : split;
    const columns = arrayed
      ? size.width
      : eye === 0
        ? split
        : size.width - split;
    return new XRWebGLSubImage({
      viewport: new XRViewport(x, 0, columns, size.height),
      arrayLayer: arrayed ? eye : 0,
      textureSize,
    });
  };
  return [regionFor(0), regionFor(1)];
}

/** WebXR Layers `XRProjectionLayer`, drawn into the host session's swapchain. */
export class XRProjectionLayer extends XRCompositionLayer {
  [P_PROJECTION_LAYER]: {
    textureType: XRTextureType;
    size: SwapchainSize;
    colorFormat: number;
    depthFormat: number;
    subImages: [XRWebGLSubImage, XRWebGLSubImage];
  };

  constructor(
    session: XRSession,
    init: XRProjectionLayerInit,
    swapchain: SwapchainSize,
    textureType: XRTextureType,
  ) {
    super({ session, layout: LAYOUT_OF[textureType] });
    const size: SwapchainSize = {
      arraySize: swapchain.arraySize,
      height: swapchain.height,
      width: swapchain.width,
    };
    // depthFormat: only an absent member takes the default. three.js passes
    // null when it renders without depth, and that choice must survive.
    const depthFormat =
      init.depthFormat === undefined ? GL_DEPTH_COMPONENT24 : init.depthFormat;
    this[P_PROJECTION_LAYER] = {
      subImages: eyeRegions(textureType, size),
      colorFormat: init.colorFormat ?? GL_RGBA8,
      depthFormat,
      textureType,
      size,
    };
  }

  get textureType(): XRTextureType {
    return this[P_PROJECTION_LAYER].textureType;
  }

  get textureWidth(): number {
    return this[P_PROJECTION_LAYER].size.width;
  }

  get textureHeight(): number {
    return this[P_PROJECTION_LAYER].size.height;
  }

  get textureArrayLength(): number {
    return this[P_PROJECTION_LAYER].size.arraySize;
  }

  /** True: the host compositor never receives depth. */
  get ignoreDepthValues(): boolean {
    return true;
  }

  get colorFormat(): number {
    return this[P_PROJECTION_LAYER].colorFormat;
  }

  get depthFormat(): number {
    return this[P_PROJECTION_LAYER].depthFormat;
  }

  /**
   * Fixed foveation. Every layer draws into the session's single swapchain,
   * so the level is shared session wide; null outside host mode.
   */
  get fixedFoveation(): number | null {
    const host = this[P_COMPOSITION_LAYER].session[P_SESSION].host;
    return host === null || host === undefined ? null : host.foveation;
  }

  set fixedFoveation(level: number | null) {
    if (level === null) {
      return;
    }
    this[P_COMPOSITION_LAYER].session[P_SESSION].host?.setFoveation(level);
  }

  get deltaPose(): null {
    return null;
  }
  set deltaPose(_ignored: unknown) {}
}
