/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  CompressedRecording,
  ActionPlayer,
} from '../../src/action/ActionPlayer.js';
import { GlobalSpace, XRSpace } from '../../src/spaces/XRSpace.js';
import {
  XRReferenceSpace,
  XRReferenceSpaceType,
} from '../../src/spaces/XRReferenceSpace.js';

import { GamepadMappingType } from '../../src/gamepad/Gamepad.js';
import { InputSchema } from '../../src/action/ActionRecorder.js';
import { P_SPACE } from '../../src/private.js';
import { mat4, vec3 } from 'gl-matrix';

// Helper: build a fresh local reference space rooted at a GlobalSpace, matching
// what XRSession.requestReferenceSpace would hand the player.
const makeRefSpace = (): XRReferenceSpace =>
  new XRReferenceSpace(XRReferenceSpaceType.Local, new GlobalSpace());

// Build a single recorded frame row in the compressed format the player
// consumes: [timeStamp, px, py, pz, qx, qy, qz, qw, ...inputFrames]. With no
// input sources the row is just the timestamp plus the viewer transform.
const viewerFrame = (
  timeStamp: number,
  position: [number, number, number],
): number[] => [timeStamp, position[0], position[1], position[2], 0, 0, 0, 1];

// Read the translation currently baked into a space's offset matrix.
const translationOf = (space: XRSpace): vec3 =>
  mat4.getTranslation(vec3.create(), space[P_SPACE].offsetMatrix);

