/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { resolveNativeTarget } from '../../src/config/resolve.ts';
import type { ResolvedNativeTarget } from '../../src/config/types.ts';
import { verifyApk } from '../src/apk-sign.ts';
import { attrString, decodeAxml, element, encodeAxml } from '../src/axml.ts';
import { scanIndexHtml } from '../src/dist.ts';
import { summarizeManifest } from '../src/manifest.ts';
import { formatPackReport, pack, type PackInput } from '../src/pack.ts';
import { decodePng, encodePng, placeholderIcon } from '../src/png.ts';
import {
  fetchPinnedTemplate,
  resolveTemplate,
  type LoadedTemplate,
} from '../src/template.ts';
import {
  checkAlignment,
  entryData,
  findEntry,
  METHOD_STORED,
  readZip,
} from '../src/zip.ts';
import {
  buildTestDist,
  buildTestTemplate,
  buildTools,
  FIXTURES,
  ICON_SIZES,
  scratchDir,
  STORE_PASSWORD,
  templateManifest,
} from './helpers.ts';

const scratch = scratchDir('pack');
after(() => rmSync(scratch, { recursive: true, force: true }));

let template: LoadedTemplate;
let dist: string;
before(async () => {
  template = await buildTestTemplate(scratch);
  dist = buildTestDist(scratch);
});

const target = (native: Record<string, unknown> = {}): ResolvedNativeTarget =>
  resolveNativeTarget(
    {
      version: 'iwsdk.project.v1',
      native: {
        packageId: 'com.example.packtest',
        appName: 'Pack Test',
        ...native,
      },
    },
    { packageJson: { name: 'pack-test', version: '1.2.3' } },
  );

let n = 0;
const input = (over: Partial<PackInput> = {}): PackInput => ({
  target: target(),
  files: { icon: null, keystore: null },
  distDir: dist,
  outFile: path.join(scratch, `out-${n++}.apk`),
  template,
  buildType: 'debug',
  env: {},
  configDir: path.join(scratch, 'config'),
  packerVersion: '0.0.0-test',
  ...over,
});

describe('pack (PKG-4)', () => {
  test('every dist file lands under assets/app/, byte for byte', async () => {
    const r = await pack(input());
    const zip = readZip(readFileSync(r.outFile));
    const names = new Set(zip.entries.map((e) => e.name));
    for (const rel of [
      'index.html',
      'assets/index.js',
      'assets/index.js.map',
      'models/robot.glb',
      '_underscore/data.json',
      '.well-known/thing.txt',
      'textures/ü-name.ktx2',
    ]) {
      assert.ok(names.has(`assets/app/${rel}`), rel);
      assert.deepEqual(
        entryData(zip, findEntry(zip, `assets/app/${rel}`)!),
        readFileSync(path.join(dist, rel)),
        rel,
      );
    }
    assert.equal(r.assetCount, 9);
  });
  test('binary types stored uncompressed and aligned; text compressed; .so 16 KiB aligned', async () => {
    const r = await pack(input());
    const zip = readZip(readFileSync(r.outFile));
    const e = (name: string) => findEntry(zip, name)!;
    for (const name of [
      'assets/app/models/robot.glb',
      'assets/app/audio/click.mp3',
      'assets/app/textures/ü-name.ktx2',
    ]) {
      assert.equal(e(name).method, METHOD_STORED, name);
      assert.equal(e(name).dataOffset % 4, 0, name);
    }
    assert.notEqual(e('assets/app/assets/vendor.js').method, METHOD_STORED);
    assert.equal(e('lib/arm64-v8a/libiwntemplate.so').dataOffset % 16384, 0);
    assert.equal(e('resources.arsc').method, METHOD_STORED);
    assert.deepEqual(checkAlignment(zip), []);
    assert.equal(zip.entries[0].name, 'AndroidManifest.xml');
    assert.ok(
      !zip.entries.some((x) => x.name.startsWith('META-INF/')),
      'template signature files dropped',
    );
  });
  test('release excludes *.map; --exclude globs', async () => {
    const r = await pack(
      input({ buildType: 'release', exclude: ['audio/**'] }),
    );
    const names = readZip(readFileSync(r.outFile)).entries.map((e) => e.name);
    assert.ok(!names.includes('assets/app/assets/index.js.map'));
    assert.ok(!names.includes('assets/app/audio/click.mp3'));
    assert.deepEqual(r.excluded.sort(), [
      'assets/index.js.map',
      'audio/click.mp3',
    ]);
  });
  test('reproducible (PKG-9): same inputs, same bytes', async () => {
    const a = await pack(input());
    const b = await pack(input());
    assert.equal(a.sha256, b.sha256);
    assert.deepEqual(readFileSync(a.outFile), readFileSync(b.outFile));
  });
  test('signed v2+v3 and self-verified', async () => {
    const r = await pack(input());
    assert.equal(r.verify.v2, true);
    assert.equal(r.verify.v3, true);
    verifyApk(readFileSync(r.outFile));
  });
  test('report numbers (PKG-11)', async () => {
    const r = await pack(input());
    assert.ok(r.runtimeBytes > 20000);
    assert.ok(r.assetBytes > 70000);
    assert.equal(r.largest[0].rel, 'models/robot.glb');
    assert.equal(r.index.moduleScripts[0], './assets/index.js');
  });
});

