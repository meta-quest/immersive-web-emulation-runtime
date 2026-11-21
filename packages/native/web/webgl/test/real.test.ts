/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The binding on a real driver: the generated natives built as a Node addon over Mesa's surfaceless
// OpenGL ES 3.2 (llvmpipe). Skipped when the addon is not built.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realInstall, SKIP_REAL } from './real-gl.ts';
import { frameBoundary, readStats, resetStats } from '../host.ts';
import type { Ctx } from '../core.ts';

const inst = SKIP_REAL ? null : realInstall();
type GL = Record<string, (...a: any[]) => any> & Record<string, number>;
function ctx(w = 8, h = 8, attrs: Record<string, unknown> = {}): GL {
  return inst!.createContext({ width: w, height: h }, 'webgl2', attrs) as unknown as GL;
}
const opt = { skip: SKIP_REAL };

function prog(gl: GL, vs: string, fs: string): any {
  const v = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(v, vs);
  gl.compileShader(v);
  const f = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(f, fs);
  gl.compileShader(f);
  const p = gl.createProgram();
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`link failed: ${gl.getProgramInfoLog(p)} ${gl.getShaderInfoLog(v)} ${gl.getShaderInfoLog(f)}`);
  }
  return p;
}

const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

function readRGBA(gl: GL, w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
}

test('draws to the emulated default framebuffer and reads back (GL-1)', opt, () => {
  const gl = ctx(4, 4);
  const p = prog(gl, FULLSCREEN_VS, '#version 300 es\nprecision highp float;\nuniform vec4 color;\nout vec4 o;\nvoid main(){ o = color; }');
  gl.useProgram(p);
  gl.uniform4f(gl.getUniformLocation(p, 'color'), 1, 0.5, 0.25, 1);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const px = readRGBA(gl, 4, 4);
  assert.deepEqual([...px.slice(0, 4)], [255, 128, 64, 255]);
  assert.equal(gl.getError(), gl.NO_ERROR);
});

test('GL-3: textures, renderbuffers and buffers are zero-initialised', opt, () => {
  const gl = ctx();
  // garbage first, so a driver that recycles memory would show it
  for (const storage of [false, true]) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    if (storage) gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 8, 8);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 8, 8, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    const px = new Uint8Array(8 * 8 * 4).fill(7);
    gl.readPixels(0, 0, 8, 8, gl.RGBA, gl.UNSIGNED_BYTE, px);
    assert.ok(px.every((v) => v === 0), `texture (${storage ? 'texStorage2D' : 'texImage2D null'}) not zero`);
  }
  const rb = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, 4, 4);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
  const px = new Uint8Array(64).fill(9);
  gl.readPixels(0, 0, 4, 4, gl.RGBA, gl.UNSIGNED_BYTE, px);
  assert.ok(px.every((v) => v === 0));
  const b = gl.createBuffer();
  gl.bindBuffer(gl.COPY_READ_BUFFER, b);
  gl.bufferData(gl.COPY_READ_BUFFER, 4096, gl.STATIC_DRAW);
  const out = new Uint8Array(4096).fill(5);
  gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, out);
  assert.ok(out.every((v) => v === 0));
  assert.equal(gl.getError(), gl.NO_ERROR);
});

