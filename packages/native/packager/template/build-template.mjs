#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Build a template APK (CI / runtime developers only; app developers never run
// this: they download the published template, PKG-1/PKG-2).
//
//   node packager/template/build-template.mjs [--out <dir>] [--native-lib <libX.so> ...] [--lib-name <name>]
//                                              [--assets <dir>] [--runtime-version <v>] [--native-build release|debug]
//
// Without --native-lib it builds the stand-in native library in src/ (logs the
// packed config and asset layout on the device). The runtime build
// passes its libiwernative.so (+ libv8android.so, libc++_shared.so, ...) and
// its runtime assets (prelude, V8 snapshot, fonts) with --native-lib/--assets and
// --lib-name iwernative.
//
// Needs: Android SDK (build-tools aapt2, platforms/android-34), NDK (for the
// stand-in library), Node 22.18+ (runs the packager's TypeScript directly).
// Writes <out>/iwer-native-template.apk (unsigned; the packer signs) and
// <out>/template-info.json (sha256 + size for packager/templates.json).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { encodePng, placeholderIcon } from '../src/png.ts';
import { copyEntry, prepareEntry, readZip, writeZip } from '../src/zip.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    out: { type: 'string', default: path.join(here, 'out') },
    'native-lib': { type: 'string', multiple: true },
    'lib-name': { type: 'string' },
    assets: { type: 'string' },
    'runtime-version': { type: 'string', default: '0.0.0-standin' },
    'native-build': { type: 'string', default: 'release' },
    'min-sdk': { type: 'string', default: '29' },
    'target-sdk': { type: 'string', default: '32' },
  },
});

const sdk =
  process.env.ANDROID_HOME ||
  process.env.ANDROID_SDK_ROOT ||
  (process.env.IWN_TOOLCHAIN_DIR
    ? path.join(process.env.IWN_TOOLCHAIN_DIR, 'android')
    : '');
if (!sdk) {
  console.error(
    'build-template: set ANDROID_HOME (Android SDK with build-tools and platforms/android-34)',
  );
  process.exit(2);
}
const buildTools = (() => {
  const dir = path.join(sdk, 'build-tools');
  const versions = readdirSync(dir)
    .filter((v) => existsSync(path.join(dir, v, 'aapt2')))
    .sort();
  if (!versions.length)
    throw new Error(`no build-tools with aapt2 under ${dir}`);
  return path.join(dir, versions[versions.length - 1]);
})();
const androidJar = path.join(sdk, 'platforms', 'android-34', 'android.jar');
const ndk =
  process.env.ANDROID_NDK_HOME || path.join(sdk, 'ndk', '27.2.12479018');
const aapt2 = path.join(buildTools, 'aapt2');

const work = mkdtempSync(path.join(os.tmpdir(), 'iwn-template-'));
const run = (cmd, args) =>
  execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] }).toString();

