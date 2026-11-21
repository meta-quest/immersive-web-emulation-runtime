/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Builds dist/storage{,.min}.js and dist/idb{,.min}.js (IIFE preludes) and prints their sizes.
import { build } from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));

export const common = {
  bundle: true,
  format: 'iife',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  target: 'es2024',
  keepNames: true,
  legalComments: 'none',
  logLevel: 'warning',
  // Some dependencies (immediate, typeson) probe Node's `global`.
  define: { global: 'globalThis' },
};
export const entries = {
  storage: join(here, 'src/entry-storage.ts'),
  idb: join(here, 'src/entry-idb.ts'),
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(join(here, 'dist'), { recursive: true });
  for (const [name, entry] of Object.entries(entries)) {
    for (const minify of [false, true]) {
      const outfile = join(here, 'dist', `${name}${minify ? '.min' : ''}.js`);
      await build({ ...common, entryPoints: [entry], minify, outfile });
      if (minify) {
        const bytes = readFileSync(outfile);
        console.log(
          `${name}.min.js: ${(bytes.length / 1024).toFixed(1)} KB, gzip ${(gzipSync(bytes).length / 1024).toFixed(1)} KB`,
        );
      }
    }
  }
}
