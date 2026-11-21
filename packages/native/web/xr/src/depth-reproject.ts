/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Depth sensing's matchDepthView (docs/spec/08 XR-DEPTH-2), as Quest Browser 156 does it (Blink XRDepthManager::
// DoReprojectDepthTexture): the frame's environment depth image, sensed from the depth cameras' pose at their own rate,
// laid out in each eye's render view of this frame. For every pixel of the eye's view, the point at the far plane on
// its ray is carried into the depth view (IWER's matrix per eye: render clip space to depth clip space) and the raw
// depth found there is written as the pixel's depth; where the depth view does not reach, the far plane. IWSDK samples
// depth by screen position, so without this its occlusion edges trail the real ones while the head turns.
//
// Drawn with the page's WebGL 2 context (two passes of the depth image's size) into a 2-layer DEPTH_COMPONENT16 texture
// of the context's own, kept for later sessions. Every piece of state it touches is read first and put back after,
// because pages (three.js) cache GL state.

import type { GLContext } from './natives.ts';

type Handle = object;
/** The WebGL 2 calls the passes make (the page's context; web/xr builds without the DOM types). */
interface GL2 {
  texStorage3D?(target: number, levels: number, format: number, width: number, height: number, depth: number): void;
  getParameter(pname: number): unknown;
  isEnabled(cap: number): boolean;
  enable(cap: number): void;
  disable(cap: number): void;
  activeTexture(unit: number): void;
  bindTexture(target: number, texture: Handle | null): void;
  bindSampler(unit: number, sampler: Handle | null): void;
  bindFramebuffer(target: number, framebuffer: Handle | null): void;
  bindVertexArray(vao: Handle | null): void;
  useProgram(program: Handle | null): void;
  viewport(x: number, y: number, width: number, height: number): void;
  depthFunc(func: number): void;
  depthMask(flag: boolean): void;
  depthRange(near: number, far: number): void;
  framebufferTextureLayer(target: number, attachment: number, texture: Handle | null, level: number, layer: number): void;
  uniform1i(location: Handle | null, x: number): void;
  uniform1f(location: Handle | null, x: number): void;
  uniformMatrix4fv(location: Handle | null, transpose: boolean, data: Float32Array, offset: number, length: number): void;
  drawArrays(mode: number, first: number, count: number): void;
  drawBuffers(buffers: number[]): void;
  readBuffer(src: number): void;
  createProgram(): Handle;
  createShader(type: number): Handle | null;
  shaderSource(shader: Handle, source: string): void;
  compileShader(shader: Handle): void;
  getShaderParameter(shader: Handle, pname: number): unknown;
  getShaderInfoLog(shader: Handle): string | null;
  attachShader(program: Handle, shader: Handle): void;
  linkProgram(program: Handle): void;
  getProgramParameter(program: Handle, pname: number): unknown;
  getProgramInfoLog(program: Handle): string | null;
  getUniformLocation(program: Handle, name: string): Handle | null;
  deleteShader(shader: Handle): void;
  deleteProgram(program: Handle): void;
  createFramebuffer(): Handle;
  createVertexArray(): Handle;
  createTexture(): Handle;
  deleteTexture(texture: Handle): void;
  texParameteri(target: number, pname: number, param: number): void;
}

const VERTEX = `#version 300 es
out vec2 v_uv;
void main() {
  // one triangle over the whole viewport
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray u_depth;
uniform mat4 u_reprojection;
uniform float u_layer;
in vec2 v_uv;
void main() {
  vec4 source = u_reprojection * vec4(v_uv * 2.0 - 1.0, 1.0, 1.0);
  vec2 uv = (source.xy / source.w + 1.0) * 0.5;
  if (source.w <= 0.0 || any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) {
    gl_FragDepth = 1.0;
  } else {
    gl_FragDepth = texture(u_depth, vec3(uv, u_layer)).r;
  }
}`;

