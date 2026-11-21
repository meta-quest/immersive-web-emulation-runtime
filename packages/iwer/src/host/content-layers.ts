/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { mat4, quat } from 'gl-matrix';

import { P_CONTENT_LAYER, P_DEVICE, P_FRAME, P_SESSION } from '../private.js';
import type {
  XRHostBackend,
  XRHostContentLayerKind,
  XRHostLayer,
  XRHostLayerLayout,
} from './types.js';
import { hostFillPoses } from './frame.js';
import {
  layerTransform,
  XRContentLayer,
  XRContentLayerState,
  XRCylinderLayer,
  XRCylinderLayerInit,
  XRLayerInit,
  XRQuadLayer,
  XRQuadLayerInit,
} from '../layers/XRContentLayer.js';
import {
  XRCompositionLayer,
  XRWebGLSubImage,
} from '../layers/XRProjectionLayer.js';
import { XRFrame } from '../frameloop/XRFrame.js';
import { XRRigidTransform } from '../primitives/XRRigidTransform.js';
import type { XRSession } from '../session/XRSession.js';
import { XRSpace } from '../spaces/XRSpace.js';
import { XRViewport } from '../views/XRViewport.js';

type GL = WebGLRenderingContext | WebGL2RenderingContext;

/** GL_RGBA8: XRLayerInit's colorFormat default, as for projection layers. */
const RGBA8 = 0x8058;

// WebGL enums for the clear on access (see clearImage)
const FRAMEBUFFER = 0x8d40;
const DRAW_FRAMEBUFFER = 0x8ca9;
const FRAMEBUFFER_BINDING = 0x8ca6;
const COLOR_ATTACHMENT0 = 0x8ce0;
const TEXTURE_2D = 0x0de1;
const SCISSOR_TEST = 0x0c11;
const COLOR_WRITEMASK = 0x0c23;
const COLOR_CLEAR_VALUE = 0x0c22;
const COLOR_BUFFER_BIT = 0x4000;
const COLOR = 0x1800;
const TRANSPARENT_BLACK = new Float32Array(4);

/** The projection layer's entry: only `kind` and `listed` matter to a host. */
function projectionEntry(): XRHostLayer {
  return {
    kind: 'projection',
    id: 0,
    listed: true,
    redrawn: true,
    layout: 'stereo',
    blendTextureSourceAlpha: false,
    located: true,
    viewerSpace: false,
    pose: new Float32Array([0, 0, 0, 0, 0, 0, 1]),
    width: 0,
    height: 0,
    radius: 0,
    centralAngle: 0,
    aspectRatio: 0,
  };
}

/** A view's region: [x, y, width, height, array layer]. */
type Region = [number, number, number, number, number];

/**
 * The layout a layer gets for its init (WebXR Layers "initialize a
 * composition layer"): 'default' belongs to projection layers, a texture
 * array holds stereo in its layers, and a plain texture holds stereo side by
 * side unless the page asked for top-bottom.
 */
function resolveLayout(
  layout: unknown,
  textureType: 'texture' | 'texture-array',
): XRHostLayerLayout {
  const requested = layout === undefined ? 'mono' : String(layout);
  if (requested === 'mono') {
    return 'mono';
  }
  if (textureType === 'texture-array') {
    if (requested === 'stereo') {
      return 'stereo';
    }
  } else if (requested === 'stereo' || requested === 'stereo-left-right') {
    return 'stereo-left-right';
  } else if (requested === 'stereo-top-bottom') {
    return 'stereo-top-bottom';
  }
  throw new TypeError(
    `XRLayerLayout '${requested}' is not valid for a ${textureType} quad or cylinder layer.`,
  );
}

/**
 * Image size and per-view regions for a layout. Each view gets exactly
 * viewPixelWidth x viewPixelHeight pixels; with GL's bottom-left origin the
 * top half of a top-bottom image is the upper rows. A mono 'texture-array'
 * layer is a texture array of one layer (arraySize 1, imageIndex 0).
 */
