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
  type XRSessionInit,
} from '../../src/session/XRSession.js';
import {
  XRGPUBinding,
  XRGPUSubImage,
  XRSubImage,
} from '../../src/layers/XRGPUBinding.js';
import {
  XRCompositionLayer,
  XRProjectionLayer,
} from '../../src/layers/XRProjectionLayer.js';
import { XRLayer, XRWebGLLayer } from '../../src/layers/XRWebGLLayer.js';
import { XRFrame } from '../../src/frameloop/XRFrame.js';
import {
  XRReferenceSpace,
  XRReferenceSpaceType,
} from '../../src/spaces/XRReferenceSpace.js';
import { XRSystem } from '../../src/initialization/XRSystem.js';
import { XRView } from '../../src/views/XRView.js';
import { XRWebGLBinding } from '../../src/depth/XRWebGLBinding.js';
import { metaQuestTouchPlus } from '../../src/device/configs/controller/meta.js';
import {
  P_DEVICE,
  P_PROJECTION_LAYER,
  P_SYSTEM,
  P_WEBGL_LAYER,
} from '../../src/private.js';

const RENDER_ATTACHMENT = 0x10;
const TEXTURE_BINDING = 0x04;
const COPY_SRC = 0x01;

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

const createMockTexture = (descriptor: any) => ({
  label: descriptor.label,
  width: descriptor.size[0],
  height: descriptor.size[1],
  depthOrArrayLayers: descriptor.size[2],
  format: descriptor.format,
  usage: descriptor.usage,
  createView: jest.fn((viewDescriptor?: any) => ({ viewDescriptor })),
  destroy: jest.fn(),
});

const createMockGPUDevice = () => {
  const renderPasses: any[] = [];
  let resolveLost: (info: unknown) => void = () => {};
  const device = {
    features: new Set<string>(),
    limits: { maxTextureDimension2D: 8192 },
    lost: new Promise((resolve) => {
      resolveLost = resolve;
    }),
    createTexture: jest.fn(createMockTexture),
    createShaderModule: jest.fn(() => ({})),
    createRenderPipeline: jest.fn(() => ({
      getBindGroupLayout: jest.fn(() => ({})),
    })),
    createSampler: jest.fn(() => ({})),
    createBuffer: jest.fn((descriptor: any) => ({ ...descriptor })),
    createBindGroup: jest.fn(() => ({})),
    createCommandEncoder: jest.fn(() => ({
      beginRenderPass: jest.fn((descriptor: any) => {
        const pass = {
          descriptor,
          setPipeline: jest.fn(),
          setBindGroup: jest.fn(),
          setViewport: jest.fn(),
          draw: jest.fn(),
          end: jest.fn(),
        };
        renderPasses.push(pass);
        return pass;
      }),
      finish: jest.fn(() => ({})),
    })),
    queue: { submit: jest.fn(), writeBuffer: jest.fn() },
  };
  return {
    device: device as any,
    renderPasses,
    lose: () => resolveLost({ reason: 'destroyed', message: '' }),
  };
};

const createMockCanvasContext = () => ({
  configure: jest.fn(),
  unconfigure: jest.fn(),
  getCurrentTexture: jest.fn(() => ({ createView: jest.fn(() => ({})) })),
});

const invalidState = expect.objectContaining({ name: 'InvalidStateError' });
const notSupported = expect.objectContaining({ name: 'NotSupportedError' });

// Runs one emulated device frame with `callback` as its only rAF callback.
const runFrame = (
  session: XRSession,
  callback: (frame: XRFrame) => void = () => {},
) => {
  session.requestAnimationFrame((_time, frame) => callback(frame));
  jest.runOnlyPendingTimers();
};

