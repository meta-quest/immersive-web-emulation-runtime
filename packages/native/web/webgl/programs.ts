/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Shaders and programs: source rewrite (GL-18), parallel compile semantics (GL-20: compile/link never block,
// COMPLETION_STATUS_KHR polls), and program reflection without per-query driver round trips (GL-21): one
// `shaderInfo` per compiled shader and one `programInfo` per linked program reach native code, whatever
// the app asks; every getActive* / get*Location / getProgramParameter is answered from the record.

import type { Ctx } from './core.ts';
import * as E from './gen/enums.gen.ts';
import {
  INTERNAL,
  WebGLActiveInfo,
  WebGLProgram,
  WebGLShader,
  WebGLShaderPrecisionFormat,
  WebGLUniformLocation,
  type UniformCell,
} from './objects.ts';
import {
  decodeProgramRecord,
  lookupUniform,
  uniformLocationOf,
  type ProgramRecord,
} from './reflection.ts';
import { rewriteShader, type UpgradeOptions } from './shader-rewrite.ts';

const INVALID_INDEX = 0xffffffff;

/** Per-program caches that live next to the record. */
interface ProgramExtras {
  /** name -> [GL location, uniform index, element] (null: no such active uniform) */
  locations: Map<string, readonly [number, number, number] | null>;
  /** sampler uniform unit values: key = uniformIndex * 4096 + element */
  samplerUnits: Map<number, number>;
  /** [uniform index, target] of sampler uniforms (feedback-loop checks) */
  samplers: Array<readonly [number, number]>;
  /** uniform value-cache cells: key = uniformIndex * 4096 + element (GL-PERF-2) */
  cells: Map<number, UniformCell>;
  /** cells of each array uniform, by uniform index */
  cellGroups: Map<number, UniformCell[]>;
}
const extras = new WeakMap<WebGLProgram, ProgramExtras>();

export function programExtras(p: WebGLProgram): ProgramExtras {
  let x = extras.get(p);
  if (!x) {
    x = {
      locations: new Map(),
      samplerUnits: new Map(),
      samplers: [],
      cells: new Map(),
      cellGroups: new Map(),
    };
    extras.set(p, x);
  }
  return x;
}

function samplerTarget(type: number): number {
  switch (type) {
    case E.SAMPLER_2D:
    case E.SAMPLER_2D_SHADOW:
    case E.INT_SAMPLER_2D:
    case E.UNSIGNED_INT_SAMPLER_2D:
      return E.TEXTURE_2D;
    case E.SAMPLER_CUBE:
    case E.SAMPLER_CUBE_SHADOW:
    case E.INT_SAMPLER_CUBE:
    case E.UNSIGNED_INT_SAMPLER_CUBE:
      return E.TEXTURE_CUBE_MAP;
    case E.SAMPLER_3D:
    case E.INT_SAMPLER_3D:
    case E.UNSIGNED_INT_SAMPLER_3D:
      return E.TEXTURE_3D;
    case E.SAMPLER_2D_ARRAY:
    case E.SAMPLER_2D_ARRAY_SHADOW:
    case E.INT_SAMPLER_2D_ARRAY:
    case E.UNSIGNED_INT_SAMPLER_2D_ARRAY:
      return E.TEXTURE_2D_ARRAY;
    default:
      return 0;
  }
}

function fetchShader(ctx: Ctx, s: WebGLShader): void {
  if (!s._compilePending) return;
  const r = ctx._n.shaderInfo(s._name) as [boolean, string];
  s._compiled = !!r[0];
  s._infoLog = r[1] ?? '';
  s._compilePending = false;
}

function reservedName(name: string): boolean {
  return name.startsWith('webgl_') || name.startsWith('_webgl_');
}

export const programMethods = {
  createShader(this: Ctx, type: number): WebGLShader | null {
    if (this._skip()) return null;
    type >>>= 0;
    if (type !== E.VERTEX_SHADER && type !== E.FRAGMENT_SHADER) {
      this._e(E.INVALID_ENUM, 'createShader');
      return null;
    }
    const s = new WebGLShader(INTERNAL, this, this._n.createShader(type), type);
    this._track(s);
    return s;
  },
  isShader(this: Ctx, shader: unknown): boolean {
    if (this._lost || shader === null || shader === undefined) return false;
    if (!(shader instanceof WebGLShader))
      throw new TypeError('isShader: argument is not a WebGLShader');
    return (
      shader._ctx === this &&
      shader._gen === this._gen &&
      (!shader._deleted || this._inUse(shader))
    );
  },
  deleteShader(this: Ctx, shader: unknown): void {
    if (this._skip()) return;
    if (!this._owned(shader, WebGLShader, 'deleteShader')) return;
    const s = shader as WebGLShader;
    if (s._deleted) return;
    s._deleted = true;
    this._untrack(s);
    this._n.deleteShader(s._name); // GL defers the deletion while the shader is attached
  },
  shaderSource(this: Ctx, shader: WebGLShader, source: string): void {
    if (this._skip()) return;
    if (!this._ok(shader, WebGLShader, false, 'shaderSource')) return;
    const src = String(source);
    shader._source = src;
    const r = rewriteShader(
      driverCharset(src),
      shader._type === E.VERTEX_SHADER,
      (name) => glslExtensionEnabled(this, name),
      upgradeOptions(this, false),
    );
    shader._pendingTranslated = r.source;
    shader._pendingEssl100 = r.essl100;
    shader._pendingUpgraded = r.upgraded;
    shader._numViews = r.numViews;
    shader._usesDrawId = r.usesDrawId;
    this._n.shaderSource(shader._name, r.source);
  },
  getShaderSource(this: Ctx, shader: WebGLShader): string | null {
    if (this._skip()) return null;
    if (!this._ok(shader, WebGLShader, false, 'getShaderSource')) return null;
    return shader._source;
  },
  compileShader(this: Ctx, shader: WebGLShader): void {
    if (this._skip()) return;
    if (!this._ok(shader, WebGLShader, false, 'compileShader')) return;
    this._n.compileShader(shader._name);
    shader._translated = shader._pendingTranslated;
    shader._compiledSource = shader._source;
    shader._essl100 = shader._pendingEssl100;
    shader._upgraded = shader._pendingUpgraded;
    shader._compilePending = true;
    shader._compiled = null;
  },
  getShaderParameter(this: Ctx, shader: WebGLShader, pname: number): unknown {
    if (this._skip()) return null;
    pname >>>= 0;
    if (!this._ok(shader, WebGLShader, false, 'getShaderParameter'))
      return null;
    switch (pname) {
      case E.SHADER_TYPE:
        return shader._type;
      case E.DELETE_STATUS:
        return shader._deleted;
      case E.COMPILE_STATUS:
        fetchShader(this, shader);
        return shader._compiled === true;
      case E.COMPLETION_STATUS_KHR:
        if (!this._extensions.has('KHR_parallel_shader_compile')) break;
        if (!shader._compilePending) return true;
        return this._n.shaderCompletion(shader._name);
    }
    this._e(E.INVALID_ENUM, 'getShaderParameter');
    return null;
  },
  getShaderInfoLog(this: Ctx, shader: WebGLShader): string | null {
    if (this._skip()) return null;
    if (!this._ok(shader, WebGLShader, false, 'getShaderInfoLog')) return null;
    fetchShader(this, shader);
    return shader._infoLog;
  },
  getShaderPrecisionFormat(
    this: Ctx,
    shadertype: number,
    precisiontype: number,
  ): WebGLShaderPrecisionFormat | null {
    if (this._skip()) return null;
    shadertype >>>= 0;
    precisiontype >>>= 0;
    if (shadertype !== E.VERTEX_SHADER && shadertype !== E.FRAGMENT_SHADER) {
      this._e(E.INVALID_ENUM, 'getShaderPrecisionFormat');
      return null;
    }
    if (precisiontype < E.LOW_FLOAT || precisiontype > E.HIGH_INT) {
      this._e(E.INVALID_ENUM, 'getShaderPrecisionFormat');
      return null;
    }
    const key = shadertype * 16 + (precisiontype - E.LOW_FLOAT);
    let cached = this._limitCache.get(-key) as
      | [number, number, number]
      | undefined;
    if (!cached) {
      const a = this._i32;
      a[0] = a[1] = a[2] = 0;
      this._n.getShaderPrecisionFormat(
        shadertype,
        precisiontype,
        a,
        0,
        8,
        a,
        8,
        4,
      );
      cached = [a[0], a[1], a[2]];
      this._limitCache.set(-key, cached);
    }
    return new WebGLShaderPrecisionFormat(
      INTERNAL,
      cached[0],
      cached[1],
      cached[2],
    );
  },

  createProgram(this: Ctx): WebGLProgram | null {
    if (this._skip()) return null;
    const p = new WebGLProgram(INTERNAL, this, this._n.createProgram());
    this._track(p);
    return p;
  },
  isProgram(this: Ctx, program: unknown): boolean {
    if (this._lost || program === null || program === undefined) return false;
    if (!(program instanceof WebGLProgram))
      throw new TypeError('isProgram: argument is not a WebGLProgram');
    return (
      program._ctx === this &&
      program._gen === this._gen &&
      (!program._deleted || this._inUse(program))
    );
  },
  deleteProgram(this: Ctx, program: unknown): void {
    if (this._skip()) return;
    if (!this._owned(program, WebGLProgram, 'deleteProgram')) return;
    const p = program as WebGLProgram;
    if (p._deleted) return;
    p._deleted = true;
    this._untrack(p);
    this._n.deleteProgram(p._name); // GL defers it while current
    if (!this._inUse(p)) releaseProgram(p);
  },
  attachShader(this: Ctx, program: WebGLProgram, shader: WebGLShader): void {
    if (this._skip()) return;
    if (
      !this._ok(program, WebGLProgram, false, 'attachShader') ||
      !this._ok(shader, WebGLShader, false, 'attachShader')
    )
      return;
    const slot = shader._type === E.VERTEX_SHADER ? '_vs' : '_fs';
    if (program[slot] !== null)
      return this._e(E.INVALID_OPERATION, 'attachShader');
    program[slot] = shader;
    shader._attachCount++;
    this._n.attachShader(program._name, shader._name);
  },
  detachShader(this: Ctx, program: WebGLProgram, shader: WebGLShader): void {
    if (this._skip()) return;
    if (
      !this._ok(program, WebGLProgram, false, 'detachShader') ||
      !this._ok(shader, WebGLShader, false, 'detachShader')
    )
      return;
    const slot = shader._type === E.VERTEX_SHADER ? '_vs' : '_fs';
    if (program[slot] !== shader)
      return this._e(E.INVALID_OPERATION, 'detachShader');
    program[slot] = null;
    shader._attachCount--;
    this._n.detachShader(program._name, shader._name);
  },
  getAttachedShaders(this: Ctx, program: WebGLProgram): WebGLShader[] | null {
    if (this._skip()) return null;
    if (!this._ok(program, WebGLProgram, false, 'getAttachedShaders'))
      return null;
    const out: WebGLShader[] = [];
    if (program._vs) out.push(program._vs);
    if (program._fs) out.push(program._fs);
    return out;
  },
  bindAttribLocation(
    this: Ctx,
    program: WebGLProgram,
    index: number,
    name: string,
  ): void {
    if (this._skip()) return;
    if (!this._ok(program, WebGLProgram, false, 'bindAttribLocation')) return;
    index >>>= 0;
    const n = String(name);
    if (!validName(this, n))
      return this._e(E.INVALID_VALUE, 'bindAttribLocation');
    if (reservedName(n) || n.startsWith('gl_'))
      return this._e(E.INVALID_OPERATION, 'bindAttribLocation');
    if (index >= this._maxAttribs)
      return this._e(E.INVALID_VALUE, 'bindAttribLocation');
    this._n.bindAttribLocation(program._name, index, n);
  },
  linkProgram(this: Ctx, program: WebGLProgram): void {
    if (this._skip()) return;
    if (!this._ok(program, WebGLProgram, false, 'linkProgram')) return;
    if (this._tf._active && this._tf._program === program)
      return this._e(E.INVALID_OPERATION, 'linkProgram');
    const vs = program._vs;
    const fs = program._fs;
    if (vs && fs && vs._upgraded !== fs._upgraded) {
      const other = vs._upgraded ? fs : vs;
      if (other._essl100) upgradeCompiled(this, other);
    }
    this._n.linkProgram(program._name);
    program._linkRequested = true;
    program._linkPending = true;
    program._record = null;
    program._linkGen++;
    program._validateLog = '';
    program._validateStatus = false;
    program._numViews = program._vs ? program._vs._numViews : 0;
    program._usesDrawId = !!program._vs?._usesDrawId;
    const x = programExtras(program);
    x.locations.clear();
    x.samplerUnits.clear();
    x.samplers = [];
    x.cells.clear();
    x.cellGroups.clear();
    if (this._program === program) {
      this._feedbackDirty = true;
      this._texDirty = true;
      this._attribsDirty = true;
    }
  },
  useProgram(this: Ctx, program: WebGLProgram | null): void {
    if (this._skip()) return;
    if (!this._ok(program, WebGLProgram, true, 'useProgram')) return;
    const p = program ?? null;
    if (this._program === p) return;
    if (this._tf._active && !this._tf._paused)
      return this._e(E.INVALID_OPERATION, 'useProgram');
    if (p !== null) {
      const rec = this._programRecord(p);
      if (!rec || !rec.linked)
        return this._e(E.INVALID_OPERATION, 'useProgram');
    }
    const prev = this._program;
    this._program = p;
    this._feedbackDirty = true;
    this._texDirty = true;
    this._attribsDirty = true;
    this._n.useProgram(p ? p._name : 0);
    if (prev && prev._deleted && !this._inUse(prev)) releaseProgram(prev);
  },
  validateProgram(this: Ctx, program: WebGLProgram): void {
    if (this._skip()) return;
    if (!this._ok(program, WebGLProgram, false, 'validateProgram')) return;
    const r = this._n.programValidate(program._name) as [boolean, string];
    program._validateStatus = !!r[0];
    program._validateLog = r[1] ?? '';
  },
  getProgramParameter(
    this: Ctx,
    program: WebGLProgram,
    pname: number,
  ): unknown {
    if (this._skip()) return null;
    pname >>>= 0;
    if (!this._ok(program, WebGLProgram, false, 'getProgramParameter'))
      return null;
    switch (pname) {
      case E.DELETE_STATUS:
        return program._deleted;
      case E.ATTACHED_SHADERS:
        return (program._vs ? 1 : 0) + (program._fs ? 1 : 0);
      case E.VALIDATE_STATUS:
        return program._validateStatus;
      case E.COMPLETION_STATUS_KHR:
        if (!this._extensions.has('KHR_parallel_shader_compile')) break;
        if (!program._linkPending) return true;
        return this._n.programCompletion(program._name);
    }
    const rec = this._programRecord(program);
    switch (pname) {
      case E.LINK_STATUS:
        return !!rec?.linked;
      case E.ACTIVE_ATTRIBUTES:
        return rec ? rec.attribs.length : 0;
      case E.ACTIVE_UNIFORMS:
        return rec ? rec.uniforms.length : 0;
      case E.TRANSFORM_FEEDBACK_BUFFER_MODE:
        if (!this._v2) break;
        return rec && rec.linked ? rec.tfBufferMode : E.INTERLEAVED_ATTRIBS;
      case E.TRANSFORM_FEEDBACK_VARYINGS:
        if (!this._v2) break;
        return rec ? rec.varyings.length : 0;
      case E.ACTIVE_UNIFORM_BLOCKS:
        if (!this._v2) break;
        return rec ? rec.blocks.length : 0;
    }
    this._e(E.INVALID_ENUM, 'getProgramParameter');
    return null;
  },
  getProgramInfoLog(this: Ctx, program: WebGLProgram): string | null {
    if (this._skip()) return null;
    if (!this._ok(program, WebGLProgram, false, 'getProgramInfoLog'))
      return null;
    if (program._validateLog) return program._validateLog;
    const rec = this._programRecord(program);
    return rec ? rec.infoLog : '';
  },
  getAttribLocation(this: Ctx, program: WebGLProgram, name: string): number {
    if (this._skip()) return -1;
    if (!this._ok(program, WebGLProgram, false, 'getAttribLocation')) return -1;
    const n = String(name);
    if (!validName(this, n)) {
      this._e(E.INVALID_VALUE, 'getAttribLocation');
      return -1;
    }
    const rec = linkedRecord(this, program, 'getAttribLocation');
    if (!rec) return -1;
    if (reservedName(n)) return -1;
    const a = rec.attribByName.get(n);
    return a ? a.location : -1;
  },
  getActiveAttrib(
    this: Ctx,
    program: WebGLProgram,
    index: number,
  ): WebGLActiveInfo | null {
    if (this._skip()) return null;
    if (!this._ok(program, WebGLProgram, false, 'getActiveAttrib')) return null;
    const rec = this._programRecord(program);
    const a = rec ? rec.attribs[index >>> 0] : undefined;
    if (!a) {
      this._e(E.INVALID_VALUE, 'getActiveAttrib');
      return null;
    }
    return new WebGLActiveInfo(INTERNAL, a.size, a.type, a.name);
  },
  getActiveUniform(
    this: Ctx,
    program: WebGLProgram,
    index: number,
  ): WebGLActiveInfo | null {
    if (this._skip()) return null;
    if (!this._ok(program, WebGLProgram, false, 'getActiveUniform'))
      return null;
    const rec = this._programRecord(program);
    const u = rec ? rec.uniforms[index >>> 0] : undefined;
    if (!u) {
      this._e(E.INVALID_VALUE, 'getActiveUniform');
      return null;
    }
    return new WebGLActiveInfo(INTERNAL, u.size, u.type, u.name);
  },
  getUniformLocation(
    this: Ctx,
    program: WebGLProgram,
    name: string,
  ): WebGLUniformLocation | null {
    if (this._skip()) return null;
    if (!this._ok(program, WebGLProgram, false, 'getUniformLocation'))
      return null;
    const n = String(name);
    if (!validName(this, n)) {
      this._e(E.INVALID_VALUE, 'getUniformLocation');
      return null;
    }
    const rec = linkedRecord(this, program, 'getUniformLocation');
    if (!rec) return null;
    // Name resolution is cached; each call returns a new WebGLUniformLocation (as browsers do).
    const x = programExtras(program);
    let hit = x.locations.get(n);
    if (hit === undefined) {
      hit = null;
      if (!reservedName(n)) {
        const r = lookupUniform(rec, n);
        if (r) {
          const glLoc = uniformLocationOf(rec, r[0], r[1]);
          if (glLoc >= 0) hit = [glLoc, r[0], r[1]] as const;
        }
      }
      x.locations.set(n, hit);
    }
    return hit === null
      ? null
      : new WebGLUniformLocation(INTERNAL, program, hit[0], hit[1], hit[2]);
  },
  getUniformBlockIndex(this: Ctx, program: WebGLProgram, name: string): number {
    if (this._skip()) return INVALID_INDEX;
    if (!this._ok(program, WebGLProgram, false, 'getUniformBlockIndex'))
      return INVALID_INDEX;
    const rec = linkedRecord(this, program, 'getUniformBlockIndex');
    if (!rec) return INVALID_INDEX;
    const n = String(name);
    let i = rec.blockByName.get(n);
    if (i === undefined) i = rec.blockByName.get(n + '[0]');
    return i === undefined ? INVALID_INDEX : i;
  },
  getActiveUniformBlockName(
    this: Ctx,
    program: WebGLProgram,
    index: number,
  ): string | null {
    if (this._skip()) return null;
    if (!this._ok(program, WebGLProgram, false, 'getActiveUniformBlockName'))
      return null;
    const rec = linkedRecord(this, program, 'getActiveUniformBlockName');
    if (!rec) return null;
    const b = rec.blocks[index >>> 0];
    if (!b) {
      this._e(E.INVALID_VALUE, 'getActiveUniformBlockName');
      return null;
    }
    return b.name;
  },
  getActiveUniformBlockParameter(
    this: Ctx,
    program: WebGLProgram,
    index: number,
    pname: number,
  ): unknown {
    if (this._skip()) return null;
    if (
      !this._ok(program, WebGLProgram, false, 'getActiveUniformBlockParameter')
    )
      return null;
    const rec = linkedRecord(this, program, 'getActiveUniformBlockParameter');
    if (!rec) return null;
    const b = rec.blocks[index >>> 0];
    if (!b) {
      this._e(E.INVALID_VALUE, 'getActiveUniformBlockParameter');
      return null;
    }
    switch (pname >>> 0) {
      case E.UNIFORM_BLOCK_BINDING:
        return b.binding;
      case E.UNIFORM_BLOCK_DATA_SIZE:
        return b.dataSize;
      case E.UNIFORM_BLOCK_ACTIVE_UNIFORMS:
        return b.indices.length;
      case E.UNIFORM_BLOCK_ACTIVE_UNIFORM_INDICES:
        return new Uint32Array(b.indices);
      case E.UNIFORM_BLOCK_REFERENCED_BY_VERTEX_SHADER:
        return b.refVS;
      case E.UNIFORM_BLOCK_REFERENCED_BY_FRAGMENT_SHADER:
        return b.refFS;
    }
    this._e(E.INVALID_ENUM, 'getActiveUniformBlockParameter');
    return null;
  },
  uniformBlockBinding(
    this: Ctx,
    program: WebGLProgram,
    index: number,
    binding: number,
  ): void {
    if (this._skip()) return;
    if (!this._ok(program, WebGLProgram, false, 'uniformBlockBinding')) return;
    const rec = linkedRecord(this, program, 'uniformBlockBinding');
    if (!rec) return;
    index >>>= 0;
    binding >>>= 0;
    const b = rec.blocks[index];
    if (!b || binding >= this._maxUboBindings)
      return this._e(E.INVALID_VALUE, 'uniformBlockBinding');
    if (b.binding === binding) return;
    b.binding = binding;
    this._n.uniformBlockBinding(program._name, index, binding);
  },
  getUniformIndices(
    this: Ctx,
    program: WebGLProgram,
    names: unknown,
  ): number[] | null {
    if (this._skip()) return null;
    if (!this._ok(program, WebGLProgram, false, 'getUniformIndices'))
      return null;
    if (
      names === null ||
      typeof names !== 'object' ||
      typeof (names as Iterable<unknown>)[Symbol.iterator] !== 'function'
    ) {
      throw new TypeError('getUniformIndices: uniformNames is not a sequence');
    }
    const rec = linkedRecord(this, program, 'getUniformIndices');
    if (!rec) return null;
    const out: number[] = [];
    for (const raw of names as Iterable<unknown>) {
      const n = String(raw);
      let idx = INVALID_INDEX;
      for (let i = 0; i < rec.uniforms.length; i++) {
        const u = rec.uniforms[i];
        if (u.name === n || (u.isArray && u.baseName === n)) {
          idx = i;
          break;
        }
      }
      out.push(idx);
    }
    return out;
  },
  getActiveUniforms(
    this: Ctx,
    program: WebGLProgram,
    indices: unknown,
    pname: number,
  ): unknown {
    if (this._skip()) return null;
    if (!this._ok(program, WebGLProgram, false, 'getActiveUniforms'))
      return null;
    if (
      indices === null ||
      typeof indices !== 'object' ||
      typeof (indices as Iterable<unknown>)[Symbol.iterator] !== 'function'
    ) {
      throw new TypeError(
        'getActiveUniforms: uniformIndices is not a sequence',
      );
    }
    const rec = this._programRecord(program);
    const list = Array.from(
      indices as Iterable<unknown>,
      (v) => Number(v) >>> 0,
    );
    const n = rec ? rec.uniforms.length : 0;
    for (const i of list) {
      if (i >= n) {
        this._e(E.INVALID_VALUE, 'getActiveUniforms');
        return null;
      }
    }
    const us = rec ? rec.uniforms : [];
    switch (pname >>> 0) {
      case E.UNIFORM_TYPE:
        return list.map((i) => us[i].type);
      case E.UNIFORM_SIZE:
        return list.map((i) => us[i].size);
      case E.UNIFORM_BLOCK_INDEX:
        return list.map((i) => us[i].blockIndex);
      case E.UNIFORM_OFFSET:
        return list.map((i) => us[i].offset);
      case E.UNIFORM_ARRAY_STRIDE:
        return list.map((i) => us[i].arrayStride);
      case E.UNIFORM_MATRIX_STRIDE:
        return list.map((i) => us[i].matrixStride);
      case E.UNIFORM_IS_ROW_MAJOR:
        return list.map((i) => us[i].rowMajor !== 0);
    }
    this._e(E.INVALID_ENUM, 'getActiveUniforms');
    return null;
  },
  transformFeedbackVaryings(
    this: Ctx,
    program: WebGLProgram,
    varyings: unknown,
    bufferMode: number,
  ): void {
    if (this._skip()) return;
    if (!this._ok(program, WebGLProgram, false, 'transformFeedbackVaryings'))
      return;
    if (
      varyings === null ||
      typeof varyings !== 'object' ||
      typeof (varyings as Iterable<unknown>)[Symbol.iterator] !== 'function'
    ) {
      throw new TypeError(
        'transformFeedbackVaryings: varyings is not a sequence',
      );
    }
    bufferMode >>>= 0;
    const list = Array.from(varyings as Iterable<unknown>, String);
    if (
      bufferMode !== E.INTERLEAVED_ATTRIBS &&
      bufferMode !== E.SEPARATE_ATTRIBS
    )
      return this._e(E.INVALID_ENUM, 'transformFeedbackVaryings');
    if (bufferMode === E.SEPARATE_ATTRIBS && list.length > this._maxTfBuffers)
      return this._e(E.INVALID_VALUE, 'transformFeedbackVaryings');
    this._n.transformFeedbackVaryings(program._name, list, bufferMode);
  },
  getTransformFeedbackVarying(
    this: Ctx,
    program: WebGLProgram,
    index: number,
  ): WebGLActiveInfo | null {
    if (this._skip()) return null;
    if (!this._ok(program, WebGLProgram, false, 'getTransformFeedbackVarying'))
      return null;
    const rec = this._programRecord(program);
    const v = rec ? rec.varyings[index >>> 0] : undefined;
    if (!v) {
      this._e(E.INVALID_VALUE, 'getTransformFeedbackVarying');
      return null;
    }
    return new WebGLActiveInfo(INTERNAL, v.size, v.type, v.name);
  },
  getFragDataLocation(this: Ctx, program: WebGLProgram, name: string): number {
    if (this._skip()) return -1;
    if (!this._ok(program, WebGLProgram, false, 'getFragDataLocation'))
      return -1;
    if (!linkedRecord(this, program, 'getFragDataLocation')) return -1;
    const n = String(name);
    // built-in outputs (gl_FragColor / gl_FragData of ESSL 1.00 programs) have no location in WebGL; some
    // drivers report 0 for them
    if (reservedName(n) || n.startsWith('gl_')) return -1;
    return this._n.getFragDataLocation(program._name, n);
  },
};

/** A program flagged for deletion is gone once it is no longer current: its shaders are released too. */
function releaseProgram(p: WebGLProgram): void {
  for (const s of [p._vs, p._fs]) if (s) s._attachCount--;
}

/** WebGL 1.0 §6.20/6.21: names are ASCII from the GLSL ES character set, at most 256 (WebGL 2: 1024) characters. */
function validName(ctx: Ctx, name: string): boolean {
  if (name.length > (ctx._v2 ? 1024 : 256)) return false;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c >= 0x80 || !GLSL_CHARS[c]) return false;
  }
  return true;
}
const GLSL_CHARS = (() => {
  const t = new Uint8Array(128);
  const ok =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.+-/*%<>[](){}^|&~=!:;,?# ';
  for (const ch of ok) t[ch.charCodeAt(0)] = 1;
  return t;
})();
/**
 * WebGL (since the 2019 character-set change, tested by conformance glsl/bugs/character-set.html): shaderSource
 * accepts any string; characters outside the GLSL ES character set fail compilation unless they are in a comment
 * or a skipped #if group. GLES compilers differ on raw non-ASCII bytes, so the driver gets each run of non-ASCII
 * characters outside comments as two adjacent identifiers (a syntax error wherever code is compiled, even in a
 * declarator position; ignored in skipped groups), and non-ASCII characters inside comments as spaces. getShaderSource still returns the original.
 */
function driverCharset(src: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7f]/.test(src)) return src;
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (
      c === 0x2f &&
      (src.charCodeAt(i + 1) === 0x2f || src.charCodeAt(i + 1) === 0x2a)
    ) {
      const block = src.charCodeAt(i + 1) === 0x2a;
      let end = block ? src.indexOf('*/', i + 2) : src.indexOf('\n', i + 2);
      end = end < 0 ? n : block ? end + 2 : end;
      out += src.slice(i, end).replace(/[^\x00-\x7f]/g, ' ');
      i = end;
      continue;
    }
    if (c >= 0x80) {
      while (i < n && src.charCodeAt(i) >= 0x80) i++;
      out += ' iwn_invalid_character iwn_invalid_character '; // two adjacent identifiers: never valid code
      continue;
    }
    out += src[i++];
  }
  return out;
}