describe('manifest and runtime config (PKG-8, PKG-CFG-1)', () => {
  test('manifest identity and INTERNET for debug builds', async () => {
    const r = await pack(
      input({ target: target({ features: { handTracking: true } }) }),
    );
    const m = summarizeManifest(
      decodeAxml(
        entryData(
          readZip(readFileSync(r.outFile)),
          findEntry(readZip(readFileSync(r.outFile)), 'AndroidManifest.xml')!,
        ),
      ),
    );
    assert.equal(m.packageId, 'com.example.packtest');
    assert.equal(m.label, 'Pack Test');
    assert.equal(m.versionName, '1.2.3');
    assert.equal(m.versionCode, 1002003);
    assert.equal(m.debuggable, true);
    assert.ok(m.permissions.includes('android.permission.INTERNET'));
    assert.ok(m.permissions.includes('com.oculus.permission.HAND_TRACKING'));
  });
  test('plain release: not debuggable, no INTERNET, inspector off', async () => {
    const r = await pack(input({ buildType: 'release' }));
    assert.equal(r.manifest.debuggable, false);
    assert.ok(!r.manifest.permissions.includes('android.permission.INTERNET'));
    const zip = readZip(readFileSync(r.outFile));
    const cfg = JSON.parse(
      entryData(zip, findEntry(zip, 'assets/iwn/config.json')!).toString(),
    );
    assert.equal(cfg.inspector.enabled, false);
    assert.equal(cfg.debug.enabled, false);
    assert.equal(cfg.launchOverrides.allowed, false);
  });
  test('config.json overlays app values on the template defaults', async () => {
    const r = await pack(
      input({
        target: target({
          network: { allow: ['https://cdn.jsdelivr.net'] },
          frameRate: 90,
          foveation: 'high',
        }),
      }),
    );
    const zip = readZip(readFileSync(r.outFile));
    const cfg = JSON.parse(
      entryData(zip, findEntry(zip, 'assets/iwn/config.json')!).toString(),
    );
    assert.deepEqual(
      cfg.preludes,
      ['iwn/prelude/glue.js'],
      'template default kept',
    );
    assert.equal(cfg.inspector.port, 9229, 'template default kept');
    assert.equal(cfg.inspector.enabled, true);
    assert.equal(cfg.origin, 'https://app.local');
    assert.equal(cfg.appRoot, 'app');
    assert.deepEqual(cfg.app, {
      buildType: 'debug',
      name: 'Pack Test',
      packageId: 'com.example.packtest',
      versionCode: 1002003,
      versionName: '1.2.3',
    });
    assert.deepEqual(cfg.network, {
      allow: ['https://cdn.jsdelivr.net'],
      debug: true,
    });
    assert.equal(cfg.xr.frameRate, 90);
    assert.equal(cfg.xr.foveation.level, 'high');
    assert.equal(cfg.page.title, 'Test App');
  });
  test('icon resized to every template density', async () => {
    const icon = path.join(scratch, 'icon.png');
    writeFileSync(icon, encodePng(placeholderIcon(512, [200, 30, 30])));
    const r = await pack(input({ files: { icon, keystore: null } }));
    const zip = readZip(readFileSync(r.outFile));
    for (const [i, meta] of template.meta.icons.entries()) {
      const img = decodePng(entryData(zip, findEntry(zip, meta.path)!));
      assert.equal(img.width, ICON_SIZES[i]);
      const c = ((img.height / 2) * img.width + img.width / 2) * 4; // centre pixel (fill colour)
      assert.deepEqual([...img.data.subarray(c, c + 4)], [200, 30, 30, 255]);
    }
  });
});

