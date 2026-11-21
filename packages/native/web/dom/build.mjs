/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Builds dist/dom.js (readable) and dist/dom.min.js: an IIFE the host evaluates after the web glue bundle and before
// the image / canvas2d / webgl / xr preludes, on the page global only. esbuild comes from web/glue's devDependencies
// (no install of its own here), as for web/image and web/canvas2d.
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
  const outfile = join(here, 'dist', minify ? 'dom.min.js' : 'dom.js');
  await build({
    entryPoints: [join(here, 'entry.ts')],
    bundle: true,
    format: 'iife',
    platform: 'neutral',
    target: 'es2024',
    minify,
    // class names are API (`el.constructor.name`, `${obj}` tags, the Element constructor's interface -> tag map)
    keepNames: true,
    legalComments: 'none',
    logLevel: 'warning',
    outfile,
  });
  const bytes = readFileSync(outfile);
  console.log(
    `${outfile}: ${bytes.length} B, ${gzipSync(bytes).length} B gzip`,
  );
}
