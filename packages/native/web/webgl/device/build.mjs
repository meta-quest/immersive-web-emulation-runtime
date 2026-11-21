#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Bundles the on-device WebGL suite (device/main.ts) into an app dist (index.html + main.js) for the runtime's
// template APK (runtime/app/template/build-apk.mjs --dist <out>).
//   node device/build.mjs [<out dir>]   (default: build/gl/gl-device-dist under the package)
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const benchOnly = process.argv.includes('--bench-only');
const out =
  process.argv.filter((a) => !a.startsWith('--'))[2] ??
  join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../build/gl',
    benchOnly ? 'gl-bench-dist' : 'gl-device-dist',
  );
mkdirSync(out, { recursive: true });
const alias = {
  name: 'device-shims',
  setup(b) {
    b.onResolve({ filter: /^node:test$/ }, () => ({
      path: join(here, 'shims/node-test.ts'),
    }));
    b.onResolve({ filter: /^node:assert\/strict$/ }, () => ({
      path: join(here, 'shims/assert.ts'),
    }));
    b.onResolve({ filter: /\/real-gl\.ts$/ }, (args) =>
      args.importer.includes('/test/')
        ? { path: join(here, 'shims/real-gl.ts') }
        : undefined,
    );
  },
};
await build({
  entryPoints: [join(here, 'main.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2024',
  mainFields: ['module', 'main'],
  outfile: join(out, 'main.js'),
  plugins: [alias],
  logLevel: 'warning',
  define: {
    'process.env.IWN_GL_ADDON': 'undefined',
    __BENCH_ONLY__: benchOnly ? 'true' : 'false',
  },
});
writeFileSync(
  join(out, 'index.html'),
  '<!doctype html>\n<html><head><meta charset="utf-8"><title>iwer-native gl device suite</title>' +
    '<script type="module" src="/main.js"></script></head><body></body></html>\n',
);
console.log(`wrote ${out}`);
