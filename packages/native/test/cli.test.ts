/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { buildTestDist, buildTestTemplate } from '../packager/test/helpers.ts';
import { EXIT, runCli, splitShellWords, type CliIo } from '../src/cli/main.ts';
import { runDoctor } from '../src/cli/doctor.ts';
import { loadNativeProject } from '../src/config/load.ts';
import { NativeConfigError } from '../src/config/validate.ts';
import {
  locateAdb,
  parseAdbDevices,
  parseAdbVersion,
  type Exec,
  type ExecResult,
} from '../src/util/exec.ts';
import { isSupportedNodeVersion } from '../src/util/node-version.ts';
import { VERSION } from '../src/version.ts';

const scratch = mkdtempSync(path.join(tmpdir(), 'iwer-native-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
function project(config: unknown, files: Record<string, string> = {}): string {
  const dir = path.join(scratch, `p${counter++}`);
  mkdirSync(dir, { recursive: true });
  if (config !== undefined)
    writeFileSync(
      path.join(dir, 'iwsdk.config.json'),
      typeof config === 'string' ? config : JSON.stringify(config),
    );
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'proto-showcase-vr', version: '0.3.1' }),
  );
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

const ADB_VERSION =
  'Android Debug Bridge version 1.0.41\nVersion 36.0.0-13206524\n';

/** Fake adb: answers by first non -s argument. */
function fakeExec(
  responses: Record<string, Partial<ExecResult>>,
  calls: string[][] = [],
): Exec {
  return async (file, args) => {
    calls.push([file, ...args]);
    const key = args.filter((_, i) => !(args[0] === '-s' && i < 2))[0] ?? '';
    const r = responses[key] ?? responses['*'];
    if (!r) return { code: null, stdout: '', stderr: '', error: 'not-found' };
    return { code: 0, stdout: '', stderr: '', ...r };
  };
}

function io(overrides: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const value: CliIo = {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    cwd: scratch,
    env: {},
    nodeVersion: '24.10.0',
    exec: fakeExec({}),
    isExecutable: () => false,
    ...overrides,
  };
  return { io: value, out: () => out.join(''), err: () => err.join('') };
}

test('VERSION matches package.json', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  assert.equal(VERSION, pkg.version);
  assert.equal(pkg.private, undefined); // published from the tree by pnpm release
  assert.equal(pkg.bin['iwer-native'], 'bin/iwer-native.mjs');
});

describe('runCli basics', () => {
  test('help', async () => {
    const t = io();
    assert.equal(await runCli([], t.io), EXIT.ok);
    assert.match(t.out(), /Usage: iwer-native <command>/);
    for (const c of ['pack', 'install', 'run', 'doctor', 'validate'])
      assert.match(t.out(), new RegExp(`\\n  ${c} `));
    assert.equal(await runCli(['doctor', '--help'], io().io), EXIT.ok);
  });
  test('version', async () => {
    const t = io();
    assert.equal(await runCli(['-v'], t.io), EXIT.ok);
    assert.equal(t.out(), `${VERSION}\n`);
  });
  test('unknown command and option are usage errors', async () => {
    const a = io();
    assert.equal(await runCli(['build'], a.io), EXIT.usage);
    assert.match(a.err(), /unknown command "build"/);
    const b = io();
    assert.equal(await runCli(['doctor', '--frobnicate'], b.io), EXIT.usage);
    assert.match(b.err(), /--frobnicate/);
  });
});

