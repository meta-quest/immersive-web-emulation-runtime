/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { Euler, Quaternion, Vector3 } from 'three';

import { InputLayer } from '../lib/scene.js';

function createLayerHarness() {
  const layer = Object.create(InputLayer.prototype);
  Object.assign(layer, {
    vec3: new Vector3(),
    quat: new Quaternion(),
    euler: new Euler(),
    keyState: {},
    xrDevice: {
      spectator: {
        enabled: false,
        position: new Vector3(0, 2, 2),
        quaternion: new Quaternion(),
      },
    },
  });
  return layer;
}

test('Shift+W moves the spectator along its heading at constant height', () => {
  const layer = createLayerHarness();
  layer.xrDevice.spectator.enabled = true;
  layer.xrDevice.spectator.quaternion.setFromEuler(
    new Euler(-0.4, Math.PI / 2, 0, 'YXZ'),
  );
  layer.keyState.ShiftLeft = true;
  layer.keyState.KeyW = true;
  layer.movePlayerRig(1);

  const { x, y, z } = layer.xrDevice.spectator.position;
  // yawed to face -X, so forward is -X regardless of the downward pitch
  assert.ok(Math.abs(x + 2) < 1e-6);
  assert.equal(y, 2);
  assert.ok(Math.abs(z - 2) < 1e-6);
});
