/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The WebGL side of a host session (docs/spec/08 XR-SC-2/3, 07 GL-PERF-5, REG-6):
// - one opaque WebGLTexture per session whose GL name follows the swapchain image the XR thread acquired for the
//   frame (the browser model: getViewSubImage hands out the same texture object every frame), re-pointed with the
//   WebGL prelude's retargetTexture, which also re-attaches it in every framebuffer that has it attached, so an app
//   that attaches once keeps rendering into the current image;
// - at the end of each frame: depth/stencil of those framebuffers invalidated (the compositor never reads them),
//   query epochs advanced, then the session's GL context made current and fenced for the XR thread
//   (runtime/xr/src/android/egl_xr.h);
// - after the fence, the frame's image is parked (XR-SC-3): the XR thread releases it to the compositor, so it is
//   detached in GL from every framebuffer that renders into it (the opaque texture is pointed at no image, an
//   XRWebGLLayer framebuffer loses its colour attachment) until the next frame begins. Drawing outside a frame
//   callback then reaches no image, as WebXR specifies for opaque framebuffers, instead of an image the compositor
//   may be reading. Only GL is changed: the WebGL binding's record of the attachment stays, so the page's view and
//   IWER's own bookkeeping (it attaches an XRWebGLLayer image only when the image changes) are untouched.
//
// Quad and cylinder layers (XR-LAYER-1) work the same way: one WebGLTexture per layer swapchain (the colorTexture of
// its sub-images), pointed at the image the XR thread acquired for that layer (the shared layer buffer, layers.ts)
// when a frame begins and parked after it, because the XR thread releases the image of a layer the page drew to the
// compositor once the frame is fenced. A layer the page draws in the frame it created it in has no image in the
// buffer yet: one is acquired at once (natives.acquireLayerImage).
//
// The framebuffers that may hold the opaque texture are found by watching which framebuffers the session's context
// binds (one JS call per bind on that context only; attaching needs the framebuffer bound, so every framebuffer that
// can hold the session's image is seen). retargetTexture skips those without the texture attached. The list is
// bounded: when it is full, deleted framebuffers go first, then the oldest one that holds no session image. One that
// holds it is never dropped, or it would keep an image the compositor owns attached and miss the next re-pointing.

import type { LayerBuffer } from './layers.ts';
import type { GLContext, WebGLHooks, XrNatives } from './natives.ts';

const TEXTURE_2D = 0x0de1;
const TEXTURE_2D_ARRAY = 0x8c1a;
const FRAMEBUFFER_BINDING = 0x8ca6;  // = DRAW_FRAMEBUFFER_BINDING
const MAX_TRACKED_FRAMEBUFFERS = 32;

interface FramebufferLike {
  _attachments?: Map<number, { object: unknown }>;
}

/** The WebGL binding's texture object as far as parking needs it (web/webgl objects.ts: `_name` is the GL name). */
interface TextureLike {
  _name: number;
}

/** A quad or cylinder layer's swapchain and the texture its sub-images report (made on first use). */
interface LayerTexture {
  id: number;
  target: number;
  tex: TextureLike | null;
}

export class GraphicsBridge {
  gl: GLContext | null = null;
  /** 2 for a texture-array (multiview) swapchain, 1 for side by side, 0 before the first layer. */
  arraySize = 0;
  /** Depth/stencil invalidations issued so far (GL-PERF-5 diagnostics). */
  invalidations = 0;
  /** Images parked after a frame so far (XR-SC-3 diagnostics). */
  parks = 0;
  private opaque: object | null = null;
  private currentName = 0;
  private readonly framebuffers: object[] = [];
  private readonly wrapped = new Map<number, object>();
  private readonly wrappers = new Set<object>();
  // XRWebGLLayer framebuffers whose colour was detached after the last frame, with the wrapper and its GL name
  // (parallel arrays reused every frame: no per-frame allocation).
  private readonly parkedFbs: object[] = [];
  private readonly parkedTextures: TextureLike[] = [];
  private readonly parkedNames: number[] = [];
  private readonly one: object[] = [];
  private readonly natives: XrNatives;
  private readonly hooks: WebGLHooks | null;
  // quad and cylinder layers: live swapchains (oldest first), their textures, the shared buffer
  private readonly layers: LayerTexture[] = [];
  private readonly layerTextures = new Set<object>();
  private layerBuffer: LayerBuffer | null = null;
  private inFrame = false;

