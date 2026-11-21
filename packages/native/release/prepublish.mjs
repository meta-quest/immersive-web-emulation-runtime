#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
// Puts the release template APK into @iwer/native for `pnpm release` (changeset publish), which publishes this
// directory like every other IWER package.
//
//   node release/prepublish.mjs --check     the root `release` script, before changeset publish: the template is
//                                           there and the package passes every staged-package check
//   node release/prepublish.mjs             prepublishOnly: the same checks, then the template goes into
//                                           packager/templates.json ("bundled") so the tarball carries it
//   node release/prepublish.mjs --restore   postpack: packager/templates.json back to the tree's "bundled": null
//
// The template comes from release/build-release.sh on a machine with the Android NDK and the prebuilt V8
// (RELEASE.md), built at the commit being published so its runtime version is this package's version. Copy it to
// prebuilt/iwer-native-template.apk (gitignored) or point IWN_TEMPLATE_APK at it. Without it nothing publishes.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { PKG } from './lib.mjs';
import {
  BUNDLED_TEMPLATE_PATH,
  bundleTemplate,
  checkStage,
  stagedPackageJson,
  whitelist,
} from './stage-package.mjs';

const TEMPLATES = path.join(PKG, 'packager', 'templates.json');

function fail(message) {
  process.stderr.write(`prepublish: ${message}\n`);
  process.exit(1);
}

/** The template to publish: IWN_TEMPLATE_APK, else prebuilt/iwer-native-template.apk. */
function templateFile() {
  const file = process.env.IWN_TEMPLATE_APK
    ? path.resolve(process.env.IWN_TEMPLATE_APK)
    : path.join(PKG, BUNDLED_TEMPLATE_PATH);
  if (!existsSync(file))
    fail(
      `no template APK at ${file}. Build it with release/build-release.sh at this commit (RELEASE.md), then copy ` +
        `$OUT/template/iwer-native-template.apk to ${BUNDLED_TEMPLATE_PATH} or set IWN_TEMPLATE_APK.`,
    );
  return file;
}

/** Stage a copy of the package with the template bundled and run the staged-package checks on it. */
async function check(apk) {
  if (!existsSync(path.join(PKG, 'lib', 'src', 'index.js')))
    fail('lib/ is not built: run pnpm run build');
  const stage = mkdtempSync(path.join(os.tmpdir(), 'iwer-native-publish-'));
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(PKG, 'package.json'), 'utf8'),
    );
    for (const f of whitelist(PKG, pkg.files)) {
      if (f === BUNDLED_TEMPLATE_PATH) continue; // bundleTemplate copies the template being published
      mkdirSync(path.dirname(path.join(stage, f)), { recursive: true });
      copyFileSync(path.join(PKG, f), path.join(stage, f));
    }
    writeFileSync(
      path.join(stage, 'package.json'),
      `${JSON.stringify(stagedPackageJson(pkg), null, 2)}\n`,
    );
    const bundled = await bundleTemplate(stage, apk);
    const problems = checkStage(stage);
    if (problems.length)
      fail(
        `${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join('\n')}`,
      );
    return bundled;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

const { values } = parseArgs({
  options: { check: { type: 'boolean' }, restore: { type: 'boolean' } },
});
if (values.restore) {
  const json = JSON.parse(readFileSync(TEMPLATES, 'utf8'));
  if (json.bundled !== null) {
    json.bundled = null;
    writeFileSync(TEMPLATES, `${JSON.stringify(json, null, 2)}\n`);
  }
} else {
  const apk = templateFile();
  const bundled = await check(apk);
  if (!values.check) {
    const dest = path.join(PKG, BUNDLED_TEMPLATE_PATH);
    if (path.resolve(apk) !== dest) {
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(apk, dest);
    }
    const json = JSON.parse(readFileSync(TEMPLATES, 'utf8'));
    json.bundled = bundled;
    writeFileSync(TEMPLATES, `${JSON.stringify(json, null, 2)}\n`);
  }
  process.stdout.write(
    `prepublish: template ${bundled.version} (sha256 ${bundled.sha256}) ${values.check ? 'checked' : 'bundled'}\n`,
  );
}
