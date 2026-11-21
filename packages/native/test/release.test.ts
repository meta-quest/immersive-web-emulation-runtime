/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Release engineering for the public alpha: package shape, bundled template
// resolution + checksum, third-party verification, notices, support matrix, staging checks.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveTemplate, TemplateError } from '../packager/src/template.ts';
import { templateCheck } from '../src/cli/doctor.ts';
import { buildTestTemplate, scratchDir } from '../packager/test/helpers.ts';
// @ts-expect-error: plain .mjs release scripts have no type declarations
import { generateNotices } from '../release/notices.mjs';
// @ts-expect-error: plain .mjs release scripts have no type declarations
import { checkStage, contentDenylist, contentProblems, stagedPackageJson, whitelist } from '../release/stage-package.mjs';
// @ts-expect-error: plain .mjs release scripts have no type declarations
import { detect, verify } from '../release/verify-third-party.mjs';
import { BEGIN, classify, END, matrixMarkdown, ROWS } from '../release/support-matrix.ts';
import type { SurfaceSnapshot } from '../compat/src/surface.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('package shape (npm alpha)', () => {
  test('private in the tree, alpha version, public alpha publishConfig', () => {
    assert.equal(pkg.name, '@iwer/native');
    assert.equal(pkg.private, true); // PKG-15: only the staged copy drops it
    assert.match(pkg.version, /^0\.1\.0-alpha\.\d+$/);
    assert.deepEqual(pkg.publishConfig, { access: 'public', tag: 'alpha' });
    assert.equal(pkg.license, 'MIT');
    assert.deepEqual(pkg.bin, { 'iwer-native': 'bin/iwer-native.mjs' });
    assert.equal(pkg.exports['.'].types, './lib/src/index.d.ts');
    assert.ok(pkg.engines.node.includes('>=20.19.0'));
    assert.deepEqual(pkg.dependencies ?? {}, {}, 'the published CLI has no runtime dependencies');
  });

  test('files whitelist ships the CLI, the template, licences and docs, nothing else', () => {
    for (const f of ['bin/', 'lib/', 'packager/templates.json', 'prebuilt/iwer-native-template.apk', 'compat/data/', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt'])
      assert.ok(pkg.files.includes(f), `files lacks ${f}`);
    for (const f of pkg.files) assert.doesNotMatch(f, /^(src|runtime|web|test|release|packager\/src|packager\/template)\b/, `files must not ship ${f}`);
    assert.ok(pkg.files.includes('!lib/**/*.map'));
    assert.ok(!pkg.files.includes('compat/README.md'), 'compat/README.md is the internal developer doc');
  });

  test('LICENSE is the IWER monorepo MIT licence', () => {
    const iwer = path.resolve(root, '../../LICENSE');
    const mine = readFileSync(path.join(root, 'LICENSE'), 'utf8');
    assert.match(mine, /^MIT License\n\nCopyright \(c\) Meta Platforms, Inc\. and affiliates\./);
    if (existsSync(iwer)) assert.equal(mine, readFileSync(iwer, 'utf8'));
  });

  test('staged package.json drops private, devDependencies and dev scripts only', () => {
    const staged = stagedPackageJson(pkg);
    assert.equal(staged.private, undefined);
    assert.equal(staged.devDependencies, undefined);
    assert.equal(staged.scripts, undefined);
    assert.equal(staged.version, pkg.version);
    assert.deepEqual(staged.files, pkg.files);
    assert.equal(pkg.private, true, 'the tree copy is not mutated');
  });

  test('whitelist expansion honours negations', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'iwn-wl-'));
    for (const f of ['lib/a.js', 'lib/a.js.map', 'lib/sub/b.d.ts', 'lib/sub/b.d.ts.map', 'README.md', 'other.txt'])
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }), writeFileSync(path.join(dir, f), 'x');
    assert.deepEqual(whitelist(dir, ['lib/', '!lib/**/*.map', 'README.md', 'missing.apk']), ['README.md', 'lib/a.js', 'lib/sub/b.d.ts']);
  });
});