/** Is the GLSL extension `name` available to shaders of this context (its WebGL extension enabled)? */
/** WebGL 1: ESSL 1.00 shaders using extensions that are core in ESSL 3.00 are upgraded (shader-rewrite.ts). */
function upgradeOptions(ctx: Ctx, force: boolean): UpgradeOptions | undefined {
  if (ctx._v2) return undefined;
  // Always upgrade rather than trusting the driver's ESSL 1.00 extension list: Adreno 740 and Mesa lack these
  // ESSL 1.00 extensions, and one translation path behaves the same everywhere.
  return { driverHas: () => false, maxDrawBuffers: ctx._maxDrawBuffers, force };
}

/**
 * The other shader of a program whose vertex or fragment shader was upgraded to ESSL 3.00: recompile its last
 * compiled source as ESSL 3.00 too (drivers link only shaders of one version). The upgrade sticks to the shader.
 */
function upgradeCompiled(ctx: Ctx, shader: WebGLShader): void {
  const r = rewriteShader(
    shader._compiledSource,
    shader._type === E.VERTEX_SHADER,
    (name) => glslExtensionEnabled(ctx, name),
    upgradeOptions(ctx, true),
  );
  if (!r.upgraded) return;
  ctx._n.shaderSource(shader._name, r.source);
  ctx._n.compileShader(shader._name);
  shader._translated = r.source;
  shader._upgraded = true;
  shader._compilePending = true;
  shader._compiled = null;
  if (shader._source === shader._compiledSource) {
    shader._pendingTranslated = r.source;
    shader._pendingUpgraded = true;
  } else {
    // a newer shaderSource is pending: hand it back to the driver for the next compileShader
    ctx._n.shaderSource(shader._name, shader._pendingTranslated);
  }
}