  constructor(natives: XrNatives, hooks: WebGLHooks | null) {
    this.natives = natives;
    this.hooks = hooks;
  }

  /** Live quad and cylinder layer swapchains. */
  get layerCount(): number {
    return this.layers.length;
  }

  setLayerBuffer(buffer: LayerBuffer): void {
    this.layerBuffer = buffer;
  }

  /** A quad or cylinder layer's swapchain was created; `textureArray`: its images are TEXTURE_2D_ARRAYs. */
  addLayer(id: number, textureArray: boolean): void {
    this.layers.push({ id, target: textureArray ? TEXTURE_2D_ARRAY : TEXTURE_2D, tex: null });
  }

  /** layer.destroy(): its texture refers to no image any more (the swapchain goes). */
  dropLayer(id: number): void {
    const i = this.layers.findIndex((l) => l.id === id);
    if (i < 0) return;
    const tex = this.layers[i].tex;
    if (tex && this.gl && this.hooks) this.hooks.retargetTexture(this.gl, tex, 0, this.framebuffers);
    if (tex) this.layerTextures.delete(tex);
    this.layers.splice(i, 1);
  }

  /**
   * XRHostBackend.getLayerColorTexture: the layer's texture, pointed at the image the page draws into this frame
   * (acquired now when the XR thread had none for it at the frame's start: a layer created in this frame).
   */
  layerTexture(id: number): object | null {
    const gl = this.gl;
    const hooks = this.hooks;
    if (!gl || !hooks) return null;
    let layer: LayerTexture | null = null;
    for (let i = 0; i < this.layers.length; i++) {
      if (this.layers[i].id === id) layer = this.layers[i];
    }
    if (!layer) return null;
    let name = 0;
    if (this.inFrame) {
      name = this.layerBuffer?.nameOf(id) ?? 0;
      if (name === 0) name = this.natives.acquireLayerImage?.(id) ?? 0;
    }
    if (!layer.tex) {
      layer.tex = hooks.wrapTexture(gl, name, layer.target) as TextureLike;
      this.layerTextures.add(layer.tex);
    } else {
      hooks.retargetTexture(gl, layer.tex, name, this.framebuffers);
    }
    return layer.tex;
  }

  /** Layer textures to this frame's images (begin) or to none (park). */
  private pointLayers(begin: boolean): void {
    const gl = this.gl;
    const hooks = this.hooks;
    const buffer = this.layerBuffer;
    if (!gl || !hooks) return;
    const layers = this.layers;
    for (let i = 0; i < layers.length; i++) {
      const tex = layers[i].tex;
      if (tex === null) continue;
      const name = begin && buffer ? buffer.nameOf(layers[i].id) : 0;
      if (tex._name !== name) {
        hooks.retargetTexture(gl, tex, name, this.framebuffers);
        if (!begin) this.parks++;
      }
    }
  }

  /** The context the page handed to XRWebGLBinding / XRWebGLLayer. */
  noteContext(gl: GLContext): void {
    if (this.gl === gl) return;
    this.gl = gl;
    this.framebuffers.length = 0;
    this.reset();
    this.watchBinds(gl);
    // A framebuffer bound before the binding existed can still get the session's image attached without a new bind.
    const bound = typeof gl.getParameter === 'function' ? gl.getParameter(FRAMEBUFFER_BINDING) : null;
    if (isFramebufferLike(bound)) this.track(bound);
  }

  /** A new swapchain for a new session. */
  onSwapchain(arraySize: number): void {
    this.reset();
    this.arraySize = arraySize;
  }

  onSessionEnd(): void {
    this.reset();
    // every layer swapchain goes with the session
    this.pointLayers(false);
    this.layers.length = 0;
    this.layerTextures.clear();
    this.inFrame = false;
  }

