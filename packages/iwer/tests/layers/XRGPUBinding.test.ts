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
  type XRSessionInit,
} from '../../src/session/XRSession.js';
import { XRWebGLLayer } from '../../src/layers/XRWebGLLayer.js';
import { XRSystem } from '../../src/initialization/XRSystem.js';
import { metaQuestTouchPlus } from '../../src/device/configs/controller/meta.js';
import { P_DEVICE, P_SYSTEM } from '../../src/private.js';

const deviceConfig: XRDeviceConfig = {
  name: 'Test Device',
  controllerConfig: metaQuestTouchPlus,
  supportedSessionModes: ['inline', 'immersive-vr', 'immersive-ar'],
  supportedFeatures: ['viewer', 'local', 'local-floor'],
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

describe('XRGPUBinding', () => {
  let xrDevice: XRDevice;
  let xrSystem: XRSystem;

  const requestWebGPUSession = () =>
    xrSystem.requestSession('immersive-vr', { requiredFeatures: ['webgpu'] });

  beforeEach(() => {
    jest.useFakeTimers();
    Object.defineProperty(window, 'innerWidth', {
      value: 1200,
      configurable: true,
    });
    Object.defineProperty(window, 'innerHeight', {
      value: 800,
      configurable: true,
    });
    Object.defineProperty(navigator, 'gpu', {
      value: {
        getPreferredCanvasFormat: () => 'bgra8unorm',
        requestAdapter: jest.fn(async () => ({})),
      },
      configurable: true,
    });
    xrDevice = new XRDevice(deviceConfig);
    xrSystem = new XRSystem(xrDevice);
  });

  afterEach(async () => {
    await xrSystem[P_SYSTEM].activeSession?.end();
    delete (navigator as any).gpu;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe("'webgpu' session feature", () => {
    test('is granted as a required or optional feature when a WebGPU adapter is available', async () => {
      const required = await requestWebGPUSession();
      expect(required.enabledFeatures).toContain('webgpu');
      await required.end();

      const optional = await xrSystem.requestSession('immersive-ar', {
        optionalFeatures: ['webgpu'],
      });
      expect(optional.enabledFeatures).toContain('webgpu');
    });

    test('is rejected when required and dropped when optional without navigator.gpu', async () => {
      delete (navigator as any).gpu;
      await expect(requestWebGPUSession()).rejects.toThrow();

      const session = await xrSystem.requestSession('immersive-vr', {
        optionalFeatures: ['webgpu'],
      });
      expect(session.enabledFeatures).not.toContain('webgpu');
    });

    test('is not granted when no adapter is available, so WebGL fallbacks still work', async () => {
      (navigator.gpu.requestAdapter as jest.Mock).mockResolvedValue(null);
      await expect(requestWebGPUSession()).rejects.toThrow();

      const session = await xrSystem.requestSession('immersive-vr', {
        optionalFeatures: ['webgpu'],
      });
      expect(session.enabledFeatures).not.toContain('webgpu');
      expect(() => new XRWebGLLayer(session, {} as any)).not.toThrow();
    });

    test('treats a failed or hanging adapter request as unavailable', async () => {
      (navigator.gpu.requestAdapter as jest.Mock).mockRejectedValue(
        new Error('no adapter'),
      );
      const failed = await xrSystem.requestSession('immersive-vr', {
        optionalFeatures: ['webgpu'],
      });
      expect(failed.enabledFeatures).not.toContain('webgpu');
      await failed.end();

      Object.defineProperty(navigator, 'gpu', {
        value: {
          getPreferredCanvasFormat: () => 'bgra8unorm',
          requestAdapter: jest.fn(() => new Promise(() => {})),
        },
        configurable: true,
      });
      const pending = xrSystem.requestSession('immersive-vr', {
        optionalFeatures: ['webgpu'],
      });
      await jest.advanceTimersByTimeAsync(2000);
      const hung = await pending;
      expect(hung.enabledFeatures).not.toContain('webgpu');
      await hung.end();

      // Later requests don't wait for a check that already timed out.
      const next = await xrSystem.requestSession('immersive-vr', {
        optionalFeatures: ['webgpu'],
      });
      expect(next.enabledFeatures).not.toContain('webgpu');
    });

    test('uses the real adapter result once a slow check finishes', async () => {
      Object.defineProperty(navigator, 'gpu', {
        value: {
          getPreferredCanvasFormat: () => 'bgra8unorm',
          requestAdapter: jest.fn(
            () => new Promise((resolve) => setTimeout(() => resolve({}), 2500)),
          ),
        },
        configurable: true,
      });
      const pending = xrSystem.requestSession('immersive-vr', {
        optionalFeatures: ['webgpu'],
      });
      await jest.advanceTimersByTimeAsync(2000);
      const early = await pending;
      expect(early.enabledFeatures).not.toContain('webgpu');
      await early.end();

      await jest.advanceTimersByTimeAsync(500);
      const later = await xrSystem.requestSession('immersive-vr', {
        optionalFeatures: ['webgpu'],
      });
      expect(later.enabledFeatures).toContain('webgpu');
      expect(navigator.gpu.requestAdapter).toHaveBeenCalledTimes(1);
    });

    test('probes for an XR-compatible adapter like WebXR apps do', async () => {
      await (await requestWebGPUSession()).end();
      expect(navigator.gpu.requestAdapter).toHaveBeenCalledWith({
        xrCompatible: true,
      });
    });

    test('is not granted alongside the WebGL layers polyfill', async () => {
      xrDevice[P_DEVICE].polyfillLayers = true;
      const session = await xrSystem.requestSession('immersive-vr', {
        optionalFeatures: ['webgpu'],
      });
      expect(session.enabledFeatures).not.toContain('webgpu');
      expect(navigator.gpu.requestAdapter).not.toHaveBeenCalled();
    });

    test('a newer WebGPU offer replaces the pending offer right away', async () => {
      Object.defineProperty(navigator, 'gpu', {
        value: {
          getPreferredCanvasFormat: () => 'bgra8unorm',
          requestAdapter: jest.fn(() => new Promise(() => {})),
        },
        configurable: true,
      });
      const olderOffer = xrSystem.offerSession('immersive-vr', {
        optionalFeatures: ['local-floor'],
      });
      const olderResult = expect(olderOffer).rejects.toThrow('superseded');
      const newerOptions: XRSessionInit = { optionalFeatures: ['webgpu'] };
      xrSystem.offerSession('immersive-vr', newerOptions).catch(() => {});
      await jest.advanceTimersByTimeAsync(0);

      expect(xrSystem[P_SYSTEM].offeredSessionConfig?.options).toBe(
        newerOptions,
      );
      await olderResult;
    });

    test('a granted WebGPU offer gets the feature', async () => {
      xrDevice[P_DEVICE].xrSystem = xrSystem;
      const offer = xrSystem.offerSession('immersive-vr', {
        requiredFeatures: ['webgpu'],
      });
      await jest.advanceTimersByTimeAsync(0);

      xrDevice.grantOfferedSession();
      const session = await offer;
      expect(session.enabledFeatures).toContain('webgpu');
    });

    test('probes the adapter once, and only for sessions that request webgpu', async () => {
      const requestAdapter = navigator.gpu.requestAdapter as jest.Mock;
      const plain = await xrSystem.requestSession('immersive-vr', {
        optionalFeatures: ['local-floor'],
      });
      expect(requestAdapter).not.toHaveBeenCalled();
      await plain.end();

      await (await requestWebGPUSession()).end();
      await (await requestWebGPUSession()).end();
      expect(requestAdapter).toHaveBeenCalledTimes(1);
    });

    test('is not supported for inline sessions', async () => {
      await expect(
        xrSystem.requestSession('inline', { requiredFeatures: ['webgpu'] }),
      ).rejects.toThrow();

      const session = await xrSystem.requestSession('inline', {
        optionalFeatures: ['webgpu'],
      });
      expect(session.enabledFeatures).not.toContain('webgpu');
    });
  });
});