describe('ActionPlayer', () => {
  describe('constructor validation', () => {
    it('throws on an empty/malformed recording (no frames)', () => {
      const refSpace = makeRefSpace();
      expect(
        () =>
          new ActionPlayer(
            refSpace,
            { schema: [], frames: [] } as CompressedRecording,
            0.063,
          ),
      ).toThrow('wrong recording format');
    });

    it('throws a clear error when gamepad data length mismatches the schema', () => {
      const refSpace = makeRefSpace();
      const schema: InputSchema = {
        handedness: 'right',
        targetRayMode: 'tracked-pointer',
        profiles: ['test-controller'],
        hasGrip: false,
        hasHand: false,
        hasGamepad: true,
        mapping: GamepadMappingType.XRStandard,
        numButtons: 2,
        numAxes: 2,
      };
      // Expected gamepad length is numButtons + numAxes = 4, but the input data
      // below only carries 2 gamepad entries.
      const inputData = [
        0, // input source index
        0,
        0,
        0,
        0,
        0,
        0,
        1, // target ray transform
        [
          [0, 0, 0],
          [0, 0, 0],
        ], // gamepad data: only 2 entries
      ];
      const frames = [[0, 0, 0, 0, 0, 0, 0, 1, inputData]];
      const recording: CompressedRecording = {
        schema: [{ 0: 0, 1: schema }],
        frames,
      };
      expect(() => new ActionPlayer(refSpace, recording, 0.063)).toThrow(
        /2 gamepad entries, expected 4/,
      );
    });

    it('throws when a frame references an unknown input source index', () => {
      const refSpace = makeRefSpace();
      // No schema entries, but a frame references input source index 0.
      const inputData = [0, 0, 0, 0, 0, 0, 0, 1];
      const frames = [[0, 0, 0, 0, 0, 0, 0, 1, inputData]];
      const recording: CompressedRecording = { schema: [], frames };
      expect(() => new ActionPlayer(refSpace, recording, 0.063)).toThrow(
        /unknown input source 0/,
      );
    });
  });

  describe('single-frame recording', () => {
    it('does not crash on the first playFrame and renders that frame pose', () => {
      const refSpace = makeRefSpace();
      const recording: CompressedRecording = {
        schema: [],
        frames: [viewerFrame(1000, [1, 2, 3])],
      };
      const player = new ActionPlayer(refSpace, recording, 0.063);
      player.play();
      // The previously-buggy path dereferenced frames[ptr + 1] which was
      // undefined for a single-frame recording; this must not throw.
      expect(() => player.playFrame()).not.toThrow();
      const t = translationOf(player.viewerSpace);
      expect(t[0]).toBeCloseTo(1);
      expect(t[1]).toBeCloseTo(2);
      expect(t[2]).toBeCloseTo(3);
    });

    it('reports a zero duration for a single-frame recording', () => {
      const refSpace = makeRefSpace();
      const recording: CompressedRecording = {
        schema: [],
        frames: [viewerFrame(500, [0, 0, 0])],
      };
      const player = new ActionPlayer(refSpace, recording, 0.063);
      expect(player.duration).toBe(0);
    });
  });

  describe('seek / duration / currentTime', () => {
    const buildPlayer = () => {
      const refSpace = makeRefSpace();
      const recording: CompressedRecording = {
        schema: [],
        frames: [
          viewerFrame(1000, [0, 0, 0]),
          viewerFrame(1100, [1, 0, 0]),
          viewerFrame(1200, [2, 0, 0]),
        ],
      };
      return new ActionPlayer(refSpace, recording, 0.063);
    };

    it('reports duration as last minus first timestamp', () => {
      const player = buildPlayer();
      expect(player.duration).toBe(200);
    });

    it('starts at currentTime 0', () => {
      const player = buildPlayer();
      expect(player.currentTime).toBe(0);
    });

    it('seek updates currentTime within the recording', () => {
      const player = buildPlayer();
      player.seek(100);
      expect(player.currentTime).toBe(100);
    });

    it('seek clamps below 0 to 0', () => {
      const player = buildPlayer();
      player.seek(-50);
      expect(player.currentTime).toBe(0);
    });

    it('seek clamps above duration to duration', () => {
      const player = buildPlayer();
      player.seek(99999);
      expect(player.currentTime).toBe(player.duration);
    });

    it('supports a backward seek', () => {
      const player = buildPlayer();
      player.seek(180);
      expect(player.currentTime).toBe(180);
      player.seek(20);
      expect(player.currentTime).toBe(20);
    });

    it('seek lands on the frame at the sought time and a following playFrame renders it', () => {
      const player = buildPlayer();
      player.play();
      player.seek(100); // lands on the second frame (timestamp 1100 -> [1,0,0])
      // After a seek the wall-clock anchor is reset, so the immediate next
      // playFrame() has ~0 delta and samples the sought frame's pose.
      player.playFrame();
      const t = translationOf(player.viewerSpace);
      expect(t[0]).toBeCloseTo(1, 1);
    });
  });

  describe('stepFrames', () => {
    const buildPlayer = () => {
      const refSpace = makeRefSpace();
      const recording: CompressedRecording = {
        schema: [],
        frames: [
          viewerFrame(0, [0, 0, 0]),
          viewerFrame(100, [1, 0, 0]),
          viewerFrame(200, [2, 0, 0]),
        ],
      };
      return new ActionPlayer(refSpace, recording, 0.063);
    };

    it('advances deterministically independent of wall-clock', () => {
      const player = buildPlayer();
      player.stepFrames(1);
      expect(translationOf(player.viewerSpace)[0]).toBeCloseTo(1);
      expect(player.currentTime).toBe(100);

      player.stepFrames(1);
      expect(translationOf(player.viewerSpace)[0]).toBeCloseTo(2);
      expect(player.currentTime).toBe(200);
    });

    it('advances by multiple frames in a single call', () => {
      const player = buildPlayer();
      player.stepFrames(2);
      expect(translationOf(player.viewerSpace)[0]).toBeCloseTo(2);
      expect(player.currentTime).toBe(200);
    });

    it('clamps at the final frame and stops when loop is off', () => {
      const player = buildPlayer();
      player.stepFrames(10);
      expect(player.currentTime).toBe(player.duration);
      expect(player.playing).toBe(false);
    });

    it('wraps to the start when loop is on', () => {
      const player = buildPlayer();
      player.loop = true;
      player.stepFrames(3); // 0 -> 1 -> 2 -> wrap -> 0
      expect(player.currentTime).toBe(0);
      expect(player.playing).toBe(true);
    });
  });

  describe('loop flag', () => {
    it('defaults to false and is settable', () => {
      const refSpace = makeRefSpace();
      const recording: CompressedRecording = {
        schema: [],
        frames: [viewerFrame(0, [0, 0, 0]), viewerFrame(100, [1, 0, 0])],
      };
      const player = new ActionPlayer(refSpace, recording, 0.063);
      expect(player.loop).toBe(false);
      player.loop = true;
      expect(player.loop).toBe(true);
    });

    it('respects loop passed via options', () => {
      const refSpace = makeRefSpace();
      const recording: CompressedRecording = {
        schema: [],
        frames: [viewerFrame(0, [0, 0, 0]), viewerFrame(100, [1, 0, 0])],
      };
      const player = new ActionPlayer(refSpace, recording, 0.063, {
        loop: true,
      });
      expect(player.loop).toBe(true);
    });
  });

  describe('playbackRate', () => {
    const buildPlayer = (rate?: number) => {
      const refSpace = makeRefSpace();
      const recording: CompressedRecording = {
        schema: [],
        frames: [viewerFrame(0, [0, 0, 0]), viewerFrame(100, [1, 0, 0])],
      };
      return new ActionPlayer(refSpace, recording, 0.063, {
        playbackRate: rate,
      });
    };

    it('defaults to 1', () => {
      const player = buildPlayer();
      expect(player.playbackRate).toBe(1);
    });

    it('accepts a positive rate via options', () => {
      const player = buildPlayer(2);
      expect(player.playbackRate).toBe(2);
    });

    it('ignores a non-positive rate via options (falls back to 1)', () => {
      const player = buildPlayer(0);
      expect(player.playbackRate).toBe(1);
      const negativePlayer = buildPlayer(-3);
      expect(negativePlayer.playbackRate).toBe(1);
    });

    it('setter accepts a positive rate', () => {
      const player = buildPlayer();
      player.playbackRate = 0.5;
      expect(player.playbackRate).toBe(0.5);
    });

    it('setter ignores zero and negative rates', () => {
      const player = buildPlayer();
      player.playbackRate = 2;
      player.playbackRate = 0;
      expect(player.playbackRate).toBe(2);
      player.playbackRate = -1;
      expect(player.playbackRate).toBe(2);
    });
  });
});
