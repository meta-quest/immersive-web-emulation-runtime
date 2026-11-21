/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Test harness: a fresh `vm` context (V8 builtins only, like the runtime's isolate) with fake core natives, the
// shipped glue bundle (web/glue/dist/glue.min.js) and the shipped DOM bundle (dist/dom.min.js, built on demand),
// evaluated in the template's order. Optionally the image prelude after them (with web/image's fake natives).

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance as hostPerformance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const domRoot = join(here, '..');
const webRoot = join(domRoot, '..');

function newestSource(dir: string): number {
  let t = 0;
  for (const f of [
    'entry.ts',
    ...[
      'css',
      'document',
      'env',
      'geometry',
      'html-elements',
      'html',
      'install',
      'nodes',
      'observers',
      'selectors',
      'ui-events',
      'window',
    ].map((n) => `src/${n}.ts`),
  ]) {
    const p = join(dir, f);
    if (existsSync(p)) t = Math.max(t, statSync(p).mtimeMs);
  }
  return t;
}

let built = false;
function ensureBuilt(): void {
  if (built) return;
  const min = join(domRoot, 'dist', 'dom.min.js');
  if (!existsSync(min) || statSync(min).mtimeMs < newestSource(domRoot)) {
    execFileSync(process.execPath, [join(domRoot, 'build.mjs')], {
      stdio: 'ignore',
    });
  }
  built = true;
}

export interface Lifecycle {
  visibilityState: string;
  focused: boolean;
  readyState: string;
}

export interface DomContext {
  g: Record<string, any>;
  ctx: vm.Context;
  run: <T = any>(code: string) => T;
  lifecycle: Lifecycle;
  fetched: string[];
}

export interface DomContextOptions {
  html?: string | null;
  config?: Record<string, unknown>;
  files?: Record<string, string>;
  image?: boolean;
  worker?: boolean;
}

export function createDomContext(opts: DomContextOptions = {}): DomContext {
  ensureBuilt();
  const lifecycle: Lifecycle = {
    visibilityState: 'visible',
    focused: true,
    readyState: 'loading',
  };
  const sandbox: Record<string, unknown> = {};
  const ctx = vm.createContext(sandbox);
  const g = vm.runInContext('globalThis', ctx) as Record<string, any>;
  const config = {
    url: 'https://app.local/',
    ...(opts.config ?? {}),
    ...(opts.worker ? { scope: 'worker' } : {}),
  };
  g.__iwn = {
    clock: {
      now: () => hostPerformance.now(),
      timeOrigin: () => hostPerformance.timeOrigin,
    },
    crypto: { random: (u8: Uint8Array) => u8.fill(7) },
    device: {
      info: () => ({
        model: 'Quest 3S',
        androidRelease: '14',
        languages: ['en-US'],
        hardwareConcurrency: 4,
      }),
    },
    app: { reload() {}, navigate() {} },
    core: {
      lifecycleState: () => ({ ...lifecycle }),
      documentSource: () => (opts.html === undefined ? null : opts.html),
      isWorker: !!opts.worker,
      documentUrl: 'https://app.local/',
    },
    config,
  };
  g.setTimeout = (cb: () => void, ms?: number) => setTimeout(cb, ms);
  g.clearTimeout = (id: ReturnType<typeof setTimeout>) => clearTimeout(id);
  const fetched: string[] = [];
  const files = opts.files ?? {};
  g.fetch = async (url: string) => {
    fetched.push(String(url));
    const path = new URL(String(url)).pathname;
    const body = files[path];
    return {
      ok: body !== undefined,
      status: body !== undefined ? 200 : 404,
      text: async () => body ?? '',
    };
  };
  vm.runInContext(
    readFileSync(join(webRoot, 'glue', 'dist', 'glue.min.js'), 'utf8'),
    ctx,
    { filename: 'glue.min.js' },
  );
  vm.runInContext(
    readFileSync(join(domRoot, 'dist', 'dom.min.js'), 'utf8'),
    ctx,
    { filename: 'dom.min.js' },
  );
  if (opts.image) {
    const imageMin = join(webRoot, 'image', 'dist', 'image.min.js');
    g.__iwn.image = {
      decode() {},
      fromPixels() {},
      close() {},
      transform() {},
      cancel() {},
      poll() {},
      needsPolling: false,
    };
    vm.runInContext(readFileSync(imageMin, 'utf8'), ctx, {
      filename: 'image.min.js',
    });
  }
  return {
    g,
    ctx,
    run: <T>(code: string) => vm.runInContext(code, ctx) as T,
    lifecycle,
    fetched,
  };
}

export const tick = (ms = 0): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
