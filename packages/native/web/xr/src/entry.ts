/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Prelude entry (dist/xr.min.js): evaluated after the web glue and the WebGL prelude, before the page. Without the
// native XR module (headless runner without XR natives) it leaves navigator.xr alone.
import { installNativeXR } from './install.ts';
import type { WebGLHooks, XrNatives } from './natives.ts';

type Global = Record<string, unknown> & typeof globalThis;
const g = globalThis as Global;
const natives = (g.__iwn as { xr?: XrNatives } | undefined)?.xr;
if (natives) {
  try {
    installNativeXR(g, natives, (g.__iwnWebGL as WebGLHooks | undefined) ?? null);
  } catch (error) {
    console.error('@iwer/native: WebXR could not be installed', error);
  }
}