  private reset(): void {
    this.arraySize = 0;
    this.opaque = null;
    this.currentName = 0;
    this.wrapped.clear();
    this.wrappers.clear();
    this.parkedFbs.length = 0;
    this.parkedTextures.length = 0;
    this.parkedNames.length = 0;
  }

  /** XRHostBackend.getOpaqueColorTexture: one texture for the whole session. */
  opaqueTexture(): object | null {
    if (!this.gl || !this.hooks) return null;
    if (!this.opaque) {
      this.opaque = this.hooks.wrapTexture(this.gl, this.currentName, this.arraySize === 1 ? TEXTURE_2D : TEXTURE_2D_ARRAY);
    }
    return this.opaque;
  }

  /** XRHostBackend.wrapTexture (the XRWebGLLayer path): one wrapper per swapchain image. */
  wrap(name: number): object | null {
    if (!this.gl || !this.hooks) return null;
    let t = this.wrapped.get(name);
    if (!t) {
      t = this.hooks.wrapTexture(this.gl, name, TEXTURE_2D);
      this.wrapped.set(name, t);
      this.wrappers.add(t);
    }
    return t;
  }

  /** Before the frame's callbacks: point the opaque texture at this frame's image, re-attach parked layer images. */
  beginFrame(name: number): void {
    this.currentName = name;
    this.inFrame = true;
    this.pointLayers(true);
    const gl = this.gl;
    const hooks = this.hooks;
    if (!gl || !hooks || name === 0) return;  // no image this frame: everything stays parked
    if (this.opaque) hooks.retargetTexture(gl, this.opaque, name, this.framebuffers);
    // XRWebGLLayer: the image detached after the last frame goes back first; IWER then attaches this frame's image
    // when it differs (when the XR thread hands out the same image again, IWER attaches nothing).
    const fbs = this.parkedFbs;
    for (let i = 0; i < fbs.length; i++) {
      if (!gl.isFramebuffer(fbs[i])) continue;
      const tex = this.parkedTextures[i];
      tex._name = 0;  // retargetTexture re-attaches only when the name changes
      this.one[0] = fbs[i];
      hooks.retargetTexture(gl, tex, this.parkedNames[i], this.one);
    }
    this.one.length = 0;
    fbs.length = 0;
    this.parkedTextures.length = 0;
    this.parkedNames.length = 0;
  }

  /** After the frame's last draw (and IWER's own layer work): invalidate, advance epochs, fence, park the image. */
  endFrame(rendered: boolean): void {
    const gl = this.gl;
    const hooks = this.hooks;
    if (gl && hooks) {
      if (this.opaque) {
        const fbs = this.framebuffers;
        for (let i = 0; i < fbs.length; i++) {
          if (attaches(fbs[i], this.opaque)) {
            hooks.invalidateDepthStencil(gl, fbs[i]);
            this.invalidations++;
          }
        }
      }
      hooks.frameBoundary(gl);
    }
    if (rendered && gl) {
      gl._makeCurrent();
      this.natives.endFrameGL();
    }
    this.park();
  }

  /** XR-SC-3: detach the frame's image (in GL only) from every framebuffer that renders into it (file comment). */
  private park(): void {
    this.inFrame = false;
    this.pointLayers(false);
    const gl = this.gl;
    const hooks = this.hooks;
    if (!gl || !hooks) return;
    if (this.opaque && (this.opaque as TextureLike)._name !== 0) {
      hooks.retargetTexture(gl, this.opaque, 0, this.framebuffers);
      this.parks++;
    }
    this.currentName = 0;
    if (this.wrappers.size === 0) return;
    const fbs = this.framebuffers;
    for (let i = 0; i < fbs.length; i++) {
      const fb = fbs[i];
      const object = colorAttachment(fb);
      if (object === undefined || !this.wrappers.has(object as object)) continue;
      const tex = object as TextureLike;
      const texName = tex._name;
      if (texName === 0) continue;
      this.one[0] = fb;
      hooks.retargetTexture(gl, tex, 0, this.one);  // GL: the attachment is detached (the wrapper's name set to 0) ...
      tex._name = texName;                          // ... while the binding keeps the wrapper and its name
      this.parkedFbs.push(fb);
      this.parkedTextures.push(tex);
      this.parkedNames.push(texName);
      this.parks++;
    }
    this.one.length = 0;
  }

