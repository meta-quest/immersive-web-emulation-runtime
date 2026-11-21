#!/usr/bin/env node
// Builds the GL-CTS-1 device harness app: cts/device-main.mjs (+ page.mjs) as the app's main module, with the
// shipped preludes web/glue/dist/glue.min.js and dist/webgl.min.js, packed by the runtime's template build-apk.mjs.
//
//   node cts/device-build.mjs --libs <android runtime build>/apk-libs.txt --out gl-cts.apk
//        [--dist <dir>] [--inspector-port 9502] [--debug-port 9602]
//
// Run `node build.mjs` (dist/webgl.min.js) and web/glue's build first. Then: node cts/device-run.mjs --serial ...
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..', '..');
const args = {};
for (let i = 2; i < process.argv.length; i++) args[process.argv[i].replace(/^--/, '')] = process.argv[++i];
if (!args.libs || !args.out) {
  console.error('usage: device-build.mjs --libs <apk-libs.txt> --out <apk> [--dist dir] [--inspector-port N] [--debug-port N]');
  process.exit(2);
}
const dist = args.dist ?? join(dirname(fileURLToPath(import.meta.url)), '../../../build/gl/gl-cts-dist');
mkdirSync(dist, { recursive: true });
await build({
  entryPoints: [join(here, 'device-main.mjs')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2024',
  outfile: join(dist, 'main.js'),
  logLevel: 'warning',
});
writeFileSync(
  join(dist, 'index.html'),
  '<!doctype html>\n<html><head><meta charset="utf-8"><title>iwer-native GL-CTS-1 harness</title>' +
    '<script type="module" src="/main.js"></script></head><body></body></html>\n',
);
const preludes = [join(pkgRoot, 'web/glue/dist/glue.min.js'), join(here, '..', 'dist', 'webgl.min.js')];
for (const p of preludes) if (!existsSync(p)) throw new Error(`missing prelude ${p} (build it first)`);
const out = execFileSync(
  process.execPath,
  [
    join(pkgRoot, 'runtime/app/template/build-apk.mjs'),
    '--libs', args.libs,
    '--dist', dist,
    ...preludes.flatMap((p) => ['--prelude', p]),
    '--out', args.out,
    '--package', 'com.iwernative.glcts',
    '--label', 'iwn gl cts',
    '--inspector-port', args['inspector-port'] ?? '9502',
    '--debug-port', args['debug-port'] ?? '9602',
  ],
  { encoding: 'utf8' },
);
process.stdout.write(out.split('\n')[0] + '\n');
