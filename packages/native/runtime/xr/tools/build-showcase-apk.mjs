#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Packs a built web app (proto-showcase-vr's dist) into a device APK for the M3 check: the runtime preludes in the
// release template's order (release/template-assets.json), plus the TEST-ONLY DOM scaffolding
// (showcase-dom/dom-shim.js, page only, never in workers) until a DOM module exists, with the XR manifest entries
// (build-xr-apk.mjs). Not the M5 packer.
//
//   node runtime/xr/tools/build-showcase-apk.mjs --dist <dist> --out <apk> [--package <id>] [--label <name>]
//        [--port 9509] [--release] [--config extra.json] [--libs <apk-libs.txt>] [--toolchain <dir>]
//
// --toolchain (or IWN_TOOLCHAIN_DIR) must be a clean toolchain root (android/{build-tools,platforms,ndk}, v8-15.5):
// as given.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, '../../..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const dist = opt('dist');
const out = opt('out');
if (!dist || !out) {
  console.error(
    'usage: build-showcase-apk.mjs --dist <dist> --out <apk> [--package id] [--label name] [--port 9509] [--release]',
  );
  process.exit(2);
}
const toolchain = opt('toolchain', process.env.IWN_TOOLCHAIN_DIR);
if (!toolchain) {
  console.error(
    'build-showcase-apk: pass --toolchain <toolchain root> (or set IWN_TOOLCHAIN_DIR)',
  );
  process.exit(2);
}

// Element ids/classes of the index.html body (DOM-7 approximation for the scaffolding).
const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const bodyHtml = (/<body[^>]*>([\s\S]*)<\/body>/i.exec(html) ?? ['', ''])[1];
const body = [];
for (const m of bodyHtml.matchAll(/<([a-zA-Z][\w-]*)([^>]*)>/g)) {
  const id = /\bid\s*=\s*"([^"]*)"/.exec(m[2])?.[1];
  const className = /\bclass\s*=\s*"([^"]*)"/.exec(m[2])?.[1];
  if (id || className) body.push({ tag: m[1].toLowerCase(), id, className });
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'iwn-showcase-'));
try {
  const shim = path.join(work, 'dom-shim.js');
  fs.writeFileSync(
    shim,
    `globalThis.__iwnDomBody = ${JSON.stringify(body)};\n` +
      fs.readFileSync(path.join(here, 'showcase-dom/dom-shim.js'), 'utf8'),
  );
  // The release template's prelude list, in its order, with the test DOM right after the glue.
  const spec = JSON.parse(
    fs.readFileSync(path.join(pkg, 'release/template-assets.json'), 'utf8'),
  );
  const preludes = [];
  for (const rel of spec.preludes) {
    preludes.push(path.join(pkg, rel));
    if (rel.endsWith('glue-subtle.min.js')) preludes.push(shim);
  }
  for (const p of preludes)
    if (!fs.existsSync(p))
      throw new Error(`missing prelude ${p} (build that web module first)`);
  const workerPreludes = preludes
    .filter((p) => p !== shim)
    .map((p) => `iwn/prelude/${path.basename(p)}`);
  const config = {
    stats: { logIntervalMs: 2000 },
    network: { allow: ['https://cdn.jsdelivr.net'] }, // REG-5: controller models from the input-profiles CDN
    workers: { preludes: workerPreludes },
  };
  if (opt('config'))
    Object.assign(config, JSON.parse(fs.readFileSync(opt('config'), 'utf8')));
  const configPath = path.join(work, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  const port = opt('port', '9509');
  const buildArgs = [
    path.join(here, 'build-xr-apk.mjs'),
    '--libs',
    opt('libs', process.env.IWN_APK_LIBS ?? ''),
    '--out',
    out,
    '--dist',
    dist,
    '--package',
    opt('package', 'com.iwernative.showcasevr'),
    '--label',
    opt('label', 'proto-showcase-vr'),
    '--inspector-port',
    port,
    '--debug-port',
    '0',
    '--config',
    configPath,
    '--toolchain',
    toolchain,
    ...preludes.flatMap((p) => ['--prelude', p]),
  ];
  if (args.includes('--release')) buildArgs.push('--release');
  execFileSync(process.execPath, buildArgs, { stdio: 'inherit' });
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
