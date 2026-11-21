/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// test/real-gl.ts for the device: the natives are the runtime's own (globalThis.__iwn.gl).
import type { GlNatives } from '../../gen/natives.gen.ts';
import { installWebGL, type WebGLInstall } from '../../install.ts';

let inst: WebGLInstall | null = null;
export function realNatives(): GlNatives | null {
  return ((globalThis as { __iwn?: { gl?: GlNatives } }).__iwn?.gl ??
    null) as GlNatives | null;
}
export function realInstall(): WebGLInstall | null {
  const n = realNatives();
  if (!n) return null;
  inst ??= installWebGL(globalThis as unknown as Record<string, unknown>, n);
  return inst;
}
export const SKIP_REAL =
  realNatives() === null ? 'no __iwn.gl natives in this runtime' : false;
