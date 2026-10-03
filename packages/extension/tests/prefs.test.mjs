/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_KEYMAP as DEVUI_DEFAULT_KEYMAP,
  IWE_PREFS_CHANNEL,
} from '@iwer/devui';

import {
  DEFAULT_KEYMAP,
  DEFAULTS,
  DEVICE_CATALOG,
  deviceSupportsVisibilityMask,
  mergePrefs,
  resolveAll,
  shouldShowMovedNotice,
} from '../lib/agent/prefs.js';
import { extractDomain, matchesForDomain } from '../lib/agent/domain.js';
import { prefsRuntimeMessageFromWindowMessage } from '../lib/agent/prefs-message.js';
import { MSG, PREFS_CHANNEL } from '../lib/agent/protocol.js';
import { applyGazePreferences } from '../lib/agent/gaze-prefs.js';
import { readFile } from 'node:fs/promises';

test('resolves defaults, all-sites prefs, and per-origin overrides', () => {
  let blob = { version: 1 };
  assert.equal(resolveAll(blob, 'example.com').device, DEFAULTS.device);

  blob = mergePrefs(blob, 'global', null, {
    device: 'metaQuest3',
    environment: 'office_small',
    keymap: { left: { trigger: 'KeyT' } },
  });
  assert.equal(resolveAll(blob, 'example.com').environment, 'office_small');
  assert.equal(resolveAll(blob, 'example.com').keymap.left.trigger, 'KeyT');
  assert.equal(
    resolveAll(blob, 'example.com').keymap.right.trigger,
    DEFAULT_KEYMAP.right.trigger,
  );

  blob = mergePrefs(blob, 'origin', 'example.com', {
    device: 'metaQuest2',
    keymap: { right: { trigger: 'KeyY' } },
  });
  const resolved = resolveAll(blob, 'example.com');
  assert.equal(resolved.device, 'metaQuest2');
  assert.equal(resolved.environment, 'office_small');
  assert.equal(resolved.keymap.left.trigger, 'KeyT');
  assert.equal(resolved.keymap.right.trigger, 'KeyY');
  assert.equal(resolved.gazeMode, 'off');
  assert.equal(resolved.gazeCommitHand, 'right');
});

test('offers the Meta VR Glasses visibility profile', () => {
  assert.equal(DEVICE_CATALOG.includes('metaVRGlasses'), true);
  const blob = mergePrefs({ version: 1 }, 'origin', 'example.com', {
    device: 'metaVRGlasses',
  });
  assert.equal(resolveAll(blob, 'example.com').device, 'metaVRGlasses');
});

test('only enables the mask setting for profiles with mask data', () => {
  assert.equal(deviceSupportsVisibilityMask('metaVRGlasses'), true);
  assert.equal(deviceSupportsVisibilityMask('metaQuest3'), false);
  assert.equal(deviceSupportsVisibilityMask('unknown-profile'), false);
});

test('vendored default keymap stays equal to @iwer/devui', () => {
  assert.deepEqual(DEFAULT_KEYMAP, DEVUI_DEFAULT_KEYMAP);
});

test('prunes per-origin writes equal to inherited settings', () => {
  const blob = mergePrefs(
    { version: 1, global: { environment: 'office_small' } },
    'origin',
    'example.com',
    { environment: 'office_small' },
  );
  assert.equal(blob.origins?.['example.com'], undefined);
});

test('stores only per-origin values that differ from inherited settings', () => {
  const blob = mergePrefs(
    {
      version: 1,
      global: {
        device: 'metaQuest3',
        environment: 'living_room',
        fovy: Math.PI / 2,
      },
    },
    'origin',
    'example.com',
    {
      device: 'metaQuest2',
      environment: 'office_small',
      fovy: Math.PI / 2,
    },
  );
  assert.deepEqual(blob.origins?.['example.com'], {
    device: 'metaQuest2',
    environment: 'office_small',
  });
});

test('clear and reset operations keep the blob versioned and recoverable', () => {
  const blob = mergePrefs(
    { version: 1, origins: { 'example.com': { device: 'metaQuest2' } } },
    'origin',
    'example.com',
    {},
    { clear: 'origin' },
  );
  assert.deepEqual(blob, { version: 1, global: {}, ui: {}, origins: {} });

  const reset = mergePrefs(
    { version: 1, global: { device: 'metaQuest2' } },
    'global',
    null,
    {},
    { resetKey: 'device' },
  );
  assert.equal(resolveAll(reset, null).device, DEFAULTS.device);
});

test('moved notice only opens for a real 1.x to 2.x update', () => {
  assert.equal(shouldShowMovedNotice('1.5.0', '2.0.0', false), true);
  assert.equal(shouldShowMovedNotice('2.0.0', '2.0.1', false), false);
  assert.equal(shouldShowMovedNotice('2.0.0', '2.0.0', false), false);
  assert.equal(shouldShowMovedNotice('1.5.0', '2.0.0', true), false);
});