// GL enums (WebGL 2)
const TEXTURE_2D_ARRAY = 0x8c1a;
const TEXTURE0 = 0x84c0;
const DEPTH_COMPONENT16 = 0x81a5;
const NEAREST = 0x2600;
const CLAMP_TO_EDGE = 0x812f;
const TEXTURE_MIN_FILTER = 0x2801;
const TEXTURE_MAG_FILTER = 0x2800;
const TEXTURE_WRAP_S = 0x2802;
const TEXTURE_WRAP_T = 0x2803;
const FRAMEBUFFER = 0x8d40;
const DRAW_FRAMEBUFFER_BINDING = 0x8ca6;
const READ_FRAMEBUFFER_BINDING = 0x8caa;
const DEPTH_ATTACHMENT = 0x8d00;
const NONE = 0;
const CURRENT_PROGRAM = 0x8b8d;
const VERTEX_ARRAY_BINDING = 0x85b5;
const ACTIVE_TEXTURE = 0x84e0;
const TEXTURE_BINDING_2D_ARRAY = 0x8c1d;
const SAMPLER_BINDING = 0x8919;
const VIEWPORT = 0x0ba2;
const DEPTH_FUNC = 0x0b74;
const DEPTH_WRITEMASK = 0x0b72;
const DEPTH_RANGE = 0x0b70;
const ALWAYS = 0x0207;
const TRIANGLES = 0x0004;
const VERTEX_SHADER = 0x8b31;
const FRAGMENT_SHADER = 0x8b30;
const COMPILE_STATUS = 0x8b81;
const LINK_STATUS = 0x8b82;
// the capabilities the passes switch: depth test on, the rest off
const DEPTH_TEST = 0x0b71;
const OFF_CAPS = [0x0b90 /* STENCIL_TEST */, 0x0b44 /* CULL_FACE */, 0x0c11 /* SCISSOR_TEST */,
  0x8c89 /* RASTERIZER_DISCARD */, 0x8037 /* POLYGON_OFFSET_FILL */];

interface Resources {
  program: Handle;
  matrix: Handle | null;
  layer: Handle | null;
  depth: Handle | null;
  vao: Handle;
  framebuffer: Handle;
  target: Handle | null;
  width: number;
  height: number;
}

export class DepthReprojection {
  private readonly resources = new WeakMap<object, Resources | null>();
  private readonly offWas = new Array<boolean>(OFF_CAPS.length);
  private readonly log: (message: string) => void;
  /** Frames reprojected (diagnostics). */
  frames = 0;

  constructor(log: (message: string) => void) {
    this.log = log;
  }

  /**
   * Draws `source` (the depth image, a 2D array texture of `width` x `height`, layer i = view i) laid out in the render
   * views into the context's own texture and returns that texture; null when the context cannot (WebGL 1, a program
   * that does not build): the caller then hands out the depth views' own images.
   */
  draw(context: GLContext, source: object, width: number, height: number, views: number,
    matrices: Float32Array): object | null {
    const gl = context as unknown as GL2;
    if (typeof gl.texStorage3D !== 'function') return null;  // WebGL 1
    let r = this.resources.get(context);
    if (r === undefined) {
      r = this.build(gl);
      this.resources.set(context, r);
    }
    if (r === null) return null;
    if (!r.target || r.width !== width || r.height !== height) {
      this.allocate(gl, r, width, height);
    }
    // the page's state, read before anything changes (all from the binding's own records: no GL round trip)
    const draw = gl.getParameter(DRAW_FRAMEBUFFER_BINDING) as Handle | null;
    const read = gl.getParameter(READ_FRAMEBUFFER_BINDING) as Handle | null;
    const program = gl.getParameter(CURRENT_PROGRAM) as Handle | null;
    const vao = gl.getParameter(VERTEX_ARRAY_BINDING) as Handle | null;
    const active = gl.getParameter(ACTIVE_TEXTURE) as number;
    gl.activeTexture(TEXTURE0);
    const texture = gl.getParameter(TEXTURE_BINDING_2D_ARRAY) as Handle | null;
    const sampler = gl.getParameter(SAMPLER_BINDING) as Handle | null;
    const viewport = gl.getParameter(VIEWPORT) as Int32Array;
    const vx = viewport[0], vy = viewport[1], vw = viewport[2], vh = viewport[3];
    const depthTest = gl.isEnabled(DEPTH_TEST);
    for (let i = 0; i < OFF_CAPS.length; i++) this.offWas[i] = gl.isEnabled(OFF_CAPS[i]);
    const depthFunc = gl.getParameter(DEPTH_FUNC) as number;
    const depthMask = gl.getParameter(DEPTH_WRITEMASK) as boolean;
    const range = gl.getParameter(DEPTH_RANGE) as Float32Array;
    const near = range[0], far = range[1];

    gl.bindFramebuffer(FRAMEBUFFER, r.framebuffer);
    gl.viewport(0, 0, width, height);
    // depth test on (gl_FragDepth is written only then), every fragment passing
    if (!depthTest) gl.enable(DEPTH_TEST);
    for (let i = 0; i < OFF_CAPS.length; i++) if (this.offWas[i]) gl.disable(OFF_CAPS[i]);
    gl.depthFunc(ALWAYS);
    gl.depthMask(true);
    gl.depthRange(0, 1);
    gl.useProgram(r.program);
    gl.bindVertexArray(r.vao);
    gl.bindTexture(TEXTURE_2D_ARRAY, source as Handle);
    if (sampler) gl.bindSampler(0, null);
    gl.uniform1i(r.depth, 0);
    for (let view = 0; view < views; view++) {
      gl.framebufferTextureLayer(FRAMEBUFFER, DEPTH_ATTACHMENT, r.target, 0, view);
      gl.uniformMatrix4fv(r.matrix, false, matrices, view * 16, 16);
      gl.uniform1f(r.layer, view);
      gl.drawArrays(TRIANGLES, 0, 3);
    }

    if (sampler) gl.bindSampler(0, sampler);
    gl.bindTexture(TEXTURE_2D_ARRAY, texture);
    gl.activeTexture(active);
    gl.bindVertexArray(vao);
    gl.useProgram(program);
    gl.depthRange(near, far);
    gl.depthMask(depthMask);
    gl.depthFunc(depthFunc);
    for (let i = 0; i < OFF_CAPS.length; i++) if (this.offWas[i]) gl.enable(OFF_CAPS[i]);
    if (!depthTest) gl.disable(DEPTH_TEST);
    gl.viewport(vx, vy, vw, vh);
    gl.bindFramebuffer(0x8ca9 /* DRAW_FRAMEBUFFER */, draw);
    gl.bindFramebuffer(0x8ca8 /* READ_FRAMEBUFFER */, read);
    this.frames++;
    return r.target;
  }

