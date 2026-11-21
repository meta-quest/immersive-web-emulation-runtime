/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// A GL call recorder implementing the natives interface without a driver: names are allocated, every call is
// counted (and optionally logged), limits come from a Quest-3-like table, and program reflection is derived
// from the shader sources with a small GLSL declaration scanner. Used by the headless tests (state cache
// counts, IDL coverage, error synthesis) and by the headless runner when no GL is available.

import type { GlNatives } from '../gen/natives.gen.ts';
import { NATIVES } from '../gen/natives.gen.ts';

export interface FakeGl {
  natives: GlNatives;
  /** calls per native name */
  calls: Map<string, number>;
  /** every call as [name, ...args] when logging is on */
  log: unknown[][];
  logging: boolean;
  reset(): void;
  total(): number;
}

const LIMITS: Record<number, number> = {
  0x8869: 16, // MAX_VERTEX_ATTRIBS
  0x8b4d: 96, // MAX_COMBINED_TEXTURE_IMAGE_UNITS
  0x8872: 32, // MAX_TEXTURE_IMAGE_UNITS
  0x8b4c: 16, // MAX_VERTEX_TEXTURE_IMAGE_UNITS
  0x8824: 8, // MAX_DRAW_BUFFERS
  0x8cdf: 8, // MAX_COLOR_ATTACHMENTS
  0x8a2f: 84, // MAX_UNIFORM_BUFFER_BINDINGS
  0x8c8b: 4, // MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS
  0x0d33: 16384, // MAX_TEXTURE_SIZE
  0x851c: 16384, // MAX_CUBE_MAP_TEXTURE_SIZE
  0x84e8: 16384, // MAX_RENDERBUFFER_SIZE
  0x8d57: 4, // MAX_SAMPLES
  0x9631: 2, // MAX_VIEWS_OVR
  0x8a34: 64, // UNIFORM_BUFFER_OFFSET_ALIGNMENT
  0x8dfb: 256, // MAX_VERTEX_UNIFORM_VECTORS
  0x8dfd: 256, // MAX_FRAGMENT_UNIFORM_VECTORS
  0x8dfc: 31, // MAX_VARYING_VECTORS
  0x0d50: 4, // SUBPIXEL_BITS
};

const EXTENSIONS = [
  'GL_EXT_color_buffer_float', 'GL_EXT_color_buffer_half_float', 'GL_EXT_float_blend', 'GL_OES_texture_float_linear',
  'GL_EXT_texture_filter_anisotropic', 'GL_KHR_parallel_shader_compile', 'GL_EXT_disjoint_timer_query',
  'GL_KHR_texture_compression_astc_ldr', 'GL_OVR_multiview', 'GL_OVR_multiview2',
  'GL_OVR_multiview_multisampled_render_to_texture', 'GL_EXT_multisampled_render_to_texture', 'GL_EXT_clip_control',
  'GL_EXT_texture_norm16', 'GL_EXT_robustness',
];

const TYPES: Record<string, number> = {
  float: 0x1406, vec2: 0x8b50, vec3: 0x8b51, vec4: 0x8b52, int: 0x1404, ivec2: 0x8b53, ivec3: 0x8b54, ivec4: 0x8b55,
  bool: 0x8b56, uint: 0x1405, uvec2: 0x8dc6, uvec3: 0x8dc7, uvec4: 0x8dc8, mat2: 0x8b5a, mat3: 0x8b5b, mat4: 0x8b5c,
  sampler2D: 0x8b5e, samplerCube: 0x8b60, sampler3D: 0x8b5f, sampler2DArray: 0x8dc1, sampler2DShadow: 0x8b62,
  usampler2D: 0x8dd2, isampler2D: 0x8dca,
};

/** Scan `uniform T name[N];` and vertex `in T name;` declarations (enough for headless runs). */
function scan(src: string, re: RegExp): Array<[string, number, number]> {
  const out: Array<[string, number, number]> = [];
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const m of code.matchAll(re)) {
    const type = TYPES[m[2]];
    if (type === undefined) continue;
    for (const part of m[3].split(',')) {
      const mm = /(\w+)\s*(?:\[\s*(\d+)\s*\])?/.exec(part.trim());
      if (mm) out.push([mm[1], type, mm[2] ? Number(mm[2]) : 0]);
    }
  }
  return out;
}

