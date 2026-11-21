/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// @iwer/native WebGL 2 binding (milestone M2, spec 07-webgl2.md).
//
//   installWebGL(globalThis, globalThis.__iwn.gl)  -> { createContext(canvas, 'webgl2' | 'webgl', attrs) }
//
// The canvas implementation (stream M4) calls createContext from HTMLCanvasElement.getContext. The XR module
// (stream M3) uses the host hooks below. In Node, pass the host test addon (runtime/gl, -DIWN_GL_NODE_ADDON=ON)
// or test/fake-natives.ts.

export { installWebGL, type WebGLInstall } from './install.ts';
export { Ctx as WebGLContextImpl, advanceEpoch, type CanvasLike, type ContextAttributes, type ContextOptions } from './core.ts';
export {
  wrapTexture,
  retargetTexture,
  wrapFramebuffer,
  frameBoundary,
  afterAnimationFrame,
  resyncState,
  invalidateDepthStencil,
  canvasResized,
  readStats,
  resetStats,
  STATS_FIELDS,
} from './host.ts';
export { TEX_SOURCE, type SourcePixels } from './tex-source.ts';
export type { GlNatives } from './gen/natives.gen.ts';
export { NATIVES } from './gen/natives.gen.ts';
