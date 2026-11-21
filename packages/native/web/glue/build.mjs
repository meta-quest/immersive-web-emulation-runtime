/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Builds dist/glue.js (readable) and dist/glue.min.js (shipped) as IIFE scripts the host evaluates
// before the app's entry module, plus dist/glue-subtle.min.js (the opt-in digest-only crypto.subtle
// prelude, evaluated right after glue.min.js; it does nothing unless config `subtle` is 'digest'), and
// prints the size budget lines (minified + gzip).
import { build } from 'esbuild';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');
mkdirSync(out, { recursive: true });

// whatwg-url is used as is, but three of its dependencies are swapped at build time for small shims
// (see src/shims/*.ts and THIRD_PARTY.md): tr46's UTS #46 table, @exodus/bytes' legacy encodings, and
// whatwg-url's own load-time TextEncoder/TextDecoder construction.
const shims = {
  name: 'iwn-glue-shims',
  setup(b) {
    const shim = (f) => ({ path: join(here, 'src/shims', f) });
    b.onResolve({ filter: /^tr46$/ }, () => shim('tr46.ts'));
    b.onResolve({ filter: /^@exodus\/bytes\/whatwg\.js$/ }, () =>
      shim('exodus-whatwg.ts'),
    );
    b.onResolve({ filter: /^@exodus\/bytes\/encoding\.js$/ }, () =>
      shim('empty.ts'),
    );
    b.onResolve({ filter: /^\.\/encoding$/ }, (args) =>
      args.importer.includes(`whatwg-url${'/'}lib`)
        ? shim('whatwg-url-encoding.ts')
        : undefined,
    );
  },
};

export const buildOptions = {
  entryPoints: [join(here, 'src/entry.ts')],
  plugins: [shims],
  bundle: true,
  format: 'iife',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  // V8 15.5 runs ES2024 natively; do not down-level.
  target: 'es2024',
  // Interface objects must keep their names (Blob.name === 'Blob', error.constructor.name, ...).
  keepNames: true,
  legalComments: 'none',
  logLevel: 'warning',
};

// The third-party packages that end up in the bundle, at the versions THIRD_PARTY.md records. The build
// fails if the bundle pulls in anything else or another version (package-lock.json is not committed,
// and whatwg-url's own dependencies are ranges).
export const BUNDLED = {
  'whatwg-url': '17.3.0',
  'webidl-conversions': '8.0.1',
  punycode: '2.3.1',
  '@noble/hashes': '2.4.0',
};

/** The subtle prelude's build options (same settings, other entry). */
export const subtleBuildOptions = {
  ...buildOptions,
  entryPoints: [join(here, 'src/subtle-entry.ts')],
};

/** The bundled packages (from the esbuild metafile), checked against BUNDLED. */
export function bundledPackages(...metafiles) {
  const names = new Set();
  for (const metafile of metafiles) {
    const output = metafile.outputs[Object.keys(metafile.outputs)[0]];
    for (const input of Object.keys(output.inputs)) {
      const m = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
      if (m && output.inputs[input].bytesInOutput > 0) names.add(m[1]);
    }
  }
  const problems = [];
  const found = [];
  for (const name of [...names].sort()) {
    const pkg = JSON.parse(
      readFileSync(join(here, 'node_modules', name, 'package.json'), 'utf8'),
    );
    if (!(name in BUNDLED))
      problems.push(
        `${name}@${pkg.version} is bundled but not listed in BUNDLED / THIRD_PARTY.md`,
      );
    else if (BUNDLED[name] !== pkg.version)
      problems.push(
        `${name} is ${pkg.version}, THIRD_PARTY.md records ${BUNDLED[name]}`,
      );
    found.push({ name, version: pkg.version, license: pkg.license });
  }
  return { found, problems };
}

/** Writes dist/glue.NOTICES.txt: the copyright and license text of every bundled package (MIT and
 * BSD-2-Clause require it in redistributed copies; the APK packer ships this file with the glue). */
export function writeNotices(found) {
  const parts = [
    'Third-party software in glue.min.js and glue-subtle.min.js (@iwer/native web glue)',
    '',
    'glue.min.js bundles whatwg-url, webidl-conversions and punycode; glue-subtle.min.js bundles',
    '@noble/hashes. Their copyright and license notices follow.',
    '',
  ];
  for (const { name, version, license } of found) {
    const dir = join(here, 'node_modules', name);
    const file = readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
    if (!file) throw new Error(`no license file in ${dir}`);
    parts.push(
      '='.repeat(78),
      `${name} ${version} (${license})`,
      '='.repeat(78),
      '',
      readFileSync(join(dir, file), 'utf8').trim(),
      '',
    );
  }
  const out = join(here, 'dist', 'glue.NOTICES.txt');
  writeFileSync(out, parts.join('\n'));
  return out;
}

export async function buildGlue({
  minify = true,
  write = true,
  subtle = false,
} = {}) {
  const outfile = join(
    out,
    subtle ? 'glue-subtle.min.js' : minify ? 'glue.min.js' : 'glue.js',
  );
  const result = await build({
    ...(subtle ? subtleBuildOptions : buildOptions),
    minify,
    outfile,
    write,
    metafile: true,
  });
  return { outfile, result };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildGlue({ minify: false });
  const { outfile, result } = await buildGlue({ minify: true });
  const subtle = await buildGlue({ minify: true, subtle: true });
  writeFileSync(join(out, 'meta.json'), JSON.stringify(result.metafile));
  const { found, problems } = bundledPackages(
    result.metafile,
    subtle.result.metafile,
  );
  if (problems.length > 0) {
    console.error(`third-party check failed:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  const notices = writeNotices(found);
  console.log(
    `notices: ${notices.slice(here.length + 1)} (${found.map((p) => `${p.name}@${p.version}`).join(', ')})`,
  );
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  for (const f of [outfile, subtle.outfile]) {
    const code = readFileSync(f);
    const gz = gzipSync(code, { level: 9 }).length;
    console.log(
      `${f.slice(out.length + 1)}: ${kb(code.length)} minified, ${kb(gz)} min+gzip`,
    );
  }
  if (process.argv.includes('--breakdown')) {
    const inputs = Object.entries(
      result.metafile.outputs[Object.keys(result.metafile.outputs)[0]].inputs,
    )
      .map(([k, v]) => [k, v.bytesInOutput])
      .sort((a, b) => b[1] - a[1]);
    const groups = {};
    for (const [k, n] of inputs) {
      const key = k.startsWith('node_modules/')
        ? k
            .split('/')
            .slice(1, k.includes('/@') ? 3 : 2)
            .join('/')
        : k;
      groups[key] = (groups[key] ?? 0) + n;
    }
    for (const [k, n] of Object.entries(groups).sort((a, b) => b[1] - a[1]))
      console.log(`  ${kb(n).padStart(9)}  ${k}`);
  }
}
