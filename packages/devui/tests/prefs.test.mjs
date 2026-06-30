/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_KEYMAP,
  IWE_PREFS_CHANNEL,
  emitPrefsPatch,
  emitPrefsPatchDebounced,
} from '../lib/index.js';

test('exports the vendorable default keymap used by the extension panel', () => {
  assert.deepEqual(DEFAULT_KEYMAP, {
    left: {
      'thumbstick-up': 'KeyW',
      'thumbstick-down': 'KeyS',
      'thumbstick-left': 'KeyA',
      'thumbstick-right': 'KeyD',
      thumbstick: 'KeyR',
      'x-button': 'KeyX',
      'y-button': 'KeyZ',
      trigger: 'KeyQ',
      squeeze: 'KeyE',
      pinch: 'MouseLeft',
      pose: 'KeyF',
    },
    right: {
      'thumbstick-up': 'ArrowUp',
      'thumbstick-down': 'ArrowDown',
      'thumbstick-left': 'ArrowLeft',
      'thumbstick-right': 'ArrowRight',
      thumbstick: 'Slash',
      'a-button': 'Enter',
      'b-button': 'ShiftRight',
      trigger: 'MouseLeft',
      squeeze: 'MouseRight',
      pinch: 'MouseRight',
      pose: 'Backslash',
    },
  });
});

test('emitPrefsPatch posts the storage-agnostic extension bridge envelope', () => {
  const calls = [];
  globalThis.window = {
    location: { origin: 'https://example.com' },
    postMessage(message, targetOrigin) {
      calls.push({ message, targetOrigin });
    },
  };

  try {
    emitPrefsPatch({ fovy: Math.PI / 2 });
  } finally {
    delete globalThis.window;
  }

  assert.deepEqual(calls, [
    {
      message: {
        channel: IWE_PREFS_CHANNEL,
        scope: 'origin',
        patch: { fovy: Math.PI / 2 },
      },
      targetOrigin: 'https://example.com',
    },
  ]);
});

test('emitPrefsPatch falls back to wildcard targetOrigin for opaque origins', () => {
  const calls = [];
  globalThis.window = {
    location: { origin: 'null' },
    postMessage(message, targetOrigin) {
      calls.push({ message, targetOrigin });
    },
  };

  try {
    emitPrefsPatch({ inputMode: 'hand' });
  } finally {
    delete globalThis.window;
  }

  assert.equal(calls[0].targetOrigin, '*');
});

test('emitPrefsPatchDebounced flushes one shallow-merged patch', async () => {
  const calls = [];
  globalThis.window = {
    location: { origin: 'https://example.com' },
    postMessage(message, targetOrigin) {
      calls.push({ message, targetOrigin });
    },
  };

  try {
    emitPrefsPatchDebounced({ fovy: 1 }, 10);
    emitPrefsPatchDebounced({ inputMode: 'hand' }, 10);
    assert.equal(calls.length, 0);
    await new Promise((resolve) => setTimeout(resolve, 25));
  } finally {
    delete globalThis.window;
  }

  assert.deepEqual(calls, [
    {
      message: {
        channel: IWE_PREFS_CHANNEL,
        scope: 'origin',
        patch: { fovy: 1, inputMode: 'hand' },
      },
      targetOrigin: 'https://example.com',
    },
  ]);
});
