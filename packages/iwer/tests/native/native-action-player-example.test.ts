/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  GlobalSpace,
  metaQuest3,
  XRDevice,
  XRReferenceSpace,
  XRReferenceSpaceType,
} from '../../src/index.js';

/**
 * The native override documentation tells applications to build an anchor
 * reference space for XRDevice.createActionPlayer(). That snippet has to be
 * writable against the published entry point, with no casts and no deep
 * imports, so it is compiled here exactly as documented.
 */
describe('native action playback public API', () => {
  test('the documented createActionPlayer call works from the entry point', () => {
    const device = new XRDevice(metaQuest3);
    const recordingSpace = new XRReferenceSpace(
      XRReferenceSpaceType.Local,
      new GlobalSpace(),
    );
    const recording = {
      schema: [],
      frames: [[0, 0, 0, 0, 0, 0, 0, 1]],
    };
    const player = device.createActionPlayer(recordingSpace, recording, {
      loop: true,
      playbackRate: 0.5,
    });

    expect(recordingSpace).toBeInstanceOf(XRReferenceSpace);
    expect(player.loop).toBe(true);
    expect(player.playbackRate).toBe(0.5);
  });
});
