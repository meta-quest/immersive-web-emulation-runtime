/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// What a host-mode benchmark needs around IWER in plain Node: the one DOM
// type IWER's pose classes use, a WebGL stand-in with just the calls host
// layers make, and a host backend. Nothing here is timed on its own; it is
// kept minimal so the numbers are IWER's.

/** DOMPointReadOnly as a plain data class (browsers and the native host implement it natively). */
export class BenchDOMPointReadOnly {
  constructor(x = 0, y = 0, z = 0, w = 1) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
  }
  static fromPoint(p = {}) {
    return new BenchDOMPointReadOnly(p.x ?? 0, p.y ?? 0, p.z ?? 0, p.w ?? 1);
  }
}

export function installGlobals() {
  if (typeof globalThis.DOMPointReadOnly === 'undefined') {
    globalThis.DOMPointReadOnly = BenchDOMPointReadOnly;
  }
}

/** WebGL2 constants host layers use (values from the WebGL 2.0 IDL). */
export function makeGL() {
  let binding = null;
  let renderbuffer = null;
  return {
    FRAMEBUFFER: 0x8d40,
    DRAW_FRAMEBUFFER: 0x8ca9,
    READ_FRAMEBUFFER: 0x8ca8,
    FRAMEBUFFER_BINDING: 0x8ca6,
    RENDERBUFFER: 0x8d41,
    RENDERBUFFER_BINDING: 0x8ca7,
    TEXTURE_2D: 0x0de1,
    COLOR_ATTACHMENT0: 0x8ce0,
    drawingBufferWidth: 1832,
    drawingBufferHeight: 1920,
    canvas: { width: 1832, height: 1920 },
    createFramebuffer: () => ({ fb: true }),
    createRenderbuffer: () => ({ rb: true }),
    createTexture: () => ({ tex: true }),
    getParameter: (pname) =>
      pname === 0x8ca7 ? renderbuffer : pname === 0x8ca6 ? binding : null,
    bindFramebuffer: (_target, fb) => {
      binding = fb;
    },
    bindRenderbuffer: (_target, rb) => {
      renderbuffer = rb;
    },
    renderbufferStorage: () => {},
    framebufferRenderbuffer: () => {},
    framebufferTexture2D: () => {},
    invalidateFramebuffer: () => {},
    getContextAttributes: () => ({
      alpha: true,
      antialias: false,
      depth: true,
      stencil: false,
      premultipliedAlpha: true,
    }),
    makeXRCompatible: () => Promise.resolve(),
  };
}

/**
 * A host backend like a native OpenXR host would provide (Quest 3 sizes).
 * Errors IWER reports are collected in `errors`; a benchmark run with any
 * is invalid.
 */
export function makeBackend(errors = []) {
  const opaque = { opaqueColorTexture: true };
  const wrapped = new Map();
  return {
    beginSwapchain: (options) => ({
      width: 1832,
      height: 1920,
      arraySize: options.arraySize,
      rates: [72, 80, 90, 120],
      rate: 72,
      hasStage: true,
      stageWidth: 3,
      stageDepth: 3,
    }),
    endSession: () => {},
    requestFrameRate: () => true,
    setFixedFoveation: () => {},
    getOpaqueColorTexture: () => opaque,
    wrapTexture: (name) => {
      let t = wrapped.get(name);
      if (!t) {
        t = { name };
        wrapped.set(name, t);
      }
      return t;
    },
    runWindowFrame: () => {},
    postTask: (task) => queueMicrotask(task),
    reportError: (error, source) => {
      errors.push({ error, source });
    },
  };
}
