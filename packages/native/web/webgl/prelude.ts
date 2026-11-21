/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Prelude entry (dist/webgl.js, an IIFE the runtime evaluates before the app): installs the WebGL interfaces
// over globalThis.__iwn.gl and publishes globalThis.__iwnWebGL for the canvas implementation (getContext) and
// the XR module (host hooks). Without natives (headless runner without GL) it publishes the installer only.
import { releaseAllContexts } from './core.ts';
import { installWebGL } from './install.ts';
import * as host from './host.ts';
import { TEX_SOURCE } from './tex-source.ts';

type Natives = { gl?: unknown };
const g = globalThis as unknown as Record<string, unknown> & { __iwn?: Natives };
const api: Record<string, unknown> = { installWebGL, TEX_SOURCE, ...host };
// Optional options (e.g. { debugErrors: true }, GL-12) set by the runtime config before the prelude runs.
const options = (g.__iwnWebGLOptions ?? {}) as Record<string, unknown>;
if (g.__iwn?.gl) {
  Object.assign(api, installWebGL(g, g.__iwn.gl as never, options), { releaseAllContexts });
  // Page teardown (location.reload / exit): free every context's GL objects, which live in the root share group
  // and would otherwise outlive the page (about 0.3 MB of GL memory per reloaded CTS page on Quest).
  const add = (g as { addEventListener?: (t: string, f: () => void) => void }).addEventListener;
  if (typeof add === 'function') add.call(g, 'pagehide', () => releaseAllContexts());
}
Object.defineProperty(g, '__iwnWebGL', { value: api, configurable: true, enumerable: false, writable: true });
