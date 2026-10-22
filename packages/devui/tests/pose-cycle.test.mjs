/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { BUILTIN_HAND_POSE_IDS } from 'iwer/lib/device/configs/hand/ids.js';

import {
  FEATURED_HAND_POSE_IDS,
  cyclePoseIds,
  poseLabel,
  stepPoseId,
} from '../lib/pose-cycle.js';

test('the stepper cycles the featured poses, without pinch', () => {
  assert.deepEqual(cyclePoseIds(BUILTIN_HAND_POSE_IDS), [
    'default',
    'point',
    'fist',
    'open',
    'thumbs-up',
  ]);
  assert.equal(FEATURED_HAND_POSE_IDS.includes('pinch'), false);
  for (const id of FEATURED_HAND_POSE_IDS) {
    assert.ok(BUILTIN_HAND_POSE_IDS.includes(id), id);
  }
});

test('next and previous wrap around the featured poses', () => {
  assert.equal(stepPoseId('default', BUILTIN_HAND_POSE_IDS, 1), 'point');
  assert.equal(stepPoseId('thumbs-up', BUILTIN_HAND_POSE_IDS, 1), 'default');
  assert.equal(stepPoseId('default', BUILTIN_HAND_POSE_IDS, -1), 'thumbs-up');
});

test('from a pose outside the cycle, next goes to the first featured pose', () => {
  assert.equal(stepPoseId('pinch', BUILTIN_HAND_POSE_IDS, 1), 'default');
  assert.equal(stepPoseId('peace', BUILTIN_HAND_POSE_IDS, 1), 'default');
  assert.equal(stepPoseId('peace', BUILTIN_HAND_POSE_IDS, -1), 'thumbs-up');
});

test('a custom config without featured poses cycles all of its poses', () => {
  const custom = ['relaxed', 'grab'];
  assert.deepEqual(cyclePoseIds(custom), custom);
  assert.equal(stepPoseId('relaxed', custom, 1), 'grab');
  assert.equal(stepPoseId('grab', custom, 1), 'relaxed');
});

test('the label marks finger blends', () => {
  assert.equal(poseLabel('open', {}), 'open');
  assert.equal(
    poseLabel('open', { middle: { poseId: 'fist', weight: 1 } }),
    'open*',
  );
});