describe('bundled template (alpha delivery)', () => {
  async function fakePackage(opts: { tamper?: boolean; file?: string } = {}) {
    const dir = scratchDir('bundled');
    const tpl = await buildTestTemplate(dir);
    writeFileSync(path.join(dir, 'package.json'), '{"name":"@iwer/native"}\n');
    mkdirSync(path.join(dir, 'packager'), { recursive: true });
    mkdirSync(path.join(dir, 'prebuilt'), { recursive: true });
    const apk = path.join(dir, 'prebuilt', 'iwer-native-template.apk');
    writeFileSync(apk, tpl.buffer);
    writeFileSync(
      path.join(dir, 'packager', 'templates.json'),
      JSON.stringify({ bundled: { file: opts.file ?? 'prebuilt/iwer-native-template.apk', version: '0.1.0-test', sha256: sha256(tpl.buffer), size: tpl.buffer.length }, template: null }),
    );
    if (opts.tamper) appendFileSync(apk, Buffer.from([0]));
    return { dir, apk, tpl };
  }

  test('is used before the pinned download and the checkout template, verified', async () => {
    const { dir, apk, tpl } = await fakePackage();
    const fetchImpl = (() => {
      throw new Error('must not download');
    }) as unknown as typeof fetch;
    const t = await resolveTemplate({ root: dir, env: {}, fetchImpl });
    assert.equal(t.source, 'bundled');
    assert.equal(t.file, apk);
    assert.equal(t.sha256, sha256(tpl.buffer));
  });

  test('an explicit --template still wins', async () => {
    const { dir, tpl } = await fakePackage();
    const t = await resolveTemplate({ root: dir, env: {}, explicit: tpl.file });
    assert.equal(t.source, 'explicit');
  });

  test('a tampered bundled template is refused with a reinstall hint', async () => {
    const { dir } = await fakePackage({ tamper: true });
    await assert.rejects(resolveTemplate({ root: dir, env: {} }), (e: unknown) => e instanceof TemplateError && /does not match its checksum/.test(e.message) && /reinstall/.test(e.message));
  });

  test('a bundled path outside the package is refused', async () => {
    const { dir } = await fakePackage({ file: '../evil.apk' });
    await assert.rejects(resolveTemplate({ root: dir, env: {} }), /must be a path inside the package/);
  });

  test('a listed but missing bundled file asks for a reinstall, not a checkout build', async () => {
    const { dir, apk } = await fakePackage();
    const { rmSync } = await import('node:fs');
    rmSync(apk);
    await assert.rejects(resolveTemplate({ root: dir, env: {} }), (e: unknown) => e instanceof TemplateError && /bundled with @iwer\/native is missing/.test(e.message) && /reinstall/.test(e.message) && !/build-template/.test(e.message));
  });

  test('doctor reports the bundled template with its checksum verified', async () => {
    const { dir, apk, tpl } = await fakePackage();
    const ok = templateCheck({ nodeVersion: '24.0.0', env: {}, projectRoot: dir, exec: null as never, templateRoot: dir });
    assert.equal(ok.status, 'ok');
    assert.match(ok.summary, new RegExp(`bundled, runtime 0\\.1\\.0-test, sha256 verified \\(${sha256(tpl.buffer).slice(0, 16)}`));
    assert.doesNotMatch(ok.summary, /milestone|not published/);
    appendFileSync(apk, Buffer.from([0]));
    const bad = templateCheck({ nodeVersion: '24.0.0', env: {}, projectRoot: dir, exec: null as never, templateRoot: dir });
    assert.equal(bad.status, 'fail');
    assert.match(bad.summary, /does not match its checksum/);
    const { rmSync } = await import('node:fs');
    rmSync(apk);
    const gone = templateCheck({ nodeVersion: '24.0.0', env: {}, projectRoot: dir, exec: null as never, templateRoot: dir });
    assert.equal(gone.status, 'fail');
    assert.match(gone.hint!, /Reinstall @iwer\/native/);
  });

  test('the committed templates.json bundles nothing (the tree never holds the binary)', () => {
    const t = JSON.parse(readFileSync(path.join(root, 'packager', 'templates.json'), 'utf8'));
    assert.equal(t.bundled, null);
  });
});

