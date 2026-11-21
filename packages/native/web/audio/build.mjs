/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Builds dist/audio.js (readable) and dist/audio.min.js (shipped prelude, after the web glue) as IIFE
// scripts, and prints the size line (minified + gzip).
import { build } from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');
mkdirSync(out, { recursive: true });

const options = {
  entryPoints: [join(here, 'src/prelude.ts')],
  bundle: true,
  format: 'iife',
  platform: 'neutral',
  target: 'es2024',
  keepNames: true,  // AudioContext.name === 'AudioContext', error.constructor.name, ...
  legalComments: 'none',
  logLevel: 'warning',
};
await build({ ...options, outfile: join(out, 'audio.js') });
await build({ ...options, outfile: join(out, 'audio.min.js'), minify: true });
const min = readFileSync(join(out, 'audio.min.js'));
console.log(`dist/audio.min.js ${min.length} bytes, ${gzipSync(min).length} gzip`);
