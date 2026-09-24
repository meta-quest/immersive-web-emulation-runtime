/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { InputLayer } from '../lib/scene.js';

function createLayerHarness() {
  const deferred = [];
  const immediate = [];
  const layer = Object.create(InputLayer.prototype);
  Object.assign(layer, {
    gazeCommitActive: undefined,
    gazeCommitPendingRelease: undefined,
    gazePointerId: null,
    renderer: {
      domElement: {
        hasPointerCapture: () => false,
      },
    },
    preferredConnectedGazeMode: 'head-locked',
    isInProgrammaticMode: false,
    xrDevice: {
      controllers: {},
      hands: {
        right: {
          setPinchValueImmediate: (value) => immediate.push(value),
          updatePinchValue: (value) => deferred.push(value),
        },
      },
    },
  });
  return { deferred, immediate, layer };
}

test('queues a normal release until after the next frame-start boundary', async () => {
  const { deferred, immediate, layer } = createLayerHarness();
  layer.gazeCommitActive = { mode: 'hand', handedness: 'right' };

  layer.releaseGazeCommit(false);
  assert.deepEqual(deferred, []);
  assert.deepEqual(immediate, []);

  layer.schedulePendingGazeRelease();
  assert.deepEqual(deferred, []);
  await Promise.resolve();
  assert.deepEqual(deferred, [0]);
  assert.ok(layer.gazeCommitPendingRelease);

  layer.schedulePendingGazeRelease();
  await Promise.resolve();
  assert.equal(layer.gazeCommitPendingRelease, undefined);
});

test('cancels a queued release synchronously during teardown', async () => {
  const { deferred, immediate, layer } = createLayerHarness();
  layer.gazeCommitActive = { mode: 'hand', handedness: 'right' };

  layer.releaseGazeCommit(false);
  layer.schedulePendingGazeRelease();
  layer.releaseGazeCommit(true);
  await Promise.resolve();

  assert.deepEqual(deferred, []);
  assert.deepEqual(immediate, [0]);
});

test('ignores foreign pointer movement while a gaze pointer is captured', () => {
  const { layer } = createLayerHarness();
  const moved = [];
  layer.gazePointerId = 7;
  layer.gazeLastPointer = { x: 10, y: 20 };
  layer.gazeCommitActive = { mode: 'hand', handedness: 'right' };
  layer.gazeInteractionEnabled = () => true;
  layer.moveCommitInput = (x, y) => moved.push([x, y]);

  layer.gazePointerMoveHandler({
    clientX: 100,
    clientY: 200,
    pointerId: 8,
    preventDefault() {},
  });

  assert.deepEqual(moved, []);
  assert.deepEqual(layer.gazeLastPointer, { x: 10, y: 20 });
});

test('does not replace an active gaze pointer with a second pointer', () => {
  const { layer } = createLayerHarness();
  layer.gazePointerId = 7;
  layer.gazeInteractionEnabled = () => true;

  layer.gazePointerDownHandler({
    button: 0,
    pointerId: 8,
    preventDefault() {
      throw new Error('foreign pointer should not be consumed');
    },
  });

  assert.equal(layer.gazePointerId, 7);
});

test('syncs remote gaze connectivity without overwriting its orientation', () => {
  const { layer } = createLayerHarness();
  const quaternion = { x: 0.1, y: 0.2, z: 0.3, w: 0.9 };
  const modes = [];
  let releases = 0;
  layer.gazeMode = 'off';
  layer.xrDevice.gaze = { connected: true, quaternion };
  layer.releaseGazeCommit = () => {
    releases++;
  };
  layer.applyGazeModePresentation = (mode) => {
    modes.push(mode);
    layer.gazeMode = mode;
  };

  layer.syncGazeModeFromDevice();

  assert.equal(releases, 1);
  assert.deepEqual(modes, ['head-locked']);
  assert.equal(layer.xrDevice.gaze.quaternion, quaternion);

  layer.syncGazeModeFromDevice();
  assert.equal(releases, 1);
});

test('restores cursor gaze after temporary programmatic control', () => {
  const { layer } = createLayerHarness();
  const quaternion = {
    x: 0.1,
    y: 0.2,
    z: 0.3,
    w: 0.9,
    set(x, y, z, w) {
      Object.assign(this, { x, y, z, w });
    },
  };
  const modes = [];
  layer.gazeMode = 'cursor';
  layer.preferredConnectedGazeMode = 'cursor';
  layer.xrDevice.gaze = { connected: true, quaternion };
  layer.releaseGazeCommit = () => {};
  layer.applyGazeModePresentation = (mode) => {
    modes.push(mode);
    layer.gazeMode = mode;
  };

  layer.setProgrammaticMode(true);
  layer.syncGazeModeFromDevice();
  assert.equal(layer.currentGazeMode, 'head-locked');
  assert.equal(layer.xrDevice.gaze.quaternion, quaternion);

  layer.setProgrammaticMode(false);
  assert.equal(layer.currentGazeMode, 'cursor');
  assert.equal(layer.xrDevice.gaze.quaternion, quaternion);
  assert.deepEqual(modes, ['head-locked', 'cursor']);
});

test('preserves remote gaze orientation when returning to head-locked manual mode', () => {
  const { layer } = createLayerHarness();
  const quaternion = {
    x: 0,
    y: Math.SQRT1_2,
    z: 0,
    w: Math.SQRT1_2,
    set() {
      throw new Error('programmatic handoff must not rewrite device gaze');
    },
  };
  const modes = [];
  layer.gazeMode = 'head-locked';
  layer.xrDevice.gaze = { connected: true, quaternion };
  layer.releaseGazeCommit = () => {};
  layer.applyGazeModePresentation = (mode) => {
    modes.push(mode);
    layer.gazeMode = mode;
  };

  layer.setProgrammaticMode(true);
  layer.syncGazeModeFromDevice();
  layer.setProgrammaticMode(false);

  assert.equal(layer.currentGazeMode, 'head-locked');
  assert.equal(layer.xrDevice.gaze.quaternion, quaternion);
  assert.deepEqual(modes, []);
});

test('does not consume the gaze reset shortcut from an interactive control', () => {
  const { layer } = createLayerHarness();
  let resets = 0;
  let prevented = false;
  layer.gazeMode = 'cursor';
  layer.keyState = {};
  layer.resetInputTransform = () => {
    resets++;
  };

  layer.keyDownHandler({
    code: 'Space',
    composedPath: () => [{ tagName: 'BUTTON' }],
    preventDefault: () => {
      prevented = true;
    },
  });

  assert.equal(resets, 0);
  assert.equal(prevented, false);
});

test('uses Space to reset the gaze commit hand outside interactive controls', () => {
  const { layer } = createLayerHarness();
  let resetHand;
  let prevented = false;
  layer.gazeMode = 'cursor';
  layer.gazeCommitHand = 'left';
  layer.keyState = {};
  layer.resetInputTransform = (handedness) => {
    resetHand = handedness;
  };

  layer.keyDownHandler({
    code: 'Space',
    composedPath: () => [{}],
    preventDefault: () => {
      prevented = true;
    },
  });

  assert.equal(resetHand, 'left');
  assert.equal(prevented, true);
});