describe('third-party verification', () => {
  test('every bundled native/JS dependency in this tree has an entry', () => {
    const r = verify({ root });
    assert.deepEqual(r.problems, []);
    for (const id of ['v8', 'libcxx', 'openxr-loader', 'oboe', 'freetype', 'harfbuzz', 'sqlite', 'stb', 'dr_mp3', 'whatwg-url', 'gl-matrix', 'roboto'])
      assert.ok(r.used.includes(id), `${id} not detected`);
  });

  function copyTree() {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'iwn-tp-'));
    for (const f of ['package.json', 'THIRD_PARTY.md', 'THIRD_PARTY_NOTICES.txt', 'LICENSE', 'release/components.json'])
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }), cpSync(path.join(root, f), path.join(dir, f));
    return dir;
  }

  test('an unrecorded npm dependency, CMake source dir, vendored dir or library fails', () => {
    const dir = copyTree();
    mkdirSync(path.join(dir, 'web', 'foo'), { recursive: true });
    writeFileSync(path.join(dir, 'web', 'foo', 'package.json'), JSON.stringify({ dependencies: { 'left-pad': '1.3.0' } }));
    mkdirSync(path.join(dir, 'runtime', 'bar', 'third_party', 'zstd'), { recursive: true });
    writeFileSync(path.join(dir, 'runtime', 'bar', 'CMakeLists.txt'), 'set(IWN_ZSTD_DIR "/x/zstd" CACHE PATH\n    "zstd (decoder)")\nset_property(GLOBAL APPEND PROPERTY IWN_APK_LIBS /opt/libfoo2.so)\n');
    const r = verify({ root: dir });
    const text = r.problems.join('\n');
    assert.match(text, /npm left-pad .*no entry/);
    assert.match(text, /cmakeVar IWN_ZSTD_DIR .*no entry/);
    assert.match(text, /vendoredDir runtime\/bar\/third_party\/zstd .*no entry/);
    assert.match(text, /lib libfoo2\.so .*no entry/);
  });

  test('a shipped component without a THIRD_PARTY.md row fails', () => {
    const dir = copyTree();
    const md = readFileSync(path.join(dir, 'THIRD_PARTY.md'), 'utf8').replace(/^\| gl-matrix .*$/m, '');
    writeFileSync(path.join(dir, 'THIRD_PARTY.md'), md);
    assert.match(verify({ root: dir }).problems.join('\n'), /gl-matrix .*THIRD_PARTY\.md has no table row/);
  });

  test('compile_commands.json: sources outside a recorded component directory fail', () => {
    const dir = copyTree();
    const build = path.join(dir, 'build');
    mkdirSync(build);
    const tp = path.join(mkdtempSync(path.join(os.tmpdir(), 'iwn-tp-')), 'third_party'); // outside the package
    writeFileSync(
      path.join(build, 'CMakeCache.txt'),
      `IWN_THIRD_PARTY_DIR:PATH=${tp}\nIWN_FREETYPE_DIR:UNINITIALIZED=${tp}/freetype\nIWN_MBEDTLS_DIR:STRING=${tp}/mbedtls\n`,
    );
    const entry = (file: string) => ({ directory: build, file, command: 'cc -c' });
    writeFileSync(
      path.join(build, 'compile_commands.json'),
      JSON.stringify([
        entry(path.join(dir, 'runtime/core/src/a.cc')), // first party
        entry(path.join(build, 'generated/b.cc')), // generated
        entry(`${tp}/freetype/src/base/ftbase.c`), // recorded component
        entry(`${tp}/zstd/lib/zstd.c`), // add_library over files under the generic root
        entry(`${tp}/mbedtls/library/ssl.c`), // plain set() + add_subdirectory
        entry('/opt/elsewhere/c.c'),
        entry(path.join(dir, 'runtime/net/third_party/llhttp/api.c')), // vendored, unrecorded
      ]),
    );
    const r = verify({ root: dir, build });
    const text = r.problems.join('\n');
    assert.ok(r.used.includes('freetype'));
    assert.match(text, /under IWN_THIRD_PARTY_DIR .*zstd\.c/);
    assert.match(text, /under IWN_MBEDTLS_DIR .*ssl\.c/);
    assert.match(text, /\/opt\/elsewhere\/c\.c: .*outside this package/);
    assert.match(text, /vendoredDir runtime\/net\/third_party\/llhttp .*no entry/);
    assert.doesNotMatch(text, /a\.cc|b\.cc|ftbase/);
    assert.match(verify({ root: dir, build: path.join(dir, 'nope') }).problems.join('\n'), /CMAKE_EXPORT_COMPILE_COMMANDS/);
  });

  test('esbuild path comments in an unminified bundle name bundled npm packages', () => {
    const dir = copyTree();
    mkdirSync(path.join(dir, 'web', 'foo', 'dist'), { recursive: true });
    writeFileSync(path.join(dir, 'web', 'foo', 'dist', 'foo.js'), '(() => {\n  // ../../node_modules/left-pad/index.js\n  // ../x/node_modules/@scope/pkg/lib/a.js\n  // src/own.ts\n})();\n');
    const text = verify({ root: dir }).problems.join('\n');
    assert.match(text, /npm left-pad \(web\/foo\/dist\/foo\.js\) has no entry/);
    assert.match(text, /npm @scope\/pkg \(web\/foo\/dist\/foo\.js\) has no entry/);
    assert.doesNotMatch(text, /own/);
  });

  test('a floating esbuild or TypeScript version fails (their output ships)', () => {
    const dir = copyTree();
    mkdirSync(path.join(dir, 'web', 'foo'), { recursive: true });
    writeFileSync(path.join(dir, 'web', 'foo', 'package.json'), JSON.stringify({ devDependencies: { esbuild: '^0.28.2' } }));
    const pj = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    pj.devDependencies.typescript = '~6.0.3';
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pj));
    const text = verify({ root: dir }).problems.join('\n');
    assert.match(text, /web\/foo\/package\.json: esbuild "\^0\.28\.2" must be an exact version/);
    assert.match(text, /package\.json: typescript "~6\.0\.3" must be an exact version/);
  });

  test('detects multi-line CMake cache paths and ignores the documentation example', () => {
    const found = detect(root).map((f: { kind: string; key: string }) => `${f.kind}:${f.key}`);
    assert.ok(found.includes('cmakeVar:IWN_OBOE_DIR'), 'multi-line set() not detected');
    assert.ok(!found.some((f: string) => f.includes('libfoo')));
  });
});