export function createFakeNatives(): FakeGl {
  const calls = new Map<string, number>();
  const log: unknown[][] = [];
  let next = 1;
  let nextCtx = 1;
  const sources = new Map<number, string>();
  const attached = new Map<number, number[]>();
  const bound = new Map<number, Map<string, number>>();
  const fake: FakeGl = {
    natives: null as unknown as GlNatives,
    calls,
    log,
    logging: false,
    reset() {
      calls.clear();
      log.length = 0;
    },
    total() {
      let n = 0;
      for (const v of calls.values()) n += v;
      return n;
    },
  };
  const impl: Record<string, (...a: unknown[]) => unknown> = {
    contextCreate: () => nextCtx++,
    contextMakeCurrent: () => true,
    contextInfo: (id) => ({
      version: 'OpenGL ES 3.2 fake',
      renderer: 'fake renderer',
      vendor: 'fake vendor',
      glsl: 'OpenGL ES GLSL ES 3.20',
      extensions: EXTENSIONS,
      robust: false,
      contextId: id,
    }),
    contextResetStatus: () => 0,
    getIntegerv: (pname, view) => {
      (view as Int32Array)[0] = LIMITS[pname as number] ?? 0;
    },
    getError: () => 0,
    createShader: () => next++,
    createProgram: () => next++,
    shaderSource: (s, src) => {
      sources.set(s as number, src as string);
    },
    attachShader: (p, s) => {
      const list = attached.get(p as number) ?? [];
      list.push(s as number);
      attached.set(p as number, list);
    },
    bindAttribLocation: (p, i, name) => {
      const m = bound.get(p as number) ?? new Map<string, number>();
      m.set(name as string, i as number);
      bound.set(p as number, m);
    },
    shaderInfo: () => [true, ''],
    shaderCompletion: () => true,
    programCompletion: () => true,
    programValidate: () => [true, ''],
    programInfo: (p) => {
      const shaders = attached.get(p as number) ?? [];
      const srcs = shaders.map((s) => sources.get(s) ?? '');
      const vs = srcs.find((s) => /gl_Position/.test(s)) ?? '';
      const attribs: unknown[] = [];
      const binds = bound.get(p as number) ?? new Map<string, number>();
      const used = new Set(binds.values());
      let loc = 0;
      for (const [name, type] of scan(vs, /(?:^|\n)\s*(?:layout\s*\([^)]*\)\s*)?(in|attribute)\s+(?:(?:highp|mediump|lowp)\s+)?(\w+)\s+([^;]+);/g)) {
        let l = binds.get(name);
        const slots = type === 0x8b5c ? 4 : type === 0x8b5b ? 3 : type === 0x8b5a ? 2 : 1; // mat4/3/2 columns
        if (l === undefined) {
          const free = (at: number): boolean => {
            for (let k = 0; k < slots; k++) if (used.has(at + k)) return false;
            return true;
          };
          while (!free(loc)) loc++;
          l = loc;
          loc += slots;
        }
        for (let k = 0; k < slots; k++) used.add(l + k);
        attribs.push(name, type, 1, l);
      }
      const uniforms: unknown[] = [];
      const seen = new Set<string>();
      let uloc = 0;
      for (const src of srcs) {
        for (const [name, type, n] of scan(src, /(?:^|\n)\s*(uniform)\s+(?:(?:highp|mediump|lowp)\s+)?(\w+)\s+([^;]+);/g)) {
          if (seen.has(name)) continue;
          seen.add(name);
          const size = n || 1;
          const locs = size > 1 ? Array.from({ length: size }, (_, i) => uloc + i) : uloc;
          uniforms.push(n ? `${name}[0]` : name, type, size, locs, -1, -1, -1, -1, 0);
          uloc += size;
        }
      }
      return [true, '', attribs, uniforms, [], [], 0x8c8c];
    },
    getShaderPrecisionFormat: (_s, _p, range, _ro, _rb, precision) => {
      const r = range as Int32Array;
      r[0] = 127;
      r[1] = 127;
      r[2] = 23;
      void precision;
    },
    fenceSync: () => next++,
    getSynciv: () => 0x9119,
    clientWaitSync: () => 0x911a,
    checkFramebufferStatus: () => 0x8cd5,
    getBufferSubData: () => true,
    clearTextureImage: () => true,
    getString: () => 'fake',
  };
  for (const [name] of NATIVES) {
    const f = impl[name];
    const gen = /^gen[A-Z]/.test(name);
    // No rest parameters on the call path: the GL-PERF-3 test measures the binding's allocations.
    impl[name] = function (this: unknown) {
      calls.set(name, (calls.get(name) ?? 0) + 1);
      if (fake.logging) log.push([name, ...Array.from(arguments)]);
      if (f) return f.apply(null, arguments as unknown as unknown[]);
      if (gen) return next++;
      return 0;
    };
  }
  fake.natives = impl as unknown as GlNatives;
  return fake;
}
