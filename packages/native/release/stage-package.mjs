#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Stages the npm package for the public alpha and checks it. Never publishes.
//
//   node release/stage-package.mjs [--template <apk>] [--out <dir>] [--pack] [--allow-missing-template] [--json]
//
// 1. Copies the `files` whitelist of package.json into <out>/package (default release/out/package) and writes a
//    package.json there with "private" removed: the tree keeps "private": true (PKG-15) and only this dry-run copy
//    is publishable. --template <apk> bundles the release template: copied to prebuilt/iwer-native-template.apk in
//    the copy, opened with the packer's template reader (contract check), and recorded with its sha256/size/runtime
//    version as "bundled" in the copy's packager/templates.json. The tree never holds the 40 MB binary or its
//    checksum.
// 2. Checks the copy: LICENSE, THIRD_PARTY_NOTICES.txt and README (alpha disclaimer first) present; lib/ built and
//    VERSION == package.json version; the bundled template present and matching packager/templates.json's sha256;
//    no sources, tests, keystores, maps or node_modules; tarball within budget.
// 3. Runs `npm pack --dry-run --json` in the copy and prints the file list and a size report
//    (writes <out>/pack-dry-run.json and <out>/size-report.md). With --pack it also writes the tarball to <out>/.
// Exit 1 when a check fails.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { isMain, PKG, walk } from './lib.mjs';

/** Tarball budget (gzip). The template APK is most of it; see RELEASE.md "Size report". */
export const TARBALL_BUDGET_BYTES = 24 * 1024 * 1024;
export const FORBIDDEN = [
  /(^|\/)node_modules\//,
  /(^|\/)test\//,
  /\.test\.[cm]?[jt]s$/,
  /\.(jks|p12|pfx|keystore|pem|key)$/i,
  /\.map$/,
  /(^|\/)\.env/,
  /(^|\/)\.npmrc$/,
];

/**
 * Material that must never reach the public package: build-machine paths, review metadata and project labels.
 * Checked in every text file of the staged copy; the template APK is checked separately (its strings come from the
 * build). Names that belong to the publishing organisation (its hosts, repositories and tools) are not listed here:
 * put them in a file, one regular expression per line (matched case-insensitively; empty lines and lines starting
 * with # are skipped), and point IWN_CONTENT_DENYLIST at it.
 */
export const CONTENT_DENYLIST = [
  /Differential Revision/i,
  /\bD\d{8,}\b/,
  /\/home\/[a-z0-9_.-]+\//i,
  /\/data\/users\//i,
  /iwer-native-work/i,
  // project-internal metadata: work-stream labels, milestones
  /\(stream [A-Z]\)/,
  /\bstreams? [A-N]\b(?![-'.\w])/,
  /\bmilestone M\d\b/i,
];

/** CONTENT_DENYLIST plus the patterns in the file IWN_CONTENT_DENYLIST names, when it is set. */
export function contentDenylist(env = process.env) {
  if (!env.IWN_CONTENT_DENYLIST) return CONTENT_DENYLIST;
  const extra = readFileSync(env.IWN_CONTENT_DENYLIST, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => new RegExp(l, 'i'));
  return [...CONTENT_DENYLIST, ...extra];
}

const TEXT_FILE = /\.(m?js|cjs|d\.ts|json|md|txt)$|(^|\/)LICENSE$/;

/** Lines of the staged copy's text files that match one of `patterns`: [{file, line, pattern}]. */
export function contentProblems(dir, patterns = contentDenylist()) {
  const hits = [];
  for (const f of walk(dir)) {
    if (!TEXT_FILE.test(f)) continue;
    const lines = readFileSync(path.join(dir, f), 'utf8').split('\n');
    lines.forEach((text, i) => {
      for (const re of patterns) if (re.test(text)) hits.push({ file: f, line: i + 1, pattern: String(re) });
    });
  }
  return hits;
}

export function stagedPackageJson(pkg) {
  const out = { ...pkg };
  delete out.private; // the one-line flip, applied to the dry-run copy only
  delete out.devDependencies;
  out.scripts = Object.fromEntries(Object.entries(pkg.scripts ?? {}).filter(([k]) => !/^(clean|build|typecheck|test|test:\w+|verify|release:\w+)$/.test(k)));
  if (!Object.keys(out.scripts).length) delete out.scripts;
  return out;
}

/** Expand package.json "files" (dirs, files, `!` negations) against the tree; returns relative paths. */
export function whitelist(root, files) {
  const include = new Set();
  const negations = files.filter((f) => f.startsWith('!')).map((f) => globToRe(f.slice(1)));
  for (const entry of files.filter((f) => !f.startsWith('!'))) {
    const rel = entry.replace(/\/$/, '');
    const abs = path.join(root, rel);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) for (const f of walk(abs)) include.add(`${rel}/${f}`);
    else include.add(rel);
  }
  return [...include].filter((f) => !negations.some((re) => re.test(f))).sort();
}

function globToRe(glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '.*');
  return new RegExp(`^${re}$`);
}

