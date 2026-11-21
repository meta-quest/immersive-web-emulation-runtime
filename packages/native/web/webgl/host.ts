/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Hooks for the runtime and the XR module (IWER host backend, stream M3): wrapping host-owned GL objects as
// WebGL objects, re-pointing the session's single opaque colour texture at each frame's swapchain image,
// frame-boundary bookkeeping (GL-15 epochs, real context loss), state re-sync after native GL work, the
// end-of-frame depth/stencil invalidation (GL-PERF-5) and stats.

import type { Ctx } from './core.ts';
import { advanceEpoch, compositeAll } from './core.ts';
import * as E from './gen/enums.gen.ts';
import { INTERNAL, WebGLFramebuffer, WebGLTexture } from './objects.ts';
import type { Attachment } from './objects.ts';
import { PS_PACK_ALIGNMENT, PS_UNPACK_ALIGNMENT } from './state.ts';

/** IWER XRHostBackend.wrapTexture: a host-owned texture (never deleted by the binding). */
export function wrapTexture(gl: Ctx, name: number, target: number = E.TEXTURE_2D_ARRAY): WebGLTexture {
  const t = new WebGLTexture(INTERNAL, gl, name, );
  t._target = target;
  t._bound = true;
  t._external = true;
  return t;
}

/**
 * The XR projection layer keeps one WebGLTexture per session whose GL name follows the acquired swapchain
 * image. Re-point it: update the name, re-bind it on every unit where it is bound, and re-attach it in every
 * framebuffer of this context that has it attached (FBO re-pointing), restoring all bindings.
 * Called up to twice per XR frame (re-point, then park after the fence), so it allocates nothing: no literals,
 * index loops over arrays, and the attachment map walked with Map.forEach and a hoisted callback (PERF-ALLOC-1:
 * ~0 per-frame allocation on the host + IWER path).
 */
export function retargetTexture(gl: Ctx, tex: WebGLTexture, name: number, framebuffers: Iterable<WebGLFramebuffer>): void {
  if (tex._name === name) return;
  gl._skip();
  tex._name = name;
  const n = gl._n;
  let unitChanged = rebindUnits(n, gl._tex2D, E.TEXTURE_2D, tex, name);
  unitChanged = rebindUnits(n, gl._texCube, E.TEXTURE_CUBE_MAP, tex, name) || unitChanged;
  unitChanged = rebindUnits(n, gl._tex3D, E.TEXTURE_3D, tex, name) || unitChanged;
  unitChanged = rebindUnits(n, gl._tex2DArray, E.TEXTURE_2D_ARRAY, tex, name) || unitChanged;
  if (unitChanged) n.activeTexture(E.TEXTURE0 + gl._activeUnit);
  const r = reattach;
  r.n = n;
  r.tex = tex;
  r.name = name;
  r.changed = false;
  if (Array.isArray(framebuffers)) {
    for (let i = 0; i < framebuffers.length; i++) {
      const fb: WebGLFramebuffer = framebuffers[i];
      r.fb = fb;
      fb._attachments.forEach(reattachVisit);
    }
  } else {
    for (const fb of framebuffers) {
      r.fb = fb;
      fb._attachments.forEach(reattachVisit);
    }
  }
  const fbChanged = r.changed;
  r.n = null;
  r.tex = null;
  r.fb = null;
  if (fbChanged) gl._restoreFramebufferBindings();
}

/** retargetTexture: re-bind `tex` (now named `name`) on every unit of one target where it is bound. */
function rebindUnits(n: Ctx['_n'], list: (WebGLTexture | null)[], target: number, tex: WebGLTexture, name: number): boolean {
  let changed = false;
  for (let u = 0; u < list.length; u++) {
    if (list[u] !== tex) continue;
    n.activeTexture(E.TEXTURE0 + u);
    n.bindTexture(target, name);
    changed = true;
  }
  return changed;
}

// retargetTexture's state for reattachVisit (one framebuffer's Map.forEach at a time; only native GL calls run inside,
// so it is never re-entered).
const reattach: { n: Ctx['_n'] | null; tex: WebGLTexture | null; fb: WebGLFramebuffer | null; name: number; changed: boolean } = {
  n: null,
  tex: null,
  fb: null,
  name: 0,
  changed: false,
};

