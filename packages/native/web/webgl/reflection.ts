/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Program reflection records (spec GL-21): the native `programInfo` returns everything WebGL can ask about a
// linked program in one call (layout: runtime/gl/src/gl_v8_composites.cc). This module decodes it and
// answers getActiveUniform / getUniformLocation / getAttribLocation / getUniformBlockIndex / ... from it.

export interface ActiveVar {
  name: string;
  type: number;
  size: number;
}

export interface AttribRecord extends ActiveVar {
  location: number;
}

export interface UniformRecord extends ActiveVar {
  /** GL location of element 0 (-1 for block members) */
  location: number;
  /** GL location of each element (arrays) */
  locations: number[] | null;
  blockIndex: number;
  offset: number;
  arrayStride: number;
  matrixStride: number;
  rowMajor: number;
  /** name without a trailing "[0]" */
  baseName: string;
  isArray: boolean;
}

export interface BlockRecord {
  name: string;
  binding: number;
  dataSize: number;
  indices: number[];
  refVS: boolean;
  refFS: boolean;
}

export interface ProgramRecord {
  linked: boolean;
  infoLog: string;
  attribs: AttribRecord[];
  uniforms: UniformRecord[];
  blocks: BlockRecord[];
  varyings: ActiveVar[];
  tfBufferMode: number;
  /** name ("a", "a[0]", "a[3]", "s.f", "s[1].f") -> [uniform index, element] */
  uniformByName: Map<string, readonly [number, number]>;
  attribByName: Map<string, AttribRecord>;
  blockByName: Map<string, number>;
  /** location of the injected webgl_DrawID uniform (-1 if none) */
  drawIdLocation: number;
  /** fragment output locations written by the program (bit per draw buffer; 0xffff when unknown / gl_FragColor) */
  outMask: number;
  /** per output location: 0 unknown, OUT_FLOAT, OUT_INT, OUT_UINT */
  outKinds: Uint8Array;
}

export const OUT_FLOAT = 1;
export const OUT_INT = 2;
export const OUT_UINT = 3;

function outputKind(type: number): number {
  switch (type) {
    case 0x1404:
    case 0x8b53:
    case 0x8b54:
    case 0x8b55: // INT, INT_VEC2..4
      return OUT_INT;
    case 0x1405:
    case 0x8dc6:
    case 0x8dc7:
    case 0x8dc8: // UNSIGNED_INT, UNSIGNED_INT_VEC2..4
      return OUT_UINT;
    default:
      return OUT_FLOAT;
  }
}

const INTERNAL_PREFIX = 'webgl_';

