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
    getParameter: jest.fn((param: number) => {
      switch (param) {
        case 0:
          return [0.1, 0.2, 0.3, 1];
        case 1:
          return 0.5;
        case 2:
          return 7;
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
    DEPTH_BUFFER_BIT: 0x100,
    COLOR_BUFFER_BIT: 0x4000,
    STENCIL_BUFFER_BIT: 0x400,
    canvas: document.createElement('canvas'),
  };
}

type MockContext = ReturnType<typeof createMockContext>;

async function startSession(
  mode: XRSessionMode,
  options: Partial<XRDeviceOptions> = {},
): Promise<{ device: XRDevice; session: XRSession; context: MockContext }> {
  const device = new XRDevice(testDeviceConfig, options);
  const system = new XRSystem(device);
  const session = await system.requestSession(mode);
  const context = createMockContext();
  session.updateRenderState({
    baseLayer: new XRWebGLLayer(session, context as any),
  });
  return { device, session, context };
}

/** Run `count` device frames, keeping an app frame callback registered. */
function runFrames(session: XRSession, count: number) {
  const onFrame = () => {
    session.requestAnimationFrame(onFrame);
  };
  session.requestAnimationFrame(onFrame);
  for (let i = 0; i < count; i++) {
    jest.advanceTimersToNextTimer();
  }
}

/**
 * Run `count` device frames with an app frame callback registered, and return
 * a reader for how many app frames have run so far.
 */
function countFrames(session: XRSession, count: number) {
  let frames = 0;
  const onFrame = () => {
    frames++;
    session.requestAnimationFrame(onFrame);
  };
  session.requestAnimationFrame(onFrame);
  for (let i = 0; i < count; i++) {
    jest.advanceTimersToNextTimer();
  }
  return () => frames;
}

describe('XRDevice.frameClearEnabled', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('defaults to true', () => {
    const device = new XRDevice(testDeviceConfig);
    expect(device.frameClearEnabled).toBe(true);
  });

  test('can be set through XRDeviceOptions and at runtime', () => {
    const device = new XRDevice(testDeviceConfig, {
      frameClearEnabled: false,
    });
    expect(device.frameClearEnabled).toBe(false);
    device.frameClearEnabled = true;
    expect(device.frameClearEnabled).toBe(true);
  });

  test('by default, immersive sessions clear every frame and restore clear values', async () => {
    const { session, context } = await startSession('immersive-vr');
    runFrames(session, 3);

    expect(context.clear).toHaveBeenCalledTimes(3);
    expect(context.clear).toHaveBeenCalledWith(
      context.DEPTH_BUFFER_BIT |
        context.COLOR_BUFFER_BIT |
        context.STENCIL_BUFFER_BIT,
    );
    // Cleared to transparent black, then the app's clear values come back.
    expect(context.clearColor).toHaveBeenNthCalledWith(1, 0, 0, 0, 0);
    expect(context.clearColor).toHaveBeenNthCalledWith(2, 0.1, 0.2, 0.3, 1);
    expect(context.clearDepth).toHaveBeenNthCalledWith(1, 1);
    expect(context.clearDepth).toHaveBeenNthCalledWith(2, 0.5);
    expect(context.clearStencil).toHaveBeenNthCalledWith(1, 0);
    expect(context.clearStencil).toHaveBeenNthCalledWith(2, 7);
    session.end();
  });

  test('immersive-ar sessions also clear by default', async () => {
    const { session, context } = await startSession('immersive-ar');
    runFrames(session, 2);
    expect(context.clear).toHaveBeenCalledTimes(2);
    session.end();
  });

  test.each(['immersive-vr', 'immersive-ar'] as XRSessionMode[])(
    'when disabled, %s sessions never touch the framebuffer',
    async (mode) => {
      const { session, context } = await startSession(mode, {
        frameClearEnabled: false,
      });
      const frames = countFrames(session, 3);

      // Frames still run; only the clear is skipped.
      expect(frames()).toBe(3);
      expect(context.clear).not.toHaveBeenCalled();
      expect(context.clearColor).not.toHaveBeenCalled();
      expect(context.clearDepth).not.toHaveBeenCalled();
      expect(context.clearStencil).not.toHaveBeenCalled();
      expect(context.getParameter).not.toHaveBeenCalled();
      session.end();
    },
  );

  test('inline sessions run frames but never clear, whatever the setting', async () => {
    for (const frameClearEnabled of [true, false]) {
      const { session, context } = await startSession('inline', {
        frameClearEnabled,
      });
      const frames = countFrames(session, 2);
      // The frames reached the clear branch and skipped it.
      expect(frames()).toBe(2);
      expect(context.clear).not.toHaveBeenCalled();
      expect(context.getParameter).not.toHaveBeenCalled();
      session.end();
    }
  });

  test('a runtime toggle takes effect on the next frame', async () => {
    const { device, session, context } = await startSession('immersive-vr');
    const frames = countFrames(session, 2);
    expect(context.clear).toHaveBeenCalledTimes(2);

    device.frameClearEnabled = false;
    jest.advanceTimersToNextTimer();
    jest.advanceTimersToNextTimer();
    // Frames keep running while the clear is off.
    expect(frames()).toBe(4);
    expect(context.clear).toHaveBeenCalledTimes(2);

    jest.clearAllMocks();
    device.frameClearEnabled = true;
    jest.advanceTimersToNextTimer();
    expect(frames()).toBe(5);
    expect(context.clear).toHaveBeenCalledTimes(1);
    // Re-enabled clears save and restore the app's clear values again.
    expect(context.clearColor).toHaveBeenNthCalledWith(1, 0, 0, 0, 0);
    expect(context.clearColor).toHaveBeenNthCalledWith(2, 0.1, 0.2, 0.3, 1);
    expect(context.clearDepth).toHaveBeenNthCalledWith(1, 1);
    expect(context.clearDepth).toHaveBeenNthCalledWith(2, 0.5);
    expect(context.clearStencil).toHaveBeenNthCalledWith(1, 0);
    expect(context.clearStencil).toHaveBeenNthCalledWith(2, 7);
    session.end();
  });
});
