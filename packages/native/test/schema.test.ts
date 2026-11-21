/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FEATURE_MANIFEST } from '../src/config/features.ts';
import { NATIVE_TARGET_JSON_SCHEMA as schema } from '../src/config/schema.ts';
import { NATIVE_FEATURE_NAMES } from '../src/config/types.ts';
import {
  NATIVE_CONFIG_KEYS,
  NATIVE_CONFIG_REQUIRED_KEYS,
  SIGNING_KEYS,
  SIGNING_REQUIRED_KEYS,
  SPLASH_KEYS,
} from '../src/config/validate.ts';

test('JSON schema and validator agree on keys', () => {
  assert.deepEqual(Object.keys(schema.properties), [...NATIVE_CONFIG_KEYS]);
  assert.deepEqual(schema.required, [...NATIVE_CONFIG_REQUIRED_KEYS]);
  assert.deepEqual(Object.keys(schema.properties.splash.oneOf[1].properties), [
    ...SPLASH_KEYS,
  ]);
  assert.deepEqual(Object.keys(schema.properties.signing.properties), [
    ...SIGNING_KEYS,
  ]);
  assert.deepEqual(schema.properties.signing.required, [
    ...SIGNING_REQUIRED_KEYS,
  ]);
  assert.deepEqual(Object.keys(schema.properties.features.properties), [
    ...NATIVE_FEATURE_NAMES,
  ]);
});

test('every feature has a manifest mapping', () => {
  assert.deepEqual(
    Object.keys(FEATURE_MANIFEST).sort(),
    [...NATIVE_FEATURE_NAMES].sort(),
  );
});

test('the schema is plain JSON', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(schema)), schema);
});
