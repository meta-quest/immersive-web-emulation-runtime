/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Regression tests for GL-CTS-1 failures seen only on the Quest's Adreno driver (device run, revision 2). Mesa
// does not show the driver behaviour, so these check what the binding sends to the driver (spied natives) and
// what it answers itself. Real driver (host addon over Mesa); skipped when the addon is not built.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realInstall, realNatives, SKIP_REAL } from './real-gl.ts';
import { sharedExponentMaskConflict } from '../framebuffers.ts';
import { releaseAllContexts } from '../core.ts';

const inst = SKIP_REAL ? null : realInstall();
const n = realNatives() as any;
type GL = Record<string, (...a: any[]) => any> & Record<string, number>;
function ctx(): GL {
  return inst!.createContext({ width: 4, height: 4 }, 'webgl2', { antialias: false }) as unknown as GL;
}
const opt = { skip: SKIP_REAL };

/** Records calls of one native while `body` runs (optionally replacing it). */
function spy(name: string, body: () => void, replace?: (orig: (...a: any[]) => any, ...a: any[]) => any): any[][] {
  const orig = n[name];
  const calls: any[][] = [];
  n[name] = (...a: any[]) => {
    calls.push(a);
    return replace ? replace(orig, ...a) : orig(...a);
  };
  try {
    body();
  } finally {
    n[name] = orig;
  }
  return calls;
}

test('CTS query.html (Adreno): deleting an active query ends it in the driver', opt, () => {
  const gl = ctx();
  const q = gl.createQuery();
  gl.beginQuery(gl.ANY_SAMPLES_PASSED, q);
  const ends = spy('endQuery', () => gl.deleteQuery(q));
  assert.deepEqual(ends, [[gl.ANY_SAMPLES_PASSED]]);
  assert.equal(gl.getQuery(gl.ANY_SAMPLES_PASSED, gl.CURRENT_QUERY), null);
  const q2 = gl.createQuery();
  gl.beginQuery(gl.ANY_SAMPLES_PASSED, q2);
  gl.endQuery(gl.ANY_SAMPLES_PASSED);
  assert.equal(gl.getError(), 0);
});

test('CTS uniform-block-buffer-size (Adreno): the driver gets a vec4-rounded uniform range, getters the real one', opt, () => {
  const gl = ctx();
  const b = gl.createBuffer();
  gl.bindBuffer(gl.UNIFORM_BUFFER, b);
  gl.bufferData(gl.UNIFORM_BUFFER, 64, gl.DYNAMIC_DRAW);
  const calls = spy('bindBufferRange', () => gl.bindBufferRange(gl.UNIFORM_BUFFER, 1, b, 0, 31));
  assert.equal(calls[0][4], 32);
  assert.equal(gl.getIndexedParameter(gl.UNIFORM_BUFFER_SIZE, 1), 31);
  assert.equal(gl.getError(), 0);
});

test('CTS framebuffer-completeness-draw-framebuffer (Adreno): a texture without images is INCOMPLETE_ATTACHMENT', opt, () => {
  const gl = ctx();
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  assert.equal(gl.checkFramebufferStatus(gl.FRAMEBUFFER), gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 4, 4);
  assert.equal(gl.checkFramebufferStatus(gl.FRAMEBUFFER), gl.FRAMEBUFFER_COMPLETE);
});

test('CTS format-filterable-renderable (Adreno): SRGB8 and RGB integer textures are never colour-renderable', opt, () => {
  const gl = ctx();
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  for (const [fmt, f, type] of [
    [gl.SRGB8, gl.RGB, gl.UNSIGNED_BYTE],
    [gl.RGB8UI, gl.RGB_INTEGER, gl.UNSIGNED_BYTE],
    [gl.RGB32I, gl.RGB_INTEGER, gl.INT],
  ]) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt, 2, 2, 0, f, type, null);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    assert.equal(gl.checkFramebufferStatus(gl.FRAMEBUFFER), gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT, `format 0x${fmt.toString(16)}`);
  }
});

test('CTS blending.html (Adreno): a driver that clamps BLEND_COLOR is detected once and getParameter follows it', opt, () => {
  const gl = ctx();
  const reads = spy('blendColor', () => {
    const q = spy('getFloatv', () => gl.blendColor(10, 0.5, 2, -1), (orig, pname, view, off, bytes) => {
      orig(pname, view, off, bytes);
      if (pname === gl.BLEND_COLOR) for (let i = 0; i < 4; i++) view[i] = Math.min(1, Math.max(0, view[i]));
    });
    assert.equal(q.length, 1);
    assert.deepEqual([...gl.getParameter(gl.BLEND_COLOR)], [1, 0.5, 1, 0]);
    const again = spy('getFloatv', () => gl.blendColor(20, 0, 0, 0));
    assert.equal(again.length, 0); // known now: no further driver queries
    assert.deepEqual([...gl.getParameter(gl.BLEND_COLOR)], [1, 0, 0, 0]);
  });
  assert.equal(reads.length, 2);
  // Mesa stores it unclamped: a fresh context keeps WebGL 2's unclamped value
  const gl2 = ctx();
  gl2.blendColor(10, 1, 1, 1);
  assert.equal(gl2.getParameter(gl2.BLEND_COLOR)[0], 10);
});