describe('XRGPUBinding', () => {
  let xrDevice: XRDevice;
  let xrSystem: XRSystem;
  let gpu: ReturnType<typeof createMockGPUDevice>;
  let canvasContext: ReturnType<typeof createMockCanvasContext>;

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
    gpu = createMockGPUDevice();
    canvasContext = createMockCanvasContext();
    jest
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(((type: string) =>
        type === 'webgpu' ? canvasContext : null) as any);
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

  describe('constructor', () => {
    test('throws InvalidStateError for an ended session', async () => {
      const session = await requestWebGPUSession();
      await session.end();
      expect(() => new XRGPUBinding(session, gpu.device)).toThrow(invalidState);
    });

    test('throws InvalidStateError for a session without the webgpu feature', async () => {
      const session = await xrSystem.requestSession('immersive-vr');
      expect(() => new XRGPUBinding(session, gpu.device)).toThrow(invalidState);
    });
  });

  describe('with a WebGPU session', () => {
    let session: XRSession;
    let binding: XRGPUBinding;

    beforeEach(async () => {
      session = await requestWebGPUSession();
      binding = new XRGPUBinding(session, gpu.device);
    });

    test('reports the preferred color format and scale factors', () => {
      expect(binding.getPreferredColorFormat()).toBe('bgra8unorm');
      expect(binding.nativeProjectionScaleFactor).toBe(1);
      expect(binding.usesDepthValues).toBe(false);
    });

    test('throws InvalidStateError once the GPU device is lost', async () => {
      gpu.lose();
      await Promise.resolve();
      expect(() =>
        binding.createProjectionLayer({ colorFormat: 'rgba8unorm' }),
      ).toThrow(invalidState);
      expect(() => new XRGPUBinding(session, gpu.device)).toThrow(invalidState);
    });

    test('XRWebGLLayer and XRWebGLBinding reject WebGPU sessions', () => {
      const gl = {} as any;
      expect(() => new XRWebGLLayer(session, gl)).toThrow(invalidState);
      expect(() => new XRWebGLBinding(session, gl)).toThrow(invalidState);
    });

    describe('createProjectionLayer', () => {
      const textureDescriptor = (index = 0) =>
        gpu.device.createTexture.mock.calls[index][0];

      test('requires a colorFormat', () => {
        expect(() => binding.createProjectionLayer({} as any)).toThrow(
          TypeError,
        );
        expect(() => (binding as any).createProjectionLayer()).toThrow(
          TypeError,
        );
      });

      test('rejects unsupported formats with NotSupportedError', () => {
        expect(() =>
          binding.createProjectionLayer({ colorFormat: 'rgba8unorm-srgb' }),
        ).toThrow(notSupported);
        expect(() =>
          binding.createProjectionLayer({
            colorFormat: 'rgba8unorm',
            depthStencilFormat: 'rgba8unorm',
          }),
        ).toThrow(notSupported);
        expect(gpu.device.createTexture).not.toHaveBeenCalled();
      });

      test('allocates a two-layer texture array on the binding device', () => {
        const layer = binding.createProjectionLayer({
          colorFormat: 'rgba8unorm',
        });

        expect(gpu.device.createTexture).toHaveBeenCalledTimes(1);
        expect(textureDescriptor()).toMatchObject({
          size: [1200, 800, 2],
          format: 'rgba8unorm',
          dimension: '2d',
          mipLevelCount: 1,
          sampleCount: 1,
        });
        expect(textureDescriptor().usage).toBe(
          RENDER_ATTACHMENT | TEXTURE_BINDING,
        );
        expect(layer).toMatchObject({
          textureWidth: 1200,
          textureHeight: 800,
          textureArrayLength: 2,
        });
      });

      test('adds the requested texture usage', () => {
        binding.createProjectionLayer({
          colorFormat: 'rgba16float',
          textureUsage: COPY_SRC,
        });
        expect(textureDescriptor().usage).toBe(
          COPY_SRC | RENDER_ATTACHMENT | TEXTURE_BINDING,
        );
      });

      test('sizes each view to half the window in stereo', () => {
        xrDevice.stereoEnabled = true;
        const layer = binding.createProjectionLayer({
          colorFormat: 'bgra8unorm',
        });
        expect([layer.textureWidth, layer.textureHeight]).toEqual([600, 800]);
      });

      test('clamps scaleFactor between 0.2 and 1', () => {
        const size = (scaleFactor: number) => {
          const layer = binding.createProjectionLayer({
            colorFormat: 'rgba8unorm',
            scaleFactor,
          });
          return [layer.textureWidth, layer.textureHeight];
        };
        expect(size(0.5)).toEqual([600, 400]);
        expect(size(0.1)).toEqual([240, 160]);
        expect(size(2)).toEqual([1200, 800]);
      });

      test('scales down to maxTextureDimension2D keeping the aspect ratio', () => {
        gpu.device.limits.maxTextureDimension2D = 600;
        const layer = binding.createProjectionLayer({
          colorFormat: 'rgba8unorm',
        });
        expect([layer.textureWidth, layer.textureHeight]).toEqual([600, 400]);
      });

      test('allocates a matching depth/stencil texture when requested', () => {
        binding.createProjectionLayer({
          colorFormat: 'rgba8unorm',
          depthStencilFormat: 'depth24plus',
        });
        expect(gpu.device.createTexture).toHaveBeenCalledTimes(2);
        expect(textureDescriptor(1)).toMatchObject({
          size: [1200, 800, 2],
          format: 'depth24plus',
          dimension: '2d',
          mipLevelCount: 1,
          sampleCount: 1,
        });
      });

      test('ignores unknown init members', () => {
        expect(() =>
          binding.createProjectionLayer({
            colorFormat: 'rgba8unorm',
            textureType: 'texture',
          } as any),
        ).not.toThrow();
      });

      test('exposes the projection layer attributes', () => {
        const layer = binding.createProjectionLayer({
          colorFormat: 'rgba8unorm',
        });
        expect(layer).toBeInstanceOf(XRProjectionLayer);
        expect(layer).toBeInstanceOf(XRCompositionLayer);
        expect(layer).toBeInstanceOf(XRLayer);
        expect(layer).toMatchObject({
          layout: 'default',
          isStatic: false,
          needsRedraw: true,
          mipLevels: 1,
          ignoreDepthValues: true,
          fixedFoveation: null,
          deltaPose: null,
          blendTextureSourceAlpha: true,
          forceMonoPresentation: false,
          opacity: 1,
          quality: 'default',
        });

        layer.fixedFoveation = 0.5;
        layer.deltaPose = {} as any;
        layer.opacity = 0.25;
        layer.quality = 'text-optimized';
        layer.blendTextureSourceAlpha = false;
        layer.forceMonoPresentation = true;
        expect(layer).toMatchObject({
          fixedFoveation: null,
          deltaPose: null,
          opacity: 0.25,
          quality: 'text-optimized',
          blendTextureSourceAlpha: false,
          forceMonoPresentation: true,
        });

        layer.opacity = 2;
        expect(layer.opacity).toBe(1);
        layer.opacity = -1;
        expect(layer.opacity).toBe(0);
      });

      test('clears depth to 1.0 when a layer with depth is created', () => {
        binding.createProjectionLayer({ colorFormat: 'rgba8unorm' });
        expect(gpu.device.queue.submit).not.toHaveBeenCalled();

        binding.createProjectionLayer({
          colorFormat: 'rgba8unorm',
          depthStencilFormat: 'depth24plus',
        });
        expect(gpu.device.queue.submit).toHaveBeenCalledTimes(1);
        expect(gpu.renderPasses).toHaveLength(2);
        gpu.renderPasses.forEach((pass) => {
          expect(pass.descriptor.depthStencilAttachment).toMatchObject({
            depthClearValue: 1,
            depthLoadOp: 'clear',
          });
        });
      });

      test('rejects usages and formats the device cannot create', () => {
        const STORAGE_BINDING = 0x08;
        const create = (init: object) => () =>
          binding.createProjectionLayer({ colorFormat: 'rgba8unorm', ...init });
        expect(
          create({
            colorFormat: 'bgra8unorm',
            textureUsage: 0x10 | STORAGE_BINDING,
          }),
        ).toThrow(notSupported);
        expect(
          create({
            depthStencilFormat: 'depth24plus',
            textureUsage: 0x10 | STORAGE_BINDING,
          }),
        ).toThrow(notSupported);
        expect(create({ depthStencilFormat: 'depth32float-stencil8' })).toThrow(
          notSupported,
        );
        expect(create({ textureUsage: 0x10 | 0x20 })).toThrow(notSupported);
        expect(create({ textureUsage: 0x10 | STORAGE_BINDING })).not.toThrow();

        gpu.device.features.add('bgra8unorm-storage');
        gpu.device.features.add('depth32float-stencil8');
        expect(
          create({
            colorFormat: 'bgra8unorm',
            textureUsage: 0x10 | STORAGE_BINDING,
          }),
        ).not.toThrow();
        expect(
          create({ depthStencilFormat: 'depth32float-stencil8' }),
        ).not.toThrow();
      });

      test('destroy() destroys the layer textures', () => {
        const layer = binding.createProjectionLayer({
          colorFormat: 'rgba8unorm',
          depthStencilFormat: 'depth32float',
        });
        layer.destroy();
        gpu.device.createTexture.mock.results.forEach(({ value }: any) => {
          expect(value.destroy).toHaveBeenCalled();
        });
      });

      test('throws InvalidStateError once the session has ended', async () => {
        await session.end();
        expect(() =>
          binding.createProjectionLayer({ colorFormat: 'rgba8unorm' }),
        ).toThrow(invalidState);
      });
    });

    describe('updateRenderState', () => {
      test('applies the layers on the next frame as a frozen copy', () => {
        const initialLayers = session.renderState.layers;
        expect(initialLayers).toEqual([]);

        const layer = binding.createProjectionLayer({
          colorFormat: 'rgba8unorm',
        });
        const layers = [layer];
        session.updateRenderState({ layers });
        expect(session.renderState.layers).toBe(initialLayers);

        runFrame(session);
        expect(session.renderState.layers).toEqual([layer]);
        expect(session.renderState.layers).not.toBe(layers);
        expect(Object.isFrozen(session.renderState.layers)).toBe(true);
      });

      test('rejects a baseLayer', () => {
        const baseLayer = { [P_WEBGL_LAYER]: { session } } as any;
        expect(() => session.updateRenderState({ baseLayer })).toThrow(
          invalidState,
        );
      });

      test('rejects more than one layer', () => {
        const layers = [
          binding.createProjectionLayer({ colorFormat: 'rgba8unorm' }),
          binding.createProjectionLayer({ colorFormat: 'rgba8unorm' }),
        ];
        expect(() => session.updateRenderState({ layers })).toThrow(
          notSupported,
        );
      });

      test('rejects layers that are not WebGPU projection layers', () => {
        expect(() =>
          session.updateRenderState({ layers: [new XRLayer()] }),
        ).toThrow(notSupported);
      });

      test('rejects a layer from another session', async () => {
        const otherSystem = new XRSystem(new XRDevice(deviceConfig));
        const otherSession = await otherSystem.requestSession('immersive-vr', {
          requiredFeatures: ['webgpu'],
        });
        const otherLayer = new XRGPUBinding(
          otherSession,
          gpu.device,
        ).createProjectionLayer({ colorFormat: 'rgba8unorm' });

        expect(() =>
          session.updateRenderState({ layers: [otherLayer] }),
        ).toThrow(invalidState);
        await otherSession.end();
      });

      test('rejects a destroyed layer', () => {
        const layer = binding.createProjectionLayer({
          colorFormat: 'rgba8unorm',
        });
        layer.destroy();
        expect(() => session.updateRenderState({ layers: [layer] })).toThrow(
          invalidState,
        );
      });

      test('sessions without the webgpu feature ignore layers', async () => {
        expect('layers' in session.renderState).toBe(true);
        await session.end();
        const webglSession = await xrSystem.requestSession('immersive-vr');
        expect(webglSession.renderState.layers).toBeUndefined();
        expect('layers' in webglSession.renderState).toBe(false);

        webglSession.updateRenderState({ layers: [new XRLayer()] });
        jest.runOnlyPendingTimers();
        expect(webglSession.renderState.layers).toBeUndefined();
        expect('layers' in webglSession.renderState).toBe(false);
      });

      test('ending the session destroys every layer it created', async () => {
        const unused = binding.createProjectionLayer({
          colorFormat: 'rgba8unorm',
        });
        const replaced = binding.createProjectionLayer({
          colorFormat: 'rgba8unorm',
        });
        const active = binding.createProjectionLayer({
          colorFormat: 'rgba8unorm',
        });
        const pending = binding.createProjectionLayer({
          colorFormat: 'rgba8unorm',
        });
        session.updateRenderState({ layers: [replaced] });
        runFrame(session);
        session.updateRenderState({ layers: [active] });
        runFrame(session);
        session.updateRenderState({ layers: [pending] });

        await session.end();
        for (const layer of [unused, replaced, active, pending]) {
          expect(
            layer[P_PROJECTION_LAYER].colorTexture.destroy,
          ).toHaveBeenCalledTimes(1);
        }
        // destroy() is idempotent
        active.destroy();
        expect(
          active[P_PROJECTION_LAYER].colorTexture.destroy,
        ).toHaveBeenCalledTimes(1);
      });
    });

    describe('frames', () => {
      let layer: XRProjectionLayer;
      let refSpace: XRReferenceSpace;

      const views = (frame: XRFrame) => frame.getViewerPose(refSpace)!.views;

      beforeEach(async () => {
        layer = binding.createProjectionLayer({ colorFormat: 'bgra8unorm' });
        session.updateRenderState({ layers: [layer] });
        refSpace = await session.requestReferenceSpace(
          XRReferenceSpaceType.Local,
        );
      });

      test('run animation frame callbacks with only a projection layer', () => {
        const callback = jest.fn();
        runFrame(session, callback);
        expect(callback).toHaveBeenCalledTimes(1);
      });

      test('getViewSubImage returns the layer texture and per-view descriptors', () => {
        let subImages: XRGPUSubImage[] = [];
        runFrame(session, (frame) => {
          subImages = views(frame).map((view) =>
            binding.getViewSubImage(layer, view),
          );
        });

        const colorTexture = gpu.device.createTexture.mock.results[0].value;
        expect(subImages).toHaveLength(2);
        subImages.forEach((subImage, index) => {
          expect(subImage).toBeInstanceOf(XRGPUSubImage);
          expect(subImage).toBeInstanceOf(XRSubImage);
          expect(subImage.colorTexture).toBe(colorTexture);
          expect(subImage.depthStencilTexture).toBeNull();
          expect(subImage.motionVectorTexture).toBeNull();
          expect(subImage.viewport).toMatchObject({
            x: 0,
            y: 0,
            width: 1200,
            height: 800,
          });
          const descriptor = subImage.getViewDescriptor();
          expect(descriptor).toEqual({
            dimension: '2d',
            mipLevelCount: 1,
            arrayLayerCount: 1,
            baseArrayLayer: index,
          });
          expect(subImage.getViewDescriptor()).not.toBe(descriptor);
        });
      });

      test('getViewSubImage returns the depth/stencil texture when the layer has one', () => {
        const depthLayer = binding.createProjectionLayer({
          colorFormat: 'bgra8unorm',
          depthStencilFormat: 'depth24plus',
        });
        session.updateRenderState({ layers: [depthLayer] });
        let subImage: XRGPUSubImage | undefined;
        runFrame(session, (frame) => {
          subImage = binding.getViewSubImage(depthLayer, views(frame)[1]);
        });
        // [0] is the beforeEach layer; [1] and [2] belong to depthLayer.
        const depthTexture = gpu.device.createTexture.mock.results[2].value;
        expect(depthTexture.format).toBe('depth24plus');
        expect(subImage!.depthStencilTexture).toBe(depthTexture);
      });

      test('getViewSubImage throws InvalidStateError outside an animation frame', () => {
        let view: XRView | undefined;
        runFrame(session, (frame) => {
          view = views(frame)[0];
        });
        expect(() => binding.getViewSubImage(layer, view!)).toThrow(
          invalidState,
        );
      });

      test('getViewSubImage validates the layer', () => {
        const otherLayer = binding.createProjectionLayer({
          colorFormat: 'bgra8unorm',
        });
        const errors: unknown[] = [];
        const attempt = (action: () => void) => {
          try {
            action();
          } catch (error) {
            errors.push(error);
          }
        };
        runFrame(session, (frame) => {
          const [view] = views(frame);
          attempt(() => binding.getViewSubImage(otherLayer, view));
          layer.destroy();
          attempt(() => binding.getViewSubImage(layer, view));
        });
        expect(errors).toHaveLength(2);
        expect(errors[0]).toBeInstanceOf(TypeError);
        expect(errors[1]).toMatchObject({ name: 'InvalidStateError' });
      });

      test('projection matrices use a [0, 1] depth range', () => {
        let projectionMatrix: Float32Array | undefined;
        runFrame(session, (frame) => {
          projectionMatrix = views(frame)[0].projectionMatrix;
        });
        const { depthNear: near, depthFar: far } = session.renderState;
        expect(projectionMatrix![10]).toBeCloseTo(far / (near - far), 5);
        expect(projectionMatrix![14]).toBeCloseTo(
          (far * near) / (near - far),
          5,
        );
      });
    });

    describe('presentation', () => {
      let layer: XRProjectionLayer;

      const useLayer = (depthStencilFormat?: GPUTextureFormat) => {
        layer = binding.createProjectionLayer({
          colorFormat: 'bgra8unorm',
          depthStencilFormat,
        });
        session.updateRenderState({ layers: [layer] });
      };

      beforeEach(() => useLayer());

      test('mounts a WebGPU canvas configured for the layer device', () => {
        runFrame(session);
        const canvas = xrDevice.appCanvas!;
        expect(canvas).toBeInstanceOf(HTMLCanvasElement);
        expect(canvas.parentElement).toBe(xrDevice.canvasContainer);
        expect(xrDevice.canvasContainer.parentElement).toBe(document.body);
        expect([canvas.width, canvas.height]).toEqual([1200, 800]);
        expect(canvasContext.configure).toHaveBeenCalledWith({
          device: gpu.device,
          format: 'bgra8unorm',
          alphaMode: 'premultiplied',
        });
      });

      test('composites every frame with one submit and a cached pipeline', () => {
        runFrame(session);
        expect(gpu.device.queue.submit).toHaveBeenCalledTimes(1);
        runFrame(session);
        expect(gpu.device.queue.submit).toHaveBeenCalledTimes(2);
        expect(gpu.device.createRenderPipeline).toHaveBeenCalledTimes(1);
        expect(gpu.device.createBuffer).toHaveBeenCalledTimes(1);
        expect(gpu.device.createBindGroup).toHaveBeenCalledTimes(1);
      });

      test('draws the left view over the whole canvas in mono', () => {
        runFrame(session);
        const [composite] = gpu.renderPasses;
        expect(composite.descriptor.colorAttachments[0]).toMatchObject({
          loadOp: 'clear',
          storeOp: 'store',
        });
        expect(composite.setViewport.mock.calls).toEqual([
          [0, 0, 1200, 800, 0, 1],
        ]);
        expect(composite.draw.mock.calls).toEqual([[3, 1, 0, 0]]);
      });

      test('draws each view into its half of the canvas in stereo', () => {
        xrDevice.stereoEnabled = true;
        runFrame(session);
        const [composite] = gpu.renderPasses;
        expect(composite.setViewport.mock.calls).toEqual([
          [0, 0, 600, 800, 0, 1],
          [600, 0, 600, 800, 0, 1],
        ]);
        expect(composite.draw.mock.calls).toEqual([
          [3, 1, 0, 0],
          [3, 1, 0, 1],
        ]);
      });

      test('clears every array layer after compositing', () => {
        runFrame(session);
        const clears = gpu.renderPasses.slice(1);
        expect(clears).toHaveLength(2);
        clears.forEach((pass, index) => {
          expect(pass.descriptor.colorAttachments[0]).toMatchObject({
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 0],
            view: {
              viewDescriptor: {
                dimension: '2d',
                baseArrayLayer: index,
                arrayLayerCount: 1,
              },
            },
          });
          expect(pass.descriptor.depthStencilAttachment).toBeUndefined();
        });
      });

      test.each<[GPUTextureFormat, boolean, boolean]>([
        ['depth24plus', true, false],
        ['depth24plus-stencil8', true, true],
        ['stencil8', false, true],
      ])('clears only the aspects of %s', (format, hasDepth, hasStencil) => {
        useLayer(format);
        const before = gpu.renderPasses.length;
        runFrame(session);
        const clears = gpu.renderPasses.slice(before + 1);
        expect(clears).toHaveLength(2);
        clears.forEach((pass) => {
          const attachment = pass.descriptor.depthStencilAttachment;
          expect(attachment.depthClearValue).toBe(hasDepth ? 1 : undefined);
          expect(attachment.depthLoadOp).toBe(hasDepth ? 'clear' : undefined);
          expect(attachment.stencilClearValue).toBe(hasStencil ? 0 : undefined);
          expect(attachment.stencilLoadOp).toBe(
            hasStencil ? 'clear' : undefined,
          );
        });
      });

      test('shows the left view in both eyes when forceMonoPresentation is set', () => {
        xrDevice.stereoEnabled = true;
        layer.forceMonoPresentation = true;
        const before = gpu.renderPasses.length;
        runFrame(session);
        expect(gpu.renderPasses[before].draw.mock.calls).toEqual([
          [3, 1, 0, 0],
          [3, 1, 0, 0],
        ]);
      });

      test('applies the layer opacity and blendTextureSourceAlpha', () => {
        const { writeBuffer, submit } = gpu.device.queue;
        const params = () => [...writeBuffer.mock.lastCall[2]];
        runFrame(session);
        expect(params()).toEqual([1, 1, 0, 0]);
        const buffer = gpu.device.createBuffer.mock.results[0].value;
        expect(writeBuffer.mock.lastCall[0]).toBe(buffer);
        expect(
          gpu.device.createBindGroup.mock.calls[0][0].entries,
        ).toContainEqual({ binding: 2, resource: { buffer } });
        // Written before the submit that draws with it.
        expect(writeBuffer.mock.invocationCallOrder[0]).toBeLessThan(
          submit.mock.invocationCallOrder[0],
        );

        layer.opacity = 0.25;
        layer.blendTextureSourceAlpha = false;
        runFrame(session);
        expect(params()).toEqual([0.25, 0, 0, 0]);
      });

      test('hides the canvas while no usable layer is set', () => {
        runFrame(session);
        const canvas = xrDevice.appCanvas!;
        expect(canvas.style.visibility).toBe('');

        layer.destroy();
        runFrame(session);
        expect(canvas.style.visibility).toBe('hidden');

        session.updateRenderState({ layers: [] });
        runFrame(session);
        expect(canvas.style.visibility).toBe('hidden');

        useLayer();
        runFrame(session);
        expect(canvas.style.visibility).toBe('');
      });

      test('keeps the frame loop running when compositing fails', () => {
        const error = new Error('compositing failed');
        gpu.device.createCommandEncoder.mockImplementation(() => {
          throw error;
        });
        const consoleError = jest
          .spyOn(console, 'error')
          .mockImplementation(() => {});
        const callback = jest.fn();
        runFrame(session, callback);
        runFrame(session, callback);
        expect(callback).toHaveBeenCalledTimes(2);
        expect(consoleError).toHaveBeenCalledWith(error);
      });

      test('skips presentation when the session ends during the frame', () => {
        const consoleError = jest.spyOn(console, 'error');
        runFrame(session, () => {
          session.end();
        });
        expect(gpu.device.queue.submit).not.toHaveBeenCalled();
        expect(consoleError).not.toHaveBeenCalled();
      });

      test('removes the canvas, unconfigures the context and destroys the layer on end', async () => {
        runFrame(session);
        const canvas = xrDevice.appCanvas!;
        await session.end();
        expect(canvas.isConnected).toBe(false);
        expect(xrDevice.canvasContainer.isConnected).toBe(false);
        expect(xrDevice.appCanvas).toBeUndefined();
        expect(canvasContext.unconfigure).toHaveBeenCalled();
        const colorTexture = gpu.device.createTexture.mock.results[0].value;
        expect(colorTexture.destroy).toHaveBeenCalled();
      });
    });
  });

  describe('depth sensing in a WebGPU session', () => {
    let session: XRSession;
    const computeDepthBuffer = jest.fn(
      (
        _view: unknown,
        _projection: unknown,
        width: number,
        height: number,
      ) => ({
        data: new Float32Array(width * height).fill(2).buffer,
        width,
        height,
        rawValueToMeters: 1,
      }),
    );

    beforeEach(async () => {
      computeDepthBuffer.mockClear();
      xrDevice = new XRDevice({
        ...deviceConfig,
        supportedFeatures: [...deviceConfig.supportedFeatures, 'depth-sensing'],
      });
      xrSystem = new XRSystem(xrDevice);
      // A minimal SEM: depth sensing only asks it for depth buffers.
      xrDevice[P_DEVICE].sem = {
        environmentCanvas: document.createElement('canvas'),
        computeDepthBuffer,
      } as any;
      session = await xrSystem.requestSession('immersive-vr', {
        requiredFeatures: ['webgpu', 'depth-sensing'],
        depthSensing: {
          usagePreference: ['gpu-optimized', 'cpu-optimized'],
          dataFormatPreference: ['float32'],
        },
      });
      const binding = new XRGPUBinding(session, gpu.device);
      session.updateRenderState({
        layers: [binding.createProjectionLayer({ colorFormat: 'bgra8unorm' })],
      });
    });

    test('provides CPU-optimized depth sized from the window', async () => {
      expect(session.depthUsage).toBe('cpu-optimized');
      const refSpace = await session.requestReferenceSpace(
        XRReferenceSpaceType.Local,
      );
      const depths: ReturnType<XRFrame['getDepthInformation']>[] = [];
      runFrame(session, (frame) => {
        for (const view of frame.getViewerPose(refSpace)!.views) {
          depths.push(frame.getDepthInformation(view));
        }
      });
      expect(depths.length).toBeGreaterThan(0);
      for (const depth of depths) {
        expect([depth!.width, depth!.height]).toEqual([300, 200]);
        expect(depth!.getDepthInMeters(0.5, 0.5)).toBe(2);
      }
    });

    test('gives SEM a projection with the [-1, 1] depth range it renders with', () => {
      runFrame(session);
      const projection = computeDepthBuffer.mock.calls[0][1] as Float32Array;
      const { depthNear: near, depthFar: far } = session.renderState;
      expect(projection[10]).toBeCloseTo((far + near) / (near - far), 5);
      expect(projection[14]).toBeCloseTo((2 * far * near) / (near - far), 5);
    });
  });
});
