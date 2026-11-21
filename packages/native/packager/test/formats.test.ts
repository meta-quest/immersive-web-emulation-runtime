/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ANDROID_NS,
  axmlToText,
  childElements,
  attrString,
  decodeAxml,
  decodeCesu8,
  element,
  encodeAxml,
  findAttr,
} from '../src/axml.ts';
import { decode, int, oid, readInt, readOid, seq, time } from '../src/der.ts';
import {
  applyManifest,
  summarizeManifest,
  templateContractWarnings,
} from '../src/manifest.ts';
import {
  decodePng,
  encodePng,
  imageSize,
  placeholderIcon,
  resize,
} from '../src/png.ts';
import { rc2CbcDecrypt, rc2EncryptBlock, rc2Expand } from '../src/rc2.ts';
import {
  checkAlignment,
  entryData,
  METHOD_DEFLATE,
  METHOD_STORED,
  prepareEntry,
  readZip,
  writeZip,
} from '../src/zip.ts';
import { resolveNativeTarget } from '../../src/config/resolve.ts';
import { templateManifest } from './helpers.ts';

describe('zip', () => {
  test('round trip with alignment, UTF-8 names and both methods', async () => {
    const entries = [
      await prepareEntry(
        'a.txt',
        Buffer.from('hello hello hello hello hello'),
        { compress: true },
      ),
      await prepareEntry('lib/arm64-v8a/libx.so', Buffer.alloc(5000, 1), {
        compress: false,
        align: 16384,
      }),
      await prepareEntry('assets/app/ü.bin', Buffer.alloc(33, 2), {
        compress: false,
      }),
      await prepareEntry('random.dat', Buffer.from([1, 2, 3]), {
        compress: true,
      }),
    ];
    const z = writeZip(entries);
    const zip = readZip(Buffer.concat([z.entries, z.centralDirectory, z.eocd]));
    assert.deepEqual(
      zip.entries.map((e) => e.name),
      ['a.txt', 'lib/arm64-v8a/libx.so', 'assets/app/ü.bin', 'random.dat'],
    );
    assert.equal(zip.entries[0].method, METHOD_DEFLATE);
    assert.equal(
      zip.entries[3].method,
      METHOD_STORED,
      'incompressible data is stored',
    );
    assert.equal(zip.entries[1].dataOffset % 16384, 0);
    assert.equal(zip.entries[2].dataOffset % 4, 0);
    assert.deepEqual(checkAlignment(zip), []);
    assert.equal(
      entryData(zip, zip.entries[0]).toString(),
      'hello hello hello hello hello',
    );
    assert.deepEqual(entryData(zip, zip.entries[2]), Buffer.alloc(33, 2));
  });
  test('deterministic', async () => {
    const make = async () => {
      const z = writeZip([
        await prepareEntry('x', Buffer.from('abcabcabc'), { compress: true }),
      ]);
      return Buffer.concat([z.entries, z.centralDirectory, z.eocd]);
    };
    assert.deepEqual(await make(), await make());
  });
  test('rejects duplicates and non-zips', async () => {
    const e = await prepareEntry('x', Buffer.from('1'), { compress: false });
    assert.throws(() => writeZip([e, e]), /duplicate/);
    assert.throws(
      () => readZip(Buffer.from('not a zip at all, definitely not')),
      /not a ZIP/,
    );
  });
  test('corrupt data is caught by the CRC', async () => {
    const z = writeZip([
      await prepareEntry('x', Buffer.from('payload'), { compress: false }),
    ]);
    const buf = Buffer.concat([z.entries, z.centralDirectory, z.eocd]);
    const zip = readZip(buf);
    buf[zip.entries[0].dataOffset] ^= 0xff;
    assert.throws(() => entryData(zip, zip.entries[0]), /CRC/);
  });
});

describe('der', () => {
  test('integers, OIDs and times round trip', () => {
    const n = decode(
      seq(
        int(0),
        int(127),
        int(128),
        int(2n ** 70n),
        oid('1.2.840.113549.1.12.10.1.2'),
      ),
    );
    assert.deepEqual(
      n.children.slice(0, 4).map((c) => readInt(c)),
      [0n, 127n, 128n, 2n ** 70n],
    );
    assert.equal(readOid(n.children[4]), '1.2.840.113549.1.12.10.1.2');
    assert.equal(
      time(new Date(Date.UTC(2030, 0, 2, 3, 4, 5))).toString('latin1', 2),
      '300102030405Z',
    );
    assert.equal(
      time(new Date(Date.UTC(2056, 0, 2, 3, 4, 5))).toString('latin1', 2),
      '20560102030405Z',
    );
  });
});