describe('launch splash and loading screen (native.splash)', () => {
  const ROBOTO = readFileSync(
    path.join(
      path.dirname(new URL(import.meta.url).pathname),
      '../../runtime/canvas2d/fonts/Roboto-Bold.ttf',
    ),
  );
  const unpack = (file: string) => {
    const zip = readZip(readFileSync(file));
    const cfg = JSON.parse(
      entryData(zip, findEntry(zip, 'assets/iwn/config.json')!).toString(),
    );
    const manifest = summarizeManifest(
      decodeAxml(entryData(zip, findEntry(zip, 'AndroidManifest.xml')!)),
    );
    return { zip, cfg, manifest, splash: findEntry(zip, 'assets/vr_splash.png') };
  };

  test('on by default: system splash declared, image stored, loading screen configured', async () => {
    const withFont = await buildTestTemplate(scratch, {
      extra: { 'assets/iwn/fonts/Roboto-Bold.ttf': ROBOTO },
    });
    const r = await pack(input({ template: withFont }));
    const { zip, cfg, manifest, splash } = unpack(r.outFile);
    // Horizon OS: assets/vr_splash.png + <meta-data android:name="com.oculus.ossplash" android:value="true"/>, on
    // black (com.oculus.ossplash.background): an app without passthrough cannot show the room behind its loading
    // screen, so neither does the system splash before it.
    assert.equal(manifest.osSplash, true);
    assert.equal(manifest.osSplashBackground, 'black');
    assert.ok(splash);
    assert.equal(splash.method, METHOD_STORED);
    const img = decodePng(entryData(zip, splash));
    assert.deepEqual([img.width, img.height], [1024, 512]);
    // The runtime shows the same file until the first XR frame, on its opaque black background.
    assert.deepEqual(cfg.xr.loading, {
      background: 'black',
      enabled: true,
      image: 'vr_splash.png',
    });
    assert.deepEqual(r.splash, {
      source: 'generated',
      width: 1024,
      height: 512,
      text: 'Pack Test',
      icon: true,
    });
    assert.ok(!r.warnings.some((w) => w.startsWith('splash:')), r.warnings.join('\n'));
    assert.match(
      formatPackReport(r),
      /splash {6}generated 1024x512 \(icon \+ "Pack Test"\) \+ loading spinner, black background/,
    );
  });

  test('without a font in the template the card has the icon only, with a warning', async () => {
    const r = await pack(input());
    assert.equal(r.splash?.text, null);
    assert.equal(r.splash?.icon, true);
    assert.ok(r.warnings.some((w) => /^splash: no font in the template/.test(w)));
  });

  test('your own image and background colour', async () => {
    const own = path.join(scratch, 'my-splash.png');
    const bytes = encodePng(placeholderIcon(300, [10, 200, 90]));
    writeFileSync(own, bytes);
    const r = await pack(
      input({
        target: target({ splash: { image: './my-splash.png', background: '#0B0C0E' } }),
        files: { icon: null, keystore: null, splash: own },
      }),
    );
    const { zip, cfg, manifest, splash } = unpack(r.outFile);
    assert.equal(manifest.osSplash, true);
    // Horizon OS's splash knows black or contextual passthrough only: a colour is for the loading screen.
    assert.equal(manifest.osSplashBackground, 'black');
    assert.deepEqual(entryData(zip, splash!), bytes);
    assert.equal(cfg.xr.loading.background, '#0b0c0e');
    assert.match(formatPackReport(r), /\+ loading spinner, background #0b0c0e/);
    assert.equal(r.splash?.source, 'image');
    // The configured image must have been resolved to a file (loadNativeProject does that).
    await assert.rejects(
      pack(input({ target: target({ splash: { image: './my-splash.png' } }) })),
      /native\.splash\.image .* was not resolved/,
    );
  });

  test('splash: false: no system splash, no image or spinner, the background stays', async () => {
    const r = await pack(input({ target: target({ splash: false }) }));
    const { cfg, manifest, splash } = unpack(r.outFile);
    assert.equal(manifest.osSplash, false);
    // The launch transition keeps its background without a logo.
    assert.equal(manifest.osSplashBackground, 'black');
    assert.equal(splash, undefined);
    // What shows behind a frame without an opaque layer is up to the system: the opaque background stays.
    assert.deepEqual(cfg.xr.loading, {
      background: 'black',
      enabled: true,
      image: null,
      spinner: false,
    });
    assert.equal(r.splash, null);
    assert.match(
      formatPackReport(r),
      /splash {6}off \(no image or spinner; black background until the first XR frame\)/,
    );
  });

  test('an app that declares passthrough gets the contextual background on both', async () => {
    // Meta's passthrough loading screen: passthrough-contextual behind the system splash, and the runtime's own
    // passthrough layer behind its loading screen (it needs com.oculus.feature.PASSTHROUGH, which the feature adds).
    const r = await pack(input({ target: target({ features: { passthrough: 'optional' } }) }));
    const { cfg, manifest } = unpack(r.outFile);
    assert.equal(manifest.osSplashBackground, 'passthrough-contextual');
    assert.deepEqual(manifest.features.find((f) => f.name === 'com.oculus.feature.PASSTHROUGH'), {
      name: 'com.oculus.feature.PASSTHROUGH',
      required: false,
    });
    assert.equal(cfg.xr.loading.background, 'contextual');
    assert.match(
      formatPackReport(r),
      /\+ loading spinner, contextual background \(passthrough from a passthrough home, else black\)/,
    );
    // splash: false keeps it; "black" overrides it.
    const off = unpack(
      (await pack(input({ target: target({ features: { passthrough: true }, splash: false }) }))).outFile,
    );
    assert.equal(off.manifest.osSplashBackground, 'passthrough-contextual');
    assert.equal(off.cfg.xr.loading.background, 'contextual');
    const black = unpack(
      (
        await pack(
          input({ target: target({ features: { passthrough: true }, splash: { background: 'black' } }) }),
        )
      ).outFile,
    );
    assert.equal(black.manifest.osSplashBackground, 'black');
    assert.equal(black.cfg.xr.loading.background, 'black');
  });

  test('splash.background "black": opaque black, and black behind the system splash', async () => {
    const r = await pack(input({ target: target({ splash: { background: 'black' } }) }));
    const { cfg, manifest } = unpack(r.outFile);
    assert.equal(manifest.osSplash, true);
    assert.equal(manifest.osSplashBackground, 'black');
    assert.equal(cfg.xr.loading.background, 'black');
    assert.match(formatPackReport(r), /\+ loading spinner, black background/);
  });

  test("a template's own ossplash declaration follows the config", async () => {
    // A template that already declares the system splash (and ships an image) gets both replaced or removed.
    const doc = decodeAxml(templateManifest());
    const app = doc.root.children.find(
      (c) => c.kind === 'element' && c.name === 'application',
    );
    assert.ok(app && app.kind === 'element');
    app.children.unshift(
      element('meta-data', {
        name: { type: 'string', value: 'com.oculus.ossplash' },
        value: { type: 'bool', value: true },
      }),
      element('meta-data', {
        name: { type: 'string', value: 'com.oculus.ossplash.background' },
        value: { type: 'string', value: 'black' },
      }),
    );
    const t = await buildTestTemplate(scratch, {
      manifest: encodeAxml(doc),
      extra: { 'assets/vr_splash.png': encodePng(placeholderIcon(8)) },
    });
    const off = unpack((await pack(input({ template: t, target: target({ splash: false }) }))).outFile);
    assert.equal(off.manifest.osSplash, false);
    assert.equal(off.splash, undefined);
    const on = unpack(
      (await pack(input({ template: t, target: target({ features: { passthrough: true } }) }))).outFile,
    );
    assert.equal(on.manifest.osSplash, true);
    // The template's background declaration is replaced, not duplicated.
    assert.equal(on.manifest.osSplashBackground, 'passthrough-contextual');
    const onApp = decodeAxml(
      entryData(on.zip, findEntry(on.zip, 'AndroidManifest.xml')!),
    ).root.children.find((c) => c.kind === 'element' && c.name === 'application');
    assert.ok(onApp && onApp.kind === 'element');
    assert.equal(
      onApp.children.filter(
        (c) =>
          c.kind === 'element' &&
          c.name === 'meta-data' &&
          attrString(c, 'name') === 'com.oculus.ossplash.background',
      ).length,
      1,
    );
    assert.equal(
      on.zip.entries.filter((e) => e.name === 'assets/vr_splash.png').length,
      1,
    );
    assert.equal(decodePng(entryData(on.zip, on.splash!)).width, 1024);
  });
});

describe('refusals (PKG-5, PKG-6, PKG-7)', () => {
  test('no module script', async () => {
    const d = buildTestDist(scratchDir('nomod'), {
      'index.html': '<html><script src="a.js"></script></html>',
    });
    await assert.rejects(
      pack(input({ distDir: d })),
      /has no <script type="module">/,
    );
  });
  test('no index.html', async () => {
    const d = buildTestDist(scratchDir('noindex'));
    rmSync(path.join(d, 'index.html'));
    await assert.rejects(pack(input({ distDir: d })), /has no index\.html/);
  });
  test('injected IWER emulator: the error names both fixes (the metavr build, the config key)', async () => {
    const d = buildTestDist(scratchDir('inject'), {
      'assets/inject.js':
        'const C={device:"metaQuest3",activation:"always",verbose:!1,sem:null,ai:null,workspace:null,userAgentException:void 0,iwer:!0,nativeXRControl:!1,targetDevicePreview:null};',
    });
    await assert.rejects(pack(input({ distDir: d })), (e: Error) => {
      const m = e.message.replace(/\s+/g, ' ');
      assert.match(m, /injected WebXR emulator/);
      // the metavr mode leaves the emulator out without touching the setting (it does not turn it off)
      assert.match(m, /Build with `npm run build:metavr` \(vite build --mode metavr, which leaves the emulator out whatever dev\.emulator\.injectOnBuild says\)/);
      assert.match(m, /or set dev\.emulator\.injectOnBuild to false in iwsdk\.config\.json, then rebuild/);
      assert.doesNotMatch(m, /turns it off/);
      return true;
    });
  });
  test('injected IWER emulator from IWSDK 0.x (no nativeXRControl) is refused (GAP-7)', async () => {
    // Shape of an IWSDK vite-plugin-dev 0.5.3 build with injectOnBuild: true.
    const d = buildTestDist(scratchDir('inject0x'), {
      'assets/inject.js':
        '(function(d){if(d.verbose)console.log(1)})({device:"metaQuest3",activation:"always",verbose:!1,sem:null,ai:null,workspace:null,userAgentException:"/OculusBrowser/",iwer:!0});',
    });
    await assert.rejects(
      pack(input({ distDir: d })),
      /dev\.emulator\.injectOnBuild/,
    );
  });
  test('config validator strings alone are not an injection', async () => {
    const d = buildTestDist(scratchDir('validator'), {
      'assets/validator.js':
        'const k=["device","iwer","environment","activation","injectOnBuild","userAgentException"];const o={activation:1};',
    });
    await pack(input({ distDir: d }));
  });
  test('release signing: missing env var', async () => {
    const t = target({
      signing: {
        keystore: path.join(FIXTURES, 'p12-jdk17.p12'),
        storePasswordEnv: 'IWN_TEST_STORE_PW',
      },
    });
    await assert.rejects(
      pack(input({ target: t, buildType: 'release' })),
      /IWN_TEST_STORE_PW .* is not set/,
    );
  });
  test('release signing with a keystore; debug build ignores it', async () => {
    const keystore = path.join(FIXTURES, 'p12-jdk17.p12');
    const t = target({
      signing: { keystore, storePasswordEnv: 'IWN_TEST_STORE_PW' },
    });
    const env = { IWN_TEST_STORE_PW: STORE_PASSWORD };
    const rel = await pack(
      input({
        target: t,
        buildType: 'release',
        env,
        files: { icon: null, keystore },
      }),
    );
    assert.equal(rel.signing.mode, 'release');
    assert.match(rel.verify.signers[0].subject, /iwer-native test/);
    const dbg = await pack(input({ target: t, buildType: 'debug', env }));
    assert.equal(dbg.signing.mode, 'debug');
    assert.match(dbg.verify.signers[0].subject, /Android Debug/);
  });
  test('release without signing: debug key with a warning', async () => {
    const r = await pack(input({ buildType: 'release' }));
    assert.equal(r.signing.mode, 'debug');
    assert.ok(r.warnings.some((w) => /signed with the debug key/.test(w)));
  });
  test('compressed resources.arsc in a template is stored on output', async () => {
    const t = await buildTestTemplate(scratchDir('arsc'), {
      arscCompressed: true,
    });
    const r = await pack(input({ template: t }));
    assert.equal(
      findEntry(readZip(readFileSync(r.outFile)), 'resources.arsc')!.method,
      METHOD_STORED,
    );
  });
});

describe('runtime templates without metadata', () => {
  test('a bare runtime APK packs (no icon), with a warning', async () => {
    const t = await buildTestTemplate(scratchDir('nometa'), { noMeta: true });
    assert.equal(t.meta.synthesized, true);
    assert.deepEqual(t.meta.abis, ['arm64-v8a']);
    const r = await pack(input({ template: t }));
    assert.ok(r.warnings.some((w) => /no assets\/iwn\/template\.json/.test(w)));
    verifyApk(readFileSync(r.outFile));
  });
  test('INTERNET shipped by a template is removed from plain release builds', async () => {
    const doc = decodeAxml(templateManifest());
    doc.root.children.unshift(
      element('uses-permission', {
        name: { type: 'string', value: 'android.permission.INTERNET' },
      }),
    );
    const t = await buildTestTemplate(scratchDir('inet'), {
      manifest: encodeAxml(doc),
    });
    const rel = await pack(input({ template: t, buildType: 'release' }));
    assert.ok(
      !rel.manifest.permissions.includes('android.permission.INTERNET'),
    );
    const dbg = await pack(input({ template: t }));
    assert.equal(
      dbg.manifest.permissions.filter(
        (p) => p === 'android.permission.INTERNET',
      ).length,
      1,
    );
    const explicit = await pack(
      input({
        template: t,
        buildType: 'release',
        target: target({ permissions: ['android.permission.INTERNET'] }),
      }),
    );
    assert.ok(
      explicit.manifest.permissions.includes('android.permission.INTERNET'),
    );
  });
});

describe('index.html scan (PKG-5)', () => {
  test('entry, preloads, classic scripts, title; comments ignored', () => {
    const info = scanIndexHtml(
      `<title> My  App </title><!-- <script type="module" src="old.js"></script> -->
       <link rel="modulepreload" href="/a.js"><script type=module src='/main.js'></script>
       <script src="/classic.js"></script><script type="module">import "/x.js"</script>`,
    );
    assert.deepEqual(info, {
      title: 'My App',
      moduleScripts: ['/main.js'],
      inlineModules: 1,
      modulePreloads: ['/a.js'],
      classicScripts: ['/classic.js'],
    });
  });
});

describe('template download and cache (PKG-2)', () => {
  test('download, verify, cache; tampered cache is fetched again; bad download refused', async () => {
    const apk = template.buffer;
    const sha256 = createHash('sha256').update(apk).digest('hex');
    let hits = 0;
    let serveBad = false;
    const server = createServer((_req, res) => {
      hits++;
      res.end(serveBad ? Buffer.from('evil') : apk);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    const env = { IWER_NATIVE_CACHE_DIR: path.join(scratch, 'cache') };
    const pinned = {
      version: 't1',
      url: `http://127.0.0.1:${port}/t.apk`,
      sha256,
    };
    try {
      const a = await fetchPinnedTemplate(pinned, { env });
      assert.equal(a.source, 'download');
      const b = await fetchPinnedTemplate(pinned, { env });
      assert.equal(b.source, 'cache');
      assert.equal(hits, 1);
      writeFileSync(b.file, Buffer.concat([apk, Buffer.from('x')]));
      const c = await fetchPinnedTemplate(pinned, { env });
      assert.equal(c.source, 'download');
      assert.equal(hits, 2);
      serveBad = true;
      rmSync(c.file);
      await assert.rejects(
        fetchPinnedTemplate(pinned, { env }),
        /does not match its pinned checksum/,
      );
      assert.ok(!existsSync(c.file));
    } finally {
      server.close();
    }
  });
  test('no template anywhere explains what to do', async () => {
    await assert.rejects(
      resolveTemplate({ env: {}, root: scratchDir('noroot') }),
      /no template APK available/,
    );
  });
});

// Cross-checks with the Android SDK's own tools (CI only; skipped when the SDK is absent).
const bt = buildTools();
describe(
  'Android SDK cross-checks',
  { skip: bt ? false : 'no Android SDK build-tools found' },
  () => {
    const checkoutTemplate = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '..',
      'template',
      'out',
      'iwer-native-template.apk',
    );
    test('apksigner verifies v2+v3; aapt2 badging shows package and label; zipalign -c passes', async (t) => {
      const tpl = existsSync(checkoutTemplate)
        ? await resolveTemplate({ explicit: checkoutTemplate })
        : template;
      const r = await pack(
        input({
          template: tpl,
          target: target({ features: { handTracking: true } }),
        }),
      );
      const out = execFileSync(path.join(bt!, 'apksigner'), [
        'verify',
        '--verbose',
        '--min-sdk-version',
        '24',
        r.outFile,
      ]).toString();
      assert.match(
        out,
        /Verified using v2 scheme \(APK Signature Scheme v2\): true/,
      );
      assert.match(
        out,
        /Verified using v3 scheme \(APK Signature Scheme v3\): true/,
      );
      const keystore = path.join(FIXTURES, 'jdk8.jks');
      const rel = await pack(
        input({
          template: tpl,
          buildType: 'release',
          target: target({
            signing: {
              keystore,
              keyAlias: 'upload',
              storePasswordEnv: 'S',
              keyPasswordEnv: 'K',
            },
          }),
          env: { S: STORE_PASSWORD, K: 'iwn-test-key' },
          files: { icon: null, keystore },
        }),
      );
      const certs = execFileSync(path.join(bt!, 'apksigner'), [
        'verify',
        '--print-certs',
        rel.outFile,
      ]).toString();
      assert.match(certs, /CN=iwer-native test jks/);
      if (!existsSync(checkoutTemplate)) {
        t.diagnostic(
          'aapt2/zipalign checks need packager/template/out (node packager/template/build-template.mjs)',
        );
        return;
      }
      const badging = execFileSync(path.join(bt!, 'aapt2'), [
        'dump',
        'badging',
        r.outFile,
      ]).toString();
      assert.match(
        badging,
        /package: name='com\.example\.packtest' versionCode='1002003' versionName='1\.2\.3'/,
      );
      assert.match(badging, /application-label:'Pack Test'/);
      assert.match(badging, /application-debuggable/);
      assert.match(
        badging,
        /uses-permission: name='com\.oculus\.permission\.HAND_TRACKING'/,
      );
      assert.match(
        badging,
        /launchable-activity: name='android\.app\.NativeActivity'/,
      );
      const za = path.join(path.dirname(bt!), '35.0.0', 'zipalign');
      if (existsSync(za)) execFileSync(za, ['-c', '-P', '16', '4', r.outFile]);
      const relBadging = execFileSync(path.join(bt!, 'aapt2'), [
        'dump',
        'badging',
        rel.outFile,
      ]).toString();
      assert.doesNotMatch(relBadging, /application-debuggable/);
      assert.doesNotMatch(relBadging, /android\.permission\.INTERNET/);
    });
  },
);