describe('validate', () => {
  test('prints the resolved target', async () => {
    const dir = project(
      {
        native: {
          packageId: 'com.yourcompany.showcase',
          frameRate: 90,
          icon: 'public/icon.png',
        },
      },
      { 'public/icon.png': 'png' },
    );
    const t = io({ cwd: dir });
    assert.equal(await runCli(['validate'], t.io), EXIT.ok);
    assert.match(t.out(), /package\s+com\.yourcompany\.showcase/);
    assert.match(t.out(), /version\s+0\.3\.1 \(versionCode 3001\)/);
    assert.match(t.out(), /frame rate\s+90 Hz/);
    assert.match(
      t.out(),
      /splash\s+generated from the icon and app name, black background/,
    );
  });

  test('--json and --project', async () => {
    const dir = project({ native: { packageId: 'com.a.b' } });
    const t = io();
    assert.equal(
      await runCli(['validate', '--json', '--project', dir], t.io),
      EXIT.ok,
    );
    const json = JSON.parse(t.out());
    assert.equal(json.ok, true);
    assert.equal(json.target.packageId, 'com.a.b');
  });

  test('reports every error with paths', async () => {
    const dir = project({ native: { packageId: 'my-app', frameRate: 75 } });
    const t = io({ cwd: dir });
    assert.equal(await runCli(['validate'], t.io), EXIT.failure);
    assert.match(t.err(), /\$\.native\.packageId: .*contains "-"/);
    assert.match(t.err(), /\$\.native\.frameRate: 75 Hz/);
  });

  test('--json failure output', async () => {
    const dir = project({ native: {} });
    const t = io({ cwd: dir });
    assert.equal(await runCli(['validate', '--json'], t.io), EXIT.failure);
    assert.equal(JSON.parse(t.out()).issues[0].path, '$.native.packageId');
  });

  test('missing project file, bad JSON', async () => {
    const a = io({ cwd: project(undefined) });
    assert.equal(await runCli(['validate'], a.io), EXIT.failure);
    assert.match(a.err(), /no iwsdk\.config\.json here/);
    const b = io({ cwd: project('{ nope') });
    assert.equal(await runCli(['validate'], b.io), EXIT.failure);
    assert.match(b.err(), /not valid JSON/);
  });
});

describe('loadNativeProject', () => {
  test('checks referenced files exist', () => {
    const dir = project({
      native: {
        packageId: 'com.a.b',
        icon: 'public/icon.png',
        signing: { keystore: '../nope.jks', storePasswordEnv: 'PW' },
      },
    });
    assert.throws(
      () => loadNativeProject(dir),
      (e: unknown) =>
        e instanceof NativeConfigError &&
        e.issues.map((i) => i.path).join() ===
          '$.native.icon,$.native.signing.keystore' &&
        /icon file not found/.test(e.message),
    );
  });
  test('returns absolute file paths', () => {
    const dir = project(
      {
        native: {
          packageId: 'com.a.b',
          icon: 'public/icon.png',
          signing: { keystore: 'keys/k.jks', storePasswordEnv: 'PW' },
        },
      },
      { 'public/icon.png': 'x', 'keys/k.jks': 'x' },
    );
    const loaded = loadNativeProject(dir);
    assert.equal(loaded.files.icon, path.join(dir, 'public/icon.png'));
    assert.equal(loaded.files.keystore, path.join(dir, 'keys/k.jks'));
    assert.equal(loaded.files.splash, null);
  });
  test('resolves splash.image and reports a missing one', () => {
    const dir = project(
      { native: { packageId: 'com.a.b', splash: { image: 'art/splash.png' } } },
      { 'art/splash.png': 'x' },
    );
    assert.equal(
      loadNativeProject(dir).files.splash,
      path.join(dir, 'art/splash.png'),
    );
    const missing = project({
      native: { packageId: 'com.a.b', splash: { image: 'art/none.png' } },
    });
    assert.throws(
      () => loadNativeProject(missing),
      (e: unknown) =>
        e instanceof NativeConfigError &&
        e.issues.map((i) => i.path).join() === '$.native.splash.image' &&
        /splash image file not found/.test(e.message),
    );
  });
});