test('GL-9: WebGL errors are synthesised without driver round trips', opt, () => {
  const gl = ctx();
  const n = (gl as unknown as Ctx)._n;
  resetStats(gl as unknown as Ctx);
  // buffer type rules (WebGL 2.0 §5.1)
  const e = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, e);
  gl.bindBuffer(gl.ARRAY_BUFFER, e);
  assert.equal(gl.getError(), gl.INVALID_OPERATION);
  gl.bindBuffer(gl.COPY_READ_BUFFER, e);
  assert.equal(gl.getError(), gl.NO_ERROR);
  const o = gl.createBuffer();
  gl.bindBuffer(gl.COPY_WRITE_BUFFER, o); // first bind to COPY_* makes it "other data"
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, o);
  assert.equal(gl.getError(), gl.INVALID_OPERATION);
  // vertexAttribPointer with no ARRAY_BUFFER and an offset
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 16);
  assert.equal(gl.getError(), gl.INVALID_OPERATION);
  // draw without a program
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  assert.equal(gl.getError(), gl.INVALID_OPERATION);
  // client-side array: enabled attribute without a buffer
  const p = prog(gl, '#version 300 es\nin vec4 a;\nvoid main(){ gl_Position = a; }', '#version 300 es\nprecision highp float;\nout vec4 o;\nvoid main(){ o = vec4(1); }');
  gl.useProgram(p);
  gl.enableVertexAttribArray(0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  assert.equal(gl.getError(), gl.INVALID_OPERATION);
  gl.disableVertexAttribArray(0);
  // drawElements without an element buffer / misaligned offset
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
  gl.drawElements(gl.TRIANGLES, 3, gl.UNSIGNED_SHORT, 0);
  assert.equal(gl.getError(), gl.INVALID_OPERATION);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, e);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2]), gl.STATIC_DRAW);
  gl.drawElements(gl.TRIANGLES, 3, gl.UNSIGNED_SHORT, 1);
  assert.equal(gl.getError(), gl.INVALID_OPERATION);
  // drawBuffers rules on the default framebuffer
  gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
  assert.equal(gl.getError(), gl.INVALID_OPERATION);
  gl.drawBuffers([gl.BACK]);
  assert.equal(gl.getError(), gl.NO_ERROR);
  // feedback loop: sampling a texture attached to the draw framebuffer
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 4, 4);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  const sp = prog(gl, FULLSCREEN_VS, '#version 300 es\nprecision highp float;\nuniform sampler2D s;\nout vec4 o;\nvoid main(){ o = texture(s, vec2(0.5)); }');
  gl.useProgram(sp);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  assert.equal(gl.getError(), gl.INVALID_OPERATION);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  assert.equal(gl.getError(), gl.NO_ERROR);
  // GL-10: glGetError only on error paths: once per binding-raised error (to keep driver errors first, GL-9)
  // (9 here) and once per app getError() that finds no JS error (3 here); never on the successful calls above.
  const s = readStats(gl as unknown as Ctx);
  assert.ok(s.getErrorCalls <= 9 + 3, `glGetError calls: ${s.getErrorCalls}`);
  void n;
});

test('GL-7: typed-array offsets/lengths in elements, out of range = INVALID_VALUE, wrong type = INVALID_OPERATION', opt, () => {
  const gl = ctx();
  const b = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, b);
  const src = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
  gl.bufferData(gl.ARRAY_BUFFER, src, gl.STATIC_DRAW, 2, 4);
  assert.equal(gl.getBufferParameter(gl.ARRAY_BUFFER, gl.BUFFER_SIZE), 16);
  const out = new Float32Array(4);
  gl.bindBuffer(gl.COPY_READ_BUFFER, b);
  gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, out);
  assert.deepEqual([...out], [3, 4, 5, 6]);
  gl.bufferData(gl.ARRAY_BUFFER, src, gl.STATIC_DRAW, 9);
  assert.equal(gl.getError(), gl.INVALID_VALUE);
  gl.bufferData(gl.ARRAY_BUFFER, src, gl.STATIC_DRAW, 4, 5);
  assert.equal(gl.getError(), gl.INVALID_VALUE);
  // view byteOffset is honoured
  const big = new Float32Array([0, 0, 10, 20, 30, 40]);
  const sub = new Float32Array(big.buffer, 8, 4);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, sub);
  gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, out);
  assert.deepEqual([...out], [10, 20, 30, 40]);
  // texImage2D view type must match type
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Float32Array(16));
  assert.equal(gl.getError(), gl.INVALID_OPERATION);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(15));
  assert.equal(gl.getError(), gl.INVALID_OPERATION, 'too small');
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8ClampedArray(16));
  assert.equal(gl.getError(), gl.NO_ERROR);
  // uniform*fv: a plain array and a Float64Array are converted as sequences
  const p = prog(gl, FULLSCREEN_VS, '#version 300 es\nprecision highp float;\nuniform vec4 c;\nout vec4 o;\nvoid main(){ o = c; }');
  gl.useProgram(p);
  const loc = gl.getUniformLocation(p, 'c');
  gl.uniform4fv(loc, [0, 1, 0, 1]);
  gl.uniform4fv(loc, new Float64Array([1, 0, 0, 1]));
  assert.equal(gl.getError(), gl.NO_ERROR);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  assert.deepEqual([...readRGBA(gl, 1, 1)], [255, 0, 0, 255]);
  gl.uniform4fv(loc, new Float32Array([1, 1, 1, 1, 1, 1, 1, 1]), 2, 3);
  assert.equal(gl.getError(), gl.INVALID_VALUE, 'length not a multiple of 4');
  assert.throws(() => gl.uniform4fv(loc, 7), TypeError);
});