function reattachVisit(a: Attachment, att: number): void {
  const r = reattach;
  if (a.object !== r.tex) return;
  const n = r.n!;
  const name = r.name;
  n.bindFramebuffer(E.DRAW_FRAMEBUFFER, r.fb!._name);
  if (a.numViews > 0) {
    if (a.samples > 0) n.framebufferTextureMultisampleMultiviewOVR(E.DRAW_FRAMEBUFFER, att, name, a.level, a.samples, a.baseViewIndex, a.numViews);
    else if (a.numViews === 1) n.framebufferTextureLayer(E.DRAW_FRAMEBUFFER, att, name, a.level, a.baseViewIndex);
    else n.framebufferTextureMultiviewOVR(E.DRAW_FRAMEBUFFER, att, name, a.level, a.baseViewIndex, a.numViews);
  } else if (a.textarget === E.TEXTURE_2D_ARRAY || a.textarget === E.TEXTURE_3D) {
    n.framebufferTextureLayer(E.DRAW_FRAMEBUFFER, att, name, a.level, a.layer);
  } else if (a.samples > 0) {
    n.framebufferTexture2DMultisampleEXT(E.DRAW_FRAMEBUFFER, att, a.textarget, name, a.level, a.samples);
  } else {
    n.framebufferTexture2D(E.DRAW_FRAMEBUFFER, att, a.textarget, name, a.level);
  }
  r.changed = true;
}

/** A host-owned framebuffer (XRWebGLLayer's opaque framebuffer). `numViews` > 0 for multiview targets. */
export function wrapFramebuffer(gl: Ctx, name: number, opts: { opaque?: boolean; numViews?: number } = {}): WebGLFramebuffer {
  const f = new WebGLFramebuffer(INTERNAL, gl, name);
  f._opaque = opts.opaque ?? true;
  f._numViews = opts.numViews ?? 0;
  f._bound = true;
  return f;
}

/** After the window rAF callbacks of a frame (the browser's composite point): drawing-buffer semantics + GL-15. */
export function afterAnimationFrame(): void {
  compositeAll();
  advanceEpoch();
}

/** Call at task / XR frame boundaries: query & sync results may become visible (GL-15); checks real loss. */
export function frameBoundary(gl: Ctx | null): void {
  advanceEpoch();
  gl?._checkReset();
}

/**
 * Native code (the XR module) changed GL state in this context behind the binding: push the cached state
 * back to the driver so the cache stays truthful (GL-PERF-2 coherency). Cheap: ~40 calls, rare.
 */