  /** Records the framebuffers the session's context binds (see the file comment). */
  private watchBinds(gl: GLContext): void {
    const bind = gl.bindFramebuffer;
    const list = this.framebuffers;
    const self = this;
    Object.defineProperty(gl, 'bindFramebuffer', {
      configurable: true,
      writable: true,
      enumerable: false,
      value: function bindFramebuffer(this: GLContext, target: number, framebuffer: object | null) {
        // only framebuffer objects (the binding itself rejects anything else)
        if (isFramebufferLike(framebuffer) && list.indexOf(framebuffer) < 0) self.track(framebuffer);
        return bind.call(this, target, framebuffer);
      },
    });
  }

  private track(fb: object): void {
    const list = this.framebuffers;
    if (list.length >= MAX_TRACKED_FRAMEBUFFERS) {
      // drop deleted framebuffers first, then the oldest that holds no session image (file comment); when every one
      // holds it (never in practice), the list grows instead
      for (let i = list.length - 1; i >= 0; i--) {
        if (this.gl && !this.gl.isFramebuffer(list[i])) list.splice(i, 1);
      }
      if (list.length >= MAX_TRACKED_FRAMEBUFFERS) {
        for (let i = 0; i < list.length; i++) {
          if (!this.holdsSessionImage(list[i])) {
            list.splice(i, 1);
            break;
          }
        }
      }
    }
    list.push(fb);
  }

  /** Whether any attachment of `fb` is the opaque texture, an XRWebGLLayer image or a layer texture (no allocation). */
  private holdsSessionImage(fb: object): boolean {
    const atts = (fb as FramebufferLike)._attachments;
    if (atts === undefined || (this.opaque === null && this.wrappers.size === 0 && this.layerTextures.size === 0)) {
      return false;
    }
    holdScan.opaque = this.opaque;
    holdScan.wrappers = this.wrappers;
    holdScan.layers = this.layerTextures;
    holdScan.found = false;
    atts.forEach(holdVisit);
    holdScan.opaque = null;
    holdScan.wrappers = null;
    holdScan.layers = null;
    return holdScan.found;
  }
}

// Scratch state for holdsSessionImage's Map.forEach (a hoisted callback allocates nothing per call).
const holdScan: {
  opaque: object | null;
  wrappers: Set<object> | null;
  layers: Set<object> | null;
  found: boolean;
} = {
  opaque: null,
  wrappers: null,
  layers: null,
  found: false,
};
function holdVisit(a: { object: unknown }): void {
  const o = a.object;
  if (
    o !== null &&
    (o === holdScan.opaque ||
      (holdScan.wrappers !== null && holdScan.wrappers.has(o as object)) ||
      (holdScan.layers !== null && holdScan.layers.has(o as object)))
  ) {
    holdScan.found = true;
  }
}

const COLOR_ATTACHMENT0 = 0x8ce0;

/** A WebGL binding framebuffer object (has the record of its attachments). */
function isFramebufferLike(fb: unknown): fb is object {
  if (typeof fb !== 'object' || fb === null) return false;
  const atts = (fb as FramebufferLike)._attachments;
  return typeof atts === 'object' && atts !== null && typeof atts.forEach === 'function';
}

/** Whether `fb` renders into the opaque texture (colour attachment 0; a Map lookup, no iterator per frame). */
function attaches(fb: object, tex: object): boolean {
  const atts = (fb as FramebufferLike)._attachments;
  return atts !== undefined && atts.get(COLOR_ATTACHMENT0)?.object === tex;
}

/** The object attached at colour attachment 0 of `fb` in the WebGL binding's record, if any. */
function colorAttachment(fb: object): unknown {
  return (fb as FramebufferLike)._attachments?.get(COLOR_ATTACHMENT0)?.object;
}