test('GL-7 fuzz: random offsets / lengths / view types never read or write outside the view', opt, () => {
  const gl = ctx();
  const b = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, 256, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.COPY_READ_BUFFER, b);
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  let seed = 12345;
  const rnd = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const kinds = [Uint8Array, Uint16Array, Float32Array, Int32Array, Uint8ClampedArray, Float64Array] as const;
  const before = readStats(gl as unknown as Ctx).rejected;
  for (let i = 0; i < 3000; i++) {
    const K = kinds[rnd(kinds.length)];
    const buf = new ArrayBuffer(128);
    const view = new K(buf, rnd(4) * 8, rnd(8));
    const off = rnd(12);
    const len = rnd(12);
    const which = rnd(4);
    if (which === 0) gl.bufferSubData(gl.ARRAY_BUFFER, rnd(300), view, off, len);
    else if (which === 1) gl.getBufferSubData(gl.COPY_READ_BUFFER, rnd(300), view, off, len);
    else if (which === 2) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, rnd(4), rnd(4), 0, gl.RGBA, gl.UNSIGNED_BYTE, view, off);
    else gl.readPixels(0, 0, rnd(4), rnd(4), gl.RGBA, gl.UNSIGNED_BYTE, view, off);
    gl.getError();
  }
  // every out-of-range case was caught in JS before the natives' own bounds check had to reject it
  assert.equal(readStats(gl as unknown as Ctx).rejected - before, 0);
});

test('GL-21: one programInfo per link, one shaderInfo per compile, reflection answered in JS', opt, () => {
  const gl = ctx();
  resetStats(gl as unknown as Ctx);
  const p = prog(
    gl,
    '#version 300 es\nin vec3 position;\nin vec2 uv;\nuniform mat4 mvp;\nuniform vec4 bones[8];\nout vec2 v;\nvoid main(){ v = uv; gl_Position = mvp * vec4(position + bones[7].xyz, 1.0); }',
    '#version 300 es\nprecision highp float;\nin vec2 v;\nuniform sampler2D map;\nlayout(std140) uniform Light { vec4 dir; vec4 col; };\nout vec4 o;\nvoid main(){ o = texture(map, v) * col + dir; }',
  );
  const nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  const names: string[] = [];
  for (let i = 0; i < nu; i++) names.push(gl.getActiveUniform(p, i).name);
  assert.ok(names.includes('bones[0]') && names.includes('mvp') && names.includes('map') && names.includes('dir'));
  assert.ok(gl.getUniformLocation(p, 'bones[3]'));
  assert.equal(gl.getUniformLocation(p, 'bones[8]'), null);
  assert.equal(gl.getUniformLocation(p, 'dir'), null, 'block members have no location');
  const bi = gl.getUniformBlockIndex(p, 'Light');
  assert.equal(gl.getActiveUniformBlockParameter(p, bi, gl.UNIFORM_BLOCK_DATA_SIZE), 32);
  const idx = gl.getUniformIndices(p, ['col', 'mvp']);
  assert.deepEqual(gl.getActiveUniforms(p, idx, gl.UNIFORM_OFFSET), [16, -1]);
  assert.ok(gl.getAttribLocation(p, 'uv') >= 0);
  const s = readStats(gl as unknown as Ctx);
  assert.equal(s.programInfoCalls, 1);
  assert.equal(s.shaderInfoCalls, 0, 'prog() reads link status only; shader logs are fetched on demand');
  // sync queries reaching native code: programInfo only (plus none for all the getters above)
  assert.equal(s.syncQueries, 1);
});

test('GL-24: OVR_multiview2 renders one colour per view into a texture array', opt, () => {
  const gl = ctx(4, 4);
  const ext = gl.getExtension('OVR_multiview2');
  if (!ext) return;
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, 4, 4, 2);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb);
  (ext as any).framebufferTextureMultiviewOVR(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, t, 0, 0, 2);
  assert.equal(gl.getFramebufferAttachmentParameter(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, (ext as any).FRAMEBUFFER_ATTACHMENT_TEXTURE_NUM_VIEWS_OVR), 2);
  const mvVS = `#version 300 es
#extension GL_OVR_multiview2 : require
layout(num_views = 2) in;
flat out int view;
void main() {
  view = int(gl_ViewID_OVR);
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;
  const mvFS = '#version 300 es\nprecision highp float;\nflat in int view;\nout vec4 o;\nvoid main(){ o = view == 0 ? vec4(1,0,0,1) : vec4(0,1,0,1); }';
  const p = prog(gl, mvVS, mvFS);
  gl.useProgram(p);
  gl.viewport(0, 0, 4, 4);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  assert.equal(gl.getError(), gl.NO_ERROR);
  const rfb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, rfb);
  for (const [layer, expect] of [[0, [255, 0, 0, 255]], [1, [0, 255, 0, 255]]] as const) {
    gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, t, 0, layer);
    const px = new Uint8Array(4);
    gl.readPixels(1, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    assert.deepEqual([...px], [...expect], `layer ${layer}`);
  }
  // a non-multiview program on the multiview framebuffer: INVALID_OPERATION (view count mismatch)
  const flat = prog(gl, FULLSCREEN_VS, '#version 300 es\nprecision highp float;\nout vec4 o;\nvoid main(){ o = vec4(1); }');
  gl.useProgram(flat);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  assert.equal(gl.getError(), gl.INVALID_OPERATION);
});

test('GL-25: WEBGL_multi_draw with gl_DrawID, count-0 entries draw nothing, list errors', opt, () => {
  const gl = ctx(4, 1);
  const md = gl.getExtension('WEBGL_multi_draw') as any;
  assert.ok(md);
  const vs = `#version 300 es
