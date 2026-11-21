/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  assertValidNativeTargetConfig,
  NativeConfigError,
  suggest,
  validateIwsdkConfigNativeSection,
  validateNativeTargetConfig,
} from '../src/config/validate.ts';

const FULL = {
  packageId: 'com.yourcompany.showcase',
  appName: 'Proto Showcase VR',
  version: '1.2.3',
  versionCode: 1002003,
  icon: './public/icon.png',
  frameRate: 90,
  foveation: { level: 'medium', dynamic: true },
  features: {
    handTracking: 'required',
    planeDetection: true,
    gazeTracking: { required: false },
  },
  permissions: ['android.permission.RECORD_AUDIO'],
  network: {
    allow: ['https://cdn.jsdelivr.net', 'https://*.example.org:8443'],
  },
  signing: {
    keystore: '../keys/release.jks',
    keyAlias: 'upload',
    storePasswordEnv: 'IWER_NATIVE_STORE_PASSWORD',
    keyPasswordEnv: 'IWER_NATIVE_KEY_PASSWORD',
  },
};

function errorsOf(section: unknown) {
  return validateNativeTargetConfig(section).errors;
}
function only(section: unknown) {
  const errors = errorsOf(section);
  assert.equal(
    errors.length,
    1,
    `expected one error, got ${JSON.stringify(errors, null, 2)}`,
  );
  return errors[0];
}
const withKey = (key: string, value: unknown) => ({
  packageId: 'com.a.b',
  [key]: value,
});

