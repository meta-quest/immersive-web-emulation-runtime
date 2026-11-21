/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Builds dist/xr.js (readable) and dist/xr.min.js (shipped): one IIFE prelude the runtime evaluates after the web
// glue and the WebGL prelude, before the app. It bundles IWER's host entry point (iwer/host, from the IWER sources
// in this checkout, so the prelude always carries the reviewed host mode) and the adapter in src/. Prints the size
// line for XRF-P-1.
//
//   node build.mjs [--quiet]
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');
// packages/native/web/xr -> packages/iwer
export const IWER_DIR = resolve(here, '../../../iwer');
const quiet = process.argv.includes('--quiet');

// Third-party code that ends up in the bundle (THIRD_PARTY.md, web/xr section). IWER is first-party (MIT).
export const BUNDLED = { 'gl-matrix': '3.4.4' };

export const buildOptions = {
  entryPoints: [join(here, 'src/entry.ts')],
  bundle: true,
  format: 'iife',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  target: 'es2024', // V8 15.5 runs ES2024 natively
  keepNames: true, // XRSession.name, error constructor names, DOMPointReadOnly.name
  legalComments: 'none',
  logLevel: 'warning',
  alias: { 'iwer/host': join(IWER_DIR, 'src/host.ts') },
  // IWER's sources import gl-matrix; IWER's package has no node_modules in this checkout, so resolve it here.
  nodePaths: [join(here, 'node_modules')],
};

// IWER's src/version.ts is generated and gitignored: in a fresh checkout, write it with IWER's own prebuild script.
export function ensureIwerVersion() {
  if (existsSync(join(IWER_DIR, 'src/version.ts'))) return;
  execFileSync('npm', ['run', '--silent', 'prebuild'], {
    cwd: IWER_DIR,
    stdio: 'inherit',
  });
}

export async function buildXr({ minify = true, write = true } = {}) {
  ensureIwerVersion();
  mkdirSync(out, { recursive: true });
  const outfile = join(out, minify ? 'xr.min.js' : 'xr.js');
  const result = await build({
    ...buildOptions,
    minify,
    outfile,
    write,
    metafile: true,
  });
  return { outfile, result };
}

function checkBundled(metafile) {
  const problems = [];
  const output = metafile.outputs[Object.keys(metafile.outputs)[0]];
  for (const input of Object.keys(output.inputs)) {
    // The package is the one after the LAST node_modules/ (a pnpm install nests them:
    // node_modules/.pnpm/<name>@<version>/node_modules/<name>/...); read its own package.json.
    const i = input.lastIndexOf('node_modules/');
    if (i < 0 || output.inputs[input].bytesInOutput === 0) continue;
    const parts = input.slice(i + 'node_modules/'.length).split('/');
    const name = parts[0].startsWith('@')
      ? `${parts[0]}/${parts[1]}`
      : parts[0];
    const pkgDir = resolve(
      process.cwd(),
      input.slice(0, i + 'node_modules/'.length),
      name,
    );
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    if (BUNDLED[name] !== pkg.version)
      problems.push(
        `${name}@${pkg.version} is bundled; THIRD_PARTY.md records ${BUNDLED[name] ?? 'nothing'}`,
      );
  }
  return [...new Set(problems)];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildXr({ minify: false });
  const { outfile, result } = await buildXr({ minify: true });
  writeFileSync(join(out, 'meta.json'), JSON.stringify(result.metafile));
  const problems = checkBundled(result.metafile);
  if (problems.length) {
    console.error(`third-party check failed:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  if (!quiet) {
    const code = readFileSync(outfile);
    const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
    console.log(
      `xr.min.js: ${kb(code.length)} minified, ${kb(gzipSync(code, { level: 9 }).length)} min+gzip`,
    );
    const inputs =
      result.metafile.outputs[Object.keys(result.metafile.outputs)[0]].inputs;
    const groups = {};
    for (const [k, v] of Object.entries(inputs)) {
      const key = k.includes('node_modules/')
        ? k.split('node_modules/').at(-1).split('/')[0]
        : k.includes('immersive-web-emulation-runtime')
          ? 'iwer (host entry)'
          : 'adapter (src/)';
      groups[key] = (groups[key] ?? 0) + v.bytesInOutput;
    }
    for (const [k, n] of Object.entries(groups).sort((a, b) => b[1] - a[1]))
      console.log(`  ${kb(n).padStart(9)}  ${k}`);
  }
}
