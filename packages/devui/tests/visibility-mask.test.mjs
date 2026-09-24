/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { HeaderUI } from '../lib/components/header.js';

function renderHeader({ visibilityMask, visibilityMaskEnabled }) {
  return renderToStaticMarkup(
    React.createElement(HeaderUI, {
      xrDevice: {
        activeSession: undefined,
        supportedFeatures: [],
        primaryInputMode: 'controller',
        sem: undefined,
        visibilityMask,
        visibilityMaskEnabled,
      },
      inputLayer: {},
    }),
  );
}

function getMaskButton(markup) {
  const match = markup.match(
    /<button[^>]*aria-label="Field-of-view mask"[^>]*>/,
  );
  assert.ok(match, 'expected the field-of-view mask button');
  return match[0];
}

test('disables the field-of-view mask button for unsupported profiles', () => {
  const button = getMaskButton(
    renderHeader({ visibilityMask: undefined, visibilityMaskEnabled: false }),
  );

  assert.match(button, /disabled=""/);
  assert.match(button, /aria-pressed="false"/);
  assert.match(button, /unavailable for this device profile/);
});

test('enables the field-of-view mask button for supported profiles', () => {
  const button = getMaskButton(
    renderHeader({ visibilityMask: {}, visibilityMaskEnabled: true }),
  );

  assert.doesNotMatch(button, /disabled=""/);
  assert.match(button, /aria-pressed="true"/);
  assert.match(button, /Disable field-of-view mask/);
});
