/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Builds dist/net.js (readable) and dist/net.min.js (shipped prelude, IIFE) and prints the size line.
import { build } from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));

export const buildOptions = {
  entryPoints: [join(here, 'src/entry.ts')],
  bundle: true,
  format: 'iife',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  target: 'es2024',
  keepNames: true,
  legalComments: 'none',
  logLevel: 'warning',
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(join(here, 'dist'), { recursive: true });
  for (const minify of [false, true]) {
    const outfile = join(here, 'dist', minify ? 'net.min.js' : 'net.js');
    await build({ ...buildOptions, minify, outfile });
    if (minify) {
      const bytes = readFileSync(outfile);
      console.log(`net.min.js: ${(bytes.length / 1024).toFixed(1)} KB, gzip ${(gzipSync(bytes).length / 1024).toFixed(1)} KB`);
    }
  }
}
