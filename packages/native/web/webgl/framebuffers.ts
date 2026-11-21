/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Framebuffers and renderbuffers: attachment tracking (GL-5 getters, GL-24 multiview views, feedback loops),
// the emulated default framebuffer (BACK -> COLOR_ATTACHMENT0 of the backing FBO), drawBuffers/readBuffer
// rules, readPixels with WebGL's out-of-bounds rule, clears, blits, invalidation, multiview attachments
// (OVR_multiview2 / OCULUS_multiview) and multisampled-render-to-texture.

import type { Ctx } from './core.ts';
import * as E from './gen/enums.gen.ts';
import {
  imageByteSize,
  viewKind,
  viewMatchesType,
  type PixelStore,
} from './formats.ts';
import {
  INTERNAL,
  WebGLFramebuffer,
  WebGLObject,
  WebGLRenderbuffer,
  WebGLTexture,
  type Attachment,
} from './objects.ts';
import {
  PS_PACK_ALIGNMENT,
  PS_PACK_ROW_LENGTH,
  PS_PACK_SKIP_PIXELS,
  PS_PACK_SKIP_ROWS,
} from './state.ts';
import { f32List, i32List, isView, materialize, u32List } from './views.ts';

/** GLES enum used by getInternalformatParameter (not a WebGL constant). */
const GL_NUM_SAMPLE_COUNTS = 0x9380;

const packPs: PixelStore = {
  alignment: 4,
  rowLength: 0,
  imageHeight: 0,
  skipPixels: 0,
  skipRows: 0,
  skipImages: 0,
};

function fbTargetOk(ctx: Ctx, target: number): boolean {
  return (
    target === E.FRAMEBUFFER ||
    (ctx._v2 &&
      (target === E.DRAW_FRAMEBUFFER || target === E.READ_FRAMEBUFFER))
  );
}

/** Framebuffer bound to `target` (null = default), undefined for an invalid target. */
function fbFor(ctx: Ctx, target: number): WebGLFramebuffer | null | undefined {
  if (target === E.FRAMEBUFFER || target === E.DRAW_FRAMEBUFFER)
    return fbTargetOk(ctx, target) ? ctx._drawFbo : undefined;
  if (target === E.READ_FRAMEBUFFER && ctx._v2) return ctx._readFbo;
  return undefined;
}

function attachmentOk(ctx: Ctx, att: number): boolean {
  if (
    att === E.DEPTH_ATTACHMENT ||
    att === E.STENCIL_ATTACHMENT ||
    att === E.DEPTH_STENCIL_ATTACHMENT
  )
    return true;
  const i = att - E.COLOR_ATTACHMENT0;
  if (i === 0) return true;
  if (i > 0 && i < 16) {
    return (
      (ctx._v2 || ctx._extensions.has('WEBGL_draw_buffers')) &&
      i < ctx._maxColorAttachments
    );
  }
  return false;
}

/** Internal format of the read framebuffer's read buffer (default framebuffer: RGBA8 / RGB8 by `alpha`). */
export function readBufferFormat(ctx: Ctx): number {
  const r = ctx._readFbo;
  if (r === null) return ctx._attrs.alpha ? E.RGBA8 : E.RGB8;
  const a = r._attachments.get(r._readBuffer);
  return a ? attachmentFormat(a) : 0;
}

export function attachmentFormat(a: Attachment): number {
  if (a.object instanceof WebGLRenderbuffer) return a.object._internalformat;
  return a.object._level0 ? a.object._level0.internalformat : 0;
}

function recompute(fb: WebGLFramebuffer): void {
  let views = 0;
  let texCount = 0;
  const gated: number[] = [];
  for (const [att, a] of fb._attachments) {
    if (a.numViews && !views) views = a.numViews;
    if (a.object instanceof WebGLTexture) texCount++;
    if (att >= E.COLOR_ATTACHMENT0 && att < E.COLOR_ATTACHMENT0 + 16) {
      const f = attachmentFormat(a);
      if (RENDER_EXT[f] !== undefined) gated.push(f);
    }
  }
  fb._numViews = views;
  fb._texAttachments = texCount;
  fb._gatedFormats = gated;
  fb._has32F = gated.some(
    (f) => f === E.R32F || f === E.RG32F || f === E.RGBA32F,
  );
  let e5 = 0;
  for (const [att, a] of fb._attachments) {
    if (
      att >= E.COLOR_ATTACHMENT0 &&
      att < E.COLOR_ATTACHMENT0 + 16 &&
      attachmentFormat(a) === E.RGB9_E5
    )
      e5 |= 1 << (att - E.COLOR_ATTACHMENT0);
  }
  fb._rgb9e5 = e5;
  // WebGL 2.0 §5.?: depth and stencil attachments must be the same image when both are present.
  const d = fb._attachments.get(E.DEPTH_ATTACHMENT);
  const s = fb._attachments.get(E.STENCIL_ATTACHMENT);
  fb._webglStatus =
    d &&
    s &&
    (d.object !== s.object || d.level !== s.level || d.layer !== s.layer)
      ? E.FRAMEBUFFER_UNSUPPORTED
      : 0;
  // WebGL 2.0 §5.? : one image attached to more than one colour attachment point is FRAMEBUFFER_UNSUPPORTED
  if (!fb._webglStatus) {
    const seen: Attachment[] = [];
    for (const [att, a] of fb._attachments) {
      if (att < E.COLOR_ATTACHMENT0 || att >= E.COLOR_ATTACHMENT0 + 16)
        continue;
      for (const b of seen) {
        if (
          b.object === a.object &&
          b.level === a.level &&
          b.layer === a.layer &&
          b.textarget === a.textarget
        ) {
          fb._webglStatus = E.FRAMEBUFFER_UNSUPPORTED;
        }
      }
      seen.push(a);
    }
  }
}

/**
 * WEBGL_render_shared_exponent: drawing or clearing an enabled RGB9_E5 draw buffer whose colour mask is neither all
 * on nor all off is INVALID_OPERATION. `only` limits the check to one draw buffer (clearBuffer*).
 */
export function sharedExponentMaskConflict(
  ctx: Ctx,
  fb: WebGLFramebuffer,
  only = -1,
): boolean {
  const bits = fb._rgb9e5 & ctx._bufMaskPartial;
  if (bits === 0) return false;
  for (let i = 0; i < 16; i++) {
    if ((bits & (1 << i)) === 0 || (only >= 0 && i !== only)) continue;
    if (fb._drawBuffers[i] === E.COLOR_ATTACHMENT0 + i) return true;
  }
  return false;
}

/** Colour formats that are renderable only with one of the listed extensions enabled (and never if empty). */
const RENDER_EXT: Record<number, readonly string[]> = {
  [E.R16F]: ['EXT_color_buffer_float', 'EXT_color_buffer_half_float'],
  [E.RG16F]: ['EXT_color_buffer_float', 'EXT_color_buffer_half_float'],
  [E.RGBA16F]: ['EXT_color_buffer_float', 'EXT_color_buffer_half_float'],
  [E.R32F]: ['EXT_color_buffer_float'],
  [E.RG32F]: ['EXT_color_buffer_float'],
  [E.RGBA32F]: ['EXT_color_buffer_float', 'WEBGL_color_buffer_float'],
  [E.R11F_G11F_B10F]: ['EXT_color_buffer_float'],
  [E.RGB9_E5]: ['WEBGL_render_shared_exponent'],
  [E.RGB16F]: [], // not renderable in WebGL 2 with or without EXT_color_buffer_half_float
  [E.RGB32F]: [],
  [E.R8_SNORM]: ['EXT_render_snorm'],
  [E.RG8_SNORM]: ['EXT_render_snorm'],
  [E.RGBA8_SNORM]: ['EXT_render_snorm'],
  [E.RGB8_SNORM]: [],
  // never colour-renderable in GLES 3.0 / WebGL 2, although some drivers (Adreno) report them complete
  [E.SRGB8]: [],
  [E.RGB8I]: [],
  [E.RGB8UI]: [],
  [E.RGB16I]: [],
  [E.RGB16UI]: [],
  [E.RGB32I]: [],
  [E.RGB32UI]: [],
  [0x822a]: ['EXT_texture_norm16'], // R16_EXT
  [0x822c]: ['EXT_texture_norm16'], // RG16_EXT
  [0x805b]: ['EXT_texture_norm16'], // RGBA16_EXT
  [0x8054]: [], // RGB16_EXT
  [0x8f98]: [], // R16_SNORM_EXT (never renderable)
  [0x8f99]: [], // RG16_SNORM_EXT
  [0x8f9a]: [], // RGB16_SNORM_EXT
  [0x8f9b]: [], // RGBA16_SNORM_EXT
};

/** 'i' signed integer, 'u' unsigned integer, 'f' anything else (normalized / float). */
export function formatClass(f: number): 'f' | 'i' | 'u' {
  switch (f) {
    case E.R8I:
    case E.R16I:
    case E.R32I:
    case E.RG8I:
    case E.RG16I:
    case E.RG32I:
    case E.RGB8I:
    case E.RGB16I:
    case E.RGB32I:
    case E.RGBA8I:
    case E.RGBA16I:
    case E.RGBA32I:
      return 'i';
    case E.R8UI:
    case E.R16UI:
    case E.R32UI:
    case E.RG8UI:
    case E.RG16UI:
    case E.RG32UI:
    case E.RGB8UI:
    case E.RGB16UI:
    case E.RGB32UI:
    case E.RGBA8UI:
    case E.RGBA16UI:
    case E.RGBA32UI:
    case E.RGB10_A2UI:
      return 'u';
    default:
      return 'f';
  }
}

