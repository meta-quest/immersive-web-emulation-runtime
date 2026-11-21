/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DEFAULT_SPLASH_BACKGROUND,
  defaultSplashBackground,
  deriveVersionCode,
  featuresFromWorld,
  resolveNativeTarget,
  withFeature,
} from '../src/config/resolve.ts';
import { NativeConfigError } from '../src/config/validate.ts';

describe('resolveNativeTarget', () => {
  test('fills defaults from package.json', () => {
    const t = resolveNativeTarget(
      { native: { packageId: 'com.a.showcase' } },
      { packageJson: { name: '@scope/proto-showcase-vr', version: '2.3.4' } },
    );
    assert.equal(t.appName, 'proto-showcase-vr');
    assert.equal(t.version, '2.3.4');
    assert.equal(t.versionCode, 2_003_004);
    assert.deepEqual(t.signing, { mode: 'debug' });
    assert.deepEqual(t.foveation, { level: 'none', dynamic: false });
    assert.equal(t.frameRate, null);
    assert.equal(t.icon, null);
    assert.deepEqual(t.permissions, []);
  });

  test('falls back without package.json', () => {
    const t = resolveNativeTarget({ native: { packageId: 'com.a.showcase' } });
    assert.equal(t.appName, 'showcase');
    assert.equal(t.version, '1.0.0');
    assert.equal(t.versionCode, 1_000_000);
  });

  test('derives features from world.xr and AR mode', () => {
    const t = resolveNativeTarget({
      world: {
        xr: {
          mode: 'ar',
          features: {
            handTracking: { required: true },
            planeDetection: true,
            layers: true,
            eyeTracking: false,
          },
        },
      },
      native: {
        packageId: 'com.a.b',
        network: { allow: ['https://a.org', 'https://a.org'] },
      },
    });
    assert.deepEqual(t.features, {
      handTracking: 'required',
      planeDetection: 'optional',
      passthrough: 'required',
    });
    assert.deepEqual(t.permissions, [
      'android.permission.INTERNET',
      'com.oculus.permission.HAND_TRACKING',
      'com.oculus.permission.USE_ANCHOR_API',
      'com.oculus.permission.USE_SCENE',
    ]);
    assert.deepEqual(t.usesFeatures, [
      { name: 'com.oculus.feature.PASSTHROUGH', required: true },
      { name: 'oculus.software.handtracking', required: true },
    ]);
    assert.deepEqual(t.network.allow, ['https://a.org']);
  });

  test('explicit features replace the derived ones', () => {
    const t = resolveNativeTarget({
      world: { xr: { mode: 'vr', features: { handTracking: true } } },
      native: {
        packageId: 'com.a.b',
        features: {
          gazeTracking: 'optional',
          handTracking: false,
          meshDetection: { required: true },
        },
      },
    });
    assert.deepEqual(t.features, {
      gazeTracking: 'optional',
      meshDetection: 'required',
    });
    assert.deepEqual(t.usesFeatures, [
      { name: 'oculus.software.eye_tracking', required: false },
    ]);
  });

  test("IWSDK's world.features.camera declares the camera (XR-CAM-1)", () => {
    const t = resolveNativeTarget({
      world: { xr: { mode: 'vr' }, features: { camera: true, grabbing: true } },
      native: { packageId: 'com.a.b' },
    });
    assert.deepEqual(t.features, { camera: 'optional' });
    assert.deepEqual(t.permissions, [
      'android.permission.CAMERA',
      'horizonos.permission.HEADSET_CAMERA',
    ]);
    assert.deepEqual(t.usesFeatures, [
      { name: 'android.hardware.camera', required: false },
      { name: 'com.oculus.feature.PASSTHROUGH', required: false },
    ]);
    for (const camera of [false, null, undefined]) {
      const off = resolveNativeTarget({
        world: { features: { camera } },
        native: { packageId: 'com.a.b' },
      });
      assert.equal(off.features.camera, undefined);
      assert.deepEqual(off.permissions, []);
    }
    const required = resolveNativeTarget({
      native: { packageId: 'com.a.b', features: { camera: 'required' } },
    });
    assert.deepEqual(required.usesFeatures, [
      { name: 'android.hardware.camera', required: true },
      { name: 'com.oculus.feature.PASSTHROUGH', required: true },
    ]);
  });

  test('a uses-feature is required if any feature needing it is', () => {
    const t = resolveNativeTarget({
      native: {
        packageId: 'com.a.b',
        features: { planeDetection: 'optional', meshDetection: 'required' },
      },
    });
    assert.deepEqual(t.permissions, [
      'com.oculus.permission.USE_ANCHOR_API',
      'com.oculus.permission.USE_SCENE',
    ]);
  });

  test('scene features declare USE_ANCHOR_API as well as USE_SCENE', () => {
    // Quest offers the scene extensions only with USE_ANCHOR_API in the
    // manifest, so a scene app without anchors still needs it.
    for (const name of ['planeDetection', 'meshDetection', 'hitTest']) {
      const t = resolveNativeTarget({
        native: { packageId: 'com.a.b', features: { [name]: 'required' } },
      });
      assert.deepEqual(
        t.permissions,
        [
          'com.oculus.permission.USE_ANCHOR_API',
          'com.oculus.permission.USE_SCENE',
        ],
        name,
      );
    }
  });

  test('release signing defaults keyPasswordEnv to storePasswordEnv', () => {
    const t = resolveNativeTarget({
      native: {
        packageId: 'com.a.b',
        signing: { keystore: 'k.jks', storePasswordEnv: 'PW' },
      },
    });
    assert.deepEqual(t.signing, {
      mode: 'release',
      keystore: 'k.jks',
      keyAlias: null,
      storePasswordEnv: 'PW',
      keyPasswordEnv: 'PW',
    });
  });

  test('foveation shorthand', () => {
    const t = resolveNativeTarget({
      native: { packageId: 'com.a.b', foveation: 'high' },
    });
    assert.deepEqual(t.foveation, { level: 'high', dynamic: false });
  });

  test('the launch splash is on by default, generated, on black (contextual with passthrough)', () => {
    const splash = (
      value?: unknown,
      extra: Record<string, unknown> = {},
      world?: unknown,
    ) =>
      resolveNativeTarget({
        ...(world ? { world } : {}),
        native: {
          packageId: 'com.a.b',
          ...(value === undefined ? {} : { splash: value }),
          ...extra,
        },
      }).splash;
    // Black by default: an app without passthrough cannot show the room behind its loading screen.
    const generated = { enabled: true, image: null, background: 'black' };
    assert.deepEqual(splash(), generated);
    assert.deepEqual(splash(true), generated);
    assert.deepEqual(splash({}), generated);
    assert.deepEqual(splash(undefined, {}, { xr: { mode: 'vr' } }), generated);
    assert.equal(DEFAULT_SPLASH_BACKGROUND, 'black');
    // false drops the image and the spinner; the background stays behind nothing.
    assert.deepEqual(splash(false), {
      enabled: false,
      image: null,
      background: 'black',
    });
    assert.deepEqual(
      splash({ image: './public/splash.png', background: '#0B0C0E' }),
      { enabled: true, image: './public/splash.png', background: '#0b0c0e' },
    );
    assert.equal(splash({ background: '#AbC' }).background, '#aabbcc');
    assert.equal(splash({ background: 'black' }).background, 'black');
    // An app that declares passthrough (or an AR world, which implies it): contextual by default.
    const pt = { features: { passthrough: 'optional' } };
    assert.equal(splash(undefined, pt).background, 'contextual');
    assert.equal(splash(false, pt).background, 'contextual');
    assert.equal(
      splash(undefined, {}, { xr: { mode: 'ar' } }).background,
      'contextual',
    );
    assert.equal(
      splash({ background: 'contextual' }, pt).background,
      'contextual',
    );
    assert.equal(splash({ background: 'black' }, pt).background, 'black');
    assert.equal(
      defaultSplashBackground({ passthrough: 'required' }),
      'contextual',
    );
    assert.equal(
      defaultSplashBackground({ handTracking: 'optional' }),
      'black',
    );
    // "contextual" without passthrough is refused (validateIwsdkConfigNativeSection).
    assert.throws(
      () => splash({ background: 'contextual' }),
      NativeConfigError,
    );
  });

  test('throws NativeConfigError for invalid input', () => {
    assert.throws(
      () => resolveNativeTarget({ native: { packageId: 'bad' } }),
      NativeConfigError,
    );
    assert.throws(() => resolveNativeTarget({}), NativeConfigError);
  });

  test('throws when versionCode cannot be derived', () => {
    assert.throws(
      () =>
        resolveNativeTarget({
          native: { packageId: 'com.a.b', version: 'beta' },
        }),
      /cannot derive a versionCode from version "beta".*set "versionCode"/,
    );
    const t = resolveNativeTarget({
      native: { packageId: 'com.a.b', version: 'beta', versionCode: 7 },
    });
    assert.equal(t.versionCode, 7);
  });
});

