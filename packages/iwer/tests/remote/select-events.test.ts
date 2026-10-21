/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_SESSION, P_SPACE } from '../../src/private.js';

import { XRDevice } from '../../src/device/XRDevice.js';
import { XRFrame } from '../../src/frameloop/XRFrame.js';
import { mat4 } from 'gl-matrix';
import { metaQuest3 } from '../../src/device/configs/headset/meta.js';

// Drives remote control and the inputs' frame update the way XRDevice does
// (remote first, then each input), recording every input source event with
// the frame it fired on and the gamepad `pressed` flag the app would read.
describe('select events through remote control', () => {
  let device: XRDevice;
  let events: {
    frame: number;
    type: string;
    pressed: boolean;
    handedness: string;
  }[];
  let frameIndex: number;
  let frame: XRFrame;

  beforeEach(() => {
    device = new XRDevice(metaQuest3);
    const mockSession = {
      mode: 'immersive-vr',
      [P_SESSION]: {
        referenceSpaces: [{ [P_SPACE]: { offsetMatrix: mat4.create() } }],
      },
      dispatchEvent: (event: { type: string; inputSource: any }) => {
        events.push({
          frame: frameIndex,
          type: event.type,
          pressed: event.inputSource.gamepad.buttons[0].pressed,
          handedness: event.inputSource.handedness,
        });
        return true;
      },
    };
    Object.defineProperty(device, 'activeSession', {
      get: () => mockSession,
      configurable: true,
    });
    frame = { session: mockSession } as unknown as XRFrame;
    events = [];
    frameIndex = 0;
  });

  afterEach(() => {
    device.remote.forceRelease();
  });

  const runFrame = (deltaMs = 16.67) => {
    frameIndex++;
    device.remote.update(deltaMs);
    device.controllers.left!.onFrameStart(frame);
    device.controllers.right!.onFrameStart(frame);
    device.hands.right!.onFrameStart(frame);
  };

  test('fires selectstart on press, then select and selectend on release', async () => {
    const done = device.remote.dispatch('select', { device: 'hand-right' });
    for (let i = 0; i < 20; i++) runFrame();
    await done;
    expect(events.map((e) => e.type)).toEqual([
      'selectstart',
      'select',
      'selectend',
    ]);
    // The gamepad flag agrees with the events on the frame they fire.
    expect(events[0].pressed).toBe(true);
    expect(events[2].pressed).toBe(false);
  });

  test('a single 200 ms frame still delivers both the press and the release', async () => {
    const done = device.remote.dispatch('select', {
      device: 'controller-right',
    });
    runFrame(16.67);
    runFrame(200);
    runFrame(16.67);
    await done;
    expect(events.map((e) => [e.frame, e.type])).toEqual([
      [1, 'selectstart'],
      [2, 'select'],
      [2, 'selectend'],
    ]);
  });

  test('back-to-back set_select_value calls each get their own frame', async () => {
    const press = device.remote.dispatch('set_select_value', {
      device: 'controller-right',
      value: 1,
    });
    const release = device.remote.dispatch('set_select_value', {
      device: 'controller-right',
      value: 0,
    });
    runFrame();
    runFrame();
    await Promise.all([press, release]);
    expect(events.map((e) => [e.frame, e.type])).toEqual([
      [1, 'selectstart'],
      [2, 'select'],
      [2, 'selectend'],
    ]);
  });

  test('writes to different devices share a frame; a second write to one device waits', async () => {
    const writes = [
      device.remote.dispatch('set_select_value', {
        device: 'controller-left',
        value: 1,
      }),
      device.remote.dispatch('set_select_value', {
        device: 'controller-right',
        value: 1,
      }),
      device.remote.dispatch('set_select_value', {
        device: 'controller-left',
        value: 0,
      }),
    ];
    runFrame();
    runFrame();
    await Promise.all(writes);
    expect(events.map((e) => [e.frame, e.handedness, e.type])).toEqual([
      [1, 'left', 'selectstart'],
      [1, 'right', 'selectstart'],
      [2, 'left', 'select'],
      [2, 'left', 'selectend'],
    ]);
  });

  test('set_input_mode ends the frame, so the new input source exists before its press', async () => {
    const mode = device.remote.dispatch('set_input_mode', { mode: 'hand' });
    const press = device.remote.dispatch('set_select_value', {
      device: 'hand-right',
      value: 1,
    });
    runFrame();
    expect(device.primaryInputMode).toBe('hand');
    expect(device.remote.queueLength).toBe(1);
    expect(device.hands.right!.pinchValue).toBe(0);
    runFrame();
    await Promise.all([mode, press]);
    expect(events.map((e) => [e.frame, e.type])).toEqual([[2, 'selectstart']]);
  });

  test('a hand selects only when the pinch reaches its press level', async () => {
    const pinch = (value: number) => {
      const done = device.remote.dispatch('set_select_value', {
        device: 'hand-right',
        value,
      });
      runFrame();
      return done;
    };
    await pinch(0.5);
    await pinch(0.85);
    expect(events).toEqual([]);
    expect(device.hands.right!.inputSource.gamepad!.buttons[0]!.pressed).toBe(
      false,
    );
    await pinch(0.95);
    expect(events.map((e) => e.type)).toEqual(['selectstart']);
    await pinch(0.75); // above the release level: still held
    expect(events.map((e) => e.type)).toEqual(['selectstart']);
    await pinch(0.6);
    expect(events.map((e) => e.type)).toEqual([
      'selectstart',
      'select',
      'selectend',
    ]);
  });

  test('rejects out-of-range and NaN select values', async () => {
    for (const value of [1.5, -0.1, Number.NaN]) {
      const result = device.remote.dispatch('set_select_value', {
        device: 'hand-right',
        value,
      }) as Promise<unknown>;
      runFrame();
      await expect(result).rejects.toThrow('within [0, 1]');
    }
  });

  test('forceRelease ends a held select without completing it', async () => {
    const press = device.remote.dispatch('set_select_value', {
      device: 'hand-right',
      value: 1,
    });
    runFrame();
    await press;
    device.remote.forceRelease();
    runFrame();
    expect(events.map((e) => e.type)).toEqual(['selectstart', 'selectend']);
  });

  test('a set_device_state reset ends held selects without completing them', async () => {
    const press = device.remote.dispatch('set_select_value', {
      device: 'controller-right',
      value: 1,
    });
    runFrame();
    await press;
    const reset = device.remote.dispatch('set_device_state', {});
    runFrame();
    await reset;
    runFrame();
    expect(events.map((e) => e.type)).toEqual(['selectstart', 'selectend']);
  });
});