describe('validateNativeTargetConfig', () => {
  test('accepts a full config with no warnings', () => {
    const result = validateNativeTargetConfig(FULL);
    assert.deepEqual(result, { valid: true, errors: [], warnings: [] });
  });

  test('accepts the minimal config', () => {
    assert.equal(
      validateNativeTargetConfig({ packageId: 'com.a.b' }).valid,
      true,
    );
  });

  test('rejects non-objects', () => {
    for (const value of [null, [], 'com.a.b', 3]) {
      assert.equal(only(value).code, 'type');
    }
  });

  test('requires packageId', () => {
    const e = only({});
    assert.equal(e.path, '$.native.packageId');
    assert.equal(e.code, 'required');
  });

  test('unknown keys get a did-you-mean', () => {
    const e = only({ packageId: 'com.a.b', framerate: 72 });
    assert.equal(e.code, 'unknown-key');
    assert.equal(e.path, '$.native.framerate');
    assert.match(e.message, /did you mean "frameRate"/);
  });

  test('collects every error, not just the first', () => {
    const errors = errorsOf({
      packageId: 'x',
      versionCode: 0,
      frameRate: 75,
      foveation: 'max',
    });
    assert.deepEqual(
      errors.map((e) => e.path),
      [
        '$.native.packageId',
        '$.native.versionCode',
        '$.native.frameRate',
        '$.native.foveation',
      ],
    );
  });

  describe('packageId', () => {
    const cases: Array<[unknown, RegExp]> = [
      [42, /must be a string/],
      ['showcase', /at least two dot-separated segments/],
      ['com.my-company.app', /contains "-".*"com\.my_company\.app"/],
      ['com..app', /empty segment/],
      ['com.app.', /empty segment/],
      ['com.1app', /segment "1app".*start with a letter/],
      ['com.new.app', /"new".*Java keyword/],
      ['com.app$', /only letters, digits and "_"/],
    ];
    for (const [value, message] of cases) {
      test(`rejects ${JSON.stringify(value)}`, () => {
        assert.match(only({ packageId: value }).message, message);
      });
    }
    test('warns about com.example', () => {
      const result = validateNativeTargetConfig({
        packageId: 'com.example.app',
      });
      assert.equal(result.valid, true);
      assert.match(result.warnings[0].message, /stores reject/);
    });
  });

  test('appName', () => {
    assert.match(only(withKey('appName', '  ')).message, /must not be empty/);
    assert.match(
      only(withKey('appName', 'a\nb')).message,
      /control characters/,
    );
    assert.equal(only(withKey('appName', 5)).code, 'type');
    assert.equal(
      validateNativeTargetConfig(withKey('appName', 'x'.repeat(60))).warnings
        .length,
      1,
    );
  });

  test('version and versionCode', () => {
    assert.equal(only(withKey('version', 1.2)).code, 'type');
    assert.equal(only(withKey('version', '')).code, 'required');
    assert.equal(only(withKey('versionCode', 1.5)).code, 'type');
    assert.equal(only(withKey('versionCode', '3')).code, 'type');
    assert.equal(only(withKey('versionCode', 0)).code, 'range');
    assert.equal(only(withKey('versionCode', 2_100_000_001)).code, 'range');
    assert.equal(errorsOf(withKey('versionCode', 2_100_000_000)).length, 0);
  });

  test('icon must be a png/webp inside the project', () => {
    assert.equal(errorsOf(withKey('icon', 'public/icon.webp')).length, 0);
    assert.match(
      only(withKey('icon', '/abs/icon.png')).message,
      /inside the project/,
    );
    assert.match(
      only(withKey('icon', 'C:\\icons\\icon.png')).message,
      /inside the project/,
    );
    assert.match(
      only(withKey('icon', 'https://x.org/icon.png')).message,
      /inside the project/,
    );
    assert.match(
      only(withKey('icon', './public/../../icon.png')).message,
      /outside the project/,
    );
    assert.match(
      only(withKey('icon', './icon.svg')).message,
      /\.png or \.webp/,
    );
  });

  test('splash: true, false, or { image, background }', () => {
    for (const ok of [
      true,
      false,
      {},
      { image: './public/splash.png' },
      { image: 'art/Splash.PNG', background: '#0b0c0e' },
      { background: '#abc' },
      { background: 'contextual' },
      { background: 'black' },
    ])
      assert.equal(errorsOf(withKey('splash', ok)).length, 0, JSON.stringify(ok));
    assert.equal(only(withKey('splash', 'yes')).code, 'type');
    assert.equal(only(withKey('splash', null)).code, 'type');
    // The image: a PNG inside the project (Horizon OS reads vr_splash.png).
    assert.match(
      only(withKey('splash', { image: './splash.jpg' })).message,
      /must be a PNG image/,
    );
    assert.match(
      only(withKey('splash', { image: '/abs/splash.png' })).message,
      /inside the project, like "\.\/public\/splash\.png"/,
    );
    assert.equal(only(withKey('splash', { image: 3 })).code, 'type');
    // The background: "black", "contextual", #rgb or #rrggbb.
    assert.match(
      only(withKey('splash', { background: 'purple' })).message,
      /"purple" is not "black", "contextual" or a colour \("#rrggbb" or "#rgb"/,
    );
    assert.match(
      only(withKey('splash', { background: 'contextul' })).message,
      /\(did you mean "contextual"\?\)/,
    );
    assert.equal(only(withKey('splash', { background: '#00000' })).code, 'format');
    assert.equal(only(withKey('splash', { background: 0 })).code, 'type');
    // Unknown keys get a did-you-mean.
    const e = only(withKey('splash', { imge: 'a.png' }));
    assert.equal(e.code, 'unknown-key');
    assert.equal(e.path, '$.native.splash.imge');
    assert.match(e.message, /did you mean "image"/);
  });

  test('frameRate', () => {
    assert.match(
      only(withKey('frameRate', 75)).message,
      /75 Hz is not a headset refresh rate/,
    );
    assert.equal(only(withKey('frameRate', '90')).code, 'type');
  });

  test('foveation accepts a level or an object', () => {
    assert.equal(errorsOf(withKey('foveation', 'high')).length, 0);
    assert.equal(errorsOf(withKey('foveation', { dynamic: true })).length, 0);
    assert.match(
      only(withKey('foveation', 'hgh')).message,
      /did you mean "high"/,
    );
    assert.equal(
      only(withKey('foveation', { level: 'low', dynamic: 'yes' })).path,
      '$.native.foveation.dynamic',
    );
    assert.equal(
      only(withKey('foveation', { lvl: 'low' })).code,
      'unknown-key',
    );
    assert.equal(
      validateNativeTargetConfig(
        withKey('foveation', { level: 'none', dynamic: true }),
      ).warnings.length,
      1,
    );
  });

  test('features', () => {
    assert.match(
      only(withKey('features', { handtracking: true })).message,
      /did you mean "handTracking"/,
    );
    assert.match(
      only(withKey('features', { handTracking: 'requird' })).message,
      /did you mean "required"/,
    );
    assert.equal(
      only(withKey('features', { anchors: { required: 'yes' } })).path,
      '$.native.features.anchors.required',
    );
    assert.equal(only(withKey('features', { anchors: 1 })).code, 'type');
    assert.equal(only(withKey('features', ['handTracking'])).code, 'type');
  });

  test('permissions', () => {
    assert.match(
      only(withKey('permissions', ['RECORD_AUDIO'])).message,
      /did you mean "android\.permission\.RECORD_AUDIO"/,
    );
    assert.equal(
      only(withKey('permissions', 'android.permission.X')).code,
      'type',
    );
    assert.equal(only(withKey('permissions', [7])).code, 'type');
    const dup = validateNativeTargetConfig(
      withKey('permissions', ['a.b.C', 'a.b.C']),
    );
    assert.equal(dup.valid, true);
    assert.equal(dup.warnings.length, 1);
  });

  describe('network.allow', () => {
    const net = (allow: unknown) => withKey('network', { allow });
    test('accepts origins, ports and leading wildcards', () => {
      assert.equal(
        errorsOf(
          net([
            'https://a.org',
            'https://a.org/',
            'https://a.org:444',
            'https://*.b.org',
          ]),
        ).length,
        0,
      );
    });
    const bad: Array<[string, RegExp]> = [
      ['*', /catch-all/],
      ['https://*', /catch-all/],
      ['cdn.example.com', /not a valid origin/],
      [
        'https://cdn.example.com/models/',
        /without a path; use "https:\/\/cdn\.example\.com"/,
      ],
      ['https://a.org?x=1', /without a path/],
      ['https://*.b.org/x', /use "https:\/\/\*\.b\.org"/],
      ['https://a*.org', /only allowed as the whole first label/],
      ['https://user:pw@a.org', /credentials/],
      ['http://a.org', /cleartext/],
      ['ftp://a.org', /only https/],
    ];
    for (const [origin, message] of bad) {
      test(`rejects ${origin}`, () =>
        assert.match(only(net([origin])).message, message));
    }
    test('allows cleartext localhost with a warning', () => {
      const result = validateNativeTargetConfig(net(['http://localhost:5173']));
      assert.equal(result.valid, true);
      assert.equal(result.warnings.length, 1);
    });
    test('type errors', () => {
      assert.equal(only(net('https://a.org')).code, 'type');
      assert.equal(only(net([1])).code, 'type');
      assert.equal(
        only(withKey('network', { allowlist: [] })).code,
        'unknown-key',
      );
    });
  });

  describe('signing', () => {
    const sign = (signing: unknown) => withKey('signing', signing);
    const base = { keystore: 'keys/release.p12', storePasswordEnv: 'STORE_PW' };

    test('requires keystore and storePasswordEnv', () => {
      assert.deepEqual(
        errorsOf(sign({})).map((e) => e.path),
        ['$.native.signing.keystore', '$.native.signing.storePasswordEnv'],
      );
    });

    test('rejects a password in the config without echoing it', () => {
      const secret = 'hunter2-very-secret';
      const errors = errorsOf(
        sign({ ...base, storePassword: secret, keyPass: secret }),
      );
      assert.deepEqual(
        errors.map((e) => [e.path, e.code]),
        [
          ['$.native.signing.storePassword', 'secret'],
          ['$.native.signing.keyPass', 'secret'],
        ],
      );
      for (const e of errors) assert.ok(!e.message.includes(secret));
    });

    test('rejects secrets at the top level too', () => {
      const e = only({ packageId: 'com.a.b', keystorePassword: 'x' });
      assert.equal(e.code, 'secret');
    });

    test('an env field holding a password is flagged without echoing it', () => {
      const secret = 'p@ss w0rd!';
      const e = only(sign({ ...base, storePasswordEnv: secret }));
      assert.equal(e.code, 'secret');
      assert.match(e.message, /NAME of an environment variable/);
      assert.ok(!e.message.includes(secret));
    });

    test('keystore under a shipped folder is an error', () => {
      for (const keystore of [
        'public/release.jks',
        './dist/release.jks',
        'dist-metavr/k.jks',
      ]) {
        assert.equal(
          only(sign({ ...base, keystore })).code,
          'invalid-path',
          keystore,
        );
      }
    });

    test('warnings: odd extension, lower-case env name', () => {
      const result = validateNativeTargetConfig(
        sign({ keystore: 'k.bin', storePasswordEnv: 'store_pw' }),
      );
      assert.equal(result.valid, true);
      assert.equal(result.warnings.length, 2);
    });

    test('keyAlias', () => {
      assert.equal(only(sign({ ...base, keyAlias: '' })).code, 'required');
      assert.equal(only(sign({ ...base, keyAlias: 1 })).code, 'type');
    });

    test('unknown signing key', () => {
      assert.match(
        only(sign({ ...base, alias: 'x' })).message,
        /unknown key "alias"/,
      );
    });
  });
});

describe('validateIwsdkConfigNativeSection', () => {
  test('splash.background "contextual" needs passthrough declared', () => {
    // Only an app with passthrough can show the room behind its loading screen (XR_FB_passthrough needs
    // com.oculus.feature.PASSTHROUGH): "contextual" without it would put the system splash on the room and the
    // loading screen on black.
    const doc = (native: Record<string, unknown>, mode?: string) => ({
      version: 'iwsdk.project.v1',
      ...(mode ? { world: { xr: { mode } } } : {}),
      native: { packageId: 'com.a.b', splash: { background: 'contextual' }, ...native },
    });
    const vr = validateIwsdkConfigNativeSection(doc({}, 'vr'));
    assert.equal(vr.errors.length, 1, JSON.stringify(vr.errors));
    assert.equal(vr.errors[0].path, '$.native.splash.background');
    assert.equal(vr.errors[0].code, 'conflict');
    assert.match(vr.errors[0].message, /needs passthrough: add "passthrough": "optional" to "features"/);
    assert.equal(validateIwsdkConfigNativeSection(doc({})).errors[0]?.code, 'conflict');
    assert.equal(
      validateIwsdkConfigNativeSection(doc({ features: { handTracking: true } }, 'ar')).errors[0]?.code,
      'conflict', // native.features replaces world's: no passthrough declared
    );
    assert.equal(
      validateIwsdkConfigNativeSection(doc({ features: { passthrough: false } })).errors[0]?.code,
      'conflict',
    );
    // Declared: in native.features (any requirement), or by world.xr.mode "ar" without native.features.
    for (const ok of [
      doc({ features: { passthrough: 'optional' } }),
      doc({ features: { passthrough: true } }, 'vr'),
      doc({ features: { passthrough: { required: false } } }),
      doc({}, 'ar'),
    ])
      assert.equal(validateIwsdkConfigNativeSection(ok).valid, true, JSON.stringify(ok));
    // The native section alone, without features: nothing to check against (the world is unknown).
    assert.equal(errorsOf({ packageId: 'com.a.b', splash: { background: 'contextual' } }).length, 0);
    assert.equal(
      errorsOf({ packageId: 'com.a.b', splash: { background: 'contextual' }, features: {} })[0]?.code,
      'conflict',
    );
  });
  test('explains a missing section', () => {
    const { errors } = validateIwsdkConfigNativeSection({
      version: 'iwsdk.project.v1',
    });
    assert.equal(errors[0].path, '$.native');
    assert.match(errors[0].message, /"packageId": "com\.yourcompany\.yourapp"/);
  });
  test('rejects a non-object document', () => {
    assert.equal(validateIwsdkConfigNativeSection([]).errors[0].code, 'type');
  });
  test('validates the section', () => {
    assert.equal(
      validateIwsdkConfigNativeSection({ native: FULL }).valid,
      true,
    );
  });
});

describe('assertValidNativeTargetConfig', () => {
  test('throws one error listing every issue', () => {
    assert.throws(
      () => assertValidNativeTargetConfig({ packageId: 'x', frameRate: 1 }),
      (error: unknown) =>
        error instanceof NativeConfigError &&
        error.issues.length === 2 &&
        /\$\.native\.packageId: .*\n.*\$\.native\.frameRate/.test(
          error.message,
        ),
    );
  });
});

test('suggest', () => {
  assert.equal(
    suggest('packageid', ['packageId']),
    ' (did you mean "packageId"?)',
  );
  assert.equal(suggest('zzzzzz', ['packageId']), '');
});