export function decodeProgramRecord(raw: unknown): ProgramRecord {
  const r = raw as [
    boolean,
    string,
    unknown[],
    unknown[],
    unknown[],
    unknown[],
    number,
    unknown[] | null | undefined,
  ];
  const rec: ProgramRecord = {
    linked: !!r?.[0],
    infoLog: (r?.[1] as string) ?? '',
    attribs: [],
    uniforms: [],
    blocks: [],
    varyings: [],
    tfBufferMode: (r?.[6] as number) ?? 0,
    uniformByName: new Map(),
    attribByName: new Map(),
    blockByName: new Map(),
    drawIdLocation: -1,
    outMask: 0xffff,
    outKinds: new Uint8Array(16),
  };
  if (!rec.linked) return rec;
  const a = r[2];
  for (let i = 0; i + 3 < a.length; i += 4) {
    const name = a[i] as string;
    if (name.startsWith(INTERNAL_PREFIX) || name.startsWith('gl_')) continue;
    const ar: AttribRecord = {
      name,
      type: a[i + 1] as number,
      size: a[i + 2] as number,
      location: a[i + 3] as number,
    };
    rec.attribs.push(ar);
    rec.attribByName.set(name, ar);
  }
  const u = r[3];
  // GL uniform index -> index visible to the app (internal webgl_* and gl_* uniforms are hidden).
  const glToJs: number[] = [];
  for (let i = 0; i + 8 < u.length; i += 9) {
    const name = u[i] as string;
    const loc = u[i + 3];
    const locations = Array.isArray(loc) ? (loc as number[]) : null;
    const location = locations ? locations[0] : (loc as number);
    glToJs.push(-1);
    if (name === 'webgl_DrawID') {
      rec.drawIdLocation = location;
      continue;
    }
    if (name.startsWith(INTERNAL_PREFIX) || name.startsWith('gl_')) continue;
    glToJs[glToJs.length - 1] = rec.uniforms.length;
    const isArray = name.endsWith('[0]');
    const ur: UniformRecord = {
      name,
      type: u[i + 1] as number,
      size: u[i + 2] as number,
      location,
      locations,
      blockIndex: u[i + 4] as number,
      offset: u[i + 5] as number,
      arrayStride: u[i + 6] as number,
      matrixStride: u[i + 7] as number,
      rowMajor: u[i + 8] as number,
      baseName: isArray ? name.slice(0, -3) : name,
      isArray,
    };
    const index = rec.uniforms.length;
    rec.uniforms.push(ur);
    if (ur.blockIndex < 0) {
      rec.uniformByName.set(name, [index, 0]);
      if (isArray) rec.uniformByName.set(ur.baseName, [index, 0]);
    }
  }
  const b = r[4];
  for (let i = 0; i + 5 < b.length; i += 6) {
    const br: BlockRecord = {
      name: b[i] as string,
      binding: b[i + 1] as number,
      dataSize: b[i + 2] as number,
      indices: (b[i + 3] as number[])
        .map((g) => glToJs[g] ?? -1)
        .filter((j) => j >= 0),
      refVS: !!b[i + 4],
      refFS: !!b[i + 5],
    };
    rec.blockByName.set(br.name, rec.blocks.length);
    // GL reports array blocks as "name[0]"; WebGL also resolves the base name to element 0's index.
    rec.blocks.push(br);
  }
  const t = r[5];
  for (let i = 0; i + 2 < t.length; i += 3) {
    rec.varyings.push({
      name: t[i] as string,
      type: t[i + 1] as number,
      size: t[i + 2] as number,
    });
  }
  const o = r[7];
  if (Array.isArray(o)) {
    let mask = 0;
    for (let i = 0; i + 3 < o.length; i += 4) {
      const name = o[i] as string;
      const kind = outputKind(o[i + 1] as number);
      let loc = o[i + 2] as number;
      let size = Math.max(1, o[i + 3] as number);
      if (name === 'gl_FragColor') {
        // GLES 3.0 §3.9.2: gl_FragColor writes colour number zero only
        loc = 0;
        size = 1;
      } else if (name.startsWith('gl_FragData')) {
        loc = 0;
      } else if (name.startsWith('gl_') || loc < 0) {
        continue; // gl_FragDepth, secondary outputs (EXT_blend_func_extended)
      }
      for (let k = 0; k < size && loc + k < 16; k++) {
        mask |= 1 << (loc + k);
        rec.outKinds[loc + k] = kind;
      }
    }
    rec.outMask = mask;
  }
  return rec;
}

/**
 * Resolve a uniform name to [uniform index, element] following WebGL/GLES naming rules: "a" and "a[0]" name
 * element 0 of an array; "a[i]" names element i (i < size); struct members are matched by their full name.
 * Returns null for unknown names, block members and out-of-range elements.
 */
export function lookupUniform(
  rec: ProgramRecord,
  name: string,
): readonly [number, number] | null {
  const hit = rec.uniformByName.get(name);
  if (hit) return hit;
  // "base[i]" with i > 0
  const m = /^(.*)\[(\d+)\]$/.exec(name);
  if (!m) return null;
  const elem = Number(m[2]);
  if (m[2].length > 1 && m[2][0] === '0') return null; // no leading zeros
  const base = rec.uniformByName.get(m[1]);
  if (!base) return null;
  const u = rec.uniforms[base[0]];
  if (!u.isArray || elem >= u.size) return null;
  return [base[0], elem];
}

export function uniformLocationOf(
  rec: ProgramRecord,
  index: number,
  element: number,
): number {
  const u = rec.uniforms[index];
  if (element === 0) return u.location;
  return u.locations ? (u.locations[element] ?? -1) : -1;
}