try {
  // 1. Resources: strings + generated launcher icons in five densities.
  const res = path.join(work, 'res');
  cpSync(path.join(here, 'res'), res, { recursive: true });
  const densities = {
    mdpi: 48,
    hdpi: 72,
    xhdpi: 96,
    xxhdpi: 144,
    xxxhdpi: 192,
  };
  for (const [d, px] of Object.entries(densities)) {
    mkdirSync(path.join(res, `mipmap-${d}`), { recursive: true });
    writeFileSync(
      path.join(res, `mipmap-${d}`, 'ic_launcher.png'),
      encodePng(placeholderIcon(px)),
    );
  }
  const compiled = path.join(work, 'compiled.zip');
  run(aapt2, ['compile', '--no-crunch', '--dir', res, '-o', compiled]);
  const base = path.join(work, 'base.apk');
  // --lib-name (the runtime build): the activity must load that library, so
  // link a copy of the manifest whose android.app.lib_name names it.
  let manifestFile = path.join(here, 'AndroidManifest.xml');
  if (values['lib-name'] && values['native-lib']?.length) {
    if (!/^[A-Za-z0-9_]+$/.test(values['lib-name']))
      throw new Error(`--lib-name ${values['lib-name']} is not a library name`);
    manifestFile = path.join(work, 'AndroidManifest.xml');
    writeFileSync(
      manifestFile,
      readFileSync(path.join(here, 'AndroidManifest.xml'), 'utf8').replace(
        /(android:name="android\.app\.lib_name"\s+android:value=")iwntemplate(")/,
        `$1${values['lib-name']}$2`,
      ),
    );
  }
  run(aapt2, [
    'link',
    '-o',
    base,
    '-I',
    androidJar,
    '--manifest',
    manifestFile,
    '--min-sdk-version',
    values['min-sdk'],
    '--target-sdk-version',
    values['target-sdk'],
    '--version-code',
    '1',
    '--version-name',
    '0.0.0',
    compiled,
  ]);

  // 2. Native libraries.
  let libs = values['native-lib'] ?? [];
  let libName = values['lib-name'];
  if (libs.length === 0) {
    const clang = path.join(
      ndk,
      'toolchains',
      'llvm',
      'prebuilt',
      'linux-x86_64',
      'bin',
      `aarch64-linux-android${values['min-sdk']}-clang`,
    );
    const so = path.join(work, 'libiwntemplate.so');
    run(clang, [
      '-shared',
      '-fPIC',
      '-O2',
      '-Wall',
      '-Werror',
      '-Wl,-z,max-page-size=16384',
      '-Wl,--build-id=sha1',
      '-Wl,--no-undefined',
      '-o',
      so,
      path.join(here, 'src', 'template_main.c'),
      '-landroid',
      '-llog',
    ]);
    run(
      path.join(
        ndk,
        'toolchains',
        'llvm',
        'prebuilt',
        'linux-x86_64',
        'bin',
        'llvm-strip',
      ),
      ['--strip-unneeded', so],
    );
    libs = [so];
    libName = 'iwntemplate';
  }
  if (libName && !libs.some((l) => path.basename(l) === `lib${libName}.so`))
    throw new Error(
      `--lib-name ${libName}: no --native-lib named lib${libName}.so (the activity would fail to load)`,
    );

  // 3. Assemble: aapt2 output + libs + template metadata + default runtime config.
  const zip = readZip(readFileSync(base));
  const entries = [];
  const icons = [];
  for (const e of zip.entries) {
    entries.push(copyEntry(zip, e, 4));
    const m = /^res\/mipmap-(\w+?)(?:-v\d+)?\/ic_launcher\.png$/.exec(e.name);
    if (m && densities[m[1]]) icons.push({ path: e.name, px: densities[m[1]] });
  }
  for (const lib of libs)
    entries.push(
      await prepareEntry(
        `lib/arm64-v8a/${path.basename(lib)}`,
        readFileSync(lib),
        { compress: false, align: 16384 },
      ),
    );
  if (values.assets) {
    const files = [];
    const walk = (dir, prefix) => {
      for (const name of readdirSync(dir).sort()) {
        const abs = path.join(dir, name);
        if (statSync(abs).isDirectory()) walk(abs, `${prefix}${name}/`);
        else files.push({ abs, name: `assets/${prefix}${name}` });
      }
    };
    walk(values.assets, '');
    for (const f of files) {
      // The V8 snapshot is mapped by the runtime: store it uncompressed.
      const compress = !/\.(bin|ttf|otf|ttc)$/i.test(f.name);
      entries.push(
        await prepareEntry(f.name, readFileSync(f.abs), { compress }),
      );
    }
  }
  // IWN_BUILD_ID: set by release/build-release.sh (HEAD plus a digest of uncommitted sources when the tree is dirty).
  // Without it: HEAD, plus "-dirty" when this package has uncommitted or untracked files, so a dev or integration
  // template never names a clean commit its code is not in.
  let buildId = process.env.IWN_BUILD_ID || 'unknown';
  if (!process.env.IWN_BUILD_ID) {
    const pkgRoot = path.join(here, '..', '..');
    let head = '';
    try {
      head = run('git', [
        '-C',
        pkgRoot,
        'rev-parse',
        '--short=12',
        'HEAD',
      ]).trim();
    } catch {}
    if (head) {
      let clean = false;
      try {
        clean =
          run('git', [
            '-C',
            pkgRoot,
            'status',
            '--porcelain',
            '--',
            '.',
          ]).trim() === '';
      } catch {}
      buildId = clean ? head : `${head}-dirty`;
    }
  }
  const meta = {
    format: 1,
    runtimeVersion: values['runtime-version'],
    buildId,
    placeholderPackage: 'org.iwer.nativetemplate',
    icons: icons.sort((a, b) => a.px - b.px),
    abis: ['arm64-v8a'],
    nativeBuild: values['native-build'],
  };
  entries.push(
    await prepareEntry(
      'assets/iwn/template.json',
      Buffer.from(`${JSON.stringify(meta, null, 2)}\n`),
      { compress: true },
    ),
  );
  if (!entries.some((e) => e.name === 'assets/iwn/config.json'))
    entries.push(
      await prepareEntry(
        'assets/iwn/config.json',
        Buffer.from('{\n  "origin": "https://app.local"\n}\n'),
        { compress: true },
      ),
    );
  const written = writeZip(entries);
  const apk = Buffer.concat([
    written.entries,
    written.centralDirectory,
    written.eocd,
  ]);
  mkdirSync(values.out, { recursive: true });
  const outApk = path.join(values.out, 'iwer-native-template.apk');
  writeFileSync(outApk, apk);
  const info = {
    version: values['runtime-version'],
    sha256: createHash('sha256').update(apk).digest('hex'),
    size: apk.length,
    icons: meta.icons,
    libs: libs.map((l) => path.basename(l)),
  };
  writeFileSync(
    path.join(values.out, 'template-info.json'),
    `${JSON.stringify(info, null, 2)}\n`,
  );
  console.log(`wrote ${outApk} (${apk.length} bytes, sha256 ${info.sha256})`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