function regionsFor(
  layout: XRHostLayerLayout,
  w: number,
  h: number,
): { width: number; height: number; arraySize: number; views: Region[] } {
  switch (layout) {
    case 'stereo-left-right':
      return {
        width: w * 2,
        height: h,
        arraySize: 1,
        views: [
          [0, 0, w, h, 0],
          [w, 0, w, h, 0],
        ],
      };
    case 'stereo-top-bottom':
      return {
        width: w,
        height: h * 2,
        arraySize: 1,
        views: [
          [0, h, w, h, 0],
          [0, 0, w, h, 0],
        ],
      };
    case 'stereo':
      return {
        width: w,
        height: h,
        arraySize: 2,
        views: [
          [0, 0, w, h, 0],
          [0, 0, w, h, 1],
        ],
      };
    default:
      return { width: w, height: h, arraySize: 1, views: [[0, 0, w, h, 0]] };
  }
}

/** A positive integer pixel count from an XRLayerInit member, else TypeError. */
function pixels(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) {
    throw new TypeError(`XRLayerInit.${name} must be a positive number.`);
  }
  return Math.floor(n);
}

function numberOr(value: unknown, fallback: number): number {
  return value === undefined ? fallback : Number(value);
}

// scratch for the per-frame pose work (no allocation per frame)
const oneSpace: XRSpace[] = [];
const spaceWorld = new Float32Array(16);
const layerWorld = mat4.create();
const rotation = quat.create();

/**
 * Writes `layer`'s pose for the host into its entry: in the viewer space for
 * a head-locked layer (its space is the session's viewer reference space),
 * else the transform carried into the base space at this frame's poses.
 */
function writePose(state: XRContentLayerState, viewerSpace: XRSpace): void {
  const entry = state.entry;
  const pose = entry.pose;
  const m = state.transform.matrix;
  entry.viewerSpace = state.space === viewerSpace;
  let world: ArrayLike<number> = m;
  if (!entry.viewerSpace) {
    oneSpace[0] = state.space;
    // the global space is IWER's base space: its inverse is the identity
    const located = hostFillPoses(
      oneSpace,
      state.session[P_SESSION].device[P_DEVICE].globalSpace,
      spaceWorld,
    );
    oneSpace[0] = null as unknown as XRSpace;
    if (!located) {
      entry.located = false;
      return;
    }
    mat4.multiply(layerWorld, spaceWorld as unknown as mat4, m as mat4);
    world = layerWorld;
  }
  mat4.getRotation(rotation, world as mat4);
  quat.normalize(rotation, rotation);
  pose[0] = world[12];
  pose[1] = world[13];
  pose[2] = world[14];
  pose[3] = rotation[0];
  pose[4] = rotation[1];
  pose[5] = rotation[2];
  pose[6] = rotation[3];
  entry.located =
    Number.isFinite(pose[0]) &&
    Number.isFinite(pose[1]) &&
    Number.isFinite(pose[2]) &&
    Number.isFinite(pose[6]);
}

/**
 * WebXR Layers quad and cylinder layers of one host session: each has a host
 * swapchain of its own, the page draws it through `getSubImage`, and once per
 * frame the session's layer list goes to the host (`submitLayers`) with each
 * layer's pose, shape and whether the page drew it.
 */
export class XRHostContentLayers {
  private readonly session: XRSession;
  private readonly backend: XRHostBackend;
  /** Live (not destroyed) layers, oldest first. */
  private readonly live: XRContentLayer[] = [];
  private readonly submission: XRHostLayer[] = [];
  private readonly projection = projectionEntry();
  private readonly report: (error: unknown) => void;
  /** Layers whose entry failed once (reported once, not every frame). */
  private readonly failed = new WeakSet<XRContentLayerState>();
  // made once (an arrow function inside create would be one per layer)
  private readonly releaseLayer = (layer: XRContentLayer) =>
    this.release(layer);

  constructor(
    session: XRSession,
    backend: XRHostBackend,
    report: (error: unknown) => void = (error) => console.error(error),
  ) {
    this.session = session;
    this.backend = backend;
    this.report = report;
  }

  /** Live layers (diagnostics, tests). */
  get count(): number {
    return this.live.length;
  }