#extension GL_ANGLE_multi_draw : require
flat out int id;
void main() {
  id = gl_DrawID;
  // sub-draw i covers pixel column i (4 x 1 target)
  float x0 = -1.0 + 0.5 * float(gl_DrawID);
  vec2 c[3] = vec2[3](vec2(x0, -1.0), vec2(x0 + 1.0, -1.0), vec2(x0, 3.0));
  gl_Position = vec4(c[gl_VertexID % 3], 0.0, 1.0);
}`;
  const fs = '#version 300 es\nprecision highp float;\nflat in int id;\nout vec4 o;\nvoid main(){ o = vec4(float(id + 1) / 255.0, 0, 0, 1); }';
  const p = prog(gl, vs, fs);
  gl.useProgram(p);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  md.multiDrawArraysWEBGL(gl.TRIANGLES, new Int32Array([0, 0, 0, 0]), 0, new Int32Array([3, 0, 3, 3]), 0, 4);
  assert.equal(gl.getError(), gl.NO_ERROR);
  const px = readRGBA(gl, 4, 1);
  assert.deepEqual([px[0], px[4], px[8], px[12]], [1, 0, 3, 4]);
  md.multiDrawArraysWEBGL(gl.TRIANGLES, [0], 0, [3], 0, -1);
  assert.equal(gl.getError(), gl.INVALID_VALUE);
  md.multiDrawArraysWEBGL(gl.TRIANGLES, [0], 1, [3], 0, 1);
  assert.equal(gl.getError(), gl.INVALID_OPERATION);
  md.multiDrawArraysWEBGL(gl.TRIANGLES, [0], 0, [3], 0, 0);
  assert.equal(gl.getError(), gl.NO_ERROR);
  assert.equal(gl.getShaderSource(gl.getAttachedShaders(p)[0]), vs, 'getShaderSource returns the app source');
});

test('GL-16: UNPACK_FLIP_Y / PREMULTIPLY for typed arrays and ImageData; ignored for ImageBitmap-like sources', opt, () => {
  const gl = ctx(2, 2);
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  const fb = gl.createFramebuffer();
  const src = new Uint8Array([255, 0, 0, 128, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 0]); // 2x2
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, src);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  let px = readRGBA(gl, 2, 2);
  // row 0 of the texture is the source's last row, premultiplied
  assert.deepEqual([...px.slice(0, 8)], [0, 0, 255, 255, 0, 0, 0, 0]);
  assert.deepEqual([...px.slice(8, 12)], [128, 0, 0, 128]);
  assert.deepEqual([...src.slice(0, 4)], [255, 0, 0, 128], 'source untouched');
  // ImageData source with flipY
  const imageData = { width: 2, height: 2, data: new Uint8ClampedArray(src) };
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, imageData);
  px = readRGBA(gl, 2, 2);
  assert.deepEqual([...px.slice(0, 4)], [0, 0, 255, 255]);
  // bitmap-like source: flags ignored
  const bitmap = {
    [Symbol.for('iwn.texImageSource')]: () => ({ width: 2, height: 2, data: src, premultiplied: false, isBitmap: true }),
  };
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
  px = readRGBA(gl, 2, 2);
  assert.deepEqual([...px.slice(0, 4)], [255, 0, 0, 128]);
  // flags + unpack buffer / 3D typed array = INVALID_OPERATION
  const ta = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, ta);
  gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  assert.equal(gl.getError(), gl.INVALID_OPERATION);
  // closed bitmap: InvalidStateError; video: TypeError
  const closed = { [Symbol.for('iwn.texImageSource')]: () => ({ closed: true }) };
  assert.throws(() => gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, closed), (e: Error) => e.name === 'InvalidStateError');
  class HTMLVideoElement {}
  assert.throws(() => gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, new HTMLVideoElement()), TypeError);
  // XR-CAM-1: a <video> playing a camera stream is an image source of its newest frame (web/dom); flags apply
  const frame = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255]);
  const IMAGE_SOURCE = Symbol.for('iwn.image.source');
  class PlayingVideo {
    [IMAGE_SOURCE]() {
      return { kind: 'pixels', origin: 'video', width: 2, height: 2, premultiplied: false, data: frame };
    }
  }
  Object.defineProperty(PlayingVideo, 'name', { value: 'HTMLVideoElement' });
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, new PlayingVideo());
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  assert.equal(gl.getError(), gl.NO_ERROR);
  px = readRGBA(gl, 2, 2);
  assert.deepEqual([...px.slice(0, 4)], [70, 80, 90, 255], 'flipped: the last row of the frame first');
});

test('GL-16/17: runtime/image sources (Symbol.for("iwn.image.source")): pixels and native-handle descriptors', opt, () => {
  const gl = ctx(2, 2);
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  const src = new Uint8Array([255, 0, 0, 128, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 0]); // 2x2 straight
  const IMAGE_SOURCE = Symbol.for('iwn.image.source');
  // 'pixels' (ImageData-like origin): flags apply
  const imageData = { [IMAGE_SOURCE]: () => ({ kind: 'pixels', origin: 'imagedata', width: 2, height: 2, premultiplied: false, data: src }) };
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, imageData);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  assert.deepEqual([...readRGBA(gl, 2, 2).slice(0, 4)], [0, 0, 255, 255]);
  // 'handle': emulate runtime/image's native store (padded rows) with the documented imageUpload/imageRead semantics
  // (the host addon is built without the image module, where both return false).
  const c = gl as unknown as Ctx;
  const real = c._n;
  const stride = 16; // 2 px + 8 bytes padding per row
  const store = new Uint8Array(stride * 2);
  store.set(src.subarray(0, 8), 0);
  store.set(src.subarray(8, 16), stride);
  let closed = false;
  const calls: string[] = [];
  const tight = (flipY: boolean): Uint8Array => {
    const out = new Uint8Array(16);
    for (let y = 0; y < 2; y++) out.set(store.subarray((flipY ? 1 - y : y) * stride, (flipY ? 1 - y : y) * stride + 8), y * 8);
    return out;
  };
  const handle = {};
  c._n = Object.assign(Object.create(real), {
    imageUpload(h: object, target: number, level: number, ifmt: number, x: number, y: number, z: number, mode: number, flipY: boolean, alpha: number) {
      calls.push(`upload:${mode}:${flipY}:${alpha}`);
      if (h !== handle || closed) return false;
      const px = tight(flipY);
      if (mode === 0) real.texImage2D(target, level, ifmt, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, px, 0, 16);
      else real.texSubImage2D(target, level, x, y, 2, 2, gl.RGBA, gl.UNSIGNED_BYTE, px, 0, 16);
      return true;
    },
    imageRead(h: object, dst: Uint8Array, off: number, bytes: number, flipY: boolean, alpha: number) {
      calls.push(`read:${bytes}`);
      if (h !== handle || closed) return false;
      dst.set(tight(flipY), off);
      return true;
    },
  });
  try {
    const image = { [IMAGE_SOURCE]: () => ({ kind: 'handle', origin: 'image', width: 2, height: 2, premultiplied: false, handle }) };
    const bitmap = { [IMAGE_SOURCE]: () => ({ kind: 'handle', origin: 'bitmap', width: 2, height: 2, premultiplied: false, handle }) };
    // RGBA8 whole image: one native upload straight from the store, flags passed through
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    // the 2x2 RGBA level above came from another path (its type is not known here): allocated again (mode 0)
    assert.deepEqual(calls, ['upload:0:true:1']);
    // respecified at the same size from native pixels again, it is replaced in place (mode 1)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    assert.deepEqual(calls, ['upload:0:true:1', 'upload:1:true:1']);
    calls.splice(0, 1);
    assert.deepEqual([...readRGBA(gl, 2, 2).slice(0, 4)], [0, 0, 255, 255]);
    // a fresh texture, a level of another size or another internal format: allocated (mode 0)
    const fresh = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, fresh);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texImage2D(gl.TEXTURE_2D, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
    assert.deepEqual(calls.slice(1), ['upload:0:true:1', 'upload:0:true:1', 'upload:1:true:1', 'upload:0:true:1']);
    gl.deleteTexture(fresh);
    gl.bindTexture(gl.TEXTURE_2D, t);
    assert.equal(gl.getError(), gl.NO_ERROR);
    // ImageBitmap: flags ignored (GL-16)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    assert.deepEqual(calls.at(-1), 'upload:1:false:-1');
    assert.deepEqual([...readRGBA(gl, 2, 2).slice(0, 4)], [255, 0, 0, 128]);
    assert.equal(gl.getError(), gl.NO_ERROR);
    // other formats: one tight copy, converted in JS (flip + premultiply here)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);
    assert.deepEqual(calls.at(-1), 'read:16');
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_SHORT_4_4_4_4, image);
    const px = readRGBA(gl, 2, 2);
    assert.deepEqual([...px.slice(0, 4)], [0, 0, 255, 255]);
    assert.deepEqual([...px.slice(8, 11)].map((v) => v >> 4), [8, 0, 0], 'premultiplied red at alpha 128');
    // sub-rectangle (UNPACK_SKIP_PIXELS) also goes through the copy
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, image);
    assert.deepEqual(calls.at(-1), 'read:16');
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    assert.equal(gl.getError(), gl.NO_ERROR);
    // closed underneath: InvalidStateError, no GL error
    closed = true;
    assert.throws(() => gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image), (e: Error) => e.name === 'InvalidStateError');
    assert.throws(() => gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image), (e: Error) => e.name === 'InvalidStateError');
    // producer throws (closed bitmap): passed through
    const err = Object.assign(new Error('closed'), { name: 'InvalidStateError' });
    const thrower = { [IMAGE_SOURCE]: () => { throw err; } };
    assert.throws(() => gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, thrower), (e: Error) => e === err);
    assert.equal(gl.getError(), gl.NO_ERROR);
  } finally {
    c._n = real;
  }
  // the real addon has no image module: a handle upload reports a closed source rather than touching memory
  const image = { [IMAGE_SOURCE]: () => ({ kind: 'handle', origin: 'image', width: 2, height: 2, premultiplied: false, handle: {} }) };
  assert.throws(() => gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image), (e: Error) => e.name === 'InvalidStateError');
});

test('GL-15: query and sync results are not available in the same task', opt, async () => {
  const gl = ctx();
  const s = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  gl.finish();
  assert.equal(gl.getSyncParameter(s, gl.SYNC_STATUS), gl.UNSIGNALED);
  assert.equal(gl.clientWaitSync(s, 0, 0), gl.TIMEOUT_EXPIRED);
  gl.clientWaitSync(s, 0, 1);
  assert.equal(gl.getError(), gl.INVALID_OPERATION, 'timeout above MAX_CLIENT_WAIT_TIMEOUT_WEBGL');
  const q = gl.createQuery();
  gl.beginQuery(gl.ANY_SAMPLES_PASSED, q);
  gl.endQuery(gl.ANY_SAMPLES_PASSED);
  gl.finish();
  assert.equal(gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE), false);
  await new Promise((r) => setTimeout(r, 5));
  frameBoundary(null);
  assert.equal(gl.getSyncParameter(s, gl.SYNC_STATUS), gl.SIGNALED);
  assert.equal(gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE), true);
  assert.equal(gl.getQueryParameter(q, gl.QUERY_RESULT), 0, 'nothing drawn: no samples passed (GLuint)');
});

test('GL-4: WEBGL_lose_context loses and restores', opt, async () => {
  const events: string[] = [];
  const canvas = {
    width: 4,
    height: 4,
    dispatchEvent(ev: { type: string; preventDefault?: () => void }) {
      events.push(ev.type);
      if (ev.type === 'webglcontextlost') ev.preventDefault?.();
      return ev.type !== 'webglcontextlost';
    },
  };
  const gl = inst!.createContext(canvas, 'webgl2') as unknown as GL;
  const ext = gl.getExtension('WEBGL_lose_context') as any;
  ext.loseContext();
  assert.equal(gl.isContextLost(), true);
  assert.equal(gl.getError(), gl.CONTEXT_LOST_WEBGL);
  assert.equal(gl.getError(), gl.NO_ERROR);
  assert.equal(gl.createBuffer(), null);
  assert.equal(gl.getParameter(gl.VIEWPORT), null);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(events, ['webglcontextlost']);
  ext.restoreContext();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(gl.isContextLost(), false);
  assert.deepEqual(events, ['webglcontextlost', 'webglcontextrestored']);
  assert.ok(gl.createBuffer());
});

test('C2D-2 / REG-10: two contexts keep independent state', opt, () => {
  const a = ctx(2, 2);
  const b = ctx(2, 2);
  a.clearColor(1, 0, 0, 1);
  b.clearColor(0, 1, 0, 1);
  a.clear(a.COLOR_BUFFER_BIT);
  b.clear(b.COLOR_BUFFER_BIT);
  assert.deepEqual([...readRGBA(a, 1, 1)], [255, 0, 0, 255]);
  assert.deepEqual([...readRGBA(b, 1, 1)], [0, 255, 0, 255]);
  a.viewport(0, 0, 1, 1);
  assert.deepEqual([...b.getParameter(b.VIEWPORT)], [0, 0, 2, 2]);
});

test('GL-PERF-2 coherency fuzz: random state sequences render identically with and without the cache', opt, () => {
  // Context A goes through the binding (cached); context B issues the same sequence straight to the natives.
  // antialias off: B reads its default framebuffer with raw natives (no resolve step)
  const A = ctx(8, 8, { antialias: false });
  const B = ctx(8, 8, { antialias: false });
  const nb = (B as unknown as Ctx)._n;
  const ctxB = B as unknown as Ctx;
  const vs = FULLSCREEN_VS;
  const fs = '#version 300 es\nprecision highp float;\nuniform vec4 c;\nout vec4 o;\nvoid main(){ o = c; }';
  const pa = prog(A, vs, fs);
  const pb = prog(B, vs, fs);
  A.useProgram(pa);
  B.useProgram(pb);
  A.clear(A.COLOR_BUFFER_BIT); // allocates both emulated default framebuffers
  B.clear(B.COLOR_BUFFER_BIT);
  const la = A.getUniformLocation(pa, 'c');
  const lb = B.getUniformLocation(pb, 'c');
  let seed = 7;
  const rnd = (n: number): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % n;
  };
  const values = [0, 0.25, 0.5, 1];
  for (let frame = 0; frame < 40; frame++) {
    for (let k = 0; k < 30; k++) {
      const op = rnd(7);
      const v = [values[rnd(4)], values[rnd(4)], values[rnd(4)], values[rnd(4)]];
      if (op === 0) {
        A.uniform4f(la, v[0], v[1], v[2], v[3]);
        ctxB._skip();
        nb.uniform4f(lb._loc, v[0], v[1], v[2], v[3]);
      } else if (op === 1) {
        const on = rnd(2) === 1;
        (on ? A.enable : A.disable).call(A, A.BLEND);
        ctxB._skip();
        if (on) nb.enable(A.BLEND);
        else nb.disable(A.BLEND);
      } else if (op === 2) {
        const f = [A.ONE, A.ZERO, A.SRC_ALPHA, A.ONE_MINUS_SRC_ALPHA][rnd(4)];
        A.blendFunc(f, A.ONE_MINUS_SRC_ALPHA);
        ctxB._skip();
        nb.blendFunc(f, A.ONE_MINUS_SRC_ALPHA);
      } else if (op === 3) {
        const m = [rnd(2) === 1, rnd(2) === 1, true, true];
        A.colorMask(m[0], m[1], m[2], m[3]);
        ctxB._skip();
        nb.colorMask(m[0], m[1], m[2], m[3]);
      } else if (op === 4) {
        const x = rnd(4);
        A.scissor(x, x, 4, 4);
        ctxB._skip();
        nb.scissor(x, x, 4, 4);
      } else if (op === 5) {
        const on = rnd(2) === 1;
        (on ? A.enable : A.disable).call(A, A.SCISSOR_TEST);
        ctxB._skip();
        if (on) nb.enable(A.SCISSOR_TEST);
        else nb.disable(A.SCISSOR_TEST);
      } else {
        A.drawArrays(A.TRIANGLES, 0, 3);
        ctxB._skip();
        nb.drawArrays(A.TRIANGLES, 0, 3);
      }
    }
    A.disable(A.SCISSOR_TEST);
    ctxB._skip();
    nb.disable(A.SCISSOR_TEST);
    A.colorMask(true, true, true, true);
    ctxB._skip();
    nb.colorMask(true, true, true, true);
    const pxA = readRGBA(A, 8, 8);
    ctxB._skip();
    const pxB = new Uint8Array(256);
    nb.readPixels(0, 0, 8, 8, A.RGBA, A.UNSIGNED_BYTE, pxB, 0, 256);
    assert.deepEqual([...pxA], [...pxB], `frame ${frame}`);
  }
});

test('GL-24 (MSAA): OCULUS_multiview renders one colour per view with 4x multisampled-render-to-texture', opt, () => {
  const gl = ctx(4, 4);
  const ext = gl.getExtension('OCULUS_multiview') as any;
  if (!ext) return; // driver lacks GL_OVR_multiview_multisampled_render_to_texture (Mesa); runs on Quest
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, 4, 4, 2);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb);
  ext.framebufferTextureMultisampleMultiviewOVR(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, t, 0, 4, 0, 2);
  assert.equal(gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER), gl.FRAMEBUFFER_COMPLETE);
  const p = prog(
    gl,
    `#version 300 es
