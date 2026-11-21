/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Loads the host test addon (runtime/gl built with -DIWN_GL_NODE_ADDON=ON: the generated natives on Mesa's
// surfaceless ES 3.2) so tests run the real binding against a real driver. Returns null when not built.

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { GlNatives } from '../gen/natives.gen.ts';
import { installWebGL, type WebGLInstall } from '../install.ts';

// Default build directory: build/gl/host under the package (see runtime/gl/README.md).
const addonPath =
  process.env.IWN_GL_ADDON ??
  fileURLToPath(new URL('../../../build/gl/host/iwn_gl.node', import.meta.url));

let natives: GlNatives | null | undefined;

export function realNatives(): GlNatives | null {
  if (natives !== undefined) return natives;
  if (!existsSync(addonPath)) return (natives = null);
  const require = createRequire(import.meta.url);
  natives = (require(addonPath) as { gl: GlNatives }).gl;
  return natives;
}

export function realInstall(): WebGLInstall | null {
  const n = realNatives();
  if (!n) return null;
  return installWebGL(globalThis as unknown as Record<string, unknown>, n);
}

export const SKIP_REAL =
  realNatives() === null
    ? 'host GL addon not built (cmake -S runtime/gl -DIWN_GL_NODE_ADDON=ON)'
    : false;
