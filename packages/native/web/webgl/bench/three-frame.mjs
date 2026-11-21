/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Host runner: node bench/three-frame.mjs   (real natives on Mesa + a null-natives variant for three's own JS)
import { realInstall } from '../test/real-gl.ts';
import { runThreeFrame, formatFrame } from './three-frame.ts';
import { installWebGL } from '../install.ts';
import { createFakeNatives } from '../test/fake-natives.ts';
const inst = realInstall();
if (inst) console.log(formatFrame(runThreeFrame(inst, 'host-mesa')));
console.log(
  formatFrame(
    runThreeFrame(
      installWebGL({}, createFakeNatives().natives),
      'host-null-natives',
    ),
  ),
);
