/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  XRDevice,
  XRDeviceConfig,
  XRDeviceOptions,
} from '../../src/device/XRDevice';
import {
  XREnvironmentBlendMode,
  XRInteractionMode,
  XRSession,
} from '../../src/session/XRSession';
import { XRSystem } from '../../src/initialization/XRSystem';
import { XRWebGLLayer } from '../../src/layers/XRWebGLLayer';
import { metaQuestTouchPlus } from '../../src/device/configs/controller/meta';

// silence console logs
console.log = () => {};

const testDeviceConfig: XRDeviceConfig = {
  name: 'Test Device',
  controllerConfig: metaQuestTouchPlus,
  supportedSessionModes: ['inline', 'immersive-vr', 'immersive-ar'],
  supportedFeatures: ['viewer', 'local'],
  supportedFrameRates: [72, 90],
  isSystemKeyboardSupported: true,
  internalNominalFrameRate: 90,
  environmentBlendModes: {
    'immersive-vr': XREnvironmentBlendMode.Opaque,
    'immersive-ar': XREnvironmentBlendMode.AlphaBlend,
  },
  interactionMode: XRInteractionMode.WorldSpace,
  userAgent: 'Test user agent',
};

function createMockContext() {
  return {
    getParameter: jest.fn(() => [0, 0, 0, 0]),
    clearColor: jest.fn(),
    clearDepth: jest.fn(),
    clearStencil: jest.fn(),
    clear: jest.fn(),
    canvas: document.createElement('canvas'),
  };
}

/** Everything the session and the app do in order, across frames. */
let log: string[] = [];

/** A module that can update and draw separately, as `@iwer/sem` does. */
class SplitSEM {
  environmentCanvas = document.createElement('canvas');
  render = jest.fn(() => log.push('render'));
  update = jest.fn(() => log.push('update'));
  draw = jest.fn(() => log.push('draw'));
}

/** An older or custom module that only renders. */
class RenderOnlySEM {
  environmentCanvas = document.createElement('canvas');
  render = jest.fn(() => log.push('render'));
}

async function startSession(
  mode: XRSessionMode,
  semConstructor: new () => object,
  options: Partial<XRDeviceOptions> = {},
) {
  const device = new XRDevice(testDeviceConfig, options);
  device.installSEM(semConstructor as any);
  const system = new XRSystem(device);
  const session: XRSession = await system.requestSession(mode);
  session.updateRenderState({
    baseLayer: new XRWebGLLayer(session, createMockContext() as any),
  });
  return { device, session, sem: device.sem as any };
}

/**
 * Keep an app frame callback registered for `count` device frames. `onFrame`
 * runs inside each app callback and receives the frame index.
 */
function runFrames(
  session: XRSession,
  count: number,
  onFrame: (index: number) => void = () => {},
) {
  let index = 0;
  const callback = () => {
    log.push('app');
    onFrame(index++);
    session.requestAnimationFrame(callback);
  };
  session.requestAnimationFrame(callback);
  for (let i = 0; i < count; i++) {
    jest.advanceTimersToNextTimer();
  }
}

