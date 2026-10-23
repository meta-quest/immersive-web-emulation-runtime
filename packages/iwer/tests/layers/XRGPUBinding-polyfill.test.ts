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
import { XRGPUBinding } from '../../src/layers/XRGPUBinding.js';
import { XRRenderState } from '../../src/session/XRRenderState.js';
import { XRSystem } from '../../src/initialization/XRSystem.js';
import { metaQuestTouchPlus } from '../../src/device/configs/controller/meta.js';
import { P_SESSION, P_SYSTEM } from '../../src/private.js';

// The WebGL layers polyfill patches XRSession.prototype for good, so these
// tests live in their own file.
const g = globalThis as Record<string, unknown>;

const deviceConfig: XRDeviceConfig = {
  name: 'Test Device',
  controllerConfig: metaQuestTouchPlus,
  supportedSessionModes: ['inline', 'immersive-vr'],
  // 'layers' shows whether the polyfill's requestSession wrapper dropped it.
  supportedFeatures: ['viewer', 'local', 'local-floor', 'layers' as any],
  supportedFrameRates: [72, 90],
  isSystemKeyboardSupported: true,
  internalNominalFrameRate: 90,
  environmentBlendModes: {
    'immersive-vr': XREnvironmentBlendMode.Opaque,
  },
  interactionMode: XRInteractionMode.WorldSpace,
  userAgent: 'Test user agent',
};

const createMockGPUDevice = () =>
  ({
    features: new Set<string>(),
    limits: { maxTextureDimension2D: 8192 },
    lost: new Promise(() => {}),
    createTexture: jest.fn((descriptor: any) => ({
      width: descriptor.size[0],
      height: descriptor.size[1],
      depthOrArrayLayers: descriptor.size[2],
      format: descriptor.format,
      createView: jest.fn(() => ({})),
      destroy: jest.fn(),
    })),
    createShaderModule: jest.fn(() => ({})),
    createRenderPipeline: jest.fn(() => ({
      getBindGroupLayout: jest.fn(() => ({})),
    })),
    createSampler: jest.fn(() => ({})),
    createBuffer: jest.fn(() => ({})),
    createBindGroup: jest.fn(() => ({})),
    createCommandEncoder: jest.fn(() => ({
      beginRenderPass: jest.fn(() => ({
        setPipeline: jest.fn(),
        setBindGroup: jest.fn(),
        setViewport: jest.fn(),
        draw: jest.fn(),
        end: jest.fn(),
      })),
      finish: jest.fn(() => ({})),
    })),
    queue: { submit: jest.fn(), writeBuffer: jest.fn() },
  }) as any;

describe('XRGPUBinding with the WebGL layers polyfill', () => {
  let xrDevice: XRDevice;
  let xr: XRSystem;

  beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    if (!('WebGL2RenderingContext' in g)) {
      g.WebGL2RenderingContext = class WebGL2RenderingContext {};
    }
    if (!('WebGLRenderingContext' in g)) {
      g.WebGLRenderingContext = class WebGLRenderingContext {};
    }
    xrDevice = new XRDevice(deviceConfig);
    xrDevice.installRuntime({ polyfillLayers: true, forceInstall: true });
    xr = navigator.xr as unknown as XRSystem;
  });

  beforeEach(() => {
    jest.useFakeTimers();
    Object.defineProperty(navigator, 'gpu', {
      value: {
        getPreferredCanvasFormat: () => 'bgra8unorm',
        requestAdapter: jest.fn(async () => ({})),
      },
      configurable: true,
    });
    jest
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(((type: string) =>
        type === 'webgpu'
          ? { configure: jest.fn(), unconfigure: jest.fn() }
          : null) as any);
  });

  afterEach(async () => {
    await xr[P_SYSTEM].activeSession?.end();
    delete (navigator as any).gpu;
    jest.useRealTimers();
  });

  afterAll(() => {
    xrDevice.uninstallRuntime();
    jest.restoreAllMocks();
  });

  test('installs the WebGPU globals', () => {
    expect(g.XRGPUBinding).toBe(XRGPUBinding);
  });

  test('WebGPU sessions bypass the polyfill and render through IWER', async () => {
    const session = await xr.requestSession('immersive-vr', {
      requiredFeatures: ['webgpu', 'layers' as any],
    });
    expect(session.enabledFeatures).toEqual(
      expect.arrayContaining(['webgpu', 'layers']),
    );
    // The polyfill adds its own state to the sessions it sets up.
    expect('taskQueue' in session).toBe(false);

    const layer = new XRGPUBinding(
      session,
      createMockGPUDevice(),
    ).createProjectionLayer({ colorFormat: 'bgra8unorm' });
    session.updateRenderState({ layers: [layer] });
    const callback = jest.fn();
    session.requestAnimationFrame(callback);
    jest.runOnlyPendingTimers();
    expect(session.renderState).toBeInstanceOf(XRRenderState);
    expect(session.renderState.layers).toEqual([layer]);
    expect(session.renderState.baseLayer).toBeNull();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  test('WebGL sessions still go through the polyfill', async () => {
    const session = await xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor'],
    });
    expect(session[P_SESSION].hasWebGPU).toBe(false);
    expect('taskQueue' in session).toBe(true);
    // The polyfill's render state is a plain copy with its own layers list.
    expect(session.renderState).not.toBeInstanceOf(XRRenderState);
  });

  test('a WebGPU request without an adapter falls back to the polyfill', async () => {
    // A fresh GPU object, so the adapter check runs again.
    Object.defineProperty(navigator, 'gpu', {
      value: {
        getPreferredCanvasFormat: () => 'bgra8unorm',
        requestAdapter: jest.fn(async () => null),
      },
      configurable: true,
    });
    const session = await xr.requestSession('immersive-vr', {
      optionalFeatures: ['webgpu'],
    });
    expect(session.enabledFeatures).not.toContain('webgpu');
    expect('taskQueue' in session).toBe(true);
    expect(session).toBeInstanceOf(XRSession);
  });
});