describe('pack', () => {
  let templateFile = '';
  before(async () => {
    const t = await buildTestTemplate(scratch);
    templateFile = t.file;
  });
  const packProject = (native: Record<string, unknown> = {}) => {
    const dir = project({
      version: 'iwsdk.project.v1',
      native: { packageId: 'com.a.b', appName: 'Proto Showcase', ...native },
    });
    buildTestDist(dir);
    return dir;
  };
  const env = () => ({ IWER_NATIVE_CONFIG_DIR: path.join(scratch, 'cfg') });
  test('writes dist-metavr/<appName>.apk and prints the report', async () => {
    const dir = packProject();
    const t = io({ cwd: dir, env: env() });
    assert.equal(
      await runCli(['pack', '--template', templateFile], t.io),
      EXIT.ok,
      t.err(),
    );
    const apk = path.join(dir, 'dist-metavr', 'Proto-Showcase.apk');
    assert.match(t.out(), /wrote .*dist-metavr\/Proto-Showcase\.apk/);
    assert.match(t.out(), /signed\s+v2\+v3 with debug key/);
    assert.ok(readFileSync(apk).length > 1000);
  });
  test('--json', async () => {
    const dir = packProject();
    const t = io({ cwd: dir, env: env() });
    assert.equal(
      await runCli(
        ['pack', '--json', '--template', templateFile, '--release'],
        t.io,
      ),
      EXIT.ok,
    );
    const json = JSON.parse(t.out());
    assert.equal(json.ok, true);
    assert.equal(json.manifest.debuggable, false);
    assert.equal(json.verify.v3, true);
  });
  test('fails on invalid config before packing', async () => {
    const t = io({ cwd: project({ native: { packageId: 'x' } }) });
    assert.equal(await runCli(['pack'], t.io), EXIT.failure);
  });
  test('missing dist is a clear error', async () => {
    const dir = project({ native: { packageId: 'com.a.b' } });
    const t = io({ cwd: dir, env: env() });
    assert.equal(
      await runCli(['pack', '--template', templateFile], t.io),
      EXIT.failure,
    );
    assert.match(t.err(), /no dist directory/);
  });
  test('run --forward targets the packed runtime config inspector port', async () => {
    const dir = packProject();
    mkdirSync(path.join(dir, 'tpl'));
    const tpl = await buildTestTemplate(path.join(dir, 'tpl'), {
      config: { inspector: { port: 9555 } },
    });
    const t = io({ cwd: dir, env: env() });
    assert.equal(await runCli(['pack', '--template', tpl.file], t.io), EXIT.ok);
    const t2 = io({ cwd: dir });
    assert.equal(
      await runCli(['run', '--dry-run', '--forward', '9508'], t2.io),
      EXIT.ok,
    );
    assert.match(
      t2.out(),
      /^adb forward tcp:9508 localabstract:com\.a\.b_devtools_9555\n/,
    );
  });
  test('debug pack works without the release keystore; --release needs it', async () => {
    const dir = packProject({
      signing: {
        keystore: '../secrets/release.p12',
        storePasswordEnv: 'IWN_NOPE_PW',
      },
    });
    const t = io({ cwd: dir, env: env() });
    assert.equal(
      await runCli(['pack', '--skip-compat', '--template', templateFile], t.io),
      EXIT.ok,
      t.err(),
    );
    assert.match(
      t.err(),
      /keystore file not found.*only needed for release builds/,
    );
    assert.match(t.out(), /signed\s+v2\+v3 with debug key/);
    const r = io({ cwd: dir, env: env() });
    assert.equal(
      await runCli(
        ['pack', '--skip-compat', '--release', '--template', templateFile],
        r.io,
      ),
      EXIT.failure,
    );
    assert.match(r.err(), /keystore file not found/);
  });
  test('file-system problems are messages, not stack traces', async () => {
    const dir = packProject();
    mkdirSync(path.join(dir, 'outdir.apk'));
    const a = io({ cwd: dir, env: env() });
    assert.equal(
      await runCli(
        [
          'pack',
          '--skip-compat',
          '--template',
          templateFile,
          '--out',
          'outdir.apk',
        ],
        a.io,
      ),
      EXIT.failure,
    );
    assert.match(a.err(), /outdir\.apk is a directory/);
    assert.deepEqual(
      readdirSync(dir).filter((f) => f.endsWith('.tmp')),
      [],
    );
    const b = io({ cwd: dir, env: env() });
    assert.equal(
      await runCli(['pack', '--skip-compat', '--template', dir], b.io),
      EXIT.failure,
    );
    assert.match(b.err(), /is not a file/);
  });
  test('run <package> --forward reads the inspector port from the installed APK', async () => {
    const dir = packProject();
    mkdirSync(path.join(dir, 'tpl'));
    const tpl = await buildTestTemplate(path.join(dir, 'tpl'), {
      config: { inspector: { port: 9501 } },
    });
    const t = io({ cwd: dir, env: env() });
    assert.equal(await runCli(['pack', '--template', tpl.file], t.io), EXIT.ok);
    const apk = path.join(dir, 'dist-metavr', 'Proto-Showcase.apk');
    const calls: string[][] = [];
    const exec: Exec = async (_file, args) => {
      calls.push([...args]);
      if (args[0] === 'shell' && args[1] === 'pm')
        return {
          code: 0,
          stdout: 'package:/data/app/~~x==/com.a.b-y==/base.apk\n',
          stderr: '',
        };
      if (args[0] === 'pull') {
        copyFileSync(apk, args[2]);
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: 'Status: ok\n', stderr: '' };
    };
    const t2 = io({ exec });
    assert.equal(
      await runCli(['run', 'com.a.b', '--forward', '9508'], t2.io),
      EXIT.ok,
      t2.err(),
    );
    assert.deepEqual(
      calls.find((c) => c[0] === 'forward'),
      ['forward', 'tcp:9508', 'localabstract:com.a.b_devtools_9501'],
    );
    const t3 = io();
    assert.equal(
      await runCli(
        [
          'run',
          'com.a.b',
          '--dry-run',
          '--forward',
          '9508',
          '--device-port',
          '9600',
        ],
        t3.io,
      ),
      EXIT.ok,
    );
    assert.match(
      t3.out(),
      /^adb forward tcp:9508 localabstract:com\.a\.b_devtools_9600\n/,
    );
  });
  test('install hint names the package read from the APK', async () => {
    const dir = packProject();
    const t = io({ cwd: dir, env: env() });
    assert.equal(
      await runCli(['pack', '--template', templateFile], t.io),
      EXIT.ok,
    );
    const t2 = io({
      cwd: dir,
      exec: fakeExec({
        install: {
          code: 1,
          stdout: 'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: x]\n',
        },
      }),
    });
    assert.equal(
      await runCli(
        ['install', 'dist-metavr/Proto-Showcase.apk', '-s', 'Q1'],
        t2.io,
      ),
      EXIT.failure,
    );
    assert.match(t2.err(), /adb -s Q1 uninstall com\.a\.b/);
  });
  test('--install --run go through adb after packing', async () => {
    const dir = packProject();
    const calls: string[][] = [];
    const t = io({
      cwd: dir,
      env: { ...env(), ADB: '/opt/adb' },
      exec: fakeExec(
        {
          install: { stdout: 'Success\n' },
          shell: {
            stdout:
              'Status: ok\nActivity: com.a.b/android.app.NativeActivity\n',
          },
        },
        calls,
      ),
    });
    assert.equal(
      await runCli(
        ['pack', '--template', templateFile, '--install', '--run', '-s', 'S1'],
        t.io,
      ),
      EXIT.ok,
    );
    assert.deepEqual(calls[0], [
      '/opt/adb',
      '-s',
      'S1',
      'install',
      '-r',
      path.join(dir, 'dist-metavr', 'Proto-Showcase.apk'),
    ]);
    assert.deepEqual(calls[1].slice(3), [
      'shell',
      'am',
      'start',
      '-S',
      '-W',
      '-n',
      'com.a.b/android.app.NativeActivity',
    ]);
  });
});