  private build(gl: GL2): Resources | null {
    const vs = this.shader(gl, VERTEX_SHADER, VERTEX);
    if (!vs) return null;
    const fs = this.shader(gl, FRAGMENT_SHADER, FRAGMENT);
    if (!fs) {
      gl.deleteShader(vs);
      return null;
    }
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, LINK_STATUS)) {
      this.log(`@iwer/native: depth reprojection program: ${gl.getProgramInfoLog(program) ?? ''}`);
      gl.deleteProgram(program);
      return null;
    }
    const framebuffer = gl.createFramebuffer();
    const draw = gl.getParameter(DRAW_FRAMEBUFFER_BINDING) as Handle | null;
    const read = gl.getParameter(READ_FRAMEBUFFER_BINDING) as Handle | null;
    gl.bindFramebuffer(FRAMEBUFFER, framebuffer);
    gl.drawBuffers([NONE]);  // depth only
    gl.readBuffer(NONE);
    gl.bindFramebuffer(0x8ca9, draw);
    gl.bindFramebuffer(0x8ca8, read);
    return {
      program,
      matrix: gl.getUniformLocation(program, 'u_reprojection'),
      layer: gl.getUniformLocation(program, 'u_layer'),
      depth: gl.getUniformLocation(program, 'u_depth'),
      vao: gl.createVertexArray(),
      framebuffer,
      target: null,
      width: 0,
      height: 0,
    };
  }

  private shader(gl: GL2, type: number, source: string): Handle | null {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, COMPILE_STATUS)) {
      this.log(`@iwer/native: depth reprojection shader: ${gl.getShaderInfoLog(s) ?? ''}`);
      gl.deleteShader(s);
      return null;
    }
    return s;
  }

  private allocate(gl: GL2, r: Resources, width: number, height: number): void {
    const active = gl.getParameter(ACTIVE_TEXTURE) as number;
    gl.activeTexture(TEXTURE0);
    const bound = gl.getParameter(TEXTURE_BINDING_2D_ARRAY) as Handle | null;
    if (r.target) gl.deleteTexture(r.target);
    const t = gl.createTexture();
    gl.bindTexture(TEXTURE_2D_ARRAY, t);
    gl.texStorage3D!(TEXTURE_2D_ARRAY, 1, DEPTH_COMPONENT16, width, height, 2);
    gl.texParameteri(TEXTURE_2D_ARRAY, TEXTURE_MIN_FILTER, NEAREST);
    gl.texParameteri(TEXTURE_2D_ARRAY, TEXTURE_MAG_FILTER, NEAREST);
    gl.texParameteri(TEXTURE_2D_ARRAY, TEXTURE_WRAP_S, CLAMP_TO_EDGE);
    gl.texParameteri(TEXTURE_2D_ARRAY, TEXTURE_WRAP_T, CLAMP_TO_EDGE);
    gl.bindTexture(TEXTURE_2D_ARRAY, bound);
    gl.activeTexture(active);
    r.target = t;
    r.width = width;
    r.height = height;
  }
}
