/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { ActionPlayer } from '../../src/action/ActionPlayer.js';
import { ActionRecorder } from '../../src/action/ActionRecorder.js';
import { XRDevice } from '../../src/device/XRDevice.js';
import { XRFrame } from '../../src/frameloop/XRFrame.js';
import {
  XRReferenceSpace,
  XRReferenceSpaceType,
} from '../../src/spaces/XRReferenceSpace.js';
import { XRSession } from '../../src/session/XRSession.js';
import { XRSystem } from '../../src/initialization/XRSystem.js';
import { XRInputSource } from '../../src/input/XRInputSource.js';
import { XRWebGLLayer } from '../../src/layers/XRWebGLLayer.js';
import { metaQuest3 } from '../../src/device/configs/headset/meta.js';

console.log = () => {};

const makeMockGL = () =>
  ({
    getParameter: jest.fn((param: number) =>
      param === 0 ? [0, 0, 0, 0] : param === 1 ? 1 : 0,
    ),
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

describe('replaying a recorded hand pinch', () => {
  let device: XRDevice;
  let session: XRSession;
  let refSpace: XRReferenceSpace;

  beforeEach(async () => {
    jest.useFakeTimers();
    device = new XRDevice(metaQuest3);
    device.primaryInputMode = 'hand';
    const system = new XRSystem(device);
    session = await system.requestSession('immersive-vr', {
      optionalFeatures: ['hand-tracking'],
    });
    session.updateRenderState({
      baseLayer: new XRWebGLLayer(session, makeMockGL()),
    });
    refSpace = await session.requestReferenceSpace(XRReferenceSpaceType.Local);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // Records a right-hand pinch, one value per frame: by default open for 2
  // frames, pinched for 3, open for 2. `tap` holds the tap microgesture
  // button down on the frames where it is 1.
  const recordPinch = (pinch = [0, 0, 1, 1, 1, 0, 0], tap?: number[]) => {
    const recorder = new ActionRecorder(session as any, refSpace as any);
    let i = 0;
    const cb = (_t: number, frame: XRFrame) => {
      recorder.recordFrame(frame as any);
      i++;
      if (i < pinch.length) {
        device.hands.right!.updatePinchValue(pinch[i]);
        if (tap) device.hands.right!.updateGestureButton('tap', tap[i] as 0);
        session.requestAnimationFrame(cb as any);
      } else {
        session.end();
      }
    };
    session.requestAnimationFrame(cb as any);
    jest.runAllTimers();
    return recorder.getRecording();
  };

  const playerWithEvents = (
    loop = false,
    pinch?: number[],
    recording = recordPinch(pinch),
  ) => {
    const events: string[] = [];
    const player = new ActionPlayer(refSpace, recording, 0.063, {
      loop,
      eventContext: {
        session: {
          dispatchEvent: (event: Event) => {
            const source = (event as unknown as { inputSource: XRInputSource })
              .inputSource;
            if (source.hand) events.push(event.type);
            return true;
          },
        } as unknown as XRSession,
        getFrame: () => ({}) as XRFrame,
      },
    });
    return { player, events, recording };
  };

  test('fires selectstart, then select and selectend, like the live hand', () => {
    const { player, events } = playerWithEvents();
    player.stepFrames(1);
    player.stepFrames(10);
    expect(events).toEqual(['selectstart', 'select', 'selectend']);
  });

  test('a loop wrap in the middle of a pinch cancels it (selectend alone)', () => {
    const { player, events } = playerWithEvents(true);
    // Frames 0..6; step into the pinch (frame 3), then seek back to the start.
    player.stepFrames(3);
    expect(events).toEqual(['selectstart']);
    player.seek(0);
    player.stepFrames(1);
    expect(events).toEqual(['selectstart', 'selectend']);
  });

  test('stop() in the middle of a pinch cancels it', () => {
    const { player, events } = playerWithEvents();
    player.stepFrames(3);
    expect(events).toEqual(['selectstart']);
    player.stop();
    expect(events).toEqual(['selectstart', 'selectend']);
  });

  test('play() restarting in the middle of a pinch cancels it', () => {
    const { player, events } = playerWithEvents();
    player.stepFrames(3);
    player.play();
    player.playFrame();
    expect(events).toEqual(['selectstart', 'selectend']);
  });

  test('a replay that starts in the middle of a pinch never releases it', () => {
    const { player, events, recording } = playerWithEvents();
    const frames = recording.frames;
    player.seek((frames[3][0] as number) - (frames[0][0] as number));
    player.stepFrames(10);
    // The app never got selectstart, so it gets no select or selectend.
    expect(events).toEqual([]);
  });

  test('reaching the end with the pinch held cancels it', () => {
    const { player, events } = playerWithEvents(false, [0, 0, 1, 1, 1]);
    player.stepFrames(10);
    expect(events).toEqual(['selectstart', 'selectend']);
  });

  test('playing past the end cancels a pinch pressed in the final frames', () => {
    const { player, events } = playerWithEvents(false, [0, 0, 1, 1, 1]);
    player.play();
    player.playFrame();
    jest.advanceTimersByTime(player.duration + 100);
    player.playFrame();
    expect(player.playing).toBe(false);
    expect(events).toEqual(['selectstart', 'selectend']);
  });

  test('records the hand gamepad as Quest Browser lays it out, and replays a microgesture on its button without events', () => {
    const recording = recordPinch(
      [0, 0, 1, 1, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 1, 1, 0],
    );
    const hand = recording.schema
      .map(([, schema]) => schema)
      .find((schema) => schema.hasHand && schema.handedness === 'right')!;
    expect(hand.mapping).toBe('xr-standard');
    expect(hand.numButtons).toBe(10);
    const { player, events } = playerWithEvents(false, undefined, recording);
    const source = () =>
      Array.from(player.inputSources ?? []).find(
        (s) => s.hand && s.handedness === 'right',
      );
    const tapDown: boolean[] = [];
    for (let i = 0; i < 9; i++) {
      player.stepFrames(1);
      tapDown.push(source()?.gamepad?.buttons[9]?.pressed ?? false);
    }
    expect(tapDown.filter(Boolean).length).toBe(2);
    // Only the pinch fires events.
    expect(events).toEqual(['selectstart', 'select', 'selectend']);
  });

  test('a recording from before the hand gamepad had a mapping still selects on button 0', () => {
    const recording = recordPinch();
    for (const [index, schema] of recording.schema) {
      if (!schema.hasHand) continue;
      schema.mapping = '' as typeof schema.mapping;
      schema.numButtons = 1;
      // Keep only button 0 of each recorded gamepad (no axes).
      for (const frame of recording.frames) {
        for (const input of frame.slice(8)) {
          if (Array.isArray(input) && input[0] === index) {
            const gamepad = input[input.length - 1] as unknown[];
            gamepad.splice(1);
          }
        }
      }
    }
    const { player, events } = playerWithEvents(false, undefined, recording);
    player.stepFrames(1);
    player.stepFrames(10);
    expect(events).toEqual(['selectstart', 'select', 'selectend']);
  });
});