describe('install', () => {
  test('without an APK installs the packed one, or explains', async () => {
    const dir = project({ native: { packageId: 'com.a.b', appName: 'X' } });
    const t = io({ cwd: dir });
    assert.equal(await runCli(['install'], t.io), EXIT.failure);
    assert.match(t.err(), /run "iwer-native pack" first/);
    const t2 = io({ cwd: dir });
    assert.equal(await runCli(['install', '--dry-run'], t2.io), EXIT.ok);
    assert.equal(
      t2.out(),
      `adb install -r ${path.join(dir, 'dist-metavr', 'X.apk')}\n`,
    );
  });
  test('with an APK runs adb install -r', async () => {
    const calls: string[][] = [];
    const t = io({
      exec: fakeExec({ install: { stdout: 'Success\n' } }, calls),
    });
    assert.equal(
      await runCli(['install', 'out/app.apk', '--serial', 'ABC'], t.io),
      EXIT.ok,
    );
    assert.deepEqual(calls, [
      ['adb', '-s', 'ABC', 'install', '-r', path.join(scratch, 'out/app.apk')],
    ]);
  });
  test('signature mismatch explains the uninstall', async () => {
    const t = io({
      exec: fakeExec({
        install: {
          code: 1,
          stdout:
            'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package com.a.b signatures do not match newer version; ignoring!]\n',
        },
      }),
    });
    assert.equal(await runCli(['install', 'a.apk'], t.io), EXIT.failure);
    assert.match(t.err(), /signed with a different key/);
  });
  test('rejects non-APKs', async () => {
    assert.equal(await runCli(['install', 'app.zip'], io().io), EXIT.usage);
  });
  test('IWER_NATIVE_ADB_ARGS prefixes every adb call', async () => {
    const t = io({ env: { IWER_NATIVE_ADB_ARGS: '--reason iwn-test' } });
    assert.equal(
      await runCli(['install', 'a.apk', '--dry-run'], t.io),
      EXIT.ok,
    );
    assert.match(t.out(), /^adb --reason iwn-test install -r /);
    const q = io({
      env: { IWER_NATIVE_ADB_ARGS: `--reason "cli test" --x 'a b'` },
    });
    assert.equal(
      await runCli(['install', 'a.apk', '--dry-run'], q.io),
      EXIT.ok,
    );
    assert.match(q.out(), /^adb --reason 'cli test' --x 'a b' install -r /);
    assert.deepEqual(splitShellWords(`a  "b \\"c\\"" 'd e'f g\\ h`), [
      'a',
      'b "c"',
      'd ef',
      'g h',
    ]);
    const bad = io({ env: { IWER_NATIVE_ADB_ARGS: '--reason "x' } });
    assert.equal(await runCli(['install', 'a.apk'], bad.io), EXIT.failure);
    assert.match(bad.err(), /unterminated quote/);
  });
});

