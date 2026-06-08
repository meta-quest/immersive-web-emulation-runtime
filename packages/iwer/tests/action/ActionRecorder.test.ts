/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRDevice, XRDeviceConfig } from '../../src/device/XRDevice.js';
import {
  XREnvironmentBlendMode,
  XRInteractionMode,
  XRSession,
} from '../../src/session/XRSession.js';
import {
  XRReferenceSpace,
  XRReferenceSpaceType,
} from '../../src/spaces/XRReferenceSpace.js';

import { ActionPlayer } from '../../src/action/ActionPlayer.js';
import {
  ActionRecorder,
  ActionRecorderOptions,
} from '../../src/action/ActionRecorder.js';
import { P_SPACE } from '../../src/private.js';
import { XRFrame } from '../../src/frameloop/XRFrame.js';
import { XRSystem } from '../../src/initialization/XRSystem.js';
import { XRWebGLLayer } from '../../src/layers/XRWebGLLayer.js';
import { mat4, vec3 } from 'gl-matrix';
import { metaQuestTouchPlus } from '../../src/device/configs/controller/meta.js';

// silence console logs from session bootstrapping
console.log = () => {};

const testDeviceConfig: XRDeviceConfig = {
  name: 'Test Device',
  controllerConfig: metaQuestTouchPlus,
  supportedSessionModes: ['inline', 'immersive-vr', 'immersive-ar'],
  supportedFeatures: ['viewer', 'local', 'local-floor'],
  supportedFrameRates: [72, 80, 90, 120],
  isSystemKeyboardSupported: true,
  internalNominalFrameRate: 90,
  environmentBlendModes: {
    'immersive-vr': XREnvironmentBlendMode.Opaque,
    'immersive-ar': XREnvironmentBlendMode.AlphaBlend,
  },
  interactionMode: XRInteractionMode.WorldSpace,
  userAgent: 'Test user agent',
};

// Minimal WebGL2 context stub sufficient for XRWebGLLayer + the session's
// per-frame buffer clearing. Mirrors the stub used in XRSession.test.ts.
const makeMockGL = () =>
  ({
    getParameter: jest.fn((param: number) => {
      switch (param) {
        case 0:
          return [0, 0, 0, 0];
        case 1:
          return 1;
        case 2:
          return 0;
        default:
          return null;
      }
    }),
    clearColor: jest.fn(),
    clearDepth: jest.fn(),
    clearStencil: jest.fn(),
    clear: jest.fn(),
    COLOR_CLEAR_VALUE: 0,
    DEPTH_CLEAR_VALUE: 1,
    STENCIL_CLEAR_VALUE: 2,
    DEPTH_BUFFER_BIT: 3,
    COLOR_BUFFER_BIT: 4,
    STENCIL_BUFFER_BIT: 5,
    canvas: document.createElement('canvas'),
  }) as any;

const translationOf = (offsetMatrix: mat4): vec3 =>
  mat4.getTranslation(vec3.create(), offsetMatrix);