describe('notices', () => {
  const generated = generateNotices({ root });
  const sourcesPresent = generated.missing.length === 0;

  test('cover every shipped component and the MIT text', () => {
    const inv = JSON.parse(readFileSync(path.join(root, 'release', 'components.json'), 'utf8'));
    for (const c of inv.components.filter((x: { ships: string }) => x.ships !== 'no'))
      assert.ok(generated.text.includes(`${c.name} ${c.version} (${c.license})`), `no section for ${c.id}`);
    assert.ok(!generated.text.includes('indexeddbshim'), 'idb.min.js is not shipped');
    assert.match(generated.text, /Permission is hereby granted/);
  });

  test('the committed THIRD_PARTY_NOTICES.txt is current', { skip: sourcesPresent ? false : 'licence sources (third-party trees, V8 tree) not on this machine' }, () => {
    assert.equal(readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.txt'), 'utf8'), generated.text);
  });
});

describe('support matrix', () => {
  const snapshot = JSON.parse(readFileSync(path.join(root, 'compat', 'data', 'surface-snapshot.json'), 'utf8')) as SurfaceSnapshot;

  test('README carries the current generated block', () => {
    const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
    const block = readme.slice(readme.indexOf(BEGIN) + BEGIN.length, readme.indexOf(END)).trim();
    assert.equal(block, matrixMarkdown(snapshot).trim());
  });

  test('alpha-scope exclusions read "not yet" even when a layer has them', () => {
    const ws = classify(ROWS.find((r) => r.api === 'WebSocket')!, snapshot);
    assert.equal(ws.support, 'not yet');
    for (const r of ROWS.filter((x) => x.alphaLater)) assert.equal(classify(r, snapshot).support, 'not yet', r.api);
  });

  test('dependent rows cascade: a row is never "supported" while a row it requires is not', () => {
    for (const r of ROWS.filter((x) => x.requires?.length)) {
      const res = classify(r, snapshot);
      for (const api of r.requires!) {
        const dep = ROWS.find((x) => x.api === api);
        assert.ok(dep, `${r.api} requires unknown row ${api}`);
        if (classify(dep!, snapshot).support !== 'supported') {
          assert.equal(res.support, 'not yet', r.api);
          assert.match(res.note ?? '', /waits for:/);
        }
      }
    }
    const ext = ROWS.find((r) => r.api.startsWith('WebGL extensions'))!;
    assert.deepEqual(ext.requires, ['WebGL 2 and WebGL 1 (over OpenGL ES 3.2)']);
  });

  test('a "supported" dependency does not demote its dependants', () => {
    const fake: SurfaceSnapshot = JSON.parse(JSON.stringify(snapshot));
    const base = ROWS.find((r) => r.api.startsWith('ECMAScript'))!;
    const probe = { group: 'Test', api: 'probe', keys: ['setTimeout'], requires: [base.api] };
    assert.equal(classify(probe, fake).support, 'supported');
  });

  test('a row no device run has exercised reads "implemented, not yet device-tested", with the reason', () => {
    // hands ran on headsets (virtual hands, and microgestures with real hands, 2026-10-21): supported, with a note
    const hands = classify(ROWS.find((r) => r.api.startsWith('Hand tracking'))!, snapshot);
    assert.equal(hands.support, 'supported');
    assert.equal(hands.deviceUntested, undefined);
    assert.match(matrixMarkdown(snapshot), /\| Hand tracking [^|]*\| supported \| tested on Quest 3 and Quest 3S with simulated hands [^|]*buttons 5-9/);
    // controllers ran on headsets (virtual controllers, 2026-10-21): supported, with the differences from Quest Browser
    const controllers = classify(ROWS.find((r) => r.api.startsWith('Controllers ('))!, snapshot);
    assert.equal(controllers.support, 'supported');
    assert.equal(controllers.deviceUntested, undefined);
    assert.match(matrixMarkdown(snapshot), /\| Controllers \([^|]*\| supported \| tested on Quest 3 and Quest 3S [^|]*buttons\[12\]/);
    const probe = { group: 'Test', api: 'probe', keys: ['setTimeout'], deviceUntested: 'never on a headset' };
    assert.equal(classify(probe, snapshot).support, 'implemented, not yet device-tested');
    // only rows that would otherwise be "supported" change
    assert.equal(classify({ ...probe, alphaLater: 'later' }, snapshot).support, 'not yet');
  });

  test('statuses come from the inventory', () => {
    assert.equal(classify(ROWS.find((r) => r.api.startsWith('ECMAScript'))!, snapshot).support, 'supported');
    assert.equal(classify(ROWS.find((r) => r.api === 'WebGPU')!, snapshot).support, 'out of scope');
    assert.equal(classify(ROWS.find((r) => r.api.startsWith('Quad'))!, snapshot).support, 'supported');
    assert.equal(classify(ROWS.find((r) => r.api.startsWith('Equirect'))!, snapshot).support, 'not yet');
  });
});

describe('staging checks', () => {
  test('flag a missing disclaimer, private, forbidden files and a bad template checksum', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'iwn-stage-'));
    const put = (f: string, s: string | Buffer) => (mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }), writeFileSync(path.join(dir, f), s));
    put('package.json', JSON.stringify({ name: '@iwer/native', version: '0.1.0-alpha.0', private: true }));
    put('README.md', '# @iwer/native\n\nRuns WebXR apps.\n');
    put('packager/templates.json', JSON.stringify({ bundled: { file: 'prebuilt/t.apk', version: 'x', sha256: '00', size: 3 } }));
    put('prebuilt/t.apk', 'apk');
    put('lib/src/index.ts', 'x');
    put('keys/release.jks', 'x');
    const problems = checkStage(dir).join('\n');
    assert.match(problems, /still has "private"/);
    assert.match(problems, /alpha disclaimer/);
    assert.match(problems, /missing LICENSE/);
    assert.match(problems, /sha256 .* != templates\.json 00/);
    assert.match(problems, /bundled template runtime version x != package version 0\.1\.0-alpha\.0/);
    assert.match(problems, /TypeScript source in package: lib\/src\/index\.ts/);
    assert.match(problems, /forbidden file in package: keys\/release\.jks/);
  });

  test('flag build-machine paths, review metadata and the IWN_CONTENT_DENYLIST names in shipped text files', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'iwn-content-'));
    const put = (f: string, s: string) => (mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }), writeFileSync(path.join(dir, f), s));
    put('README.md', '# ok\n\nnpm install --registry https://npm.corp.example/\n');
    put('THIRD_PARTY_NOTICES.txt', 'Source: https://example.org (reviewed in D12345678)\n');
    put('lib/a.js', 'const p = "/home/someone/checkout/x.ts";\n');
    put('compat/README.md', 'See the Deploy-Tool config.\n');
    put('lib/b.d.ts', "/** runtime/core (stream A), milestone M5 */\n");
    put('prebuilt/t.apk', '/home/someone/ (binary, not scanned here)');
    put('package.json', JSON.stringify({ name: '@iwer/native', version: '0.1.0-alpha.0' }));
    // the publishing organisation's names come from a file outside the package (IWN_CONTENT_DENYLIST)
    const list = path.join(mkdtempSync(path.join(os.tmpdir(), 'iwn-denylist-')), 'names.txt');
    writeFileSync(list, '# hosts and tools of the publishing organisation\n\nnpm\\.corp\\.example\n\\bdeploy-tool\\b\n');
    const env = { IWN_CONTENT_DENYLIST: list };
    const where = (hits: { file: string; line: number }[]) => [...new Set(hits.map((h) => `${h.file}:${h.line}`))].sort();
    assert.deepEqual(where(contentProblems(dir, contentDenylist(env))), ['README.md:3', 'THIRD_PARTY_NOTICES.txt:1', 'compat/README.md:1', 'lib/a.js:1', 'lib/b.d.ts:1']);
    assert.deepEqual(where(contentProblems(dir, contentDenylist({}))), ['THIRD_PARTY_NOTICES.txt:1', 'lib/a.js:1', 'lib/b.d.ts:1']);
    assert.match(checkStage(dir, { allowMissingTemplate: true, env }).join('\n'), /internal-only content in package: README\.md:3/);
    assert.doesNotMatch(checkStage(dir, { allowMissingTemplate: true, env: {} }).join('\n'), /README\.md:3/);
  });

  test('a dangling sourceMappingURL in a shipped file is a staging problem', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'iwn-maps-'));
    const put = (f: string, s: string) => (mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }), writeFileSync(path.join(dir, f), s));
    put('package.json', JSON.stringify({ name: '@iwer/native', version: '0.1.0-alpha.0' }));
    put('lib/src/a.js', 'export {};\n//# sourceMappingURL=a.js.map');
    put('lib/src/b.js', 'export {};\n');
    const problems = checkStage(dir, { allowMissingTemplate: true }).join('\n');
    assert.match(problems, /lib\/src\/a\.js points at a source map/);
    assert.doesNotMatch(problems, /lib\/src\/b\.js/);
    const build = JSON.parse(readFileSync(path.join(root, 'tsconfig.build.json'), 'utf8'));
    assert.equal(build.compilerOptions.sourceMap, false);
    assert.equal(build.compilerOptions.declarationMap, false);
  });

  test('the shipped docs carry no internal-only content', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'iwn-docs-'));
    for (const f of ['README.md', 'THIRD_PARTY_NOTICES.txt', 'LICENSE', 'packager/templates.json', 'package.json'])
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }), cpSync(path.join(root, f), path.join(dir, f));
    assert.deepEqual(contentProblems(dir), []);
  });

  test('README links only to files the package ships', () => {
    const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
    for (const m of readme.matchAll(/\]\((?!https?:|#)([^)#]+)/g)) {
      const target = m[1];
      assert.ok(pkg.files.some((f: string) => f === target || (f.endsWith('/') && target.startsWith(f))), `README links to ${target}, which is not in "files"`);
    }
  });

  test('the README opens with the alpha disclaimer', () => {
    const head = readFileSync(path.join(root, 'README.md'), 'utf8').split('\n').slice(0, 12).join('\n');
    assert.match(head, /alpha/i);
    assert.match(head, /not every web API is supported/i);
    assert.match(head, /NotSupportedError/);
  });
});