function glslExtensionEnabled(ctx: Ctx, name: string): boolean {
  const has = (n: string): boolean => ctx._extensions.has(n);
  switch (name) {
    case 'GL_OVR_multiview2':
      return has('OVR_multiview2') || has('OCULUS_multiview');
    case 'GL_OVR_multiview':
      // three.js (r181) emits `#extension GL_OVR_multiview : require` for its multiview path; Chrome/ANGLE and
      // Quest Browser accept it once OVR_multiview2 / OCULUS_multiview is enabled, and GLES drivers with
      // GL_OVR_multiview2 also implement GL_OVR_multiview.
      return has('OVR_multiview2') || has('OCULUS_multiview');
    case 'GL_EXT_clip_cull_distance':
    case 'GL_ANGLE_clip_cull_distance':
      return has('WEBGL_clip_cull_distance');
    case 'GL_EXT_draw_buffers':
      return !ctx._v2 && has('WEBGL_draw_buffers');
    case 'GL_EXT_frag_depth':
      return !ctx._v2 && has('EXT_frag_depth');
    case 'GL_EXT_shader_texture_lod':
      return !ctx._v2 && has('EXT_shader_texture_lod');
    case 'GL_OES_standard_derivatives':
      return !ctx._v2 && has('OES_standard_derivatives');
    default:
      return false; // extensions this runtime does not offer
  }
}