export function resyncState(gl: Ctx): void {
  gl._makeCurrent();
  const n = gl._n;
  const caps = [E.BLEND, E.CULL_FACE, E.DEPTH_TEST, E.DITHER, E.POLYGON_OFFSET_FILL, E.SAMPLE_ALPHA_TO_COVERAGE, E.SAMPLE_COVERAGE, E.SCISSOR_TEST, E.STENCIL_TEST, E.RASTERIZER_DISCARD];
  caps.forEach((cap, i) => {
    if (i === 9 && !gl._v2) return;
    if (gl._caps[i] === 1) n.enable(cap);
    else if (gl._caps[i] === 0) n.disable(cap);
  });
  const v = gl._viewport;
  n.viewport(v[0], v[1], v[2], v[3]);
  const s = gl._scissor;
  n.scissor(s[0], s[1], s[2], s[3]);
  const c = gl._clearColor;
  n.clearColor(c[0], c[1], c[2], c[3]);
  n.clearDepthf(gl._clearDepth);
  n.clearStencil(gl._clearStencil);
  const m = gl._colorMask;
  n.colorMask(m[0] === 1, m[1] === 1, m[2] === 1, m[3] === 1);
  n.depthMask(gl._depthMask);
  n.depthFunc(gl._depthFunc);
  n.depthRangef(gl._depthRange[0], gl._depthRange[1]);
  const bc = gl._blendColor;
  n.blendColor(bc[0], bc[1], bc[2], bc[3]);
  n.blendEquationSeparate(gl._blendEq[0], gl._blendEq[1]);
  n.blendFuncSeparate(gl._blendFunc[0], gl._blendFunc[1], gl._blendFunc[2], gl._blendFunc[3]);
  n.cullFace(gl._cullFace);
  n.frontFace(gl._frontFace);
  n.lineWidth(gl._lineWidth);
  if (gl._polygonOffsetClamp !== 0) n.polygonOffsetClampEXT(gl._polygonOffset[0], gl._polygonOffset[1], gl._polygonOffsetClamp);
  else n.polygonOffset(gl._polygonOffset[0], gl._polygonOffset[1]);
  if (gl._extensions.has('EXT_clip_control')) n.clipControlEXT(gl._clipControl[0], gl._clipControl[1]);
  if (gl._extensions.has('WEBGL_polygon_mode')) n.polygonModeNV(E.FRONT_AND_BACK, gl._polygonMode);
  n.sampleCoverage(gl._sampleCoverageValue, gl._sampleCoverageInvert);
  n.stencilFuncSeparate(E.FRONT, gl._stencilFuncF[0], gl._stencilFuncF[1], gl._stencilFuncF[2] >>> 0);
  n.stencilFuncSeparate(E.BACK, gl._stencilFuncB[0], gl._stencilFuncB[1], gl._stencilFuncB[2] >>> 0);
  n.stencilMaskSeparate(E.FRONT, gl._stencilMaskF >>> 0);
  n.stencilMaskSeparate(E.BACK, gl._stencilMaskB >>> 0);
  n.stencilOpSeparate(E.FRONT, gl._stencilOpF[0], gl._stencilOpF[1], gl._stencilOpF[2]);
  n.stencilOpSeparate(E.BACK, gl._stencilOpB[0], gl._stencilOpB[1], gl._stencilOpB[2]);
  n.pixelStorei(E.PACK_ALIGNMENT, gl._ps[PS_PACK_ALIGNMENT]);
  n.pixelStorei(E.UNPACK_ALIGNMENT, gl._ps[PS_UNPACK_ALIGNMENT]);
  n.useProgram(gl._program ? gl._program._name : 0);
  n.bindVertexArray(gl._vao._name);
  n.bindBuffer(E.ARRAY_BUFFER, gl._arrayBuffer ? gl._arrayBuffer._name : 0);
  n.bindRenderbuffer(E.RENDERBUFFER, gl._renderbuffer ? gl._renderbuffer._name : 0);
  for (let u = 0; u < gl._maxUnits; u++) {
    const t2 = gl._tex2D[u];
    const tc = gl._texCube[u];
    const t3 = gl._tex3D[u];
    const ta = gl._tex2DArray[u];
    if (!t2 && !tc && !t3 && !ta && !gl._samplers[u]) continue;
    n.activeTexture(E.TEXTURE0 + u);
    if (t2) n.bindTexture(E.TEXTURE_2D, t2._name);
    if (tc) n.bindTexture(E.TEXTURE_CUBE_MAP, tc._name);
    if (gl._v2) {
      if (t3) n.bindTexture(E.TEXTURE_3D, t3._name);
      if (ta) n.bindTexture(E.TEXTURE_2D_ARRAY, ta._name);
      const smp = gl._samplers[u];
      if (smp) n.bindSampler(u, smp._name);
    }
  }
  n.activeTexture(E.TEXTURE0 + gl._activeUnit);
  gl._restoreFramebufferBindings();
}

/**
 * GL-PERF-5: after the app's last draw of an XR frame, discard depth/stencil of a framebuffer that targets
 * the swapchain when the projection layer does not submit depth. The colour attachment is never invalidated.
 */
export function invalidateDepthStencil(gl: Ctx, fb: WebGLFramebuffer): void {
  if (gl._skip()) return;
  const n = gl._n;
  const atts = gl._u32;
  let count = 0;
  if (fb._opaque || fb._attachments.has(E.DEPTH_ATTACHMENT)) atts[count++] = E.DEPTH_ATTACHMENT;
  if (fb._opaque || fb._attachments.has(E.STENCIL_ATTACHMENT)) atts[count++] = E.STENCIL_ATTACHMENT;
  if (!count) return;
  n.bindFramebuffer(E.DRAW_FRAMEBUFFER, fb._name);
  n.invalidateFramebuffer(E.DRAW_FRAMEBUFFER, count, atts, 0, count * 4);
  gl._restoreFramebufferBindings();
}