describe('rc2 (RFC 2268 test vectors)', () => {
  const vectors: [string, number, string, string][] = [
    ['0000000000000000', 63, '0000000000000000', 'ebb773f993278eff'],
    ['ffffffffffffffff', 64, 'ffffffffffffffff', '278b27e42e2f0d49'],
    ['3000000000000000', 64, '1000000000000001', '30649edf9be7d2c2'],
    ['88', 64, '0000000000000000', '61a8a244adacccf0'],
    ['88bca90e90875a', 64, '0000000000000000', '6ccf4308974c267f'],
    [
      '88bca90e90875a7f0f79c384627bafb2',
      128,
      '0000000000000000',
      '2269552ab0f85ca6',
    ],
  ];
  for (const [key, bits, plain, cipher] of vectors) {
    test(`key ${key} bits ${bits}`, () => {
      const K = rc2Expand(Buffer.from(key, 'hex'), bits);
      assert.equal(
        rc2EncryptBlock(K, Buffer.from(plain, 'hex')).toString('hex'),
        cipher,
      );
    });
  }
  test('CBC decrypt rejects bad padding', () => {
    assert.throws(
      () =>
        rc2CbcDecrypt(
          Buffer.alloc(5, 1),
          40,
          Buffer.alloc(8),
          Buffer.alloc(8, 9),
        ),
      /padding/,
    );
  });
});

describe('binary XML', () => {
  test('decodes aapt2 output', () => {
    const doc = decodeAxml(templateManifest());
    assert.equal(doc.root.name, 'manifest');
    assert.equal(findAttr(doc.root, 'package', null)?.value.type, 'string');
    const text = axmlToText(doc);
    assert.match(text, /package="org\.iwer\.nativetemplate"/);
    assert.match(text, /android:name="android\.app\.NativeActivity"/);
    assert.match(text, /com\.oculus\.intent\.category\.VR/);
  });
  test('encode/decode is lossless', () => {
    const doc = decodeAxml(templateManifest());
    const again = decodeAxml(encodeAxml(doc));
    assert.equal(axmlToText(again), axmlToText(doc));
    // and stable: encoding the re-decoded tree gives the same bytes
    assert.deepEqual(encodeAxml(again), encodeAxml(doc));
  });
  test('new android attributes get framework resource IDs', () => {
    const el = element('uses-permission', {
      name: { type: 'string', value: 'x' },
    });
    assert.equal(el.attributes[0].resId, 0x01010003);
    assert.equal(el.attributes[0].ns, ANDROID_NS);
  });
  test('UTF-8 pools: CESU-8 surrogate pairs (aapt2) and 4-byte UTF-8 both decode', () => {
    const text = 'π 🎉 日本語';
    const cesu = Buffer.concat([
      Buffer.from('π ', 'utf8'),
      Buffer.from([0xed, 0xa0, 0xbc, 0xed, 0xbe, 0x89]), // U+D83C U+DF89
      Buffer.from(' 日本語', 'utf8'),
    ]);
    assert.equal(decodeCesu8(cesu, 0, cesu.length), text);
    const utf8 = Buffer.from(text, 'utf8');
    assert.equal(decodeCesu8(utf8, 0, utf8.length), text);
  });
});