describe('XRDevice.shouldDrawEnvironment', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    log = [];
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('defaults to null and can be set through XRDeviceOptions and at runtime', () => {
    expect(new XRDevice(testDeviceConfig).shouldDrawEnvironment).toBeNull();
    const gate = () => false;
    const device = new XRDevice(testDeviceConfig, {
      shouldDrawEnvironment: gate,
    });
    expect(device.shouldDrawEnvironment).toBe(gate);
    device.shouldDrawEnvironment = null;
    expect(device.shouldDrawEnvironment).toBeNull();
  });

  test('by default the environment updates before the app and draws after it, every frame', async () => {
    const { session, sem } = await startSession('immersive-ar', SplitSEM);
    runFrames(session, 2);
    expect(log).toEqual(['update', 'app', 'draw', 'update', 'app', 'draw']);
    // render() is the combined path; the session uses the split one.
    expect(sem.render).not.toHaveBeenCalled();
    expect(sem.update).toHaveBeenCalledWith(expect.any(Number));
    session.end();
  });

  test('draws only on frames the gate allows, and keeps updating on the others', async () => {
    const { device, session, sem } = await startSession(
      'immersive-ar',
      SplitSEM,
    );
    let appDrew = false;
    device.shouldDrawEnvironment = jest.fn(() => {
      log.push('gate');
      return appDrew;
    });
    // The app draws on frames 1 and 3 only.
    runFrames(session, 4, (index) => {
      appDrew = index % 2 === 1;
    });

    expect(log).toEqual(
      [
        ['update', 'app', 'gate'],
        ['update', 'app', 'gate', 'draw'],
        ['update', 'app', 'gate'],
        ['update', 'app', 'gate', 'draw'],
      ].flat(),
    );
    expect(sem.update).toHaveBeenCalledTimes(4);
    expect(sem.draw).toHaveBeenCalledTimes(2);
    expect(device.shouldDrawEnvironment).toHaveBeenCalledTimes(4);
    session.end();
  });

  test('a runtime change applies from the next frame', async () => {
    const { device, session, sem } = await startSession(
      'immersive-ar',
      SplitSEM,
    );
    runFrames(session, 1);
    expect(sem.draw).toHaveBeenCalledTimes(1);

    device.shouldDrawEnvironment = () => false;
    jest.advanceTimersToNextTimer();
    expect(sem.update).toHaveBeenCalledTimes(2);
    expect(sem.draw).toHaveBeenCalledTimes(1);

    device.shouldDrawEnvironment = null;
    jest.advanceTimersToNextTimer();
    expect(sem.draw).toHaveBeenCalledTimes(2);
    session.end();
  });

  test('only an explicit false skips the draw', async () => {
    const { device, session, sem } = await startSession(
      'immersive-ar',
      SplitSEM,
    );
    device.shouldDrawEnvironment = () => undefined as unknown as boolean;
    runFrames(session, 1);
    expect(sem.draw).toHaveBeenCalledTimes(1);
    session.end();
  });

  test('a throwing gate draws the environment and reports the error', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('gate failed');
    const { session, sem } = await startSession('immersive-ar', SplitSEM, {
      shouldDrawEnvironment: () => {
        throw failure;
      },
    });
    runFrames(session, 2);
    expect(sem.draw).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(failure);
    session.end();
  });

  test('a session ended by an app callback is not drawn', async () => {
    const { device, session, sem } = await startSession(
      'immersive-ar',
      SplitSEM,
    );
    device.shouldDrawEnvironment = jest.fn(() => true);
    runFrames(session, 1, () => {
      session.end();
    });
    expect(sem.update).toHaveBeenCalledTimes(1);
    expect(sem.draw).not.toHaveBeenCalled();
    expect(device.shouldDrawEnvironment).not.toHaveBeenCalled();
  });

  test('modules that only render() keep rendering before the app every frame', async () => {
    const gate = jest.fn(() => false);
    const { session, sem } = await startSession('immersive-ar', RenderOnlySEM, {
      shouldDrawEnvironment: gate,
    });
    runFrames(session, 2);
    expect(log).toEqual(['render', 'app', 'render', 'app']);
    expect(sem.render).toHaveBeenCalledWith(expect.any(Number));
    expect(gate).not.toHaveBeenCalled();
    session.end();
  });

  test('immersive-vr sessions neither update, draw nor consult the gate', async () => {
    const gate = jest.fn(() => true);
    const { session, sem } = await startSession('immersive-vr', SplitSEM, {
      shouldDrawEnvironment: gate,
    });
    runFrames(session, 2);
    expect(log).toEqual(['app', 'app']);
    expect(sem.update).not.toHaveBeenCalled();
    expect(sem.draw).not.toHaveBeenCalled();
    expect(gate).not.toHaveBeenCalled();
    session.end();
  });
});
