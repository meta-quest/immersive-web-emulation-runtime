#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Generates THIRD_PARTY_NOTICES.txt from release/components.json.
//
//   node release/notices.mjs [--out <file>]     write (default: THIRD_PARTY_NOTICES.txt in the package root)
//   node release/notices.mjs --check            exit 1 if the committed file differs from a fresh generation
//
// Covers everything the npm package redistributes: the template APK (native libraries, V8 and what is statically
// linked into it, fonts) and the JS preludes inside it. License texts are read from the files each component
// lists (the upstream third-party trees, the V8 source tree, node_modules, runtime/*/licenses); IWN_THIRD_PARTY_DIR and
// IWN_V8_SRC say where the first two are. Output is deterministic (no dates), so --check works in CI.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { expand, isMain, loadComponents, PKG, placeholders } from './lib.mjs';

const RULE = '='.repeat(78);

export function mitBody(root = PKG) {
  // The MIT text after the copyright line of this package's LICENSE.
  const text = readFileSync(path.join(root, 'LICENSE'), 'utf8');
  const i = text.indexOf('Permission is hereby granted');
  if (i < 0) throw new Error('LICENSE is not the MIT license text');
  return text.slice(i).trimEnd();
}

function normalise(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function generateNotices({ root = PKG, env = process.env } = {}) {
  const inv = loadComponents(root);
  const vars = placeholders(env, root);
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const missing = [];
  const shipped = inv.components.filter(
    (c) => c.ships === 'apk' || c.ships === 'prelude',
  );
  const byId = new Map(inv.components.map((c) => [c.id, c]));
  const out = [
    `Third-party software notices for ${pkg.name} ${pkg.version}`,
    '',
    `${pkg.name} is licensed under the MIT license (the LICENSE file of the npm package). The prebuilt template`,
    'APK in the package (prebuilt/iwer-native-template.apk), and therefore every APK packed from it, contains the',
    'third-party software listed below. The Node packer and CLI in lib/ contain no third-party code.',
    '',
    'Contents:',
    ...shipped.map(
      (c) =>
        `  - ${c.name} ${c.version} (${c.license})${c.inside ? `, inside ${byId.get(c.inside)?.name ?? c.inside}` : ''}`,
    ),
    '',
  ];
  for (const c of shipped) {
    out.push(RULE, `${c.name} ${c.version} (${c.license})`, RULE, '');
    out.push(`Source: ${c.source}`);
    out.push(
      `Ships in: ${c.ships === 'apk' ? 'the template APK (native code / assets)' : 'a JS prelude inside the template APK'}${c.inside ? `, as part of ${byId.get(c.inside)?.name ?? c.inside}` : ''}`,
    );
    out.push('');
    const n = c.notice ?? {};
    if (n.preface) out.push(n.preface, '');
    if (n.kind === 'mit') {
      out.push(...n.copyright, '', mitBody(root), '');
      continue;
    }
    if (n.kind === 'statement') {
      out.push(...n.copyright, '');
      continue;
    }
    for (const f of n.files ?? []) {
      const abs = expand(f, vars);
      if (!existsSync(abs)) {
        missing.push(`${c.id}: ${abs}`);
        out.push(`[license text missing at generation time: ${f}]`, '');
        continue;
      }
      out.push(normalise(readFileSync(abs, 'utf8')), '');
    }
  }
  return { text: `${out.join('\n').trimEnd()}\n`, missing };
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({
    options: { out: { type: 'string' }, check: { type: 'boolean' } },
  });
  const file = values.out ?? path.join(PKG, 'THIRD_PARTY_NOTICES.txt');
  const { text, missing } = generateNotices();
  if (missing.length) {
    process.stderr.write(
      `notices: license files not found (set IWN_THIRD_PARTY_DIR / IWN_V8_SRC):\n${missing.map((m) => `  - ${m}`).join('\n')}\n`,
    );
    process.exitCode = 1;
  } else if (values.check) {
    const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (current !== text) {
      process.stderr.write(
        `notices: ${file} is stale; run npm run release:notices\n`,
      );
      process.exitCode = 1;
    } else
      process.stdout.write(`notices: ${path.basename(file)} is up to date\n`);
  } else {
    writeFileSync(file, text);
    process.stdout.write(`notices: wrote ${file} (${text.length} bytes)\n`);
  }
}
