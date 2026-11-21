#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Reports which post-MVP features a .wasm binary relies on, from its structure (WebAssembly core spec binary format):
//   simd    v128 (0x7b) in a function type or a function's locals  -> the module needs WASM SIMD
//   shared  a memory (defined or imported) with the shared flag    -> the module needs WASM threads
// Usage: node wasm-features.mjs <file.wasm>...
import { readFileSync } from 'node:fs';

function features(bytes) {
  let p = 8; // magic + version
  const u32 = () => {
    let r = 0,
      shift = 0,
      b;
    do {
      b = bytes[p++];
      r |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    return r >>> 0;
  };
  const out = {
    simd: false,
    shared: false,
    v128Types: 0,
    v128Locals: 0,
    functions: 0,
  };
  const limits = () => {
    const flags = bytes[p++];
    u32();
    if (flags & 1) u32();
    if (flags & 2) out.shared = true;
  };
  while (p < bytes.length) {
    const id = bytes[p++];
    const size = u32();
    const end = p + size;
    if (id === 1) {
      const n = u32();
      for (let i = 0; i < n && p < end; i++) {
        p++; // 0x60
        const params = u32();
        for (let k = 0; k < params; k++)
          if (bytes[p++] === 0x7b) out.v128Types++;
        const results = u32();
        for (let k = 0; k < results; k++)
          if (bytes[p++] === 0x7b) out.v128Types++;
      }
    } else if (id === 2) {
      const n = u32();
      for (let i = 0; i < n; i++) {
        const modLen = u32();
        p += modLen; // module name (read the length first: `p += u32()` would add it to the old p)
        const fieldLen = u32();
        p += fieldLen;
        const kind = bytes[p++];
        if (kind === 0) u32();
        else if (kind === 1) {
          p++;
          limits();
        } else if (kind === 2) limits();
        else if (kind === 3) p += 2;
        else if (kind === 4) {
          p++;
          u32();
        }
      }
    } else if (id === 5) {
      const n = u32();
      for (let i = 0; i < n; i++) limits();
    } else if (id === 10) {
      const n = u32();
      out.functions = n;
      for (let i = 0; i < n; i++) {
        const bodySize = u32();
        const bodyEnd = p + bodySize;
        const groups = u32();
        for (let g = 0; g < groups; g++) {
          u32();
          if (bytes[p++] === 0x7b) out.v128Locals++;
        }
        p = bodyEnd;
      }
    }
    p = end;
  }
  out.simd = out.v128Types + out.v128Locals > 0;
  return out;
}

for (const f of process.argv.slice(2))
  console.log(f, JSON.stringify(features(readFileSync(f))));