  /**
   * `createQuadLayer` / `createCylinderLayer`: checks the init, asks the host
   * for the layer's swapchain and builds the layer.
   */
  create(
    kind: XRHostContentLayerKind,
    context: GL,
    init: XRQuadLayerInit | XRCylinderLayerInit,
  ): XRContentLayer {
    const s = this.session[P_SESSION];
    if (s.ended) {
      throw new DOMException(
        'Cannot create a layer for an XRSession that has ended.',
        'InvalidStateError',
      );
    }
    if (!s.enabledFeatures.includes('layers')) {
      throw new DOMException(
        `create${kind === 'quad' ? 'Quad' : 'Cylinder'}Layer needs the 'layers' feature.`,
        'NotSupportedError',
      );
    }
    if (!this.backend.getLayerColorTexture) {
      throw new DOMException(
        'This IWER host does not present quad or cylinder layers.',
        'NotSupportedError',
      );
    }
    if (!init || typeof init !== 'object') {
      throw new TypeError('An XRLayerInit dictionary is required.');
    }
    const base = init as XRLayerInit;
    if (!(base.space instanceof XRSpace)) {
      throw new TypeError('XRLayerInit.space must be an XRSpace.');
    }
    const textureType = base.textureType ?? 'texture';
    if (textureType !== 'texture' && textureType !== 'texture-array') {
      throw new TypeError(
        `XRTextureType '${String(textureType)}' is not supported for quad or cylinder layers.`,
      );
    }
    const layout = resolveLayout(base.layout, textureType);
    const viewWidth = pixels(base.viewPixelWidth, 'viewPixelWidth');
    const viewHeight = pixels(base.viewPixelHeight, 'viewPixelHeight');
    const transform =
      base.transform === undefined
        ? new XRRigidTransform()
        : layerTransform(base.transform, 'XRLayerInit.transform');
    const isStatic = base.isStatic === true;
    const regions = regionsFor(layout, viewWidth, viewHeight);
    const colorFormat = base.colorFormat || RGBA8;
    const created = this.backend.beginSwapchain({
      arraySize: regions.arraySize,
      scale: 1,
      format: colorFormat,
      layer: kind,
      width: regions.width,
      height: regions.height,
      isStatic,
      mipLevels: Math.max(1, Math.floor(Number(base.mipLevels) || 1)),
      textureType,
    });
    if (!created || typeof created.id !== 'number' || created.id === 0) {
      throw new DOMException(
        `IWER host mode: the host could not create a swapchain for this ${kind} layer.`,
        'OperationError',
      );
    }
    const textureSize = { width: regions.width, height: regions.height };
    const quad = init as XRQuadLayerInit;
    const cylinder = init as XRCylinderLayerInit;
    const state: XRContentLayerState = {
      kind,
      session: this.session,
      context,
      id: created.id,
      layout,
      textureType,
      textureWidth: regions.width,
      textureHeight: regions.height,
      arraySize: regions.arraySize,
      colorFormat,
      isStatic,
      clearOnAccess: base.clearOnAccess !== false,
      // the host's swapchains have one level
      mipLevels: 1,
      space: base.space,
      transform,
      width: numberOr(quad.width, 1),
      height: numberOr(quad.height, 1),
      radius: numberOr(cylinder.radius, 2),
      centralAngle: numberOr(cylinder.centralAngle, 0.78539),
      aspectRatio: numberOr(cylinder.aspectRatio, 2),
      // the WebXR Layers default (Chromium, the Layers polyfill): transparent
      // texels show what is behind the layer
      blendTextureSourceAlpha: true,
      forceMonoPresentation: false,
      needsRedraw: true,
      destroyed: false,
      drawnInFrame: -1,
      clearedInFrame: -1,
      subImages: regions.views.map(
        ([x, y, w, h, arrayLayer]) =>
          new XRWebGLSubImage({
            viewport: new XRViewport(x, y, w, h),
            arrayLayer,
            textureSize,
          }),
      ),
      entry: {
        kind,
        id: created.id,
        listed: false,
        redrawn: false,
        layout,
        blendTextureSourceAlpha: true,
        located: false,
        viewerSpace: false,
        pose: new Float32Array([0, 0, 0, 0, 0, 0, 1]),
        width: 0,
        height: 0,
        radius: 0,
        centralAngle: 0,
        aspectRatio: 0,
      },
      clearFramebuffer: null,
      release: this.releaseLayer,
    };
    const layer =
      kind === 'quad' ? new XRQuadLayer(state) : new XRCylinderLayer(state);
    this.live.push(layer);
    return layer;
  }

