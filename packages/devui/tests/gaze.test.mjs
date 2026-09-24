/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { cursorToViewerDirection } from '../lib/gaze.js';

const close = (actual, expected, epsilon = 1e-6) =>
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `${actual} is not within ${epsilon} of ${expected}`,
  );

test('canvas center produces the viewer forward ray', () => {
  const direction = cursorToViewerDirection(
    50,
    50,
    { left: 0, top: 0, width: 100, height: 100 },
    false,
    Math.PI / 2,
  );
  close(direction[0], 0);
  close(direction[1], 0);
  close(direction[2], -1);
});

test('zero-area canvas falls back to the viewer forward ray', () => {
  const cases = [
    [{ left: 0, top: 0, width: 0, height: 100 }, false],
    [{ left: 0, top: 0, width: 100, height: 0 }, false],
    [{ left: 0, top: 0, width: 0, height: 100 }, true],
    [{ left: 0, top: 0, width: 0, height: 0 }, true],
  ];

  for (const [rect, stereoEnabled] of cases) {
    const direction = cursorToViewerDirection(
      50,
      50,
      rect,
      stereoEnabled,
      Math.PI / 2,
    );

    assert.deepEqual(direction, [0, 0, -1]);
    assert.ok(direction.every(Number.isFinite));
  }
});

test('equivalent mono and stereo viewport coordinates produce the same ray', () => {
  const mono = cursorToViewerDirection(
    25,
    30,
    { left: 0, top: 0, width: 100, height: 100 },
    false,
    Math.PI / 2,
  );
  const stereoLeft = cursorToViewerDirection(
    25,
    30,
    { left: 0, top: 0, width: 200, height: 100 },
    true,
    Math.PI / 2,
  );
  const stereoRight = cursorToViewerDirection(
    125,
    30,
    { left: 0, top: 0, width: 200, height: 100 },
    true,
    Math.PI / 2,
  );

  for (let index = 0; index < 3; index++) {
    close(stereoLeft[index], mono[index]);
    close(stereoRight[index], mono[index]);
  }
});
