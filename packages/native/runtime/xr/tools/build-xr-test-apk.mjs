#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Builds the XR pipeline check app (tools/xr-test-app) as a device APK, with the release template's preludes
// (release/template-assets.json) and the XR manifest entries, in one of its test variants:
//
//   node runtime/xr/tools/build-xr-test-apk.mjs --out <apk> --toolchain <clean toolchain root>
//        [--mode default|webgllayer|nooffer|request] [--package <id>] [--port 9509] [--release]
//        [--libs <apk-libs.txt>] [--config extra.json]
//
// The mode is written to mode.json next to index.html (main.js reads it at boot). Package ids default to
// com.iwernative.xrtest (+ ".<mode>" for the variants) so the variants install side by side.
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
const out = opt('out');
const toolchain = opt('toolchain', process.env.IWN_TOOLCHAIN_DIR);
const mode = opt('mode', 'default');
if (
  !out ||
  !toolchain ||
  !['default', 'webgllayer', 'nooffer', 'request'].includes(mode)
) {
  console.error(
    'usage: build-xr-test-apk.mjs --out <apk> --toolchain <dir> [--mode default|webgllayer|nooffer|request]',
  );
  process.exit(2);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'iwn-xrtest-'));
try {
  const dist = path.join(work, 'dist');
  fs.cpSync(path.join(here, 'xr-test-app'), dist, { recursive: true });
  if (mode !== 'default')
    fs.writeFileSync(path.join(dist, 'mode.json'), JSON.stringify({ mode }));
  const spec = JSON.parse(
    fs.readFileSync(path.join(pkg, 'release/template-assets.json'), 'utf8'),
  );
  const preludes = spec.preludes.map((rel) => path.join(pkg, rel));
  for (const p of preludes)
    if (!fs.existsSync(p))
      throw new Error(`missing prelude ${p} (build that web module first)`);
  const config = { stats: { logIntervalMs: 2000 } };
  if (opt('config'))
    Object.assign(config, JSON.parse(fs.readFileSync(opt('config'), 'utf8')));
  const configPath = path.join(work, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  const buildArgs = [
    path.join(here, 'build-xr-apk.mjs'),
    '--libs',
    opt('libs', process.env.IWN_APK_LIBS ?? ''),
    '--out',
    out,
    '--dist',
    dist,
    '--package',
    opt(
      'package',
      mode === 'default'
        ? 'com.iwernative.xrtest'
        : `com.iwernative.xrtest.${mode}`,
    ),
    '--label',
    `xr-test ${mode}`,
    '--inspector-port',
    opt('port', '9509'),
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