/** WebGL completeness on top of the driver's (0 = complete as far as WebGL is concerned). */
export function webglFramebufferStatus(ctx: Ctx, fb: WebGLFramebuffer): number {
  if (fb._webglStatus) return fb._webglStatus;
  for (const f of fb._gatedFormats) {
    const exts = RENDER_EXT[f];
    if (!exts.some((n) => ctx._extensions.has(n)))
      return E.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
  }
  if (!ctx._v2) return webgl1Status(fb);
  // WebGL 2.0 §5.? (differs from GLES 3): attached images of different sizes are FRAMEBUFFER_INCOMPLETE_DIMENSIONS
  const sizes = sizeStatus(fb);
  if (sizes) return sizes;
  // OVR_multiview2: every multiview attachment must have the same views
  let views = -1;
  let base = -1;
  for (const a of fb._attachments.values()) {
    if (views < 0) {
      views = a.numViews;
      base = a.baseViewIndex;
    } else if (
      a.numViews !== views ||
      (views > 0 && a.baseViewIndex !== base)
    ) {
      return E.FRAMEBUFFER_INCOMPLETE_VIEW_TARGETS_OVR;
    }
  }
  return 0;
}

/** WebGL 1.0 §6.6: depth/stencil attachment formats, one depth-ish attachment point, equal sizes. */
function webgl1Status(fb: WebGLFramebuffer): number {
  const ds = fb._v1Points.get(E.DEPTH_STENCIL_ATTACHMENT);
  const d = fb._v1Points.get(E.DEPTH_ATTACHMENT);
  const s = fb._v1Points.get(E.STENCIL_ATTACHMENT);
  if (ds) {
    if ((d && d.object !== ds.object) || (s && s.object !== ds.object))
      return E.FRAMEBUFFER_UNSUPPORTED;
    const f = attachmentFormat(ds);
    if (f !== E.DEPTH_STENCIL && f !== E.DEPTH24_STENCIL8)
      return E.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
  } else {
    if (d && s && d.object !== s.object) return E.FRAMEBUFFER_UNSUPPORTED;
    if (d) {
      const f = attachmentFormat(d);
      if (
        f !== E.DEPTH_COMPONENT16 &&
        f !== E.DEPTH_COMPONENT &&
        f !== E.DEPTH_COMPONENT24
      )
        return E.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
    }
    if (s && attachmentFormat(s) !== E.STENCIL_INDEX8)
      return E.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
  }
  return sizeStatus(fb);
}

/** Zero-sized images are attachment-incomplete; images of different sizes are INCOMPLETE_DIMENSIONS in WebGL. */
function sizeStatus(fb: WebGLFramebuffer): number {
  let w = -1;
  let h = -1;
  let dims = false;
  for (const a of fb._attachments.values()) {
    const sz = attachmentSize(a);
    if (!sz) {
      // GLES 3.0 §4.4.4.1: a texture with no image at all is attachment-incomplete (Adreno answers
      // MISSING_ATTACHMENT; CTS framebuffer-completeness-draw-framebuffer). Host-owned textures have no records.
      if (
        a.object instanceof WebGLTexture &&
        !a.object._external &&
        a.object._levels.size === 0
      ) {
        return E.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
      }
      continue;
    }
    if (sz[0] === 0 || sz[1] === 0) return E.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
    if (w < 0) {
      w = sz[0];
      h = sz[1];
    } else if (sz[0] !== w || sz[1] !== h) {
      dims = true;
    }
  }
  return dims ? E.FRAMEBUFFER_INCOMPLETE_DIMENSIONS : 0;
}

function attachmentSize(a: Attachment): [number, number] | null {
  if (a.object instanceof WebGLRenderbuffer)
    return [a.object._width, a.object._height];
  const l = a.object._levels.get(a.level);
  return l ? [l.width, l.height] : null;
}

/**
 * Cached framebuffer verdict (0 = complete, else a FRAMEBUFFER_* status): WebGL's own rules first, then the
 * driver's glCheckFramebufferStatus, asked once per change (attachments, attached images, extensions), never
 * per draw.
 */
export function framebufferVerdict(
  ctx: Ctx,
  fb: WebGLFramebuffer,
  target: number,
): number {
  if (fb._opaque) return 0;
  if (fb._verdictEpoch === ctx._fbEpoch) return fb._verdict;
  recompute(fb);
  let v = webglFramebufferStatus(ctx, fb);
  if (!v) {
    const s = ctx._n.checkFramebufferStatus(target);
    v = s === E.FRAMEBUFFER_COMPLETE ? 0 : s;
  }
  fb._verdict = v;
  fb._verdictEpoch = ctx._fbEpoch;
  return v;
}

function setAttachment(
  ctx: Ctx,
  fb: WebGLFramebuffer,
  att: number,
  a: Attachment | null,
  target = E.FRAMEBUFFER,
): void {
  if (!ctx._v2 && isDepthStencilPoint(att)) {
    if (a) fb._v1Points.set(att, a);
    else fb._v1Points.delete(att);
    syncV1DepthStencil(ctx, fb, target);
  } else {
    const keys =
      att === E.DEPTH_STENCIL_ATTACHMENT
        ? [E.DEPTH_ATTACHMENT, E.STENCIL_ATTACHMENT]
        : [att];
    for (const k of keys) putAttachment(fb, k, a);
  }
  recompute(fb);
  ctx._fbEpoch++;
  ctx._feedbackDirty = true;
  ctx._texDirty = true;
}

function isDepthStencilPoint(att: number): boolean {
  return (
    att === E.DEPTH_ATTACHMENT ||
    att === E.STENCIL_ATTACHMENT ||
    att === E.DEPTH_STENCIL_ATTACHMENT
  );
}

function putAttachment(
  fb: WebGLFramebuffer,
  k: number,
  a: Attachment | null | undefined,
): void {
  const old = fb._attachments.get(k);
  if (old === a) return;
  if (old && old.object instanceof WebGLTexture) old.object._attachCount--;
  if (a) {
    fb._attachments.set(k, a);
    if (a.object instanceof WebGLTexture) a.object._attachCount++;
  } else {
    fb._attachments.delete(k);
  }
}

/**
 * WebGL 1: derive the driver's DEPTH / STENCIL attachments from the three WebGL points (DEPTH_STENCIL, when set,
 * occupies both) and attach them natively, so detaching one point restores the other (framebuffer-object-attachment).
 */
function syncV1DepthStencil(
  ctx: Ctx,
  fb: WebGLFramebuffer,
  target: number,
): void {
  const ds = fb._v1Points.get(E.DEPTH_STENCIL_ATTACHMENT);
  const d = ds ?? fb._v1Points.get(E.DEPTH_ATTACHMENT);
  const s = ds ?? fb._v1Points.get(E.STENCIL_ATTACHMENT);
  putAttachment(fb, E.DEPTH_STENCIL_ATTACHMENT, ds);
  for (const [k, a] of [
    [E.DEPTH_ATTACHMENT, d],
    [E.STENCIL_ATTACHMENT, s],
  ] as const) {
    putAttachment(fb, k, a);
    if (!a) ctx._n.framebufferRenderbuffer(target, k, E.RENDERBUFFER, 0);
    else if (a.object instanceof WebGLRenderbuffer)
      ctx._n.framebufferRenderbuffer(target, k, E.RENDERBUFFER, a.object._name);
    else
      ctx._n.framebufferTexture2D(
        target,
        k,
        a.textarget,
        a.object._name,
        a.level,
      );
  }
}

function translateDefaultAttachment(att: number): number {
  switch (att) {
    case E.BACK:
    case E.COLOR:
      return E.COLOR_ATTACHMENT0;
    case E.DEPTH:
      return E.DEPTH_ATTACHMENT;
    case E.STENCIL:
      return E.STENCIL_ATTACHMENT;
    default:
      return -1;
  }
}

