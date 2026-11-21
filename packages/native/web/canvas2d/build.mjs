/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Builds dist/canvas2d.js (readable) and dist/canvas2d.min.js: an IIFE the host evaluates after the web glue bundle, on
// window and worker globals. esbuild comes from web/glue's devDependencies (no install of its own here).
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '../glue/package.json'));
const { build } = require('esbuild');
mkdirSync(join(here, 'dist'), { recursive: true });
for (const minify of [false, true]) {
  const outfile = join(
    here,
    'dist',
    minify ? 'canvas2d.min.js' : 'canvas2d.js',
  );
  await build({
    entryPoints: [join(here, 'entry.ts')],
    bundle: true,
    format: 'iife',
    platform: 'neutral',
    target: 'es2024',
    minify,
    legalComments: 'none',
    logLevel: 'warning',
    outfile,
  });
  const bytes = readFileSync(outfile);
  console.log(
    `${outfile}: ${bytes.length} B, ${gzipSync(bytes).length} B gzip`,
  );
}