describe('manifest rewrite (PKG-8)', () => {
  const target = (native: Record<string, unknown>, world?: unknown) =>
    resolveNativeTarget(
      { version: 'iwsdk.project.v1', ...(world ? { world } : {}), native },
      {
        packageJson: { name: 'my-app', version: '2.3.4' },
      },
    );
  const rewrite = (
    t: ReturnType<typeof target>,
    debuggable: boolean,
    servesInspector = debuggable,
  ) => {
    const doc = decodeAxml(templateManifest());
    applyManifest(doc, { target: t, debuggable, servesInspector });
    return { doc, summary: summarizeManifest(decodeAxml(encodeAxml(doc))) };
  };
  test('identity, version, label, debuggable', () => {
    const { summary } = rewrite(
      target({ packageId: 'com.example.app', appName: 'My App' }),
      true,
    );
    assert.equal(summary.packageId, 'com.example.app');
    assert.equal(summary.label, 'My App');
    assert.equal(summary.versionName, '2.3.4');
    assert.equal(summary.versionCode, 2003004);
    assert.equal(summary.debuggable, true);
    assert.equal(summary.launcherActivity, 'android.app.NativeActivity');
    assert.equal(summary.minSdk, 29);
  });
  test('INTERNET: debug build with empty allowlist has it, plain release does not', () => {
    const t = target({ packageId: 'com.example.app' });
    assert.ok(
      rewrite(t, true).summary.permissions.includes(
        'android.permission.INTERNET',
      ),
    );
    assert.ok(
      !rewrite(t, false).summary.permissions.includes(
        'android.permission.INTERNET',
      ),
    );
    assert.ok(
      rewrite(t, false, true).summary.permissions.includes(
        'android.permission.INTERNET',
      ),
      'release + inspector',
    );
    const net = target({
      packageId: 'com.example.app',
      network: { allow: ['https://cdn.example.org'] },
    });
    assert.ok(
      rewrite(net, false).summary.permissions.includes(
        'android.permission.INTERNET',
      ),
    );
  });
  test('features and permissions from the config; template entries kept', () => {
    const t = target({
      packageId: 'com.example.app',
      features: { handTracking: 'required', planeDetection: true },
    });
    const { summary, doc } = rewrite(t, false);
    assert.deepEqual(summary.permissions, [
      'com.oculus.permission.HAND_TRACKING',
      'com.oculus.permission.USE_ANCHOR_API',
      'com.oculus.permission.USE_SCENE',
      'org.khronos.openxr.permission.OPENXR',
      'org.khronos.openxr.permission.OPENXR_SYSTEM',
    ]);
    assert.deepEqual(
      summary.features.find((f) => f.name === 'oculus.software.handtracking'),
      { name: 'oculus.software.handtracking', required: true },
    );
    assert.deepEqual(
      summary.features.find(
        (f) => f.name === 'android.hardware.vr.headtracking',
      ),
      {
        name: 'android.hardware.vr.headtracking',
        required: true,
      },
    );
    assert.equal(childElements(doc.root, 'queries').length, 1);
    assert.equal(summary.debuggable, false);
  });
  test('relative class names are qualified with the template package; alias labels follow', () => {
    const doc = decodeAxml(templateManifest());
    const app = childElements(doc.root, 'application')[0];
    app.children.push(
      element('activity', {
        name: { type: 'string', value: '.MainActivity' },
      }),
      element('service', { name: { type: 'string', value: 'Helper' } }),
      element('activity-alias', {
        name: { type: 'string', value: '.Alias' },
        targetActivity: { type: 'string', value: '.MainActivity' },
        label: { type: 'string', value: 'Alias label' },
      }),
    );
    applyManifest(doc, {
      target: target({ packageId: 'com.example.app', appName: 'My App' }),
      debuggable: false,
      servesInspector: false,
    });
    const again = decodeAxml(encodeAxml(doc));
    const a2 = childElements(again.root, 'application')[0];
    const names = [
      ...childElements(a2, 'activity'),
      ...childElements(a2, 'service'),
      ...childElements(a2, 'activity-alias'),
    ].map((e) => attrString(e, 'name'));
    assert.deepEqual(names, [
      'android.app.NativeActivity',
      'org.iwer.nativetemplate.MainActivity',
      'org.iwer.nativetemplate.Helper',
      'org.iwer.nativetemplate.Alias',
    ]);
    const alias = childElements(a2, 'activity-alias')[0];
    assert.equal(
      attrString(alias, 'targetActivity'),
      'org.iwer.nativetemplate.MainActivity',
    );
    assert.equal(attrString(alias, 'label'), 'My App');
  });
  test('template contract: VR category, head tracking and OpenXR permission checked', () => {
    assert.deepEqual(
      templateContractWarnings(decodeAxml(templateManifest())),
      [],
    );
    const doc = decodeAxml(templateManifest());
    doc.root.children = doc.root.children.filter(
      (c) =>
        !(
          c.kind === 'element' &&
          (c.name === 'uses-feature' || c.name === 'uses-permission')
        ),
    );
    const strip = (el: (typeof doc)['root']) => {
      for (const c of el.children)
        if (c.kind === 'element') {
          c.children = c.children.filter(
            (x) =>
              !(
                x.kind === 'element' &&
                x.name === 'category' &&
                attrString(x, 'name') === 'com.oculus.intent.category.VR'
              ),
          );
          strip(c);
        }
    };
    strip(doc.root);
    const w = templateContractWarnings(doc).join('\n');
    assert.match(w, /com\.oculus\.intent\.category\.VR/);
    assert.match(w, /android\.hardware\.vr\.headtracking/);
    assert.match(w, /org\.khronos\.openxr\.permission\.OPENXR/);
  });
  test('features default from world.xr (hand tracking optional)', () => {
    const t = target(
      { packageId: 'com.example.app' },
      { xr: { features: { handTracking: true } } },
    );
    const { summary } = rewrite(t, false);
    assert.deepEqual(
      summary.features.find((f) => f.name === 'oculus.software.handtracking'),
      {
        name: 'oculus.software.handtracking',
        required: false,
      },
    );
  });
});

describe('png', () => {
  test('encode/decode/resize', () => {
    const icon = placeholderIcon(64);
    const back = decodePng(encodePng(icon));
    assert.equal(back.width, 64);
    assert.deepEqual(Buffer.from(back.data), Buffer.from(icon.data));
    const small = resize(icon, 16, 16);
    assert.equal(small.data.length, 16 * 16 * 4);
    assert.ok(small.data[3] < 64, 'rounded corner stays mostly transparent');
    assert.equal(small.data[(8 * 16 + 8) * 4 + 3], 255, 'centre opaque');
    const big = resize(icon, 100, 100);
    assert.equal(big.width, 100);
    assert.deepEqual(imageSize(encodePng(small)), { width: 16, height: 16 });
  });
});