describe('run', () => {
  test('launches the configured package with am start', async () => {
    const calls: string[][] = [];
    const dir = project({ native: { packageId: 'com.a.b' } });
    const t = io({
      cwd: dir,
      env: { ADB: '/opt/adb' },
      exec: fakeExec({ shell: { stdout: 'Status: ok\n' } }, calls),
    });
    assert.equal(await runCli(['run'], t.io), EXIT.ok);
    assert.deepEqual(calls, [
      [
        '/opt/adb',
        'shell',
        'am',
        'start',
        '-S',
        '-W',
        '-n',
        'com.a.b/android.app.NativeActivity',
      ],
    ]);
  });
  test('debug switches become intent extras (PKG-10)', async () => {
    const calls: string[][] = [];
    const t = io({
      exec: fakeExec({ shell: { stdout: 'Status: ok\n' } }, calls),
    });
    assert.equal(
      await runCli(
        [
          'run',
          'com.x.y',
          '-s',
          'S1',
          '--inspect',
          '--inspect-brk',
          '--query',
          'debug=1&x=2',
          '--v8-flags=--max-lazy --no-opt',
        ],
        t.io,
      ),
      EXIT.ok,
    );
    // adb shell hands the joined words to the device shell: values are quoted for it.
    assert.deepEqual(calls[0].slice(3), [
      'shell',
      'am',
      'start',
      '-S',
      '-W',
      '-n',
      'com.x.y/android.app.NativeActivity',
      '--ez',
      'iwn.inspector',
      'true',
      '--ez',
      'iwn.inspectBrk',
      'true',
      '--es',
      'iwn.query',
      "'debug=1&x=2'",
      '--es',
      'iwn.v8flags',
      "'--max-lazy --no-opt'",
    ]);
  });
  test('--forward sets up the inspector port first', async () => {
    const t = io();
    assert.equal(
      await runCli(['run', 'com.x.y', '--dry-run', '--forward', '9508'], t.io),
      EXIT.ok,
    );
    assert.match(
      t.out(),
      /^adb forward tcp:9508 localabstract:com\.x\.y_devtools_9229\n/,
    );
  });
  test('not installed', async () => {
    const t = io({
      exec: fakeExec({
        shell: {
          stdout:
            'Error: Activity class {com.x.y/android.app.NativeActivity} does not exist.\n',
        },
      }),
    });
    assert.equal(await runCli(['run', 'com.x.y'], t.io), EXIT.failure);
    assert.match(t.err(), /is it installed/);
  });
  test('adb missing', async () => {
    const t = io();
    assert.equal(await runCli(['run', 'com.x.y'], t.io), EXIT.failure);
    assert.match(t.err(), /adb not found/);
  });
});

