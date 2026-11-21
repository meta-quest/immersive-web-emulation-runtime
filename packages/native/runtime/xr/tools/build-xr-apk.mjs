#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Builds a device APK with the XR module's manifest entries (manifest/vr-manifest.json): the template build
// (runtime/app/template/build-apk.mjs) reads AndroidManifest.xml from its own directory, so this copies the
// script next to a patched manifest in a temporary directory and runs it there with the same arguments. The
// template itself is not modified.
//
//   node runtime/xr/tools/build-xr-apk.mjs <build-apk.mjs arguments...>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const templateDir = path.resolve(here, '../../app/template');
const additions = JSON.parse(
  fs.readFileSync(path.resolve(here, '../manifest/vr-manifest.json'), 'utf8'),
);

export function patchManifest(xml) {
  const insertAfter = (text, anchor, lines) => {
    const at = text.indexOf(anchor);
    if (at < 0)
      throw new Error(`template manifest: anchor not found: ${anchor}`);
    const end = at + anchor.length;
    return (
      text.slice(0, end) +
      '\n' +
      lines.map((l) => `    ${l}`).join('\n') +
      text.slice(end)
    );
  };
  let out = xml;
  // manifest-level entries after the GLES feature line
  const gles = out.match(
    /<uses-feature android:glEsVersion="[^"]*" android:required="true" \/>/,
  );
  if (!gles)
    throw new Error('template manifest: GLES uses-feature line not found');
  out = insertAfter(out, gles[0], additions.manifest);
  out = insertAfter(
    out,
    '<meta-data android:name="android.app.lib_name" android:value="iwernative" />',
    additions.activity,
  );
  out = insertAfter(
    out,
    '<category android:name="android.intent.category.LAUNCHER" />',
    additions.intentFilter,
  );
  const app = out.indexOf('<activity');
  out =
    out.slice(0, app) +
    additions.application.join('\n        ') +
    '\n        ' +
    out.slice(app);
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'iwn-xr-apk-'));
  try {
    fs.copyFileSync(
      path.join(templateDir, 'build-apk.mjs'),
      path.join(work, 'build-apk.mjs'),
    );
    const manifest = patchManifest(
      fs.readFileSync(path.join(templateDir, 'AndroidManifest.xml'), 'utf8'),
    );
    fs.writeFileSync(path.join(work, 'AndroidManifest.xml'), manifest);
    execFileSync(
      process.execPath,
      [path.join(work, 'build-apk.mjs'), ...process.argv.slice(2)],
      { stdio: 'inherit' },
    );
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