export function checkStage(dir, { allowMissingTemplate = false, env = process.env } = {}) {
  const problems = [];
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  if (pkg.private) problems.push('staged package.json still has "private"');
  for (const f of ['LICENSE', 'THIRD_PARTY_NOTICES.txt', 'README.md', 'bin/iwer-native.mjs', 'lib/src/index.js', 'lib/src/index.d.ts', 'lib/src/cli/main.js', 'compat/data/surface-snapshot.json', 'packager/templates.json'])
    if (!existsSync(path.join(dir, f))) problems.push(`missing ${f}`);
  if (existsSync(path.join(dir, 'README.md'))) {
    const head = readFileSync(path.join(dir, 'README.md'), 'utf8').split('\n').slice(0, 12).join('\n');
    if (!/alpha/i.test(head) || !/not (every|all) web api/i.test(head)) problems.push('README.md must open with the alpha disclaimer (alpha + "not every web API is supported")');
  }
  const versionJs = path.join(dir, 'lib/src/version.js');
  if (existsSync(versionJs) && !readFileSync(versionJs, 'utf8').includes(`'${pkg.version}'`))
    problems.push(`lib/src/version.js does not say ${pkg.version}: rebuild (npm run build)`);
  const templates = existsSync(path.join(dir, 'packager/templates.json')) ? JSON.parse(readFileSync(path.join(dir, 'packager/templates.json'), 'utf8')) : {};
  const b = templates.bundled;
  if (!b) {
    if (!allowMissingTemplate) problems.push('packager/templates.json has no "bundled" template (run release/build-release.sh)');
  } else {
    const apk = path.join(dir, b.file);
    if (!existsSync(apk)) problems.push(`bundled template ${b.file} missing from the package`);
    else {
      const sha = createHash('sha256').update(readFileSync(apk)).digest('hex');
      if (sha !== b.sha256) problems.push(`bundled template ${b.file}: sha256 ${sha} != templates.json ${b.sha256}`);
      if (b.version !== pkg.version) problems.push(`bundled template runtime version ${b.version} != package version ${pkg.version}: rebuild the template (release/build-release.sh)`);
      if (b.size !== undefined && statSync(apk).size !== b.size) problems.push(`bundled template ${b.file}: size ${statSync(apk).size} != templates.json ${b.size}`);
    }
  }
  for (const h of contentProblems(dir, contentDenylist(env))) problems.push(`internal-only content in package: ${h.file}:${h.line} matches ${h.pattern}`);
  for (const f of walk(dir)) {
    if (FORBIDDEN.some((re) => re.test(f))) problems.push(`forbidden file in package: ${f}`);
    if (/\.ts$/.test(f) && !/\.d\.ts$/.test(f)) problems.push(`TypeScript source in package: ${f}`);
    if (/\.(m?js|d\.ts)$/.test(f)) {
      const m = /\/\/# sourceMappingURL=(\S+)\s*$/.exec(readFileSync(path.join(dir, f), 'utf8'));
      if (m && !m[1].startsWith('data:') && !existsSync(path.join(dir, path.dirname(f), m[1])))
        problems.push(`${f} points at a source map the package does not ship (${m[1]}): build without maps`);
    }
  }
  return problems;
}

export const BUNDLED_TEMPLATE_PATH = 'prebuilt/iwer-native-template.apk';

/** Put the release template into a staged package and record it in the copy's templates.json. */
export async function bundleTemplate(stage, apkFile) {
  const { openTemplate } = await import(path.join(stage, 'lib', 'packager', 'src', 'template.js'));
  const buffer = readFileSync(apkFile);
  const t = openTemplate(apkFile, buffer, 'explicit'); // throws when the contract is not met
  if (t.meta.synthesized) throw new Error(`${apkFile} has no assets/iwn/template.json: not a release template`);
  if (t.meta.nativeBuild && t.meta.nativeBuild !== 'release') throw new Error(`${apkFile} is a ${t.meta.nativeBuild} native build (PKG-3 wants release)`);
  const dest = path.join(stage, BUNDLED_TEMPLATE_PATH);
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, buffer);
  const file = path.join(stage, 'packager', 'templates.json');
  const json = JSON.parse(readFileSync(file, 'utf8'));
  json.bundled = { file: BUNDLED_TEMPLATE_PATH, version: t.meta.runtimeVersion, sha256: t.sha256, size: buffer.length };
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  return json.bundled;
}

