/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Havok (IWSDK's physics engine) in a module worker: create a world, a falling sphere, step it.
import HavokPhysics from '../vendor/HavokPhysics_es.js';
const hk = await HavokPhysics();
const [r, world] = hk.HP_World_Create();
hk.HP_World_SetGravity(world, [0, -9.81, 0]);
const [, shape] = hk.HP_Shape_CreateSphere([0, 0, 0], 0.5);
const [, body] = hk.HP_Body_Create();
hk.HP_Body_SetShape(body, shape);
hk.HP_Body_SetMotionType(body, hk.MotionType.DYNAMIC);
hk.HP_Body_SetMassProperties(body, [
  [0, 0, 0],
  1,
  [0.1, 0.1, 0.1],
  [0, 0, 0, 1],
]);
hk.HP_World_AddBody(world, body, false);
for (let i = 0; i < 60; i++) hk.HP_World_Step(world, 1 / 60);
const [, pos] = hk.HP_Body_GetPosition(body);
postMessage({ result: String(r), y: pos[1] });
