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
  XRGPUDepthInformation,
  XRGPUSubImage,
  XRSubImage,
} from '../../src/layers/XRGPUBinding.js';
import type {
  XRDepthDataFormat,
  XRDepthUsage,
} from '../../src/depth/XRDepthInformation.js';
import {
  XRCompositionLayer,
  XRProjectionLayer,
} from '../../src/layers/XRProjectionLayer.js';
import { XRLayer, XRWebGLLayer } from '../../src/layers/XRWebGLLayer.js';
import { XRFrame } from '../../src/frameloop/XRFrame.js';
import { XRRigidTransform } from '../../src/primitives/XRRigidTransform.js';
import {
  XRReferenceSpace,
  XRReferenceSpaceType,
} from '../../src/spaces/XRReferenceSpace.js';
import { XRSystem } from '../../src/initialization/XRSystem.js';
import { XRView } from '../../src/views/XRView.js';
import { XRWebGLBinding } from '../../src/depth/XRWebGLBinding.js';
import { XRViewport } from '../../src/views/XRViewport.js';
import { createMockCanvasContext, createMockGPUDevice } from './mockWebGPU.js';
import { metaQuestTouchPlus } from '../../src/device/configs/controller/meta.js';
import {
  P_COMPOSITION_LAYER,
  P_DEVICE,
  P_PROJECTION_LAYER,
  P_SYSTEM,
  P_WEBGL_LAYER,
} from '../../src/private.js';