describe('deriveVersionCode', () => {
  test('orders releases', () => {
    assert.equal(deriveVersionCode('0.0.0'), 1);
    assert.equal(deriveVersionCode('0.1.0'), 1_000);
    assert.equal(deriveVersionCode('v1.2.3-rc.1'), 1_002_003);
    assert.ok(deriveVersionCode('1.10.0') > deriveVersionCode('1.9.999'));
  });
  test('rejects what does not fit', () => {
    assert.throws(() => deriveVersionCode('1.1000.0'), /below 1000/);
    assert.throws(() => deriveVersionCode('2101.0.0'), /exceeds/);
    assert.throws(() => deriveVersionCode('1.2'), /major\.minor\.patch/);
  });
});

test('featuresFromWorld tolerates missing parts', () => {
  assert.deepEqual(featuresFromWorld(undefined), {});
  assert.deepEqual(featuresFromWorld({ xr: { mode: 'vr' } }), {});
});

test('camera: world.features.camera derives it (optional), native.features.camera declares it', () => {
  assert.deepEqual(featuresFromWorld({ features: { camera: true } }), {
    camera: 'optional',
  });
  assert.deepEqual(
    featuresFromWorld({ features: { camera: { facing: 'back' } } }),
    { camera: 'optional' },
  );
  assert.deepEqual(featuresFromWorld({ features: { camera: false } }), {});
  const t = resolveNativeTarget({
    native: { packageId: 'com.a.b', features: { camera: 'required' } },
  });
  assert.deepEqual(t.permissions, [
    'android.permission.CAMERA',
    'horizonos.permission.HEADSET_CAMERA',
  ]);
  assert.deepEqual(t.usesFeatures, [
    { name: 'android.hardware.camera', required: true },
    { name: 'com.oculus.feature.PASSTHROUGH', required: true },
  ]);
  assert.equal(t.featuresDerived, false);
  assert.equal(
    resolveNativeTarget({ native: { packageId: 'com.a.b' } }).featuresDerived,
    true,
  );
});

test('withFeature adds a feature with its manifest entries and keeps the rest', () => {
  const t = resolveNativeTarget({
    world: { xr: { mode: 'ar', features: { handTracking: true } } },
    native: {
      packageId: 'com.a.b',
      permissions: ['android.permission.RECORD_AUDIO'],
      network: { allow: ['https://a.org'] },
    },
  });
  const c = withFeature(t, 'camera', 'optional');
  assert.deepEqual(c.features, {
    handTracking: 'optional',
    passthrough: 'required',
    camera: 'optional',
  });
  assert.deepEqual(c.permissions, [
    'android.permission.CAMERA',
    'android.permission.INTERNET',
    'android.permission.RECORD_AUDIO',
    'com.oculus.permission.HAND_TRACKING',
    'horizonos.permission.HEADSET_CAMERA',
  ]);
  // passthrough already made the uses-feature required; the optional camera does not weaken it
  assert.deepEqual(c.usesFeatures, [
    { name: 'android.hardware.camera', required: false },
    { name: 'com.oculus.feature.PASSTHROUGH', required: true },
    { name: 'oculus.software.handtracking', required: false },
  ]);
  assert.equal(
    withFeature(c, 'camera', 'required'),
    c,
    'an existing feature keeps its requirement',
  );
});
