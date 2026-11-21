#!/usr/bin/env node
// Builds dist/webgl.js (readable) and dist/webgl.min.js (shipped prelude), IIFE, and prints the size line.
import { build } from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');
mkdirSync(out, { recursive: true });
for (const minify of [false, true]) {
  await build({
    entryPoints: [join(here, 'prelude.ts')],
    bundle: true,
    format: 'iife',
    platform: 'neutral',
    target: 'es2024',
    minify,
    // WebGL interface names are observable (Symbol.toStringTag, Function.name, TypeError messages): keep them.
    keepNames: true,
    legalComments: 'none',
    outfile: join(out, minify ? 'webgl.min.js' : 'webgl.js'),
    logLevel: 'warning',
  });
}
const code = readFileSync(join(out, 'webgl.min.js'));
console.log(`webgl.min.js: ${(code.length / 1024).toFixed(1)} KB minified, ${(gzipSync(code, { level: 9 }).length / 1024).toFixed(1)} KB min+gzip`);