const RENDER_ATTACHMENT = 0x10;
const TEXTURE_BINDING = 0x04;
const COPY_DST = 0x02;
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
      await jest.advanceTimersByTimeAsync(10000);
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
            () =>
              new Promise((resolve) => setTimeout(() => resolve({}), 10500)),
          ),
        },
        configurable: true,
      });
      const pending = xrSystem.requestSession('immersive-vr', {
        optionalFeatures: ['webgpu'],
      });
      await jest.advanceTimersByTimeAsync(10000);
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

    test('waits for an adapter that takes a few seconds to answer', async () => {
      Object.defineProperty(navigator, 'gpu', {
        value: {
          getPreferredCanvasFormat: () => 'bgra8unorm',
          requestAdapter: jest.fn(
            () => new Promise((resolve) => setTimeout(() => resolve({}), 5000)),
          ),
        },
        configurable: true,
      });
      const pending = xrSystem.requestSession('immersive-vr', {
        optionalFeatures: ['webgpu'],
      });
      await jest.advanceTimersByTimeAsync(5000);
      const session = await pending;
      expect(session.enabledFeatures).toContain('webgpu');
    });

    test('probes for an XR-compatible adapter like WebXR apps do', async () => {
      await (await requestWebGPUSession()).end();
      expect(navigator.gpu.requestAdapter).toHaveBeenCalledWith({
        xrCompatible: true,
      });
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
      const descriptors = (layer: XRProjectionLayer) =>
        layer[P_COMPOSITION_LAYER].textures.descriptors;

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
      });

      test('describes a two-layer texture array on the binding device', () => {
        const layer = binding.createProjectionLayer({
          colorFormat: 'rgba8unorm',
        });
        const { textures } = layer[P_COMPOSITION_LAYER];
        expect(textures.device).toBe(gpu.device);
        expect(textures.descriptors.color).toMatchObject({
          size: [1200, 800, 2],
          format: 'rgba8unorm',
          dimension: '2d',
          mipLevelCount: 1,
          sampleCount: 1,
          usage: RENDER_ATTACHMENT,
          viewFormats: [],
        });
        expect(textures.descriptors.depthStencil).toBeNull();
        expect(textures.descriptors.motionVector).toBeNull();
        expect(layer).toMatchObject({
          textureWidth: 1200,
          textureHeight: 800,
          textureArrayLength: 2,
        });
        // Textures are made per frame, once the app draws.
        expect(gpu.device.createTexture).not.toHaveBeenCalled();
      });

      test('keeps the requested texture usage', () => {
        const layer = binding.createProjectionLayer({
          colorFormat: 'rgba16float',
          textureUsage: COPY_SRC,
        });
        expect(descriptors(layer).color.usage).toBe(COPY_SRC);
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

      test('describes a matching depth/stencil texture when requested', () => {
        const layer = binding.createProjectionLayer({
          colorFormat: 'rgba8unorm',
          depthStencilFormat: 'depth24plus',
        });
        expect(descriptors(layer).depthStencil).toMatchObject({
          size: [1200, 800, 2],
          format: 'depth24plus',
          dimension: '2d',
          mipLevelCount: 1,
          sampleCount: 1,
          usage: RENDER_ATTACHMENT,
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
          fixedFoveation: 0,
          deltaPose: null,
          blendTextureSourceAlpha: true,
          forceMonoPresentation: false,
          opacity: 1,
          quality: 'default',
        });

        layer.fixedFoveation = 0.5;
        // Without space warp, setting deltaPose does nothing.
        layer.deltaPose = new XRRigidTransform();
        layer.opacity = 0.25;
        layer.quality = 'text-optimized';
        layer.blendTextureSourceAlpha = false;
        layer.forceMonoPresentation = true;
        expect(layer).toMatchObject({
          fixedFoveation: 0.5,
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
        layer.fixedFoveation = 2;
        expect(layer.fixedFoveation).toBe(1);
        layer.fixedFoveation = -1;
        expect(layer.fixedFoveation).toBe(0);
        layer.fixedFoveation = null;
        expect(layer.fixedFoveation).toBe(0);
        expect(() => (layer.fixedFoveation = NaN)).toThrow(TypeError);
        // WebIDL still checks the type.
        expect(() => (layer.deltaPose = {} as any)).toThrow(TypeError);
        // Like any WebIDL enum attribute, unknown qualities are ignored.
        layer.quality = 'sharpest' as any;
        expect(layer.quality).toBe('text-optimized');
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
        expect(create({ textureUsage: 0 })).toThrow(notSupported);
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

      test('destroy() marks the layer destroyed and frees its textures', () => {
        const layer = binding.createProjectionLayer({
          colorFormat: 'rgba8unorm',
          depthStencilFormat: 'depth32float',
        });
        layer.destroy();
        expect(layer[P_COMPOSITION_LAYER].destroyed).toBe(true);
        expect(layer[P_COMPOSITION_LAYER].textures.destroyed).toBe(true);
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

      test('rejects anything that is not an XRLayer', () => {
        expect(() =>
          session.updateRenderState({ layers: [{} as any] }),
        ).toThrow(TypeError);
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
        ).toThrow(TypeError);
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
          expect(layer[P_COMPOSITION_LAYER].destroyed).toBe(true);
          expect(layer[P_COMPOSITION_LAYER].textures.destroyed).toBe(true);
        }
        // destroy() is idempotent
        const destroyTextures = jest.spyOn(
          active[P_COMPOSITION_LAYER].textures,
          'destroy',
        );
        active.destroy();
        expect(destroyTextures).not.toHaveBeenCalled();
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

      test('getViewSubImage returns the frame textures and per-view descriptors', () => {
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
        const depthTexture = gpu.device.createTexture.mock.results[1].value;
        expect(depthTexture.format).toBe('depth24plus');
        expect(subImage!.depthStencilTexture).toBe(depthTexture);
      });

      test('each frame gets new textures, shared by all of its subimages', () => {
        const textures: GPUTexture[][] = [];
        for (let i = 0; i < 2; i++) {
          runFrame(session, (frame) => {
            textures.push(
              views(frame).map(
                (view) => binding.getViewSubImage(layer, view).colorTexture,
              ),
            );
          });
        }
        expect(textures[0][0]).toBe(textures[0][1]);
        expect(textures[1][0]).toBe(textures[1][1]);
        expect(textures[1][0]).not.toBe(textures[0][0]);
        // The app's textures copy out to the compositor, with their usage.
        expect((textures[0][0] as any).usage).toBe(
          RENDER_ATTACHMENT | COPY_SRC,
        );
      });

      test('releases each drawn frame to the compositor and ends write access', () => {
        let colorTexture: GPUTexture | undefined;
        runFrame(session, (frame) => {
          colorTexture = binding.getViewSubImage(
            layer,
            views(frame)[0],
          ).colorTexture;
          expect(layer.needsRedraw).toBe(true);
        });
        const compositorTexture = layer[P_COMPOSITION_LAYER].textures.released!
          .color as any;
        expect(gpu.copies).toEqual([
          expect.objectContaining({
            label: 'IWER layer release',
            source: { texture: colorTexture, mipLevel: 0 },
            destination: { texture: compositorTexture, mipLevel: 0 },
            size: [1200, 800, 2],
          }),
        ]);
        expect(compositorTexture.usage).toBe(TEXTURE_BINDING | COPY_DST);
        expect((colorTexture as any).destroyMock).toHaveBeenCalledTimes(1);
        expect(compositorTexture.destroy).not.toHaveBeenCalled();
        expect(layer.needsRedraw).toBe(false);
        // Copied before the frame's textures were destroyed.
        expect(
          gpu.device.queue.submit.mock.invocationCallOrder[0],
        ).toBeLessThan(
          (colorTexture as any).destroyMock.mock.invocationCallOrder[0],
        );
      });

      test('keeps what was drawn when the app destroys a current texture', () => {
        let colorTexture: any;
        runFrame(session, (frame) => {
          const [left, right] = views(frame);
          colorTexture = binding.getViewSubImage(layer, left).colorTexture;
          // Ends the app's write access...
          colorTexture.destroy();
          expect(colorTexture.destroyMock).toHaveBeenCalledTimes(1);
          // ...and later subimages in the frame give the same texture.
          expect(binding.getViewSubImage(layer, right).colorTexture).toBe(
            colorTexture,
          );
        });
        const compositorTexture =
          layer[P_COMPOSITION_LAYER].textures.released!.color;
        // Copied once, just before it was destroyed.
        expect(gpu.copies).toEqual([
          expect.objectContaining({
            source: { texture: colorTexture, mipLevel: 0 },
            destination: { texture: compositorTexture, mipLevel: 0 },
          }),
        ]);
        expect(
          gpu.device.queue.submit.mock.invocationCallOrder[0],
        ).toBeLessThan(colorTexture.destroyMock.mock.invocationCallOrder[0]);
        expect(colorTexture.destroyMock).toHaveBeenCalledTimes(1);
        expect(gpu.compositorPasses()).toHaveLength(1);
      });

      test('a texture destroyed after its frame is not copied again', () => {
        let colorTexture: any;
        runFrame(session, (frame) => {
          colorTexture = binding.getViewSubImage(
            layer,
            views(frame)[0],
          ).colorTexture;
        });
        colorTexture.destroy();
        runFrame(session, (frame) => {
          binding.getViewSubImage(layer, views(frame)[0]);
          colorTexture.destroy();
        });
        expect(
          gpu.copies.filter((copy) => copy.source.texture === colorTexture),
        ).toHaveLength(1);
        expect(gpu.copies).toHaveLength(2);
      });

      test('the compositor keeps no depth, so destroying it copies nothing', () => {
        const depthLayer = binding.createProjectionLayer({
          colorFormat: 'bgra8unorm',
          depthStencilFormat: 'depth24plus',
        });
        session.updateRenderState({ layers: [depthLayer] });
        runFrame(session, (frame) => {
          binding
            .getViewSubImage(depthLayer, views(frame)[0])
            .depthStencilTexture!.destroy();
        });
        expect(gpu.copies.map((copy) => copy.source.texture.format)).toEqual([
          'bgra8unorm',
        ]);
        expect(
          gpu.device.createCommandEncoder.mock.calls.filter(
            ([descriptor]: any[]) => descriptor?.label === 'IWER layer release',
          ),
        ).toHaveLength(1);
      });

      test.each<[GPUTextureFormat, boolean, boolean]>([
        ['depth24plus', true, false],
        ['depth24plus-stencil8', true, true],
        ['stencil8', false, true],
      ])(
        'clears each frame %s texture to depth 1 and stencil 0',
        (format, hasDepth, hasStencil) => {
          const depthLayer = binding.createProjectionLayer({
            colorFormat: 'bgra8unorm',
            depthStencilFormat: format,
          });
          session.updateRenderState({ layers: [depthLayer] });
          runFrame(session, (frame) => {
            binding.getViewSubImage(depthLayer, views(frame)[0]);
          });
          const clears = gpu.depthClears();
          expect(clears).toHaveLength(2);
          clears.forEach((pass, index) => {
            expect(pass.descriptor.colorAttachments).toEqual([]);
            const attachment = pass.descriptor.depthStencilAttachment;
            expect(attachment.view.viewDescriptor).toMatchObject({
              dimension: '2d',
              baseArrayLayer: index,
              arrayLayerCount: 1,
            });
            expect(attachment.depthClearValue).toBe(hasDepth ? 1 : undefined);
            expect(attachment.depthLoadOp).toBe(hasDepth ? 'clear' : undefined);
            expect(attachment.stencilClearValue).toBe(
              hasStencil ? 0 : undefined,
            );
            expect(attachment.stencilLoadOp).toBe(
              hasStencil ? 'clear' : undefined,
            );
          });
        },
      );

      test("getViewSubImage applies the view's requested viewport scale", () => {
        let viewport: XRViewport | undefined;
        runFrame(session, (frame) => {
          const [view] = views(frame);
          view.requestViewportScale(0.5);
          viewport = binding.getViewSubImage(layer, view).viewport;
        });
        expect(viewport).toMatchObject({ x: 0, y: 0, width: 600, height: 400 });
        expect(layer[P_PROJECTION_LAYER].viewportScales).toEqual([0.5, 1]);
      });

      test('a requested viewport scale lasts until it changes', () => {
        const widths: number[] = [];
        const frameWidth = (request?: number) =>
          runFrame(session, (frame) => {
            const [view] = views(frame);
            if (request !== undefined) {
              view.requestViewportScale(request);
            }
            widths.push(binding.getViewSubImage(layer, view).viewport.width);
          });
        frameWidth(0.5);
        frameWidth();
        frameWidth(1);
        expect(widths).toEqual([600, 600, 1200]);
      });

      test('the viewport scale holds for the rest of a frame once used', () => {
        const widths: number[] = [];
        runFrame(session, (frame) => {
          const [view] = views(frame);
          widths.push(binding.getViewSubImage(layer, view).viewport.width);
          view.requestViewportScale(0.5);
          widths.push(binding.getViewSubImage(layer, view).viewport.width);
        });
        runFrame(session, (frame) => {
          const [view] = views(frame);
          widths.push(binding.getViewSubImage(layer, view).viewport.width);
        });
        expect(widths).toEqual([1200, 1200, 600]);
      });

      test('destroy() frees the frame and compositor textures', () => {
        let colorTexture: any;
        runFrame(session, (frame) => {
          colorTexture = binding.getViewSubImage(
            layer,
            views(frame)[0],
          ).colorTexture;
        });
        const compositorTexture = layer[P_COMPOSITION_LAYER].textures.released!
          .color as any;
        layer.destroy();
        expect(colorTexture.destroyMock).toHaveBeenCalledTimes(1);
        expect(compositorTexture.destroy).toHaveBeenCalledTimes(1);
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
          attempt(() => binding.getViewSubImage({} as any, view));
          layer.destroy();
          attempt(() => binding.getViewSubImage(layer, view));
        });
        expect(errors).toHaveLength(3);
        expect(errors[0]).toBeInstanceOf(TypeError);
        expect(errors[1]).toBeInstanceOf(TypeError);
        expect(errors[2]).toMatchObject({ name: 'InvalidStateError' });
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
      let refSpace: XRReferenceSpace;

      const useLayer = (depthStencilFormat?: GPUTextureFormat) => {
        layer = binding.createProjectionLayer({
          colorFormat: 'bgra8unorm',
          depthStencilFormat,
        });
        session.updateRenderState({ layers: [layer] });
      };
      // Runs a frame in which the app draws the layer, plus `callback`.
      const drawFrame = (callback: (frame: XRFrame) => void = () => {}) =>
        runFrame(session, (frame) => {
          for (const view of frame.getViewerPose(refSpace)!.views) {
            binding.getViewSubImage(layer, view);
          }
          callback(frame);
        });

      beforeEach(async () => {
        useLayer();
        refSpace = await session.requestReferenceSpace(
          XRReferenceSpaceType.Local,
        );
      });

      test('mounts a WebGPU canvas configured for the layer device', () => {
        drawFrame();
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

      test('shows nothing until the layer is first drawn', () => {
        runFrame(session);
        expect(gpu.compositorPasses()).toHaveLength(0);
        expect(xrDevice.appCanvas!.style.visibility).toBe('hidden');
        drawFrame();
        expect(gpu.compositorPasses()).toHaveLength(1);
        expect(xrDevice.appCanvas!.style.visibility).toBe('');
      });

      test('keeps showing the last drawn frame, with cached pipeline and bindings', () => {
        drawFrame();
        runFrame(session);
        const passes = gpu.compositorPasses();
        expect(passes).toHaveLength(2);
        const bound = passes.map(
          (pass: any) => pass.setBindGroup.mock.calls[1][1],
        );
        expect(bound[1]).toBe(bound[0]);
        expect(gpu.copies).toHaveLength(1);
        expect(gpu.device.createRenderPipeline).toHaveBeenCalledTimes(1);
        expect(gpu.device.createBuffer).toHaveBeenCalledTimes(1);
      });

      test('draws the left view over the whole canvas in mono', () => {
        drawFrame();
        const [composite] = gpu.compositorPasses();
        expect(composite.descriptor.colorAttachments[0]).toMatchObject({
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0, 0, 0, 0],
        });
        expect(composite.setViewport.mock.calls).toEqual([
          [0, 0, 1200, 800, 0, 1],
        ]);
        expect(composite.draw.mock.calls).toEqual([[3]]);
        expect(composite.setBindGroup.mock.calls[0]).toEqual([
          0,
          expect.anything(),
          [0],
        ]);
        expect(gpu.draws()[0]).toMatchObject({
          arrayLayer: 0,
          uvRect: [0, 0, 1, 1],
          opacity: 1,
          blendSourceAlpha: 1,
        });
      });

      test('draws each view into its half of the canvas in stereo', () => {
        xrDevice.stereoEnabled = true;
        drawFrame();
        const [composite] = gpu.compositorPasses();
        expect(composite.setViewport.mock.calls).toEqual([
          [0, 0, 600, 800, 0, 1],
          [600, 0, 600, 800, 0, 1],
        ]);
        expect(
          composite.setBindGroup.mock.calls.map((call: any[]) => call[2]),
        ).toEqual([[0], undefined, [256], undefined]);
        expect(gpu.draws().map((draw) => draw.arrayLayer)).toEqual([0, 1]);
      });

      test('shows the left view in both eyes when forceMonoPresentation is set', () => {
        xrDevice.stereoEnabled = true;
        layer.forceMonoPresentation = true;
        drawFrame();
        expect(gpu.draws().map((draw) => draw.arrayLayer)).toEqual([0, 0]);
      });

      test('applies the layer opacity and blendTextureSourceAlpha', () => {
        drawFrame();
        expect(gpu.draws()[0]).toMatchObject({
          opacity: 1,
          blendSourceAlpha: 1,
        });
        layer.opacity = 0.25;
        layer.blendTextureSourceAlpha = false;
        drawFrame();
        expect(gpu.draws()[0]).toMatchObject({
          opacity: 0.25,
          blendSourceAlpha: 0,
        });
        // The draws are written before the submit that uses them.
        const { writeBuffer, submit } = gpu.device.queue;
        expect(writeBuffer.mock.invocationCallOrder.slice(-1)[0]).toBeLessThan(
          submit.mock.invocationCallOrder.slice(-1)[0]!,
        );
      });

      test('applies fixedFoveation from the frame after it changes', () => {
        drawFrame(() => {
          layer.fixedFoveation = 0.75;
        });
        expect(gpu.draws()[0].fixedFoveation).toBe(0);
        drawFrame();
        expect(gpu.draws()[0].fixedFoveation).toBe(0.75);
      });

      test('shows only the part of each view the app was given', () => {
        drawFrame();
        runFrame(session, (frame) => {
          const [view] = frame.getViewerPose(refSpace)!.views;
          view.requestViewportScale(0.5);
          binding.getViewSubImage(layer, view);
        });
        expect(gpu.draws()[0].uvRect).toEqual([0, 0, 0.5, 0.5]);
      });

      test('hides the canvas while no usable layer is set', () => {
        drawFrame();
        const canvas = xrDevice.appCanvas!;
        expect(canvas.style.visibility).toBe('');

        layer.destroy();
        runFrame(session);
        expect(canvas.style.visibility).toBe('hidden');

        session.updateRenderState({ layers: [] });
        runFrame(session);
        expect(canvas.style.visibility).toBe('hidden');

        useLayer();
        drawFrame();
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
        drawFrame(callback);
        drawFrame(callback);
        expect(callback).toHaveBeenCalledTimes(2);
        expect(consoleError).toHaveBeenCalledWith(error);
      });

      test('skips presentation when the session ends during the frame', () => {
        const consoleError = jest.spyOn(console, 'error');
        drawFrame(() => {
          session.end();
        });
        expect(gpu.compositorPasses()).toHaveLength(0);
        expect(consoleError).not.toHaveBeenCalled();
      });

      test('removes the canvas, unconfigures the context and destroys the layer on end', async () => {
        drawFrame();
        const canvas = xrDevice.appCanvas!;
        const compositorTexture = layer[P_COMPOSITION_LAYER].textures.released!
          .color as any;
        await session.end();
        expect(canvas.isConnected).toBe(false);
        expect(xrDevice.canvasContainer.isConnected).toBe(false);
        expect(xrDevice.appCanvas).toBeUndefined();
        expect(canvasContext.unconfigure).toHaveBeenCalled();
        expect(compositorTexture.destroy).toHaveBeenCalled();
      });
    });
  });

  describe('depth sensing in a WebGPU session', () => {
    let session: XRSession;
    let binding: XRGPUBinding;
    let refSpace: XRReferenceSpace;
    let semCalls = 0;
    // The left view sees 2 m and the right view 3 m, so views can't mix up.
    const computeDepthBuffer = jest.fn(
      (
        _view: unknown,
        _projection: unknown,
        width: number,
        height: number,
      ) => ({
        data: new Float32Array(width * height).fill(2 + (semCalls++ % 2))
          .buffer,
        width,
        height,
        rawValueToMeters: 1,
      }),
    );

    const startSession = async (
      usagePreference: XRDepthUsage[],
      dataFormatPreference: XRDepthDataFormat[] = ['float32'],
    ) => {
      session = await xrSystem.requestSession('immersive-vr', {
        requiredFeatures: ['webgpu', 'depth-sensing'],
        depthSensing: { usagePreference, dataFormatPreference },
      });
      binding = new XRGPUBinding(session, gpu.device);
      session.updateRenderState({
        layers: [binding.createProjectionLayer({ colorFormat: 'bgra8unorm' })],
      });
      refSpace = await session.requestReferenceSpace(
        XRReferenceSpaceType.Local,
      );
    };
    const views = (frame: XRFrame) => frame.getViewerPose(refSpace)!.views;

    beforeEach(() => {
      semCalls = 0;
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
    });

    test('provides CPU-optimized depth sized from the window', async () => {
      await startSession(['cpu-optimized']);
      expect(session.depthUsage).toBe('cpu-optimized');
      const depths: ReturnType<XRFrame['getDepthInformation']>[] = [];
      runFrame(session, (frame) => {
        for (const view of views(frame)) {
          depths.push(frame.getDepthInformation(view));
        }
      });
      expect(depths.map((depth) => [depth!.width, depth!.height])).toEqual([
        [300, 200],
        [300, 200],
      ]);
      expect(depths.map((depth) => depth!.getDepthInMeters(0.5, 0.5))).toEqual([
        2, 3,
      ]);
    });

    test('gives SEM a projection with the [-1, 1] depth range it renders with', async () => {
      await startSession(['cpu-optimized']);
      runFrame(session);
      const projection = computeDepthBuffer.mock.calls[0][1] as Float32Array;
      const { depthNear: near, depthFar: far } = session.renderState;
      expect(projection[10]).toBeCloseTo((far + near) / (near - far), 5);
      expect(projection[14]).toBeCloseTo((2 * far * near) / (near - far), 5);
    });

    test('provides GPU-optimized depth as an r32float texture on the binding device', async () => {
      await startSession(['gpu-optimized', 'cpu-optimized']);
      expect(session.depthUsage).toBe('gpu-optimized');
      const { createTexture, queue } = gpu.device;
      createTexture.mockClear();
      const depths: XRGPUDepthInformation[] = [];
      runFrame(session, (frame) => {
        for (const view of views(frame)) {
          depths.push(binding.getDepthInformation(view)!);
        }
      });

      // One texture for the frame, with an array layer per view.
      expect(createTexture).toHaveBeenCalledTimes(1);
      expect(createTexture.mock.calls[0][0]).toMatchObject({
        size: [300, 200, 2],
        format: 'r32float',
        usage: TEXTURE_BINDING | COPY_DST,
        dimension: '2d',
        mipLevelCount: 1,
        sampleCount: 1,
      });
      const texture = createTexture.mock.results[0].value;
      expect(depths.map((depth) => depth.texture)).toEqual([texture, texture]);
      expect(depths.map((depth) => depth.getViewDescriptor())).toEqual(
        [0, 1].map((baseArrayLayer) => ({
          dimension: '2d',
          baseMipLevel: 0,
          mipLevelCount: 1,
          baseArrayLayer,
          arrayLayerCount: 1,
        })),
      );
      for (const depth of depths) {
        expect([depth.width, depth.height, depth.rawValueToMeters]).toEqual([
          300, 200, 1,
        ]);
      }

      // SEM's linear depth is uploaded unchanged, rows from the top.
      const semResults = computeDepthBuffer.mock.results;
      expect(queue.writeTexture).toHaveBeenCalledTimes(2);
      queue.writeTexture.mock.calls.forEach(
        ([destination, data, layout, size]: any[], layer: number) => {
          expect(destination).toEqual({ texture, origin: [0, 0, layer] });
          expect(data).toBe(semResults[layer].value.data);
          expect(layout).toEqual({ bytesPerRow: 1200, rowsPerImage: 200 });
          expect(size).toEqual([300, 200, 1]);
        },
      );
      // Only valid during its frame.
      expect(texture.destroy).toHaveBeenCalledTimes(1);
    });

    test('creates a new depth texture each frame', async () => {
      await startSession(['gpu-optimized']);
      const textures: GPUTexture[] = [];
      for (let i = 0; i < 2; i++) {
        runFrame(session, (frame) => {
          textures.push(binding.getDepthInformation(views(frame)[0])!.texture);
        });
      }
      expect(textures[0]).not.toBe(textures[1]);
      expect(textures[0].destroy).toHaveBeenCalled();
    });

    test('returns null when there is no depth data', async () => {
      await startSession(['gpu-optimized']);
      computeDepthBuffer
        .mockImplementationOnce(() => null as any)
        .mockImplementationOnce(() => null as any);
      let depth: XRGPUDepthInformation | null | undefined;
      runFrame(session, (frame) => {
        depth = binding.getDepthInformation(views(frame)[0]);
      });
      expect(depth).toBeNull();
    });

    test('provides unsigned-short GPU depth as an r16uint texture of millimeters', async () => {
      await startSession(['gpu-optimized'], ['unsigned-short']);
      expect([session.depthUsage, session.depthDataFormat]).toEqual([
        'gpu-optimized',
        'unsigned-short',
      ]);
      const { createTexture, queue } = gpu.device;
      createTexture.mockClear();
      let depth: XRGPUDepthInformation | null = null;
      runFrame(session, (frame) => {
        depth = binding.getDepthInformation(views(frame)[1]);
      });
      expect(createTexture.mock.calls[0][0]).toMatchObject({
        size: [300, 200, 2],
        format: 'r16uint',
      });
      expect(depth!.rawValueToMeters).toBe(0.001);
      const [destination, data, layout] = queue.writeTexture.mock.calls[1];
      expect(destination.origin).toEqual([0, 0, 1]);
      expect(layout).toEqual({ bytesPerRow: 600, rowsPerImage: 200 });
      expect(new Uint16Array(data)[0]).toBe(3000);
    });

    test.each(['unsigned-short', 'luminance-alpha'] as XRDepthDataFormat[])(
      'provides %s CPU depth in millimeters',
      async (dataFormat) => {
        await startSession(['cpu-optimized'], [dataFormat]);
        expect(session.depthDataFormat).toBe(dataFormat);
        const depths: ReturnType<XRFrame['getDepthInformation']>[] = [];
        runFrame(session, (frame) => {
          for (const view of views(frame)) {
            depths.push(frame.getDepthInformation(view));
          }
        });
        expect(depths.map((depth) => depth!.rawValueToMeters)).toEqual([
          0.001, 0.001,
        ]);
        expect(
          depths.map((depth) => depth!.getDepthInMeters(0.5, 0.5)),
        ).toEqual([2, 3]);
      },
    );

    test('negotiates usage before data format, without GPU luminance-alpha', async () => {
      const configuration = () => [session.depthUsage, session.depthDataFormat];
      await startSession(
        ['gpu-optimized', 'cpu-optimized'],
        ['luminance-alpha'],
      );
      expect(configuration()).toEqual(['cpu-optimized', 'luminance-alpha']);
      await session.end();
      await startSession(
        ['gpu-optimized', 'cpu-optimized'],
        ['luminance-alpha', 'float32'],
      );
      expect(configuration()).toEqual(['gpu-optimized', 'float32']);
      await session.end();
      await startSession(
        ['gpu-optimized'],
        ['luminance-alpha', 'unsigned-short', 'float32'],
      );
      expect(configuration()).toEqual(['gpu-optimized', 'unsigned-short']);
      await session.end();
      await startSession([], []);
      expect(configuration()).toEqual(['cpu-optimized', 'float32']);
    });

    test('does not grant depth sensing without a supported configuration', async () => {
      const depthSensing = {
        usagePreference: ['gpu-optimized'] as XRDepthUsage[],
        dataFormatPreference: ['luminance-alpha'] as XRDepthDataFormat[],
      };
      await expect(
        xrSystem.requestSession('immersive-vr', {
          requiredFeatures: ['webgpu', 'depth-sensing'],
          depthSensing,
        }),
      ).rejects.toThrow();
      const optional = await xrSystem.requestSession('immersive-vr', {
        requiredFeatures: ['webgpu'],
        optionalFeatures: ['depth-sensing'],
        depthSensing,
      });
      expect(optional.enabledFeatures).toContain('webgpu');
      expect(optional.enabledFeatures).not.toContain('depth-sensing');
    });

    test('getDepthInformation requires gpu-optimized usage, an active frame and a live device', async () => {
      const errors: unknown[] = [];
      const attempt = (action: () => void) => {
        try {
          action();
        } catch (error) {
          errors.push(error);
        }
      };
      await startSession(['cpu-optimized']);
      runFrame(session, (frame) => {
        attempt(() => binding.getDepthInformation(views(frame)[0]));
      });
      await session.end();

      await startSession(['gpu-optimized']);
      let view: XRView | undefined;
      runFrame(session, (frame) => {
        view = views(frame)[0];
      });
      attempt(() => binding.getDepthInformation(view!));
      gpu.lose();
      await Promise.resolve();
      runFrame(session, (frame) => {
        attempt(() => binding.getDepthInformation(views(frame)[0]));
      });

      expect(errors).toHaveLength(3);
      for (const error of errors) {
        expect(error).toMatchObject({ name: 'InvalidStateError' });
      }
      expect((errors as Error[]).map(({ message }) => message)).toEqual([
        expect.stringContaining('gpu-optimized'),
        expect.stringContaining('XRFrame callback'),
        expect.stringContaining('lost'),
      ]);
    });

    test('getDepthInformation throws NotSupportedError without depth sensing', async () => {
      const plain = await xrSystem.requestSession('immersive-vr', {
        requiredFeatures: ['webgpu'],
      });
      const plainBinding = new XRGPUBinding(plain, gpu.device);
      plain.updateRenderState({
        layers: [
          plainBinding.createProjectionLayer({ colorFormat: 'bgra8unorm' }),
        ],
      });
      const plainSpace = await plain.requestReferenceSpace(
        XRReferenceSpaceType.Local,
      );
      const errors: unknown[] = [];
      runFrame(plain, (frame) => {
        try {
          plainBinding.getDepthInformation(
            frame.getViewerPose(plainSpace)!.views[0],
          );
        } catch (error) {
          errors.push(error);
        }
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ name: 'NotSupportedError' });
    });
  });
});