export function sizeReport(packJson, dir) {
  const files = packJson.files ?? [];
  const byTop = new Map();
  for (const f of files) {
    const top = f.path.includes('/') ? f.path.slice(0, f.path.indexOf('/')) : f.path;
    byTop.set(top, (byTop.get(top) ?? 0) + f.size);
  }
  const apk = files.find((f) => f.path.endsWith('.apk'));
  const apkGz = apk ? gzipSync(readFileSync(path.join(dir, apk.path)), { level: 9 }).length : 0;
  const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;
  const lines = [
    `# @iwer/native ${packJson.version}: npm package size report`,
    '',
    `| | bytes | |`,
    '|---|---|---|',
    `| tarball (gzip, what users download) | ${packJson.size} | ${mb(packJson.size)} |`,
    `| unpacked | ${packJson.unpackedSize} | ${mb(packJson.unpackedSize)} |`,
    `| files | ${files.length} | |`,
    ...(apk ? [`| template APK (unpacked / gzip -9) | ${apk.size} / ${apkGz} | ${mb(apk.size)} / ${mb(apkGz)} |`] : []),
    '',
    '| path | unpacked bytes |',
    '|---|---|',
    ...[...byTop.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`),
    '',
    `Budget: tarball <= ${mb(TARBALL_BUDGET_BYTES)} (${packJson.size <= TARBALL_BUDGET_BYTES ? 'OK' : 'OVER'}).`,
  ];
  return lines.join('\n');
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({
    options: { template: { type: 'string' }, out: { type: 'string' }, pack: { type: 'boolean' }, 'allow-missing-template': { type: 'boolean' }, json: { type: 'boolean' } },
  });
  const out = path.resolve(values.out ?? path.join(PKG, 'release', 'out'));
  const stage = path.join(out, 'package');
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const pkg = JSON.parse(readFileSync(path.join(PKG, 'package.json'), 'utf8'));
  if (!existsSync(path.join(PKG, 'lib', 'src', 'index.js'))) {
    process.stderr.write('stage: lib/ is not built; run npm run build first\n');
    process.exit(1);
  }
  for (const f of whitelist(PKG, pkg.files)) {
    mkdirSync(path.dirname(path.join(stage, f)), { recursive: true });
    cpSync(path.join(PKG, f), path.join(stage, f));
  }
  writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(stagedPackageJson(pkg), null, 2)}\n`);
  if (values.template) await bundleTemplate(stage, path.resolve(values.template));
  const problems = checkStage(stage, { allowMissingTemplate: values['allow-missing-template'] });
  const listed = contentDenylist().length - CONTENT_DENYLIST.length;
  process.stderr.write(`stage: content check: ${CONTENT_DENYLIST.length} built-in patterns, ${process.env.IWN_CONTENT_DENYLIST ? `${listed} from IWN_CONTENT_DENYLIST` : 'IWN_CONTENT_DENYLIST not set'}\n`);
  const npm = process.env.NPM ?? 'npm';
  const dry = JSON.parse(execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: stage, encoding: 'utf8' }))[0];
  writeFileSync(path.join(out, 'pack-dry-run.json'), `${JSON.stringify(dry, null, 2)}\n`);
  const report = sizeReport(dry, stage);
  writeFileSync(path.join(out, 'size-report.md'), `${report}\n`);
  if (dry.size > TARBALL_BUDGET_BYTES) problems.push(`tarball ${dry.size} bytes exceeds the ${TARBALL_BUDGET_BYTES} budget`);
  if (values.pack && !problems.length) {
    const name = execFileSync(npm, ['pack', '--ignore-scripts', '--pack-destination', out], { cwd: stage, encoding: 'utf8' }).trim().split('\n').pop();
    process.stdout.write(`stage: wrote ${path.join(out, name)}\n`);
  }
  if (values.json) process.stdout.write(`${JSON.stringify({ problems, dryRun: dry }, null, 2)}\n`);
  else {
    process.stdout.write(`${dry.files.map((f) => `${String(f.size).padStart(10)}  ${f.path}`).join('\n')}\n\n${report}\n`);
    if (problems.length) process.stderr.write(`\nstage: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
    else process.stdout.write(`\nstage: OK. Staged at ${stage}\n`);
  }
  process.exitCode = problems.length ? 1 : 0;
}
