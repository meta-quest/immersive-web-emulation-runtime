#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Lays out the template APK's runtime assets, for
// packager/template/build-template.mjs --assets <dir>:
//
//   node release/stage-template-assets.mjs --out <dir> --snapshot <snapshot_blob.bin>
//
// <dir>/iwn/prelude/<name>.js   the preludes of release/template-assets.json, in order
// <dir>/iwn/config.json         runtime defaults: origin, appRoot, index, preludes (the packer keeps keys it does not set)
// <dir>/iwn/v8/snapshot_blob.bin
// <dir>/iwn/fonts/*, iwn/licenses/**   from the module asset lists and the release notices

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isMain, PKG } from './lib.mjs';

export function stageTemplateAssets({ out, snapshot, root = PKG }) {
  const spec = JSON.parse(readFileSync(path.join(root, 'release', 'template-assets.json'), 'utf8'));
  rmSync(out, { recursive: true, force: true });
  const missing = [];
  const put = (from, to) => {
    if (!existsSync(from)) return missing.push(from);
    mkdirSync(path.dirname(path.join(out, to)), { recursive: true });
    copyFileSync(from, path.join(out, to));
  };
  const preludes = [];
  for (const rel of spec.preludes) {
    if (spec.notShipped?.includes(rel)) throw new Error(`${rel} is listed as not shipped`);
    const name = path.basename(rel);
    put(path.join(root, rel), `iwn/prelude/${name}`);
    preludes.push(`iwn/prelude/${name}`);
  }
  for (const list of spec.assetLists ?? []) {
    const file = path.join(root, list);
    if (!existsSync(file)) {
      missing.push(file);
      continue;
    }
    const base = path.dirname(file);
    for (const a of JSON.parse(readFileSync(file, 'utf8')).assets) put(path.join(base, a.from), a.to);
  }
  for (const l of spec.licenses ?? []) put(path.join(root, l.from), l.to);
  if (snapshot) put(snapshot, 'iwn/v8/snapshot_blob.bin');
  else missing.push('--snapshot <snapshot_blob.bin>');
  const config = { origin: 'https://app.local', appRoot: 'app', index: 'index.html', preludes };
  if (Array.isArray(spec.workerPreludes)) {
    const workerPreludes = spec.workerPreludes.map((rel) => {
      if (!spec.preludes.includes(rel)) throw new Error(`workerPreludes: ${rel} is not one of the page preludes`);
      return `iwn/prelude/${path.basename(rel)}`;
    });
    config.workers = { preludes: workerPreludes };
  }
  mkdirSync(path.join(out, 'iwn'), { recursive: true });
  writeFileSync(path.join(out, 'iwn', 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  return { preludes, missing };
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, snapshot: { type: 'string' } } });
  if (!values.out) {
    process.stderr.write('usage: stage-template-assets.mjs --out <dir> --snapshot <snapshot_blob.bin>\n');
    process.exit(2);
  }
  const r = stageTemplateAssets({ out: path.resolve(values.out), snapshot: values.snapshot });
  if (r.missing.length) {
    process.stderr.write(`stage-template-assets: missing inputs (build the web areas first):\n${r.missing.map((m) => `  - ${m}`).join('\n')}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`stage-template-assets: ${r.preludes.length} preludes -> ${values.out}\n`);
}