#extension GL_OVR_multiview2 : require
layout(num_views = 2) in;
flat out int view;
void main() {
  view = int(gl_ViewID_OVR);
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`,
    '#version 300 es\nprecision highp float;\nflat in int view;\nout vec4 o;\nvoid main(){ o = view == 0 ? vec4(1,0,0,1) : vec4(0,0,1,1); }',
  );
  gl.useProgram(p);
  gl.viewport(0, 0, 4, 4);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  assert.equal(gl.getError(), gl.NO_ERROR);
  const rfb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, rfb);
  for (const [layer, expect] of [[0, [255, 0, 0, 255]], [1, [0, 0, 255, 255]]] as const) {
    gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, t, 0, layer);
    const px = new Uint8Array(4);
    gl.readPixels(2, 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    assert.deepEqual([...px], [...expect], `layer ${layer} (resolved on tile store)`);
  }
});

test('GL-20: KHR_parallel_shader_compile: 40 programs compile without blocking; status polls are cheap', opt, async () => {
  const gl = ctx(4, 4);
  const ext = gl.getExtension('KHR_parallel_shader_compile');
  if (!ext) return;
  const now = (): number => performance.now();
  const programs: unknown[] = [];
  const t0 = now();
  for (let i = 0; i < 40; i++) {
    const v = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(v, `#version 300 es\nin vec4 a;\nuniform mat4 m[${4 + i}];\nvoid main(){ gl_Position = m[${3 + i}] * a * float(${i}); }`);
    gl.compileShader(v);
    const f = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(f, `#version 300 es\nprecision highp float;\nuniform vec4 c;\nout vec4 o;\nvoid main(){ o = c * ${i + 1}.0; }`);
    gl.compileShader(f);
    const p = gl.createProgram();
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    programs.push(p);
  }
  const issue = now() - t0;
  const polls: number[] = [];
  let done = 0;
  for (let round = 0; round < 2000 && done < programs.length; round++) {
    done = 0;
    for (const p of programs) {
      const s = now();
      const complete = gl.getProgramParameter(p, ext ? (ext as { COMPLETION_STATUS_KHR: number }).COMPLETION_STATUS_KHR : 0);
      polls.push(now() - s);
      if (complete) done++;
    }
    if (done < programs.length) await new Promise((r) => setTimeout(r, 2));
  }
  assert.equal(done, programs.length, 'all programs complete eventually');
  for (const p of programs) assert.equal(gl.getProgramParameter(p, gl.LINK_STATUS), true);
  polls.sort((a, b) => a - b);
  const median = polls[polls.length >> 1];
  console.log(`# GL-20: issue 40 compiles+links ${issue.toFixed(1)} ms, median poll ${(median * 1000).toFixed(1)} us over ${polls.length} polls`);
  assert.ok(median < 0.05, `median COMPLETION_STATUS poll ${(median * 1000).toFixed(1)} us`);
});