describe('ActionRecorder', () => {
  let device: XRDevice;
  let system: XRSystem;
  let session: XRSession;
  let refSpace: XRReferenceSpace;

  beforeEach(async () => {
    jest.useFakeTimers();
    device = new XRDevice(testDeviceConfig);
    system = new XRSystem(device);
    session = await system.requestSession('immersive-vr');
    // A baseLayer is required for the device frame loop to dispatch rAF
    // callbacks (otherwise onDeviceFrame returns early).
    session.updateRenderState({
      baseLayer: new XRWebGLLayer(session, makeMockGL()),
    });
    refSpace = await session.requestReferenceSpace(XRReferenceSpaceType.Local);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /**
   * Drive `count` animation frames synchronously through a rAF callback chain,
   * invoking `onFrame(frame, i)` for each. The session is ended after the final
   * frame so the self-rescheduling device loop terminates, then all timers are
   * flushed. Returns once every frame has been processed.
   */
  const driveFrames = (
    count: number,
    onFrame: (frame: XRFrame, index: number) => void,
  ) => {
    let i = 0;
    const cb = (_t: number, frame: XRFrame) => {
      onFrame(frame, i);
      i++;
      if (i < count) {
        session.requestAnimationFrame(cb as any);
      } else {
        session.end();
      }
    };
    session.requestAnimationFrame(cb as any);
    jest.runAllTimers();
  };

  // The ActionRecorder targets the ambient global WebXR types, while these
  // tests drive the local IWER implementations; cast at the boundary (as the
  // rest of the suite does) so the structurally-compatible locals are accepted.
  const makeRecorder = (options?: ActionRecorderOptions) =>
    new ActionRecorder(session as any, refSpace as any, options);
  const record = (recorder: ActionRecorder, frame: XRFrame) =>
    recorder.recordFrame(frame as any);

  describe('getRecording / toJSON', () => {
    it('returns { schema, frames } with no frames before any recording', () => {
      const recorder = makeRecorder();
      const recording = recorder.getRecording();
      expect(recording).toHaveProperty('schema');
      expect(recording).toHaveProperty('frames');
      expect(Array.isArray(recording.schema)).toBe(true);
      expect(Array.isArray(recording.frames)).toBe(true);
      expect(recording.frames).toHaveLength(0);
    });

    it('records frames and exposes them through getRecording', () => {
      const recorder = makeRecorder();
      driveFrames(2, (frame) => record(recorder, frame));
      const recording = recorder.getRecording();
      expect(recording.frames).toHaveLength(2);
      // With connected controllers a schema entry should be registered.
      expect(recording.schema.length).toBeGreaterThan(0);
    });

    it('toJSON returns valid JSON that round-trips to getRecording', () => {
      const recorder = makeRecorder();
      driveFrames(1, (frame) => record(recorder, frame));
      const json = recorder.toJSON();
      expect(typeof json).toBe('string');
      const parsed = JSON.parse(json);
      expect(parsed).toHaveProperty('schema');
      expect(parsed).toHaveProperty('frames');
      expect(parsed.frames).toHaveLength(1);
      expect(parsed.frames[0]).toEqual(recorder.getRecording().frames[0]);
    });
  });

  describe('frameCount / durationMs', () => {
    it('frameCount reflects the number of recorded frames', () => {
      const recorder = makeRecorder();
      expect(recorder.frameCount).toBe(0);
      driveFrames(3, (frame) => record(recorder, frame));
      expect(recorder.frameCount).toBe(3);
    });

    it('durationMs is 0 with fewer than two frames', () => {
      const recorder = makeRecorder();
      expect(recorder.durationMs).toBe(0);
      driveFrames(1, (frame) => record(recorder, frame));
      expect(recorder.durationMs).toBe(0);
    });

    it('durationMs reflects elapsed time between first and last frame', () => {
      // Control the recorder's per-frame timestamps deterministically.
      const nowSpy = jest.spyOn(performance, 'now');
      const recorder = makeRecorder();
      const stamps = [1000, 1250];
      driveFrames(2, (frame, i) => {
        nowSpy.mockReturnValue(stamps[i]);
        record(recorder, frame);
      });
      expect(recorder.durationMs).toBe(250);
    });
  });

  describe('maxFrames cap', () => {
    it("'stop' policy stops recording once the cap is reached", () => {
      const recorder = makeRecorder({
        maxFrames: 2,
        capPolicy: 'stop',
      });
      // Feed four frames; only the first two should be retained.
      driveFrames(4, (frame) => record(recorder, frame));
      expect(recorder.frameCount).toBe(2);
      const frames = recorder.getRecording().frames;
      expect(frames[0][0]).toBeLessThanOrEqual(frames[1][0]);
    });

    it("'drop' policy keeps a sliding window of the most recent frames", () => {
      const nowSpy = jest.spyOn(performance, 'now');
      const recorder = makeRecorder({
        maxFrames: 2,
        capPolicy: 'drop',
      });
      const stamps = [100, 200, 300, 400];
      driveFrames(4, (frame, i) => {
        nowSpy.mockReturnValue(stamps[i]);
        record(recorder, frame);
      });
      // Window never exceeds the cap.
      expect(recorder.frameCount).toBe(2);
      const frames = recorder.getRecording().frames;
      // The oldest frames were dropped; the window holds the two newest
      // timestamps (300 and 400, stored rounded to one decimal).
      expect(frames[0][0]).toBeCloseTo(300, 1);
      expect(frames[1][0]).toBeCloseTo(400, 1);
    });
  });

  describe('record -> play round-trip', () => {
    it('reproduces recorded viewer poses within tolerance', () => {
      const recorder = makeRecorder();
      const positions: [number, number, number][] = [
        [0, 1.5, 0],
        [0.5, 1.5, -0.5],
        [1, 1.5, -1],
      ];
      driveFrames(positions.length, (frame, i) => {
        // Move the headset before each frame; the viewer pose (in the local ref
        // space) tracks the device position, so each recorded frame captures a
        // distinct, known pose.
        const [x, y, z] = positions[i];
        device.position.set(x, y, z);
        record(recorder, frame);
      });

      const recording = recorder.getRecording();
      expect(recording.frames).toHaveLength(3);

      // The recorded viewer transform is expressed relative to the local
      // reference space origin (captured at request time), so compare playback
      // against the recorded frame values rather than the absolute device
      // positions. The headset moved, so these must be distinct per frame.
      const expectedTranslations = recording.frames.map(
        (f) => [f[1], f[2], f[3]] as [number, number, number],
      );
      expect(expectedTranslations[0]).not.toEqual(expectedTranslations[2]);

      const player = new ActionPlayer(refSpace, recording, device.ipd);
      player.play();

      // Sample each recorded frame boundary in order and compare the player's
      // reproduced viewer translation to the recorded transform.
      const sampled: vec3[] = [];
      // Frame 0: play() reset the wall-clock anchor, so this playFrame() has a
      // ~0 delta and samples the first frame at pointer 0.
      player.playFrame();
      sampled.push(translationOf(player.viewerSpace[P_SPACE].offsetMatrix));
      // Frames 1..n: advance one boundary at a time, deterministically.
      for (let i = 1; i < positions.length; i++) {
        player.stepFrames(1);
        sampled.push(translationOf(player.viewerSpace[P_SPACE].offsetMatrix));
      }

      expectedTranslations.forEach((expected, i) => {
        expect(sampled[i][0]).toBeCloseTo(expected[0], 2);
        expect(sampled[i][1]).toBeCloseTo(expected[1], 2);
        expect(sampled[i][2]).toBeCloseTo(expected[2], 2);
      });
    });
  });
});