test('domain normalization matches registered content-script patterns', () => {
  assert.equal(extractDomain('https://www.example.com/app'), 'example.com');
  assert.equal(extractDomain('https://app.example.com/app'), 'example.com');
  assert.equal(extractDomain('http://localhost:5173/'), 'localhost');
  assert.deepEqual(matchesForDomain('example.com'), [
    'http://example.com/*',
    'https://example.com/*',
    'http://*.example.com/*',
    'https://*.example.com/*',
  ]);
  assert.deepEqual(matchesForDomain('localhost'), [
    'http://localhost/*',
    'https://localhost/*',
  ]);
});

test('prefs channel tag matches @iwer/devui (no cross-package drift)', () => {
  assert.equal(PREFS_CHANNEL, IWE_PREFS_CHANNEL);
});

test('prunes a per-origin keymap override that equals the inherited binding', () => {
  // Remap, then remap back to the inherited (global) value: the override must be
  // pruned so the origin stops being flagged as customized and tracks defaults.
  let blob = mergePrefs({ version: 1 }, 'global', null, {
    keymap: { left: { trigger: 'KeyT' } },
  });
  blob = mergePrefs(blob, 'origin', 'example.com', {
    keymap: { left: { trigger: 'KeyT' } },
  });
  assert.equal(blob.origins?.['example.com'], undefined);
});

test('prunes a per-origin handPose override equal to the inherited pose', () => {
  let blob = mergePrefs({ version: 1 }, 'global', null, {
    handPoses: { left: 'point' },
  });
  blob = mergePrefs(blob, 'origin', 'example.com', {
    handPoses: { left: 'point' },
  });
  assert.equal(blob.origins?.['example.com'], undefined);
});

test('handPoses resolve to a complete { left, right } from a partial override', () => {
  const blob = mergePrefs({ version: 1 }, 'origin', 'example.com', {
    handPoses: { left: 'point' },
  });
  const resolved = resolveAll(blob, 'example.com').handPoses;
  assert.equal(resolved.left, 'point');
  assert.equal(resolved.right, DEFAULTS.handPoses.right);
});

test('IP-literal and IPv6 hosts get bare match patterns (no subdomain wildcard)', () => {
  assert.deepEqual(matchesForDomain('192.168.1.10'), [
    'http://192.168.1.10/*',
    'https://192.168.1.10/*',
  ]);
  assert.deepEqual(matchesForDomain('::1'), [
    'http://[::1]/*',
    'https://[::1]/*',
  ]);
});

test('DevUI prefs postMessage survives as a runtime write message', () => {
  assert.deepEqual(
    prefsRuntimeMessageFromWindowMessage({
      channel: PREFS_CHANNEL,
      scope: 'global',
      patch: {
        keymap: { left: { trigger: 'KeyG' } },
        fovy: Math.PI / 2,
        visibilityMaskEnabled: false,
        spectatorEnabled: true,
        gazeMode: 'cursor',
        gazeCommitHand: 'left',
        unknown: true,
      },
    }),
    {
      type: MSG.PREFS_WRITE,
      scope: 'origin',
      patch: {
        fovy: Math.PI / 2,
        visibilityMaskEnabled: false,
        spectatorEnabled: true,
        gazeMode: 'cursor',
        gazeCommitHand: 'left',
        keymap: { left: { trigger: 'KeyG' } },
      },
    },
  );
  assert.equal(
    prefsRuntimeMessageFromWindowMessage({
      channel: PREFS_CHANNEL,
      patch: null,
    }),
    null,
  );
  assert.equal(
    prefsRuntimeMessageFromWindowMessage({
      channel: PREFS_CHANNEL,
      patch: {
        fovy: 999,
        keymap: { left: { trigger: 42 } },
        defaultPose: { headset: { position: [0], quaternion: [0] } },
      },
    }),
    null,
  );
});

test('gaze preferences are sanitized and persist through layered resolution', () => {
  const blob = mergePrefs({ version: 1 }, 'origin', 'example.com', {
    gazeMode: 'head-locked',
    gazeCommitHand: 'left',
  });
  assert.equal(resolveAll(blob, 'example.com').gazeMode, 'head-locked');
  assert.equal(resolveAll(blob, 'example.com').gazeCommitHand, 'left');

  assert.deepEqual(
    prefsRuntimeMessageFromWindowMessage({
      channel: PREFS_CHANNEL,
      patch: { gazeMode: 'invalid', gazeCommitHand: 'center' },
    }),
    null,
  );
});

test('gaze preferences are applied to the injected DevUI', () => {
  const calls = [];
  const target = {
    devui: {
      setGazeMode: (mode) => calls.push(['mode', mode]),
      setGazeCommitHand: (handedness) => calls.push(['hand', handedness]),
    },
  };

  applyGazePreferences(target, 'cursor', 'left');

  assert.deepEqual(calls, [
    ['hand', 'left'],
    ['mode', 'cursor'],
  ]);
});

test('extension panel exposes persistent gaze mode and commit-hand controls', async () => {
  const source = await readFile(
    new URL('../src/agent/panel.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /id="gazeMode"/);
  assert.match(source, /id="gazeCommitHand"/);
});