  /**
   * `getSubImage(layer, frame, eye)`: the view's sub-image, whose
   * colorTexture refers to the image the page draws this frame. The layer
   * counts as redrawn in this frame; with clearOnAccess its image is cleared
   * to transparent black on the first access of the frame. needsRedraw goes
   * false once the frame is over (endFrame).
   */
  subImage(
    layer: XRCompositionLayer,
    frame: XRFrame,
    eye: unknown,
  ): XRWebGLSubImage {
    if (!(layer instanceof XRContentLayer)) {
      throw new TypeError(
        'getSubImage expects an XRQuadLayer or an XRCylinderLayer.',
      );
    }
    const state = layer[P_CONTENT_LAYER];
    if (state.session !== this.session || state.destroyed) {
      throw new DOMException(
        'getSubImage: the layer belongs to another session or was destroyed.',
        'InvalidStateError',
      );
    }
    if (!(frame instanceof XRFrame)) {
      throw new TypeError('getSubImage expects an XRFrame.');
    }
    const f = frame[P_FRAME];
    if (f.session !== this.session || !f.active || !f.animationFrame) {
      throw new DOMException(
        'getSubImage needs an active animation frame of the layer’s session.',
        'InvalidStateError',
      );
    }
    // a static layer takes its content in the frame it is drawn in: every view
    // of a stereo layer, as often as the page asks in that frame (the Layers
    // polyfill clears needsRedraw after the frame too)
    if (state.isStatic && !state.needsRedraw && state.drawnInFrame !== f.id) {
      throw new DOMException(
        'getSubImage: a static layer can only be drawn while needsRedraw is true.',
        'InvalidStateError',
      );
    }
    let view = 0;
    if (state.layout !== 'mono') {
      if (eye === 'right') {
        view = 1;
      } else if (eye !== 'left') {
        throw new TypeError(
          'getSubImage: a stereo layer needs eye "left" or "right".',
        );
      }
    }
    const subImage = state.subImages[view];
    const texture = this.backend.getLayerColorTexture?.(state.id) ?? null;
    subImage.colorTexture = texture;
    state.drawnInFrame = f.id;
    if (state.clearOnAccess && state.clearedInFrame !== f.id && texture) {
      state.clearedInFrame = f.id;
      clearImage(state, texture);
    }
    return subImage;
  }

  /** layer.destroy(): the host releases the swapchain. */
  private release(layer: XRContentLayer): void {
    const i = this.live.indexOf(layer);
    if (i < 0) {
      return;
    }
    this.live.splice(i, 1);
    deleteClearFramebuffer(layer[P_CONTENT_LAYER]);
    if (this.session[P_SESSION].ended) {
      return;
    }
    this.backend.releaseSwapchain?.(layer[P_CONTENT_LAYER].id);
  }

  /**
   * Hands the frame's layer list to the host: `layers` (renderState.layers)
   * in order, then layers drawn in frame `frameId` that are not listed.
   */
  submit(layers: readonly XRCompositionLayer[], frameId: number): void {
    const submit = this.backend.submitLayers;
    if (!submit) {
      return;
    }
    const out = this.submission;
    let count = 0;
    const viewerSpace = this.session[P_SESSION].device.viewerSpace;
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      if (!(layer instanceof XRContentLayer)) {
        // the projection layer (renderState.layers only holds composition
        // layers of this session)
        out[count++] = this.projection;
        continue;
      }
      const state = layer[P_CONTENT_LAYER];
      if (state.destroyed || state.entry.listed) {
        continue; // destroyed layers show nothing; a repeat is shown once
      }
      this.fill(state, frameId, viewerSpace, true);
      out[count++] = state.entry;
    }
    const live = this.live;
    for (let i = 0; i < live.length; i++) {
      const state = live[i][P_CONTENT_LAYER];
      if (!state.entry.listed && state.drawnInFrame === frameId) {
        // drawn but not shown: the new content still becomes current
        this.fill(state, frameId, viewerSpace, false);
        out[count++] = state.entry;
      }
    }
    out.length = count;
    try {
      submit.call(this.backend, out);
    } finally {
      // `listed` marks repeats while the list is built; it is set again
      // for each entry every frame
      for (let i = 0; i < live.length; i++) {
        live[i][P_CONTENT_LAYER].entry.listed = false;
      }
    }
  }

  private fill(
    state: XRContentLayerState,
    frameId: number,
    viewerSpace: XRSpace,
    listed: boolean,
  ): void {
    const entry = state.entry;
    entry.listed = listed;
    entry.redrawn = state.drawnInFrame === frameId;
    entry.blendTextureSourceAlpha = state.blendTextureSourceAlpha;
    if (state.kind === 'quad') {
      entry.width = state.width * 2;
      entry.height = state.height * 2;
    } else {
      entry.radius = state.radius;
      entry.centralAngle = state.centralAngle;
      entry.aspectRatio = state.aspectRatio;
    }
    // try/catch in place (no closure per frame): a layer whose pose cannot be
    // worked out is left unlocated (not shown) instead of costing the whole
    // list; reported once
    try {
      writePose(state, viewerSpace);
    } catch (error) {
      entry.located = false;
      if (!this.failed.has(state)) {
        this.failed.add(state);
        this.report(error);
      }
    }
  }

  /**
   * The frame is over: layers drawn in it no longer need a redraw (a static
   * one cannot be drawn again).
   */
  endFrame(frameId: number): void {
    const live = this.live;
    for (let i = 0; i < live.length; i++) {
      const state = live[i][P_CONTENT_LAYER];
      if (state.drawnInFrame === frameId) {
        state.needsRedraw = false;
      }
    }
  }

  /** The session ended: every layer is gone (the host released the swapchains). */
  end(): void {
    const live = this.live;
    for (let i = 0; i < live.length; i++) {
      const state = live[i][P_CONTENT_LAYER];
      state.destroyed = true;
      deleteClearFramebuffer(state);
    }
    live.length = 0;
  }
}