describe('doctor', () => {
  const healthy = () =>
    fakeExec({
      version: { stdout: ADB_VERSION },
      devices: {
        stdout:
          'List of devices attached\n2G0Y123 device usb:1-1 product:quest model:Quest_3 device:quest\n\n',
      },
    });

  test('all good', async () => {
    const dir = project({ native: { packageId: 'com.a.b' } });
    const t = io({ cwd: dir, exec: healthy() });
    assert.equal(await runCli(['doctor'], t.io), EXIT.ok);
    assert.match(t.out(), /\[ok\]\s+Node 24\.10\.0/);
    assert.match(t.out(), /\[ok\]\s+adb 1\.0\.41 \(from PATH\)/);
    assert.match(t.out(), /1 device\(s\) ready/);
    assert.match(t.out(), /2G0Y123 device \(Quest_3\)/);
    assert.match(t.out(), /native target com\.a\.b 0\.3\.1 \(3001\)/);
  });

  test('old Node and missing adb fail', async () => {
    const t = io({ nodeVersion: '16.20.2' });
    assert.equal(await runCli(['doctor', '--json'], t.io), EXIT.failure);
    const json = JSON.parse(t.out());
    const byId = Object.fromEntries(
      json.checks.map((c: { id: string; status: string }) => [c.id, c.status]),
    );
    assert.ok(['ok', 'warn'].includes(byId.template), byId.template); // depends on the checkout; test/release.test.ts covers it
    delete byId.template;
    assert.deepEqual(byId, {
      node: 'fail',
      adb: 'fail',
      devices: 'skip',
      config: 'skip',
    });
  });

  test('unauthorized device and missing native section warn', async () => {
    const checks = await runDoctor({
      nodeVersion: '22.12.0',
      env: {},
      projectRoot: project({ version: 'iwsdk.project.v1' }),
      exec: fakeExec({
        version: { stdout: ADB_VERSION },
        devices: { stdout: 'List of devices attached\nXYZ unauthorized\n' },
      }),
    });
    const devices = checks.find((c) => c.id === 'devices')!;
    assert.equal(devices.status, 'warn');
    assert.match(devices.hint!, /Allow USB debugging/);
    const config = checks.find((c) => c.id === 'config')!;
    assert.equal(config.status, 'warn');
    assert.match(config.summary, /no "native" section/);
  });

  test('release signing needs its env vars, values never printed', async () => {
    const dir = project(
      {
        native: {
          packageId: 'com.a.b',
          signing: {
            keystore: 'k.jks',
            storePasswordEnv: 'STORE_PW',
            keyPasswordEnv: 'KEY_PW',
          },
        },
      },
      { 'k.jks': 'x' },
    );
    const a = io({
      cwd: dir,
      exec: healthy(),
      env: { STORE_PW: 'secret-value' },
    });
    assert.equal(await runCli(['doctor'], a.io), EXIT.ok);
    assert.match(
      a.out(),
      /\[warn\] release signing: KEY_PW not set \(needed for pack --release only\)/,
    );
    assert.ok(!a.out().includes('secret-value'));
    const b = io({
      cwd: dir,
      exec: healthy(),
      env: { STORE_PW: 'secret-value', KEY_PW: 'k' },
    });
    assert.equal(await runCli(['doctor'], b.io), EXIT.ok);
    assert.ok(!b.out().includes('secret-value'));
  });

  test('a debug machine without the release keystore: doctor and validate warn, pack --release still needs it', async () => {
    const dir = project({
      native: {
        packageId: 'com.a.b',
        signing: {
          keystore: '../secrets/release.p12',
          storePasswordEnv: 'STORE_PW',
        },
      },
    });
    const d = io({ cwd: dir, exec: healthy(), env: { STORE_PW: '' } });
    assert.equal(await runCli(['doctor'], d.io), EXIT.ok, d.out());
    assert.match(
      d.out(),
      /\[warn\].*\n.*keystore file not found.*only needed for release builds/,
    );
    // an empty password is set (pack accepts it)
    assert.match(d.out(), /\[ok\]\s+release signing: STORE_PW set/);
    const v = io({ cwd: dir });
    assert.equal(await runCli(['validate'], v.io), EXIT.ok, v.err());
    assert.match(
      v.err() + v.out(),
      /keystore file not found.*only needed for release builds/,
    );
  });

  test('invalid config fails', async () => {
    const t = io({
      cwd: project({ native: { packageId: 'x' } }),
      exec: healthy(),
    });
    assert.equal(await runCli(['doctor'], t.io), EXIT.failure);
    assert.match(t.out(), /\[fail\] native target config is invalid/);
  });

  test('adb timeout is reported', async () => {
    const t = io({
      exec: async () => ({
        code: null,
        stdout: '',
        stderr: '',
        error: 'timeout',
      }),
    });
    await runCli(['doctor'], t.io);
    assert.match(t.out(), /did not answer `adb version`/);
  });
});