function linkedRecord(
  ctx: Ctx,
  program: WebGLProgram,
  what: string,
): ProgramRecord | null {
  const rec = ctx._programRecord(program);
  if (!rec || !rec.linked) {
    ctx._e(E.INVALID_OPERATION, what);
    return null;
  }
  return rec;
}

export const programInternals = {
  /** The program's reflection record, fetched once after each link (GL-21); null if never linked. */
  _programRecord(this: Ctx, p: WebGLProgram): ProgramRecord | null {
    if (p._linkPending) {
      p._record = decodeProgramRecord(this._n.programInfo(p._name));
      p._linkPending = false;
      checkAttribAliasing(p._record);
      const x = programExtras(p);
      x.samplers = [];
      p._record.uniforms.forEach((u, i) => {
        const t = samplerTarget(u.type);
        if (t) x.samplers.push([i, t] as const);
      });
    }
    return p._record;
  },
};

/** Column count of a matrix attribute type (attributes of these types take that many locations). */
function attribSlots(type: number): number {
  switch (type) {
    case E.FLOAT_MAT2:
    case E.FLOAT_MAT2x3:
    case E.FLOAT_MAT2x4:
      return 2;
    case E.FLOAT_MAT3:
    case E.FLOAT_MAT3x2:
    case E.FLOAT_MAT3x4:
      return 3;
    case E.FLOAT_MAT4:
    case E.FLOAT_MAT4x2:
    case E.FLOAT_MAT4x3:
      return 4;
    default:
      return 1;
  }
}

/** WebGL 1.0 §6.?: a link where two active attributes share a location (aliasing) must fail. */
function checkAttribAliasing(rec: ProgramRecord): void {
  if (!rec.linked) return;
  const used = new Set<number>();
  for (const a of rec.attribs) {
    if (a.location < 0) continue;
    const n = attribSlots(a.type) * Math.max(1, a.size);
    for (let i = 0; i < n; i++) {
      if (used.has(a.location + i)) {
        rec.linked = false;
        rec.infoLog += `\nWebGL: attributes alias location ${a.location + i}`;
        return;
      }
      used.add(a.location + i);
    }
  }
}
