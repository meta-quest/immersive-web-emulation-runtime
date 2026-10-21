/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRSession } from '../session/XRSession.js';

type GL = WebGLRenderingContext | WebGL2RenderingContext;
type LayersSession = XRSession & {
  context?: GL;
  isPolyfillActive: boolean;
  _requestAnimationFrame: XRSession['requestAnimationFrame'];
};

// webxr-layers-polyfill 1.1.0 shares the application's context but does not
// restore all bindings. Also save its normally-restored state for exceptions.
function captureState(gl: GL): () => void {
  const gl2 = gl instanceof WebGL2RenderingContext ? gl : null;
  const vaoExtension = gl2 ? null : gl.getExtension('OES_vertex_array_object');
  const vao: WebGLVertexArrayObject | WebGLVertexArrayObjectOES | null = gl2
    ? gl2.getParameter(gl2.VERTEX_ARRAY_BINDING)
    : vaoExtension
      ? gl.getParameter(vaoExtension.VERTEX_ARRAY_BINDING_OES)
      : null;
  const arrayBuffer: WebGLBuffer | null = gl.getParameter(
    gl.ARRAY_BUFFER_BINDING,
  );
  const program: WebGLProgram | null = gl.getParameter(gl.CURRENT_PROGRAM);
  const viewport: Int32Array = gl.getParameter(gl.VIEWPORT);
  const drawFramebuffer: WebGLFramebuffer | null = gl.getParameter(
    gl.FRAMEBUFFER_BINDING,
  );
  const readFramebuffer: WebGLFramebuffer | null = gl2
    ? gl2.getParameter(gl2.READ_FRAMEBUFFER_BINDING)
    : null;
  const activeTexture: number = gl.getParameter(gl.ACTIVE_TEXTURE);
  const targets = [
    [gl.TEXTURE_2D, gl.TEXTURE_BINDING_2D],
    [gl.TEXTURE_CUBE_MAP, gl.TEXTURE_BINDING_CUBE_MAP],
    ...(gl2 ? [[gl2.TEXTURE_2D_ARRAY, gl2.TEXTURE_BINDING_2D_ARRAY]] : []),
  ];
  const textures = [...new Set([gl.TEXTURE0, activeTexture])].map((unit) => {
    gl.activeTexture(unit);
    return {
      unit,
      bindings: targets.map(([target, parameter]) => ({
        target,
        texture: gl.getParameter(parameter) as WebGLTexture | null,
      })),
    };
  });
  gl.activeTexture(activeTexture);
  const flipY: boolean = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
  const clearColor: Float32Array = gl.getParameter(gl.COLOR_CLEAR_VALUE);
  const enables = [gl.BLEND, gl.DEPTH_TEST, gl.CULL_FACE].map((cap) => ({
    cap,
    enabled: gl.isEnabled(cap),
  }));
  const blend = [
    gl.BLEND_SRC_RGB,
    gl.BLEND_DST_RGB,
    gl.BLEND_SRC_ALPHA,
    gl.BLEND_DST_ALPHA,
  ].map((parameter): number => gl.getParameter(parameter));

  return () => {
    if (gl2) {
      gl2.bindVertexArray(vao);
      gl2.bindFramebuffer(gl2.READ_FRAMEBUFFER, readFramebuffer);
      gl2.bindFramebuffer(gl2.DRAW_FRAMEBUFFER, drawFramebuffer);
    } else {
      vaoExtension?.bindVertexArrayOES(vao);
      gl.bindFramebuffer(gl.FRAMEBUFFER, drawFramebuffer);
    }
    // ELEMENT_ARRAY_BUFFER belongs to the VAO and is restored with it.
    gl.bindBuffer(gl.ARRAY_BUFFER, arrayBuffer);
    gl.useProgram(program);
    gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
    for (const { unit, bindings } of textures) {
      gl.activeTexture(unit);
      for (const { target, texture } of bindings) {
        gl.bindTexture(target, texture);
      }
    }
    gl.activeTexture(activeTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipY);
    gl.clearColor(clearColor[0], clearColor[1], clearColor[2], clearColor[3]);
    for (const { cap, enabled } of enables) {
      if (enabled) gl.enable(cap);
      else gl.disable(cap);
    }
    gl.blendFuncSeparate(blend[0], blend[1], blend[2], blend[3]);
  };
}

export function installLayerStatePreservation(): void {
  const prototype = XRSession.prototype as LayersSession;
  const requestFrame = prototype._requestAnimationFrame;
  const requestPolyfillFrame = prototype.requestAnimationFrame;
  const states = new WeakMap<XRSession, { restore?: () => void }>();

  prototype._requestAnimationFrame = function (callback) {
    return requestFrame.call(this, (time, frame) => {
      const state: { restore?: () => void } = {};
      if (this.isPolyfillActive && this.context) {
        state.restore = captureState(this.context);
      }
      states.set(this, state);
      try {
        callback(time, frame);
      } finally {
        states.delete(this);
        state.restore?.();
      }
    });
  };
  prototype.requestAnimationFrame = function (callback) {
    return requestPolyfillFrame.call(this, (time, frame) => {
      const state = states.get(this);
      if (!state) {
        callback(time, frame);
        return;
      }
      // Undo the pre-frame clear pass, then preserve the application's changes
      // rather than rolling them back after the post-frame composition.
      state.restore?.();
      try {
        callback(time, frame);
      } finally {
        if (this.isPolyfillActive && this.context) {
          state.restore = captureState(this.context);
        }
      }
    });
  };
}