test('CTS multisampled-renderbuffer-initialization (Adreno): reallocating an attached renderbuffer re-attaches it', opt, () => {
  const gl = ctx();
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  const rb = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
  gl.renderbufferStorageMultisample(gl.RENDERBUFFER, 4, gl.RGBA8, 5, 5);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
  const calls = spy('framebufferRenderbuffer', () => gl.renderbufferStorageMultisample(gl.RENDERBUFFER, 4, gl.RGBA8, 8, 8));
  assert.deepEqual(calls, [[gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, (rb as any)._name]]);
  assert.equal(gl.checkFramebufferStatus(gl.FRAMEBUFFER), gl.FRAMEBUFFER_COMPLETE);
  assert.equal(gl.getError(), 0);
});

test('WEBGL_render_shared_exponent: a partial colour mask on an enabled RGB9_E5 draw buffer conflicts', () => {
  const COLOR_ATTACHMENT0 = 0x8ce0;
  const fb = { _rgb9e5: 0b01, _drawBuffers: [COLOR_ATTACHMENT0, COLOR_ATTACHMENT0 + 1] } as any;
  const c = { _bufMaskPartial: 0 } as any;
  assert.equal(sharedExponentMaskConflict(c, fb), false); // all-on / all-off masks are fine
  c._bufMaskPartial = 0xffff;
  assert.equal(sharedExponentMaskConflict(c, fb), true);
  assert.equal(sharedExponentMaskConflict(c, fb, 1), false); // clearBuffer on the RGBA8 buffer
  fb._drawBuffers = [0, COLOR_ATTACHMENT0 + 1]; // RGB9_E5 buffer disabled (NONE)
  assert.equal(sharedExponentMaskConflict(c, fb), false);
});

test('CTS multisample-with-full-sample-counts (Adreno): a new context sets SAMPLE_COVERAGE_VALUE in the driver', opt, () => {
  const calls = spy('sampleCoverage', () => ctx());
  assert.deepEqual(calls, [[1, false]]);
});

test('CTS ext-shader-texture-lod / glsl-built-ins (WebGL 1): enabled-extension macros and gl_MaxDrawBuffers', opt, () => {
  const gl = inst!.createContext({ width: 4, height: 4 }, 'webgl', { antialias: false }) as unknown as GL;
  const compiles = (src: string): boolean => {
    const s = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) as unknown as boolean;
  };
  const macro = `precision mediump float;
void main() {
#ifdef GL_EXT_shader_texture_lod
  gl_FragColor = vec4(0.0);
#else
  #error no GL_EXT_shader_texture_lod
#endif
}`;
  assert.equal(compiles(macro), false, 'not enabled: the macro is undefined');
  if (gl.getExtension('EXT_shader_texture_lod')) assert.equal(compiles(macro), true);
  const maxDb = `precision mediump float;
void main() {
#if 1
  gl_FragColor = gl_MaxDrawBuffers == 1 ? vec4(0.0, 1.0, 0.0, 1.0) : vec4(1.0, 0.0, 0.0, 1.0);
#endif
}`;
  assert.equal(compiles(maxDb), true);
});

test('page teardown (pagehide before location.reload) deletes every context\'s GL objects and EGL context', opt, () => {
  const a = ctx();
  const b = ctx();
  const ta = a.createTexture();
  a.bindTexture(a.TEXTURE_2D, ta);
  a.texStorage2D(a.TEXTURE_2D, 1, a.RGBA8, 4, 4);
  const bb = b.createBuffer();
  b.bindBuffer(b.ARRAY_BUFFER, bb);
  const deletedTex: any[][] = [];
  const deletedBuf: any[][] = [];
  const destroyed = spy('contextDestroy', () => {
    deletedTex.push(...spy('deleteTexture', () => {
      deletedBuf.push(...spy('deleteBuffer', () => releaseAllContexts()));
    }));
  });
  assert.ok(destroyed.length >= 2, `contextDestroy calls: ${destroyed.length}`);
  assert.ok(deletedTex.some((c) => c[0] === (ta as any)._name));
  assert.ok(deletedBuf.some((c) => c[0] === (bb as any)._name));
  assert.equal(a.isContextLost(), true);
  assert.equal(releaseAllContexts(), 0); // nothing left
});