/**
 * Clears a framebuffer that renders into the XR session's image as the frame starts (XR-DEPTH-2): colour
 * attachment 0 (when draw buffer 0 writes it) to transparent black, depth to 1, stencil to 0, whatever the masks,
 * scissor and rasterizer discard, as a browser clears a layer's textures before each frame. three.js
 * relies on that while depth sensing runs: it then skips its own clear. Restores every binding and mask it touched.
 */
export function clearSessionFramebuffer(gl: Ctx, fb: WebGLFramebuffer): void {
  if (gl._skip()) return;
  const atts = fb._attachments;
  const color = atts.has(E.COLOR_ATTACHMENT0) && fb._drawBuffers[0] === E.COLOR_ATTACHMENT0;
  const depth = atts.has(E.DEPTH_ATTACHMENT);
  const stencil = atts.has(E.STENCIL_ATTACHMENT);
  if (!color && !depth && !stencil) return;
  const n = gl._n;
  const c = gl._caps;
  n.bindFramebuffer(E.DRAW_FRAMEBUFFER, fb._name);
  if (c[7] === 1) n.disable(E.SCISSOR_TEST);
  if (c[9] === 1) n.disable(E.RASTERIZER_DISCARD);
  const perBuffer = (gl._idxDiverged & 8) !== 0;
  if (perBuffer) n.colorMaskiOES(0, true, true, true, true);
  else n.colorMask(true, true, true, true);
  n.depthMask(true);
  n.stencilMaskSeparate(E.FRONT_AND_BACK, 0xffffffff);
  const z = gl._f32;
  if (color) {
    z[0] = z[1] = z[2] = z[3] = 0;
    n.clearBufferfv(E.COLOR, 0, z, 0, 16);
  }
  if (depth && stencil) {
    n.clearBufferfi(E.DEPTH_STENCIL, 0, 1, 0);
  } else if (depth) {
    z[0] = 1;
    n.clearBufferfv(E.DEPTH, 0, z, 0, 4);
  } else if (stencil) {
    gl._i32[0] = 0;
    n.clearBufferiv(E.STENCIL, 0, gl._i32, 0, 4);
  }
  const m = gl._colorMask;
  if (perBuffer) n.colorMaskiOES(0, m[0] === 1, m[1] === 1, m[2] === 1, m[3] === 1);
  else n.colorMask(m[0] === 1, m[1] === 1, m[2] === 1, m[3] === 1);
  n.depthMask(gl._depthMask);
  n.stencilMaskSeparate(E.FRONT, gl._stencilMaskF >>> 0);
  n.stencilMaskSeparate(E.BACK, gl._stencilMaskB >>> 0);
  if (c[7] === 1) n.enable(E.SCISSOR_TEST);
  if (c[9] === 1) n.enable(E.RASTERIZER_DISCARD);
  gl._restoreFramebufferBindings();
}

/** Mark the canvas resized: the emulated default framebuffer is re-allocated on its next use. */
export function canvasResized(gl: Ctx): void {
  gl._dfbReady = false;
}

export const STATS_FIELDS = [
  'nativeCalls',
  'rejected',
  'getErrorCalls',
  'syncQueries',
  'programInfoCalls',
  'shaderInfoCalls',
  'reflectionGlCalls',
  'contextSwitches',
  'zeroInits',
  'multiDrawSubDraws',
] as const;

/** Native counters of the GL module (runtime/gl/src/stats.h). */
export function readStats(gl: Ctx): Record<(typeof STATS_FIELDS)[number], number> {
  const out = new Float64Array(STATS_FIELDS.length);
  void out.buffer;
  gl._n.stats(out, 0, out.byteLength);
  const r = {} as Record<(typeof STATS_FIELDS)[number], number>;
  STATS_FIELDS.forEach((k, i) => (r[k] = out[i]));
  return r;
}

export function resetStats(gl: Ctx): void {
  gl._n.resetStats();
}