export const framebufferMethods = {
  createFramebuffer(this: Ctx): WebGLFramebuffer | null {
    if (this._skip()) return null;
    const f = new WebGLFramebuffer(INTERNAL, this, this._n.genFramebuffer());
    this._track(f);
    return f;
  },
  isFramebuffer(this: Ctx, fb: unknown): boolean {
    if (this._lost || fb === null || fb === undefined) return false;
    if (!(fb instanceof WebGLFramebuffer))
      throw new TypeError('isFramebuffer: argument is not a WebGLFramebuffer');
    return (
      fb._ctx === this && fb._gen === this._gen && !fb._deleted && fb._bound
    );
  },
  deleteFramebuffer(this: Ctx, fb: unknown): void {
    if (this._skip()) return;
    if (!this._owned(fb, WebGLFramebuffer, 'deleteFramebuffer')) return;
    const f = fb as WebGLFramebuffer;
    if (f._deleted || f._opaque) return;
    f._deleted = true;
    for (const a of f._attachments.values())
      if (a.object instanceof WebGLTexture) a.object._attachCount--;
    f._attachments.clear();
    f._v1Points.clear();
    const wasDraw = this._drawFbo === f;
    const wasRead = this._readFbo === f;
    if (wasDraw) this._drawFbo = null;
    if (wasRead) this._readFbo = null;
    this._untrack(f);
    this._n.deleteFramebuffer(f._name);
    // GL reverts to framebuffer 0; ours is the emulated default framebuffer.
    if (wasDraw || wasRead) this._restoreFramebufferBindings();
    this._feedbackDirty = true;
    this._texDirty = true;
  },
  bindFramebuffer(
    this: Ctx,
    target: number,
    fb: WebGLFramebuffer | null,
  ): void {
    if (this._skip()) return;
    target >>>= 0;
    if (!this._ok(fb, WebGLFramebuffer, true, 'bindFramebuffer')) return;
    if (!fbTargetOk(this, target))
      return this._e(E.INVALID_ENUM, 'bindFramebuffer');
    const f = fb ?? null;
    const name = f ? f._name : this._dfbName;
    if (target === E.FRAMEBUFFER) {
      if (this._drawFbo === f && this._readFbo === f) return;
      this._drawFbo = f;
      this._readFbo = f;
    } else if (target === E.DRAW_FRAMEBUFFER) {
      if (this._drawFbo === f) return;
      this._drawFbo = f;
    } else {
      if (this._readFbo === f) return;
      this._readFbo = f;
    }
    if (f) f._bound = true;
    if (target !== E.READ_FRAMEBUFFER) this._feedbackDirty = true;
    this._texDirty = true;
    this._n.bindFramebuffer(target, name);
  },
  framebufferTexture2D(
    this: Ctx,
    target: number,
    attachment: number,
    textarget: number,
    texture: WebGLTexture | null,
    level: number,
  ): void {
    if (this._skip()) return;
    target >>>= 0;
    attachment >>>= 0;
    textarget >>>= 0;
    level |= 0;
    if (!this._ok(texture, WebGLTexture, true, 'framebufferTexture2D')) return;
    const fb = fbFor(this, target);
    if (fb === undefined || !attachmentOk(this, attachment))
      return this._e(E.INVALID_ENUM, 'framebufferTexture2D');
    const cube =
      textarget >= E.TEXTURE_CUBE_MAP_POSITIVE_X &&
      textarget <= E.TEXTURE_CUBE_MAP_NEGATIVE_Z;
    if (textarget !== E.TEXTURE_2D && !cube)
      return this._e(E.INVALID_ENUM, 'framebufferTexture2D');
    if (fb === null || fb._opaque)
      return this._e(E.INVALID_OPERATION, 'framebufferTexture2D');
    const t = texture ?? null;
    if (t) {
      if (t._target !== (cube ? E.TEXTURE_CUBE_MAP : E.TEXTURE_2D))
        return this._e(E.INVALID_OPERATION, 'framebufferTexture2D');
      if (level < 0) return this._e(E.INVALID_VALUE, 'framebufferTexture2D');
      if (!this._v2 && level !== 0)
        return this._e(E.INVALID_VALUE, 'framebufferTexture2D');
    }
    const v1ds = !this._v2 && isDepthStencilPoint(attachment);
    if (v1ds) {
      // (setAttachment attaches the WebGL 1 depth/stencil points)
    } else if (attachment === E.DEPTH_STENCIL_ATTACHMENT) {
      this._n.framebufferTexture2D(
        target,
        E.DEPTH_ATTACHMENT,
        textarget,
        t ? t._name : 0,
        level,
      );
      this._n.framebufferTexture2D(
        target,
        E.STENCIL_ATTACHMENT,
        textarget,
        t ? t._name : 0,
        level,
      );
    } else {
      this._n.framebufferTexture2D(
        target,
        attachment,
        textarget,
        t ? t._name : 0,
        level,
      );
    }
    setAttachment(
      this,
      fb,
      attachment,
      t
        ? {
            object: t,
            textarget,
            level,
            layer: 0,
            numViews: 0,
            baseViewIndex: 0,
            samples: 0,
          }
        : null,
      target,
    );
  },
  framebufferTextureLayer(
    this: Ctx,
    target: number,
    attachment: number,
    texture: WebGLTexture | null,
    level: number,
    layer: number,
  ): void {
    if (this._skip()) return;
    target >>>= 0;
    attachment >>>= 0;
    level |= 0;
    layer |= 0;
    if (!this._ok(texture, WebGLTexture, true, 'framebufferTextureLayer'))
      return;
    const fb = fbFor(this, target);
    if (fb === undefined || !attachmentOk(this, attachment))
      return this._e(E.INVALID_ENUM, 'framebufferTextureLayer');
    if (fb === null || fb._opaque)
      return this._e(E.INVALID_OPERATION, 'framebufferTextureLayer');
    const t = texture ?? null;
    if (t) {
      if (t._target !== E.TEXTURE_2D_ARRAY && t._target !== E.TEXTURE_3D)
        return this._e(E.INVALID_OPERATION, 'framebufferTextureLayer');
      if (level < 0 || layer < 0)
        return this._e(E.INVALID_VALUE, 'framebufferTextureLayer');
    }
    this._n.framebufferTextureLayer(
      target,
      attachment,
      t ? t._name : 0,
      level,
      layer,
    );
    setAttachment(
      this,
      fb,
      attachment,
      t
        ? {
            object: t,
            textarget: t._target,
            level,
            layer,
            numViews: 0,
            baseViewIndex: 0,
            samples: 0,
          }
        : null,
    );
  },
  framebufferRenderbuffer(
    this: Ctx,
    target: number,
    attachment: number,
    rbtarget: number,
    rb: WebGLRenderbuffer | null,
  ): void {
    if (this._skip()) return;
    target >>>= 0;
    attachment >>>= 0;
    rbtarget >>>= 0;
    if (!this._ok(rb, WebGLRenderbuffer, true, 'framebufferRenderbuffer'))
      return;
    const fb = fbFor(this, target);
    if (
      fb === undefined ||
      !attachmentOk(this, attachment) ||
      rbtarget !== E.RENDERBUFFER
    ) {
      return this._e(E.INVALID_ENUM, 'framebufferRenderbuffer');
    }
    if (fb === null || fb._opaque)
      return this._e(E.INVALID_OPERATION, 'framebufferRenderbuffer');
    const r = rb ?? null;
    // WebGL (like GLES 3): a renderbuffer must have been bound once before it can be attached
    if (r && !r._bound)
      return this._e(E.INVALID_OPERATION, 'framebufferRenderbuffer');
    // DEPTH_STENCIL_ATTACHMENT is "attach to both" (GLES 3.0 §4.4.2); issued as two calls so drivers that apply
    // desktop GL's depth+stencil format check at attach time (Mesa) do not raise an error WebGL does not have.
    if (!this._v2 && isDepthStencilPoint(attachment)) {
      // (setAttachment attaches the WebGL 1 depth/stencil points)
    } else if (attachment === E.DEPTH_STENCIL_ATTACHMENT) {
      this._n.framebufferRenderbuffer(
        target,
        E.DEPTH_ATTACHMENT,
        rbtarget,
        r ? r._name : 0,
      );
      this._n.framebufferRenderbuffer(
        target,
        E.STENCIL_ATTACHMENT,
        rbtarget,
        r ? r._name : 0,
      );
    } else {
      this._n.framebufferRenderbuffer(
        target,
        attachment,
        rbtarget,
        r ? r._name : 0,
      );
    }
    setAttachment(
      this,
      fb,
      attachment,
      r
        ? {
            object: r,
            textarget: 0,
            level: 0,
            layer: 0,
            numViews: 0,
            baseViewIndex: 0,
            samples: 0,
          }
        : null,
      target,
    );
  },
  checkFramebufferStatus(this: Ctx, target: number): number {
    if (this._skip()) return 0;
    target >>>= 0;
    const fb = fbFor(this, target);
    if (fb === undefined) {
      this._e(E.INVALID_ENUM, 'checkFramebufferStatus');
      return 0;
    }
    if (fb === null) {
      this._ensureDefaultFramebuffer();
      return E.FRAMEBUFFER_COMPLETE;
    }
    return (
      framebufferVerdict(
        this,
        fb,
        target === E.READ_FRAMEBUFFER ? E.READ_FRAMEBUFFER : E.DRAW_FRAMEBUFFER,
      ) || E.FRAMEBUFFER_COMPLETE
    );
  },
  getFramebufferAttachmentParameter(
    this: Ctx,
    target: number,
    attachment: number,
    pname: number,
  ): unknown {
    if (this._skip()) return null;
    target >>>= 0;
    attachment >>>= 0;
    pname >>>= 0;
    const fb = fbFor(this, target);
    if (fb === undefined) {
      this._e(E.INVALID_ENUM, 'getFramebufferAttachmentParameter');
      return null;
    }
    if (fb === null) {
      // default framebuffer (WebGL 2): BACK, DEPTH, STENCIL
      if (!this._v2) {
        this._e(E.INVALID_OPERATION, 'getFramebufferAttachmentParameter');
        return null;
      }
      const mapped = translateDefaultAttachment(attachment);
      if (mapped < 0 || attachment === E.COLOR) {
        this._e(E.INVALID_ENUM, 'getFramebufferAttachmentParameter');
        return null;
      }
      this._ensureDefaultFramebuffer();
      const present =
        mapped === E.COLOR_ATTACHMENT0 ||
        (mapped === E.DEPTH_ATTACHMENT
          ? this._attrs.depth
          : this._attrs.stencil);
      if (pname === E.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE)
        return present ? E.FRAMEBUFFER_DEFAULT : E.NONE;
      if (!present) {
        this._e(E.INVALID_OPERATION, 'getFramebufferAttachmentParameter');
        return null;
      }
      return queryAttachment(this, target, mapped, pname, true);
    }
    if (!attachmentOk(this, attachment)) {
      this._e(E.INVALID_ENUM, 'getFramebufferAttachmentParameter');
      return null;
    }
    let a: Attachment | undefined;
    if (attachment === E.DEPTH_STENCIL_ATTACHMENT && this._v2) {
      const d = fb._attachments.get(E.DEPTH_ATTACHMENT);
      const s = fb._attachments.get(E.STENCIL_ATTACHMENT);
      if ((d?.object ?? null) !== (s?.object ?? null)) {
        this._e(E.INVALID_OPERATION, 'getFramebufferAttachmentParameter');
        return null;
      }
      a = d;
    } else {
      a =
        !this._v2 && isDepthStencilPoint(attachment)
          ? fb._v1Points.get(attachment)
          : fb._attachments.get(attachment);
    }
    switch (pname) {
      case E.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE:
        return a
          ? a.object instanceof WebGLTexture
            ? E.TEXTURE
            : E.RENDERBUFFER
          : E.NONE;
      case E.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME:
        if (!a && !this._v2) break; // WebGL 1: nothing attached -> INVALID_ENUM
        return a ? a.object : null;
    }
    if (!a) {
      if (this._v2 && pname !== E.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE) {
        this._e(E.INVALID_OPERATION, 'getFramebufferAttachmentParameter');
        return null;
      }
      this._e(E.INVALID_ENUM, 'getFramebufferAttachmentParameter');
      return null;
    }
    const isTex = a.object instanceof WebGLTexture;
    switch (pname) {
      case E.FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL:
        if (!isTex) break;
        return a.level;
      case E.FRAMEBUFFER_ATTACHMENT_TEXTURE_CUBE_MAP_FACE:
        if (!isTex) break;
        return a.textarget >= E.TEXTURE_CUBE_MAP_POSITIVE_X &&
          a.textarget <= E.TEXTURE_CUBE_MAP_NEGATIVE_Z
          ? a.textarget
          : 0;
      case E.FRAMEBUFFER_ATTACHMENT_TEXTURE_LAYER:
        if (!isTex || !this._v2) break;
        return a.layer;
      case E.FRAMEBUFFER_ATTACHMENT_TEXTURE_NUM_VIEWS_OVR:
        if (!isTex) break;
        return a.numViews;
      case E.FRAMEBUFFER_ATTACHMENT_TEXTURE_BASE_VIEW_INDEX_OVR:
        if (!isTex) break;
        return a.baseViewIndex;
      case E.FRAMEBUFFER_ATTACHMENT_TEXTURE_SAMPLES_EXT:
        return a.samples;
      default:
        return queryAttachment(this, target, attachment, pname, false);
    }
    this._e(E.INVALID_ENUM, 'getFramebufferAttachmentParameter');
    return null;
  },
  drawBuffers(this: Ctx, buffers: unknown): void {
    if (this._skip()) return;
    const list = u32List(this, buffers, 'drawBuffers');
    const count =
      list === buffers ? list.length : (buffers as ArrayLike<unknown>).length;
    const fb = this._drawFbo;
    if (fb === null) {
      if (count !== 1 || (list[0] !== E.BACK && list[0] !== E.NONE))
        return this._e(E.INVALID_OPERATION, 'drawBuffers');
      if (this._dfbDrawBuffer === list[0]) return;
      this._dfbDrawBuffer = list[0];
      const u = this._u32;
      u[0] = list[0] === E.BACK ? E.COLOR_ATTACHMENT0 : E.NONE;
      this._n.drawBuffers(1, u, 0, 4);
      return;
    }
    if (count > this._maxDrawBuffers)
      return this._e(E.INVALID_VALUE, 'drawBuffers');
    for (let i = 0; i < count; i++) {
      const b = list[i];
      if (b !== E.NONE && b !== E.COLOR_ATTACHMENT0 + i) {
        if (
          b === E.BACK ||
          (b >= E.COLOR_ATTACHMENT0 && b < E.COLOR_ATTACHMENT0 + 16)
        )
          return this._e(E.INVALID_OPERATION, 'drawBuffers');
        return this._e(E.INVALID_ENUM, 'drawBuffers');
      }
    }
    const cur = fb._drawBuffers;
    let same = cur.length === count;
    for (let i = 0; same && i < count; i++) same = cur[i] === list[i];
    if (same) return;
    fb._drawBuffers = Array.from(list.subarray(0, count));
    this._n.drawBuffers(count, list, 0, count * 4);
  },
  readBuffer(this: Ctx, src: number): void {
    if (this._skip()) return;
    src >>>= 0;
    const fb = this._readFbo;
    if (fb === null) {
      if (src !== E.BACK && src !== E.NONE)
        return this._e(E.INVALID_OPERATION, 'readBuffer');
      this._dfbReadBuffer = src;
      this._n.readBuffer(src === E.BACK ? E.COLOR_ATTACHMENT0 : E.NONE);
      return;
    }
    if (
      src !== E.NONE &&
      !(
        src >= E.COLOR_ATTACHMENT0 &&
        src < E.COLOR_ATTACHMENT0 + this._maxColorAttachments
      )
    ) {
      const colorAttachment =
        src >= E.COLOR_ATTACHMENT0 && src <= E.COLOR_ATTACHMENT0 + 31;
      return this._e(
        src === E.BACK || colorAttachment
          ? E.INVALID_OPERATION
          : E.INVALID_ENUM,
        'readBuffer',
      );
    }
    fb._readBuffer = src;
    this._n.readBuffer(src);
  },
  invalidateFramebuffer(this: Ctx, target: number, attachments: unknown): void {
    invalidate(this, target >>> 0, attachments, false, 0, 0, 0, 0);
  },
  invalidateSubFramebuffer(
    this: Ctx,
    target: number,
    attachments: unknown,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    invalidate(
      this,
      target >>> 0,
      attachments,
      true,
      x | 0,
      y | 0,
      width | 0,
      height | 0,
    );
  },
  blitFramebuffer(
    this: Ctx,
    sx0: number,
    sy0: number,
    sx1: number,
    sy1: number,
    dx0: number,
    dy0: number,
    dx1: number,
    dy1: number,
    mask: number,
    filter: number,
  ): void {
    if (this._skip()) return;
    mask >>>= 0;
    filter >>>= 0;
    if (
      mask & ~(E.COLOR_BUFFER_BIT | E.DEPTH_BUFFER_BIT | E.STENCIL_BUFFER_BIT)
    )
      return this._e(E.INVALID_VALUE, 'blitFramebuffer');
    if (filter !== E.NEAREST && filter !== E.LINEAR)
      return this._e(E.INVALID_ENUM, 'blitFramebuffer');
    // Sizes must fit 32-bit signed arithmetic (WebGL 2.0 §5.40, blitFramebuffer).
    const big = (a: number, b: number): boolean =>
      Math.abs((b | 0) - (a | 0)) > 0x7fffffff;
    if (big(sx0, sx1) || big(sy0, sy1) || big(dx0, dx1) || big(dy0, dy1))
      return this._e(E.INVALID_VALUE, 'blitFramebuffer');
    if (this._readFbo === null || this._drawFbo === null)
      this._ensureDefaultFramebuffer();
    if (
      (this._readFbo &&
        framebufferVerdict(this, this._readFbo, E.READ_FRAMEBUFFER)) ||
      (this._drawFbo &&
        framebufferVerdict(this, this._drawFbo, E.DRAW_FRAMEBUFFER))
    ) {
      return this._e(E.INVALID_FRAMEBUFFER_OPERATION, 'blitFramebuffer');
    }
    // OVR_multiview2: blits to a multiview framebuffer, or from one with more than one view, are
    // INVALID_FRAMEBUFFER_OPERATION.
    if (
      (this._drawFbo?._numViews ?? 0) > 0 ||
      (this._readFbo?._numViews ?? 0) > 1
    )
      return this._e(E.INVALID_FRAMEBUFFER_OPERATION, 'blitFramebuffer');
    if (blitImagesMissing(this, mask))
      return this._e(E.INVALID_OPERATION, 'blitFramebuffer');
    if ((mask & E.COLOR_BUFFER_BIT) !== 0 && sameColorImage(this))
      return this._e(E.INVALID_OPERATION, 'blitFramebuffer');
    // Colour from or to buffers without an image is a no-op (WebGL 2.0). Adreno's glBlitFramebuffer crashes on
    // enabled draw buffers that have no image (CTS read-draw-when-missing-image): keep them away from the driver.
    const d = this._drawFbo;
    let holes: Uint32Array | null = null;
    if ((mask & E.COLOR_BUFFER_BIT) !== 0) {
      if (missingReadImage(this)) {
        mask &= ~E.COLOR_BUFFER_BIT; // no enabled draw buffer has an image either (checked above)
        if (mask === 0) return;
      } else if (
        d !== null &&
        !d._opaque &&
        d._drawBuffers.some((b) => b !== E.NONE && !d._attachments.has(b))
      ) {
        holes = new Uint32Array(
          d._drawBuffers.map((b) =>
            b !== E.NONE && d._attachments.has(b) ? b : E.NONE,
          ),
        );
        if (holes.every((b) => b === E.NONE)) {
          mask &= ~E.COLOR_BUFFER_BIT;
          holes = null;
          if (mask === 0) return;
        }
      }
    }
    if (holes) this._n.drawBuffers(holes.length, holes, 0, holes.length * 4);
    this._n.blitFramebuffer(
      sx0 | 0,
      sy0 | 0,
      sx1 | 0,
      sy1 | 0,
      dx0 | 0,
      dy0 | 0,
      dx1 | 0,
      dy1 | 0,
      mask,
      filter,
    );
    if (holes && d) {
      const cur = new Uint32Array(d._drawBuffers);
      this._n.drawBuffers(cur.length, cur, 0, cur.length * 4);
    }
  },
  clear(this: Ctx, mask: number): void {
    if (this._skip()) return;
    mask >>>= 0;
    if (
      mask & ~(E.COLOR_BUFFER_BIT | E.DEPTH_BUFFER_BIT | E.STENCIL_BUFFER_BIT)
    )
      return this._e(E.INVALID_VALUE, 'clear');
    const fb = this._drawFbo;
    if (fb === null) {
      this._ensureDefaultFramebuffer();
      this._dfbDrawn = true;
    } else if (framebufferVerdict(this, fb, E.DRAW_FRAMEBUFFER)) {
      return this._e(E.INVALID_FRAMEBUFFER_OPERATION, 'clear');
    } else if (
      fb._numViews > 1 &&
      this._activeQueries.has(E.TIME_ELAPSED_EXT)
    ) {
      return this._e(E.INVALID_OPERATION, 'clear'); // OVR_multiview2 with an active timer query
    } else if ((mask & E.COLOR_BUFFER_BIT) !== 0 && this._v2) {
      // WebGL 2.0 §5.?: clear() cannot clear integer colour buffers (use clearBufferiv/uiv)
      for (const b of fb._drawBuffers) {
        if (b === E.NONE) continue;
        const a = fb._attachments.get(b);
        if (a && formatClass(attachmentFormat(a)) !== 'f')
          return this._e(E.INVALID_OPERATION, 'clear');
      }
      if (fb._rgb9e5 !== 0 && sharedExponentMaskConflict(this, fb))
        return this._e(E.INVALID_OPERATION, 'clear');
    }
    this._n.clear(mask);
  },
  clearBufferfv(
    this: Ctx,
    buffer: number,
    drawbuffer: number,
    values: unknown,
    srcOffset = 0,
  ): void {
    clearBuffer(
      this,
      'f',
      buffer >>> 0,
      drawbuffer | 0,
      values,
      srcOffset >>> 0,
    );
  },
  clearBufferiv(
    this: Ctx,
    buffer: number,
    drawbuffer: number,
    values: unknown,
    srcOffset = 0,
  ): void {
    clearBuffer(
      this,
      'i',
      buffer >>> 0,
      drawbuffer | 0,
      values,
      srcOffset >>> 0,
    );
  },
  clearBufferuiv(
    this: Ctx,
    buffer: number,
    drawbuffer: number,
    values: unknown,
    srcOffset = 0,
  ): void {
    clearBuffer(
      this,
      'u',
      buffer >>> 0,
      drawbuffer | 0,
      values,
      srcOffset >>> 0,
    );
  },
  clearBufferfi(
    this: Ctx,
    buffer: number,
    drawbuffer: number,
    depth: number,
    stencil: number,
  ): void {
    if (this._skip()) return;
    buffer >>>= 0;
    if (buffer !== E.DEPTH_STENCIL)
      return this._e(E.INVALID_ENUM, 'clearBufferfi');
    if ((drawbuffer | 0) !== 0)
      return this._e(E.INVALID_VALUE, 'clearBufferfi');
    if (this._drawFbo === null) this._ensureDefaultFramebuffer();
    this._n.clearBufferfi(buffer, 0, +depth, stencil | 0);
  },
  readPixels(
    this: Ctx,
    x: number,
    y: number,
    width: number,
    height: number,
    format: number,
    type: number,
    dst: unknown,
    dstOffset?: number,
  ): void {
    if (this._skip()) return;
    x |= 0;
    y |= 0;
    width |= 0;
    height |= 0;
    format >>>= 0;
    type >>>= 0;
    if (width < 0 || height < 0) return this._e(E.INVALID_VALUE, 'readPixels');
    const n = this._n;
    if (typeof dst === 'number') {
      if (!this._v2)
        throw new TypeError('readPixels: pixels is not an ArrayBufferView');
      if (dst < 0) return this._e(E.INVALID_VALUE, 'readPixels');
      const ferr = readFormatError(this, format, type);
      if (ferr) return this._e(ferr, 'readPixels');
      const pbo = this._pixelPack;
      if (!pbo) return this._e(E.INVALID_OPERATION, 'readPixels');
      if (
        this._readFbo &&
        framebufferVerdict(this, this._readFbo, E.READ_FRAMEBUFFER)
      )
        return this._e(E.INVALID_FRAMEBUFFER_OPERATION, 'readPixels');
      if (missingReadImage(this))
        return this._e(E.INVALID_OPERATION, 'readPixels');
      const pp = this._ps;
      if (packParamsInvalid(this, width))
        return this._e(E.INVALID_OPERATION, 'readPixels');
      packPs.alignment = pp[PS_PACK_ALIGNMENT];
      packPs.rowLength = pp[PS_PACK_ROW_LENGTH];
      packPs.skipPixels = pp[PS_PACK_SKIP_PIXELS];
      packPs.skipRows = pp[PS_PACK_SKIP_ROWS];
      const needed = imageByteSize(
        width,
        height,
        1,
        format,
        type,
        packPs,
        false,
      );
      if (needed < 0) return this._e(E.INVALID_ENUM, 'readPixels');
      if (dst + needed > pbo._size)
        return this._e(E.INVALID_OPERATION, 'readPixels');
      const restore = this._prepareDefaultRead();
      n.readPixelsOffset(x, y, width, height, format, type, dst);
      if (restore) this._restoreFramebufferBindings();
      return;
    }
    if (dst === null || dst === undefined) {
      if (this._v2) throw new TypeError('readPixels: pixels is null');
      return this._e(E.INVALID_VALUE, 'readPixels');
    }
    if (!isView(dst))
      throw new TypeError('readPixels: pixels is not an ArrayBufferView');
    const ferr = readFormatError(this, format, type);
    if (ferr) return this._e(ferr, 'readPixels');
    if (this._pixelPack) return this._e(E.INVALID_OPERATION, 'readPixels');
    if (!viewMatchesType(viewKind(dst), type))
      return this._e(E.INVALID_OPERATION, 'readPixels');
    if (
      this._readFbo &&
      framebufferVerdict(this, this._readFbo, E.READ_FRAMEBUFFER)
    )
      return this._e(E.INVALID_FRAMEBUFFER_OPERATION, 'readPixels');
    if (missingReadImage(this))
      return this._e(E.INVALID_OPERATION, 'readPixels');
    const p = this._ps;
    if (packParamsInvalid(this, width))
      return this._e(E.INVALID_OPERATION, 'readPixels');
    packPs.alignment = p[PS_PACK_ALIGNMENT];
    packPs.rowLength = p[PS_PACK_ROW_LENGTH];
    packPs.skipPixels = p[PS_PACK_SKIP_PIXELS];
    packPs.skipRows = p[PS_PACK_SKIP_ROWS];
    const need = imageByteSize(width, height, 1, format, type, packPs, false);
    if (need < 0) return this._e(E.INVALID_ENUM, 'readPixels');
    const bpe = (dst as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1;
    const off = ((dstOffset ?? 0) >>> 0) * bpe;
    if (off > dst.byteLength) return this._e(E.INVALID_VALUE, 'readPixels');
    if (need > dst.byteLength - off)
      return this._e(E.INVALID_OPERATION, 'readPixels');
    materialize(dst);
    const restore = this._prepareDefaultRead();
    const [rw, rh] = this._readSize();
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(rw, x + width);
    const y1 = Math.min(rh, y + height);
    if (x0 === x && y0 === y && x1 === x + width && y1 === y + height) {
      n.readPixels(x, y, width, height, format, type, dst, off, need);
    } else if (x1 > x0 && y1 > y0) {
      // Pixels outside the framebuffer leave the destination untouched: read only the overlap, addressed
      // inside the full rectangle through PACK_ROW_LENGTH / SKIP_*.
      const rowLength =
        p[PS_PACK_ROW_LENGTH] > 0 ? p[PS_PACK_ROW_LENGTH] : width;
      n.pixelStorei(E.PACK_ROW_LENGTH, rowLength);
      n.pixelStorei(E.PACK_SKIP_PIXELS, p[PS_PACK_SKIP_PIXELS] + (x0 - x));
      n.pixelStorei(E.PACK_SKIP_ROWS, p[PS_PACK_SKIP_ROWS] + (y0 - y));
      n.readPixels(
        x0,
        y0,
        x1 - x0,
        y1 - y0,
        format,
        type,
        dst,
        off,
        dst.byteLength - off,
      );
      n.pixelStorei(E.PACK_ROW_LENGTH, p[PS_PACK_ROW_LENGTH]);
      n.pixelStorei(E.PACK_SKIP_PIXELS, p[PS_PACK_SKIP_PIXELS]);
      n.pixelStorei(E.PACK_SKIP_ROWS, p[PS_PACK_SKIP_ROWS]);
    }
    if (restore) this._restoreFramebufferBindings();
  },

  // ---------------------------------------------------------------------------------------------- renderbuffers
  createRenderbuffer(this: Ctx): WebGLRenderbuffer | null {
    if (this._skip()) return null;
    const r = new WebGLRenderbuffer(INTERNAL, this, this._n.genRenderbuffer());
    this._track(r);
    return r;
  },
  isRenderbuffer(this: Ctx, rb: unknown): boolean {
    if (this._lost || rb === null || rb === undefined) return false;
    if (!(rb instanceof WebGLRenderbuffer))
      throw new TypeError(
        'isRenderbuffer: argument is not a WebGLRenderbuffer',
      );
    return (
      rb._ctx === this && rb._gen === this._gen && !rb._deleted && rb._bound
    );
  },
  deleteRenderbuffer(this: Ctx, rb: unknown): void {
    if (this._skip()) return;
    if (!this._owned(rb, WebGLRenderbuffer, 'deleteRenderbuffer')) return;
    const r = rb as WebGLRenderbuffer;
    if (r._deleted) return;
    r._deleted = true;
    if (this._renderbuffer === r) this._renderbuffer = null;
    this._detachFromBound(r);
    this._untrack(r);
    this._n.deleteRenderbuffer(r._name);
  },
  bindRenderbuffer(
    this: Ctx,
    target: number,
    rb: WebGLRenderbuffer | null,
  ): void {
    if (this._skip()) return;
    target >>>= 0;
    if (!this._ok(rb, WebGLRenderbuffer, true, 'bindRenderbuffer')) return;
    if (target !== E.RENDERBUFFER)
      return this._e(E.INVALID_ENUM, 'bindRenderbuffer');
    const r = rb ?? null;
    if (this._renderbuffer === r) return;
    this._renderbuffer = r;
    if (r) r._bound = true;
    this._n.bindRenderbuffer(target, r ? r._name : 0);
  },
  renderbufferStorage(
    this: Ctx,
    target: number,
    internalformat: number,
    width: number,
    height: number,
  ): void {
    storage(
      this,
      target >>> 0,
      0,
      internalformat >>> 0,
      width | 0,
      height | 0,
      'renderbufferStorage',
    );
  },
  renderbufferStorageMultisample(
    this: Ctx,
    target: number,
    samples: number,
    internalformat: number,
    width: number,
    height: number,
  ): void {
    storage(
      this,
      target >>> 0,
      samples | 0,
      internalformat >>> 0,
      width | 0,
      height | 0,
      'renderbufferStorageMultisample',
    );
  },
  getRenderbufferParameter(this: Ctx, target: number, pname: number): unknown {
    if (this._skip()) return null;
    target >>>= 0;
    pname >>>= 0;
    if (target !== E.RENDERBUFFER) {
      this._e(E.INVALID_ENUM, 'getRenderbufferParameter');
      return null;
    }
    const r = this._renderbuffer;
    if (!r) {
      this._e(E.INVALID_OPERATION, 'getRenderbufferParameter');
      return null;
    }
    switch (pname) {
      case E.RENDERBUFFER_WIDTH:
        return r._width;
      case E.RENDERBUFFER_HEIGHT:
        return r._height;
      case E.RENDERBUFFER_INTERNAL_FORMAT:
        return r._internalformat;
      case E.RENDERBUFFER_SAMPLES:
        if (!this._v2) break;
        return r._samples;
      case E.RENDERBUFFER_RED_SIZE:
      case E.RENDERBUFFER_GREEN_SIZE:
      case E.RENDERBUFFER_BLUE_SIZE:
      case E.RENDERBUFFER_ALPHA_SIZE:
      case E.RENDERBUFFER_DEPTH_SIZE:
      case E.RENDERBUFFER_STENCIL_SIZE:
        this._n.getRenderbufferParameteriv(target, pname, this._i32, 0, 4);
        return this._i32[0];
    }
    this._e(E.INVALID_ENUM, 'getRenderbufferParameter');
    return null;
  },
  getInternalformatParameter(
    this: Ctx,
    target: number,
    internalformat: number,
    pname: number,
  ): unknown {
    if (this._skip()) return null;
    target >>>= 0;
    internalformat >>>= 0;
    pname >>>= 0;
    if (
      target !== E.RENDERBUFFER ||
      pname !== E.SAMPLES ||
      renderbufferFormatError(this, internalformat)
    ) {
      this._e(E.INVALID_ENUM, 'getInternalformatParameter');
      return null;
    }
    const a = this._i32;
    this._n.getInternalformativ(
      target,
      internalformat,
      GL_NUM_SAMPLE_COUNTS,
      1,
      a,
      0,
      4,
    );
    const count = Math.max(0, Math.min(16, a[0]));
    const out = new Int32Array(count);
    if (count)
      this._n.getInternalformativ(
        target,
        internalformat,
        E.SAMPLES,
        count,
        out,
        0,
        count * 4,
      );
    return out;
  },

  // ---------------------------------------------------------------------------------------------- extensions
  /** OVR_multiview2 / OCULUS_multiview (GL-24) */
  _framebufferTextureMultiview(
    this: Ctx,
    target: number,
    attachment: number,
    texture: WebGLTexture | null,
    level: number,
    samples: number,
    baseViewIndex: number,
    numViews: number,
    what: string,
  ): void {
    if (this._skip()) return;
    target >>>= 0;
    attachment >>>= 0;
    level |= 0;
    samples |= 0;
    baseViewIndex |= 0;
    numViews |= 0;
    if (!this._ok(texture, WebGLTexture, true, what)) return;
    const fb = fbFor(this, target);
    if (fb === undefined || !attachmentOk(this, attachment))
      return this._e(E.INVALID_ENUM, what);
    if (fb === null || fb._opaque) return this._e(E.INVALID_OPERATION, what);
    const t = texture ?? null;
    if (t) {
      if (t._target !== E.TEXTURE_2D_ARRAY)
        return this._e(E.INVALID_OPERATION, what);
      if (
        numViews < 1 ||
        numViews > this._getLimit(E.MAX_VIEWS_OVR) ||
        baseViewIndex < 0 ||
        level < 0
      ) {
        return this._e(E.INVALID_VALUE, what);
      }
    }
    if (samples > 0)
      n_msmv(
        this,
        target,
        attachment,
        t,
        level,
        samples,
        baseViewIndex,
        numViews,
      );
    // One view is attached as a plain layer: the driver then treats the framebuffer as single-view, so the
    // num_views = 1 programs (compiled single-view, see shader-rewrite.ts) draw to it as they do in ANGLE.
    // WebGL-visible state (NUM_VIEWS_OVR, draw validation) still comes from the recorded attachment.
    else if (numViews === 1 && t)
      this._n.framebufferTextureLayer(
        target,
        attachment,
        t._name,
        level,
        baseViewIndex,
      );
    else
      this._n.framebufferTextureMultiviewOVR(
        target,
        attachment,
        t ? t._name : 0,
        level,
        baseViewIndex,
        numViews,
      );
    setAttachment(
      this,
      fb,
      attachment,
      t
        ? {
            object: t,
            textarget: E.TEXTURE_2D_ARRAY,
            level,
            layer: baseViewIndex,
            numViews,
            baseViewIndex,
            samples,
          }
        : null,
    );
  },
  /** WEBGL_multisampled_render_to_texture */
  _framebufferTexture2DMultisample(
    this: Ctx,
    target: number,
    attachment: number,
    textarget: number,
    texture: WebGLTexture | null,
    level: number,
    samples: number,
  ): void {
    if (this._skip()) return;
    target >>>= 0;
    attachment >>>= 0;
    textarget >>>= 0;
    if (
      !this._ok(
        texture,
        WebGLTexture,
        true,
        'framebufferTexture2DMultisampleEXT',
      )
    )
      return;
    const fb = fbFor(this, target);
    if (fb === undefined || !attachmentOk(this, attachment))
      return this._e(E.INVALID_ENUM, 'framebufferTexture2DMultisampleEXT');
    if (fb === null)
      return this._e(E.INVALID_OPERATION, 'framebufferTexture2DMultisampleEXT');
    const t = texture ?? null;
    this._n.framebufferTexture2DMultisampleEXT(
      target,
      attachment,
      textarget,
      t ? t._name : 0,
      level | 0,
      samples | 0,
    );
    setAttachment(
      this,
      fb,
      attachment,
      t
        ? {
            object: t,
            textarget,
            level: level | 0,
            layer: 0,
            numViews: 0,
            baseViewIndex: 0,
            samples: samples | 0,
          }
        : null,
    );
  },
  _renderbufferStorageMultisampleEXT(
    this: Ctx,
    target: number,
    samples: number,
    internalformat: number,
    width: number,
    height: number,
  ): void {
    storage(
      this,
      target >>> 0,
      samples | 0,
      internalformat >>> 0,
      width | 0,
      height | 0,
      'renderbufferStorageMultisampleEXT',
      true,
    );
  },
};

/** WebGL 2.0 §5.?: PACK_SKIP_PIXELS + width must fit in the row (PACK_ROW_LENGTH, or width when 0). */
function packParamsInvalid(ctx: Ctx, width: number): boolean {
  const p = ctx._ps;
  const rowLength = p[PS_PACK_ROW_LENGTH] > 0 ? p[PS_PACK_ROW_LENGTH] : width;
  return p[PS_PACK_SKIP_PIXELS] + width > rowLength;
}

/** readPixels format/type enums (WebGL 1.0 §5.14.12 / WebGL 2.0): unknown -> INVALID_ENUM; the driver decides
 * whether a known pair matches the read buffer (INVALID_OPERATION). */
function readFormatError(ctx: Ctx, format: number, type: number): number {
  const formats = ctx._v2 ? READ_FORMATS2 : READ_FORMATS1;
  const types = ctx._v2 ? READ_TYPES2 : READ_TYPES1;
  if (!formats.has(format) || !types.has(type)) return E.INVALID_ENUM;
  return 0;
}
const READ_FORMATS1 = new Set([E.ALPHA, E.RGB, E.RGBA]);
const READ_TYPES1 = new Set([
  E.UNSIGNED_BYTE,
  E.UNSIGNED_SHORT_5_6_5,
  E.UNSIGNED_SHORT_4_4_4_4,
  E.UNSIGNED_SHORT_5_5_5_1,
  E.FLOAT,
  E.HALF_FLOAT_OES,
]);
const READ_FORMATS2 = new Set([
  E.ALPHA,
  E.RGB,
  E.RGBA,
  E.RED,
  E.RG,
  E.RED_INTEGER,
  E.RG_INTEGER,
  E.RGB_INTEGER,
  E.RGBA_INTEGER,
]);
const READ_TYPES2 = new Set([
  E.UNSIGNED_BYTE,
  E.BYTE,
  E.UNSIGNED_SHORT,
  E.SHORT,
  E.UNSIGNED_INT,
  E.INT,
  E.HALF_FLOAT,
  E.FLOAT,
  E.UNSIGNED_SHORT_5_6_5,
  E.UNSIGNED_SHORT_4_4_4_4,
  E.UNSIGNED_SHORT_5_5_5_1,
  E.UNSIGNED_INT_2_10_10_10_REV,
  E.UNSIGNED_INT_10F_11F_11F_REV,
  E.UNSIGNED_INT_5_9_9_9_REV,
]);

/** The read framebuffer's read buffer has no image attached (reads are INVALID_OPERATION, WebGL 2.0). */
export function missingReadImage(ctx: Ctx): boolean {
  const r = ctx._readFbo;
  if (r === null) return ctx._dfbReadBuffer === E.NONE;
  if (r._opaque) return false;
  return r._readBuffer === E.NONE || !r._attachments.has(r._readBuffer);
}

/**
 * WebGL 2.0 §5.?: blitting from a missing image into an existing one is INVALID_OPERATION (colour: read buffer
 * missing while an enabled draw buffer has an image; depth / stencil: present on one side only).
 */
function blitImagesMissing(ctx: Ctx, mask: number): boolean {
  const r = ctx._readFbo;
  const d = ctx._drawFbo;
  if ((mask & E.COLOR_BUFFER_BIT) !== 0 && missingReadImage(ctx)) {
    if (d === null) return ctx._dfbDrawBuffer !== E.NONE;
    if (d._opaque) return true;
    for (const b of d._drawBuffers)
      if (b !== E.NONE && d._attachments.has(b)) return true;
  }
  const has = (
    fb: WebGLFramebuffer | null,
    att: number,
    dflt: boolean,
  ): boolean => (fb === null ? dflt : fb._opaque || fb._attachments.has(att));
  if (
    (mask & E.DEPTH_BUFFER_BIT) !== 0 &&
    has(r, E.DEPTH_ATTACHMENT, ctx._attrs.depth) !==
      has(d, E.DEPTH_ATTACHMENT, ctx._attrs.depth)
  )
    return true;
  if (
    (mask & E.STENCIL_BUFFER_BIT) !== 0 &&
    has(r, E.STENCIL_ATTACHMENT, ctx._attrs.stencil) !==
      has(d, E.STENCIL_ATTACHMENT, ctx._attrs.stencil)
  )
    return true;
  return false;
}

/** Read buffer and an enabled draw buffer are the same image (blitFramebuffer, WebGL 2.0). */
function sameColorImage(ctx: Ctx): boolean {
  const r = ctx._readFbo;
  const d = ctx._drawFbo;
  if (r === null && d === null) return true;
  if (r === null || d === null) return false;
  const ra = r._attachments.get(r._readBuffer);
  if (!ra) return false;
  for (const b of d._drawBuffers) {
    if (b === E.NONE) continue;
    const da = d._attachments.get(b);
    if (
      da &&
      da.object === ra.object &&
      da.level === ra.level &&
      da.layer === ra.layer &&
      da.textarget === ra.textarget
    )
      return true;
  }
  return false;
}

function n_msmv(
  ctx: Ctx,
  target: number,
  attachment: number,
  t: WebGLTexture | null,
  level: number,
  samples: number,
  base: number,
  views: number,
): void {
  ctx._n.framebufferTextureMultisampleMultiviewOVR(
    target,
    attachment,
    t ? t._name : 0,
    level,
    samples,
    base,
    views,
  );
}

function queryAttachment(
  ctx: Ctx,
  target: number,
  attachment: number,
  pname: number,
  isDefault: boolean,
): unknown {
  switch (pname) {
    case E.FRAMEBUFFER_ATTACHMENT_RED_SIZE:
    case E.FRAMEBUFFER_ATTACHMENT_GREEN_SIZE:
    case E.FRAMEBUFFER_ATTACHMENT_BLUE_SIZE:
    case E.FRAMEBUFFER_ATTACHMENT_ALPHA_SIZE:
    case E.FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE:
    case E.FRAMEBUFFER_ATTACHMENT_STENCIL_SIZE:
    case E.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE:
    case E.FRAMEBUFFER_ATTACHMENT_COLOR_ENCODING:
      if (!ctx._v2 && pname !== E.FRAMEBUFFER_ATTACHMENT_COLOR_ENCODING) break;
      if (
        attachment === E.DEPTH_STENCIL_ATTACHMENT &&
        pname === E.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE
      ) {
        ctx._e(E.INVALID_OPERATION, 'getFramebufferAttachmentParameter');
        return null;
      }
      if (isDefault) {
        ctx._n.bindFramebuffer(target, ctx._dfbName);
      }
      ctx._n.getFramebufferAttachmentParameteriv(
        target,
        attachment,
        pname,
        ctx._i32,
        0,
        4,
      );
      return ctx._i32[0];
  }
  ctx._e(E.INVALID_ENUM, 'getFramebufferAttachmentParameter');
  return null;
}

function invalidate(
  ctx: Ctx,
  target: number,
  attachments: unknown,
  sub: boolean,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  if (ctx._skip()) return;
  const what = sub ? 'invalidateSubFramebuffer' : 'invalidateFramebuffer';
  const fb = fbFor(ctx, target);
  if (fb === undefined) return ctx._e(E.INVALID_ENUM, what);
  const src = u32List(ctx, attachments, what);
  const count =
    src === attachments
      ? src.length
      : (attachments as ArrayLike<unknown>).length;
  if (count > 16) return ctx._e(E.INVALID_VALUE, what);
  const out = ctx._u32;
  for (let i = 0; i < count; i++) {
    const a = src[i];
    if (fb === null) {
      const m = translateDefaultAttachment(a);
      if (m < 0 || a === E.BACK) return ctx._e(E.INVALID_ENUM, what);
      out[i] = m;
    } else {
      if (!attachmentOk(ctx, a))
        return ctx._e(
          a === E.COLOR || a === E.DEPTH || a === E.STENCIL
            ? E.INVALID_OPERATION
            : E.INVALID_ENUM,
          what,
        );
      out[i] = a;
    }
  }
  if (sub && (w < 0 || h < 0)) return ctx._e(E.INVALID_VALUE, what);
  if (fb === null && !ctx._dfbReady) return; // nothing allocated, nothing to discard
  if (sub) {
    ctx._n.invalidateSubFramebuffer(
      target,
      count,
      out,
      0,
      count * 4,
      x,
      y,
      w,
      h,
    );
  } else {
    ctx._n.invalidateFramebuffer(target, count, out, 0, count * 4);
  }
}

function clearBuffer(
  ctx: Ctx,
  kind: 'f' | 'i' | 'u',
  buffer: number,
  drawbuffer: number,
  values: unknown,
  srcOffset: number,
): void {
  if (ctx._skip()) return;
  const what =
    kind === 'f'
      ? 'clearBufferfv'
      : kind === 'i'
        ? 'clearBufferiv'
        : 'clearBufferuiv';
  const list =
    kind === 'f'
      ? f32List(ctx, values, what)
      : kind === 'i'
        ? i32List(ctx, values, what)
        : u32List(ctx, values, what);
  const len =
    list === values ? list.length : (values as ArrayLike<unknown>).length;
  let need: number;
  if (buffer === E.COLOR) {
    need = 4;
    if (drawbuffer < 0 || drawbuffer >= ctx._maxDrawBuffers)
      return ctx._e(E.INVALID_VALUE, what);
  } else if (
    (buffer === E.DEPTH && kind === 'f') ||
    (buffer === E.STENCIL && kind === 'i')
  ) {
    need = 1;
    if (drawbuffer !== 0) return ctx._e(E.INVALID_VALUE, what);
  } else {
    return ctx._e(E.INVALID_ENUM, what);
  }
  if (srcOffset + need > len) return ctx._e(E.INVALID_VALUE, what);
  const fb = ctx._drawFbo;
  if (fb === null) ctx._ensureDefaultFramebuffer();
  else if (buffer === E.COLOR) {
    const db = fb._drawBuffers[drawbuffer] ?? E.NONE;
    const a = db === E.NONE ? undefined : fb._attachments.get(db);
    if (a && formatClass(attachmentFormat(a)) !== kind)
      return ctx._e(E.INVALID_OPERATION, what);
    if (fb._rgb9e5 !== 0 && sharedExponentMaskConflict(ctx, fb, drawbuffer))
      return ctx._e(E.INVALID_OPERATION, what);
  }
  const off = srcOffset * 4;
  if (kind === 'f')
    ctx._n.clearBufferfv(buffer, drawbuffer, list, off, need * 4);
  else if (kind === 'i')
    ctx._n.clearBufferiv(buffer, drawbuffer, list, off, need * 4);
  else ctx._n.clearBufferuiv(buffer, drawbuffer, list, off, need * 4);
}

/** WebGL 2 renderbuffer formats: colour-renderable sized formats (some only with an extension), depth/stencil. */
function renderbufferFormatError(ctx: Ctx, f: number): number {
  if (RB_FORMATS2.has(f)) return 0;
  const exts = RENDER_EXT[f];
  if (exts !== undefined)
    return exts.some((n) => ctx._extensions.has(n)) ? 0 : E.INVALID_ENUM;
  return E.INVALID_ENUM;
}
const RB_FORMATS2 = new Set(
  [
    E.R8,
    E.RG8,
    E.RGB8,
    E.RGBA8,
    E.SRGB8_ALPHA8,
    E.RGB565,
    E.RGBA4,
    E.RGB5_A1,
    E.RGB10_A2,
    E.RGB10_A2UI,
    E.R8I,
    E.R8UI,
    E.R16I,
    E.R16UI,
    E.R32I,
    E.R32UI,
    E.RG8I,
    E.RG8UI,
    E.RG16I,
    E.RG16UI,
    E.RG32I,
    E.RG32UI,
    E.RGBA8I,
    E.RGBA8UI,
    E.RGBA16I,
    E.RGBA16UI,
    E.RGBA32I,
    E.RGBA32UI,
    E.DEPTH_COMPONENT16,
    E.DEPTH_COMPONENT24,
    E.DEPTH_COMPONENT32F,
    E.DEPTH24_STENCIL8,
    E.DEPTH32F_STENCIL8,
    E.STENCIL_INDEX8,
    E.R16F,
    E.RG16F,
    E.RGBA16F,
    E.R32F,
    E.RG32F,
    E.RGBA32F,
    E.R11F_G11F_B10F, // gated below by RENDER_EXT
  ].filter((f) => RENDER_EXT[f] === undefined),
);

const WEBGL1_RB_FORMATS = new Set([
  E.RGBA4,
  E.RGB565,
  E.RGB5_A1,
  E.DEPTH_COMPONENT16,
  E.STENCIL_INDEX8,
  E.DEPTH_STENCIL,
]);

function storage(
  ctx: Ctx,
  target: number,
  samples: number,
  internalformat: number,
  width: number,
  height: number,
  what: string,
  ext = false,
): void {
  if (ctx._skip()) return;
  if (target !== E.RENDERBUFFER) return ctx._e(E.INVALID_ENUM, what);
  const r = ctx._renderbuffer;
  if (!r) return ctx._e(E.INVALID_OPERATION, what);
  if (width < 0 || height < 0 || samples < 0)
    return ctx._e(E.INVALID_VALUE, what);
  const max = ctx._getLimit(E.MAX_RENDERBUFFER_SIZE);
  if (width > max || height > max) return ctx._e(E.INVALID_VALUE, what);
  let fmt = internalformat;
  if (!ctx._v2) {
    if (
      !WEBGL1_RB_FORMATS.has(fmt) &&
      !(ctx._extensions.has('EXT_sRGB') && fmt === E.SRGB8_ALPHA8_EXT) &&
      !(
        ctx._extensions.has('WEBGL_color_buffer_float') && fmt === E.RGBA32F_EXT
      ) &&
      !(
        ctx._extensions.has('EXT_color_buffer_half_float') &&
        fmt === E.RGBA16F_EXT
      )
    ) {
      return ctx._e(E.INVALID_ENUM, what);
    }
  }
  if (ctx._v2 && fmt !== E.DEPTH_STENCIL) {
    const err = renderbufferFormatError(ctx, fmt);
    if (err) return ctx._e(err, what);
  }
  if (fmt === E.DEPTH_STENCIL) {
    // WebGL 1 DEPTH_STENCIL renderbuffers (WebGL 2 accepts it for single-sample storage only)
    if (samples > 0) return ctx._e(E.INVALID_OPERATION, what);
    fmt = E.DEPTH24_STENCIL8;
  }
  if (samples > 0 && samples > ctx._getLimit(E.MAX_SAMPLES))
    return ctx._e(E.INVALID_OPERATION, what);
  const n = ctx._n;
  if (ext)
    n.renderbufferStorageMultisampleEXT(target, samples, fmt, width, height);
  else if (samples > 0 || what === 'renderbufferStorageMultisample')
    n.renderbufferStorageMultisample(target, samples, fmt, width, height);
  else n.renderbufferStorage(target, fmt, width, height);
  r._internalformat = internalformat;
  r._width = width;
  r._height = height;
  r._samples = samples;
  ctx._fbEpoch++;
  if (width && height) n.clearRenderbuffer(r._name, fmt);
  // Qualcomm drivers keep using the old storage in a framebuffer the renderbuffer was attached to before it was
  // reallocated (crbug.com/696126; CTS multisampled-renderbuffer-initialization): re-attach it in the bound ones.
  if (ctx._v2) {
    for (const [fb, t] of [
      [ctx._drawFbo, E.DRAW_FRAMEBUFFER],
      [ctx._readFbo, E.READ_FRAMEBUFFER],
    ] as const) {
      if (!fb || (t === E.READ_FRAMEBUFFER && fb === ctx._drawFbo)) continue;
      for (const [k, a] of fb._attachments)
        if (a.object === r)
          n.framebufferRenderbuffer(t, k, E.RENDERBUFFER, r._name);
    }
  }
}

/** Internal helpers mixed into Ctx. */
export const framebufferInternals = {
  /** GLES: deleting a texture / renderbuffer detaches it from the currently bound framebuffers. */
  _detachFromBound(this: Ctx, obj: WebGLObject): void {
    for (const fb of [this._drawFbo, this._readFbo]) {
      if (!fb) continue;
      let changed = false;
      let v1 = false;
      for (const [k, a] of fb._v1Points) {
        if (a.object === obj) {
          fb._v1Points.delete(k);
          v1 = true;
        }
      }
      for (const [k, a] of fb._attachments) {
        if (a.object === obj) {
          fb._attachments.delete(k);
          if (obj instanceof WebGLTexture) obj._attachCount--;
          changed = true;
        }
      }
      // WebGL 1: the driver dropped the object from both of its points; re-attach what the other points still hold
      if (v1)
        syncV1DepthStencil(
          this,
          fb,
          fb === this._drawFbo ? E.FRAMEBUFFER : E.READ_FRAMEBUFFER,
        );
      if (changed || v1) {
        recompute(fb);
        this._feedbackDirty = true;
        this._texDirty = true;
        this._fbEpoch++;
      }
    }
  },
  /** Size of the read framebuffer's read attachment (for WebGL's out-of-bounds rules). */
  _readSize(this: Ctx): [number, number] {
    const fb = this._readFbo;
    if (fb === null) {
      this._ensureDefaultFramebuffer();
      return [this._dfbWidth, this._dfbHeight];
    }
    const a =
      fb._attachments.get(fb._readBuffer) ??
      fb._attachments.get(E.COLOR_ATTACHMENT0) ??
      fb._attachments.get(E.DEPTH_ATTACHMENT);
    if (!a) return [0x7fffffff, 0x7fffffff];
    if (a.object instanceof WebGLRenderbuffer)
      return [a.object._width, a.object._height];
    const l0 = a.object._level0;
    if (!l0) return [0x7fffffff, 0x7fffffff];
    return [
      Math.max(1, l0.width >> a.level),
      Math.max(1, l0.height >> a.level),
    ];
  },
  /** copyTex*: reading from a framebuffer that has `tex` at `level` attached is a feedback loop. */
  _readFeedback(this: Ctx, tex: WebGLTexture, level: number): boolean {
    const fb = this._readFbo;
    if (!fb || tex._attachCount === 0) return false;
    for (const a of fb._attachments.values())
      if (a.object === tex && a.level === level) return true;
    return false;
  },
};