/** The framebuffer clearImage made for a layer, deleted with the layer. */
function deleteClearFramebuffer(state: XRContentLayerState): void {
  const fb = state.clearFramebuffer;
  if (fb === null) {
    return;
  }
  state.clearFramebuffer = null;
  const gl = state.context;
  if (typeof gl.deleteFramebuffer === 'function') {
    gl.deleteFramebuffer(fb);
  }
}

/**
 * clearOnAccess: clears the layer's image (every array layer) to transparent
 * black through a framebuffer of the layer's own. The page's framebuffer
 * binding, scissor test, colour mask and clear colour are restored exactly,
 * because three.js caches them (see host/layer-target.ts). This runs every
 * frame for every such layer, so WebGL 2 clears with clearBufferfv and leaves
 * the clear colour alone (one state query fewer, no array per frame for it).
 */
function clearImage(state: XRContentLayerState, texture: WebGLTexture): void {
  const gl = state.context as WebGL2RenderingContext;
  if (
    typeof gl.clear !== 'function' ||
    typeof gl.createFramebuffer !== 'function'
  ) {
    return;
  }
  if (state.clearFramebuffer === null) {
    state.clearFramebuffer = gl.createFramebuffer();
  }
  // WebGL 1.0 has no separate draw binding
  const target =
    (gl as unknown as Record<string, unknown>).DRAW_FRAMEBUFFER ===
      DRAW_FRAMEBUFFER || typeof gl.blitFramebuffer === 'function'
      ? DRAW_FRAMEBUFFER
      : FRAMEBUFFER;
  const clearBuffer = typeof gl.clearBufferfv === 'function';
  const previous = gl.getParameter(FRAMEBUFFER_BINDING);
  const scissor = gl.isEnabled(SCISSOR_TEST);
  const mask = gl.getParameter(COLOR_WRITEMASK) as boolean[];
  const color = clearBuffer
    ? null
    : (gl.getParameter(COLOR_CLEAR_VALUE) as Float32Array);
  gl.bindFramebuffer(target, state.clearFramebuffer);
  if (scissor) {
    gl.disable(SCISSOR_TEST);
  }
  gl.colorMask(true, true, true, true);
  if (color) {
    gl.clearColor(0, 0, 0, 0);
  }
  // a 'texture-array' texture is a TEXTURE_2D_ARRAY even with one layer
  const arrayed = state.textureType === 'texture-array';
  for (let layer = 0; layer < state.arraySize; layer++) {
    if (arrayed) {
      gl.framebufferTextureLayer(target, COLOR_ATTACHMENT0, texture, 0, layer);
    } else {
      gl.framebufferTexture2D(
        target,
        COLOR_ATTACHMENT0,
        TEXTURE_2D,
        texture,
        0,
      );
    }
    if (color) {
      gl.clear(COLOR_BUFFER_BIT);
    } else {
      gl.clearBufferfv(COLOR, 0, TRANSPARENT_BLACK);
    }
  }
  if (color) {
    gl.clearColor(color[0], color[1], color[2], color[3]);
  }
  gl.colorMask(mask[0], mask[1], mask[2], mask[3]);
  if (scissor) {
    gl.enable(SCISSOR_TEST);
  }
  gl.bindFramebuffer(target, previous);
}