describe('helpers', () => {
  test('isSupportedNodeVersion', () => {
    const yes = ['20.19.0', '22.12.0', 'v24.0.0', '25.1.0', '30.0.0'];
    const no = ['16.20.2', '20.18.9', '21.7.0', '22.11.0', '23.9.0', 'garbage'];
    for (const v of yes) assert.equal(isSupportedNodeVersion(v), true, v);
    for (const v of no) assert.equal(isSupportedNodeVersion(v), false, v);
  });
  test('locateAdb order', () => {
    assert.deepEqual(
      locateAdb({ ADB: '/x/adb', ANDROID_HOME: '/sdk' }, () => true),
      { command: '/x/adb', source: 'ADB' },
    );
    assert.deepEqual(
      locateAdb({ ANDROID_HOME: '/sdk' }, () => true),
      {
        command: path.join('/sdk', 'platform-tools', 'adb'),
        source: 'ANDROID_HOME',
      },
    );
    assert.deepEqual(
      locateAdb({ ANDROID_HOME: '/sdk', ANDROID_SDK_ROOT: '/r' }, (f) =>
        f.startsWith('/r'),
      ),
      {
        command: path.join('/r', 'platform-tools', 'adb'),
        source: 'ANDROID_SDK_ROOT',
      },
    );
    assert.deepEqual(
      locateAdb({}, () => true),
      { command: 'adb', source: 'PATH' },
    );
  });
  test('parseAdbDevices / parseAdbVersion', () => {
    const out =
      '* daemon started successfully\nList of devices attached\nA device model:Quest_3S\nB offline\n\n';
    assert.deepEqual(parseAdbDevices(out), [
      { serial: 'A', state: 'device', model: 'Quest_3S' },
      { serial: 'B', state: 'offline', model: null },
    ]);
    assert.equal(parseAdbVersion(ADB_VERSION), '1.0.41');
    assert.equal(parseAdbVersion('nope'), null);
  });
});