describe('remote control queue watchdog', () => {
  let device: XRDevice;
  let events: string[];
  let frame: XRFrame;

  beforeEach(() => {
    jest.useFakeTimers();
    device = new XRDevice(metaQuest3);
    const mockSession = {
      mode: 'immersive-vr',
      [P_SESSION]: {
        referenceSpaces: [{ [P_SPACE]: { offsetMatrix: mat4.create() } }],
      },
      dispatchEvent: (event: { type: string }) => {
        events.push(event.type);
        return true;
      },
    };
    Object.defineProperty(device, 'activeSession', {
      get: () => mockSession,
      configurable: true,
    });
    frame = { session: mockSession } as unknown as XRFrame;
    events = [];
  });

  afterEach(() => {
    device.remote.forceRelease();
    jest.useRealTimers();
  });

  test('a command queued behind a 12 s animation survives while frames arrive', async () => {
    const animation = device.remote.dispatch('animate_to', {
      device: 'headset',
      position: { x: 0, y: 1.6, z: -1 },
      duration: 12,
    });
    const behind = device.remote.dispatch('set_transform', {
      device: 'hand-right',
      position: { x: 0.2, y: 1.2, z: -0.3 },
    });
    // 13 s of frames at 10 Hz, advancing timers alongside.
    for (let t = 0; t < 13000; t += 100) {
      jest.advanceTimersByTime(100);
      device.remote.update(100);
    }
    await expect(animation).resolves.toBeDefined();
    await expect(behind).resolves.toBeDefined();
  });

  test('rejects queued commands when frames stop arriving', async () => {
    const queued = device.remote.dispatch('set_transform', {
      device: 'hand-right',
      position: { x: 0.2, y: 1.2, z: -0.3 },
    }) as Promise<unknown>;
    jest.advanceTimersByTime(device.remote.ACTION_TIMEOUT_MS + 1);
    await expect(queued).rejects.toThrow('timed out');
  });

  test('when frames stop, a held select is ended without completing it', async () => {
    const press = device.remote.dispatch('set_select_value', {
      device: 'controller-right',
      value: 1,
    });
    device.remote.update(16.67);
    device.controllers.right!.onFrameStart(frame);
    await press;
    const queued = device.remote.dispatch('set_transform', {
      device: 'hand-right',
      position: { x: 0.2, y: 1.2, z: -0.3 },
    }) as Promise<unknown>;
    jest.advanceTimersByTime(device.remote.ACTION_TIMEOUT_MS + 1);
    await expect(queued).rejects.toThrow('timed out');
    // The next frame (whenever it comes) ends the press.
    device.controllers.right!.onFrameStart(frame);
    expect(events).toEqual(['selectstart', 'selectend']);
    expect(
      device.controllers.right!.inputSource.gamepad!.buttons[0]!.value,
    ).toBe(0);
  });
});