test('GL-26: EXT_disjoint_timer_query_webgl2 measures GPU time across frames', opt, async () => {
  const gl = ctx(64, 64, { antialias: false });
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as any;
  if (!ext) return;
  const p = prog(gl, FULLSCREEN_VS, '#version 300 es\nprecision highp float;\nout vec4 o;\nvoid main(){ o = vec4(0.5); }');
  gl.useProgram(p);
  const q = gl.createQuery();
  gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
  for (let i = 0; i < 20; i++) gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.endQuery(ext.TIME_ELAPSED_EXT);
  assert.equal(gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE), false, 'not in the same task');
  let available = false;
  for (let i = 0; i < 200 && !available; i++) {
    await new Promise((r) => setTimeout(r, 5));
    frameBoundary(null);
    available = gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE);
  }
  assert.ok(available);
  const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
  const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
  console.log(`# GL-26: 20 full-screen draws took ${ns} ns of GPU time (disjoint=${disjoint})`);
  // llvmpipe reports an absolute timestamp for TIME_ELAPSED (driver bug); real GPUs give the elapsed time.
  const llvmpipe = /llvmpipe/.test((gl as unknown as Ctx)._info.renderer);
  if (!disjoint && !llvmpipe) assert.ok(ns > 0 && ns < 1e9, `elapsed ${ns} ns`);
});
