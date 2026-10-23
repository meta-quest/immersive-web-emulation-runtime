/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  XRDevice,
  XRDeviceConfig,
  type WebXRFeature,
} from '../../src/device/XRDevice.js';
import {
  XREnvironmentBlendMode,
  XRInteractionMode,
  XRSession,
} from '../../src/session/XRSession.js';
import { XRGPUBinding } from '../../src/layers/XRGPUBinding.js';
import { XRMediaBinding } from '../../src/layers/XRMediaBinding.js';
import { GPUMediaTextures } from '../../src/layers/GPUMediaTextures.js';
import {
  XRCylinderLayer,
  XREquirectLayer,
  XRQuadLayer,
} from '../../src/layers/XRSpaceLayers.js';
import { XRFrame } from '../../src/frameloop/XRFrame.js';
import {
  XRReferenceSpace,
  XRReferenceSpaceType,
} from '../../src/spaces/XRReferenceSpace.js';
import { XRSpace } from '../../src/spaces/XRSpace.js';
import { XRSystem } from '../../src/initialization/XRSystem.js';
import { XRRigidTransform } from '../../src/primitives/XRRigidTransform.js';
import { metaQuestTouchPlus } from '../../src/device/configs/controller/meta.js';
import { P_COMPOSITION_LAYER, P_SYSTEM } from '../../src/private.js';
import { createMockCanvasContext, createMockGPUDevice } from './mockWebGPU.js';

const COPY_DST = 0x02;
const TEXTURE_BINDING = 0x04;
const RENDER_ATTACHMENT = 0x10;

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

// Lets IWER's request for its own GPUDevice settle.
const settle = async () => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

// A video element with the given frame size and readiness.
const videoOf = (width: number, height: number, readyState = 2) => {
  const video = document.createElement('video');
  Object.defineProperties(video, {
    videoWidth: { value: width, configurable: true },
    videoHeight: { value: height, configurable: true },
    readyState: { value: readyState, configurable: true },
  });
  return video;
};

describe('WebGPU media layers', () => {
  let xrDevice: XRDevice;
  let xrSystem: XRSystem;
  let appGPU: ReturnType<typeof createMockGPUDevice>;
  let iwerGPU: ReturnType<typeof createMockGPUDevice>;
  let contexts: ReturnType<typeof createMockCanvasContext>[];
  let session: XRSession;
  let mediaBinding: XRMediaBinding;
  let space: XRReferenceSpace;
  let video: HTMLVideoElement;
  let adapter: { requestDevice: jest.Mock };

  const startSession = async (
    features: WebXRFeature[] = ['webgpu', 'layers'],
  ) => {
    session = await xrSystem.requestSession('immersive-vr', {
      requiredFeatures: features,
    });
    space = await session.requestReferenceSpace(XRReferenceSpaceType.Local);
  };
  const quad = (init: Record<string, unknown> = {}) =>
    mediaBinding.createQuadLayer(video, { space, ...init });

  beforeEach(async () => {
    jest.useFakeTimers();
    Object.defineProperty(window, 'innerWidth', {
      value: 1200,
      configurable: true,
    });
    Object.defineProperty(window, 'innerHeight', {
      value: 800,
      configurable: true,
    });
    appGPU = createMockGPUDevice();
    iwerGPU = createMockGPUDevice();
    adapter = { requestDevice: jest.fn(async () => iwerGPU.device) };
    Object.defineProperty(navigator, 'gpu', {
      value: {
        getPreferredCanvasFormat: () => 'bgra8unorm',
        requestAdapter: jest.fn(async () => adapter),
      },
      configurable: true,
    });
    contexts = [];
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((
      type: string,
    ) => {
      if (type !== 'webgpu') {
        return null;
      }
      const context = createMockCanvasContext();
      contexts.push(context);
      return context;
    }) as any);
    xrDevice = new XRDevice(deviceConfig);
    xrSystem = new XRSystem(xrDevice);
    await startSession();
    mediaBinding = new XRMediaBinding(session);
    video = videoOf(400, 200);
  });

  afterEach(async () => {
    await xrSystem[P_SYSTEM].activeSession?.end();
    delete (navigator as any).gpu;
    delete (globalThis as any).XRMediaBinding;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe('XRMediaBinding', () => {
    test('needs a live immersive session', async () => {
      expect(() => new XRMediaBinding({} as any)).toThrow(TypeError);
      await session.end();
      expect(() => new XRMediaBinding(session)).toThrow(invalidState);
      const inline = await xrSystem.requestSession('inline');
      expect(() => new XRMediaBinding(inline)).toThrow(invalidState);
    });

    test("is only defined while a WebGPU session with 'layers' runs", async () => {
      const global = globalThis as { XRMediaBinding?: unknown };
      expect(global.XRMediaBinding).toBe(XRMediaBinding);
      await session.end();
      expect('XRMediaBinding' in global).toBe(false);

      // What was there before comes back, such as the Layers polyfill's.
      const polyfill = class {};
      global.XRMediaBinding = polyfill;
      await startSession();
      expect(global.XRMediaBinding).toBe(XRMediaBinding);
      await session.end();
      expect(global.XRMediaBinding).toBe(polyfill);

      for (const features of [['webgpu'], []] as WebXRFeature[][]) {
        await startSession(features);
        expect(global.XRMediaBinding).toBe(polyfill);
        await session.end();
      }

      // Left alone if something replaced it meanwhile.
      await startSession();
      const replacement = class {};
      global.XRMediaBinding = replacement;
      await session.end();
      expect(global.XRMediaBinding).toBe(replacement);
    });
  });

  describe('creation', () => {
    test("needs the 'layers' feature and a live session", async () => {
      await session.end();
      await startSession(['webgpu']);
      const binding = new XRMediaBinding(session);
      expect(() => binding.createQuadLayer(video, { space })).toThrow(
        notSupported,
      );
      await session.end();
      expect(() => binding.createQuadLayer(video, { space })).toThrow(
        notSupported,
      );
      await startSession();
      const live = new XRMediaBinding(session);
      await session.end();
      expect(() => live.createQuadLayer(video, { space })).toThrow(
        invalidState,
      );
    });

    test('converts its arguments before anything else', async () => {
      await session.end();
      await startSession(['webgpu']);
      const binding = new XRMediaBinding(session);
      const create = (args: unknown[]) => () =>
        (binding.createQuadLayer as any)(...args);
      expect(create([{}, { space }])).toThrow(TypeError);
      expect(create([video, {}])).toThrow(TypeError);
      expect(create([video])).toThrow(TypeError);
      expect(create([video, { space, layout: 'side' }])).toThrow(TypeError);
      expect(create([video, { space, transform: {} }])).toThrow(TypeError);
      expect(create([video, { space, width: NaN }])).toThrow(TypeError);
      expect(create([video, { space }])).toThrow(notSupported);
    });

    test('rejects the "default" layout and spaces of other sessions', async () => {
      expect(() => quad({ layout: 'default' })).toThrow(TypeError);
      expect(() => quad({ space: {} })).toThrow(TypeError);
      const otherSystem = new XRSystem(new XRDevice(deviceConfig));
      const other = await otherSystem.requestSession('immersive-vr');
      const otherSpace = await other.requestReferenceSpace(
        XRReferenceSpaceType.Local,
      );
      expect(() => quad({ space: otherSpace })).toThrow(TypeError);
      await other.end();
    });

    test('sizes a quad from the video when width or height is missing', () => {
      const size = (init: Record<string, unknown>) => {
        const layer = quad(init);
        return [layer.width, layer.height];
      };
      expect(size({})).toEqual([1, 0.5]);
      expect(size({ width: 3 })).toEqual([3, 1.5]);
      expect(size({ height: 2 })).toEqual([4, 2]);
      expect(size({ width: 1, height: 1, layout: 'stereo' })).toEqual([1, 1]);
      expect(size({ width: null, height: null })).toEqual([1, 0.5]);
      // Each eye sees half of a stereo video.
      expect(size({ layout: 'stereo-left-right' })).toEqual([1, 1]);
      expect(size({ layout: 'stereo-top-bottom' })).toEqual([1, 0.25]);
    });

    test('creates a quad layer that needs no drawing', () => {
      const transform = new XRRigidTransform({ x: 1, y: 0, z: -2, w: 1 });
      const layer = quad({ transform, layout: 'stereo-left-right' });
      expect(layer).toBeInstanceOf(XRQuadLayer);
      expect(layer).toMatchObject({
        space,
        layout: 'stereo-left-right',
        isStatic: false,
        needsRedraw: false,
        mipLevels: 1,
        opacity: 1,
      });
      expect(layer.transform).not.toBe(transform);
      expect(layer.transform.position).toMatchObject({ x: 1, y: 0, z: -2 });
      expect(layer[P_COMPOSITION_LAYER].textures).toBeInstanceOf(
        GPUMediaTextures,
      );
    });

    test('creates a cylinder layer with the video aspect ratio unless given', () => {
      const layer = mediaBinding.createCylinderLayer(video, { space });
      expect(layer).toBeInstanceOf(XRCylinderLayer);
      expect(layer).toMatchObject({
        radius: 2,
        centralAngle: 0.78539,
        aspectRatio: 2,
        needsRedraw: false,
      });
      expect(
        mediaBinding.createCylinderLayer(video, {
          space,
          radius: 3,
          centralAngle: 1,
          aspectRatio: 1.5,
        }),
      ).toMatchObject({ radius: 3, centralAngle: 1, aspectRatio: 1.5 });
      expect(
        mediaBinding.createCylinderLayer(video, {
          space,
          layout: 'stereo-top-bottom',
        }).aspectRatio,
      ).toBe(4);
    });

    test('creates an equirect layer in a reference space other than viewer', async () => {
      const layer = mediaBinding.createEquirectLayer(video, { space });
      expect(layer).toBeInstanceOf(XREquirectLayer);
      expect(layer).toMatchObject({
        radius: 0,
        centralHorizontalAngle: 6.28318,
        upperVerticalAngle: 1.570795,
        lowerVerticalAngle: -1.570795,
        needsRedraw: false,
      });
      const viewer = await session.requestReferenceSpace(
        XRReferenceSpaceType.Viewer,
      );
      expect(() =>
        mediaBinding.createEquirectLayer(video, { space: viewer }),
      ).toThrow(invalidState);
      expect(() =>
        mediaBinding.createEquirectLayer(video, { space: new XRSpace() }),
      ).toThrow(invalidState);
    });

    test('media layers have no subimages', () => {
      const binding = new XRGPUBinding(session, appGPU.device);
      const layer = quad();
      session.updateRenderState({ layers: [layer] });
      let error: unknown;
      runFrame(session, (frame) => {
        try {
          binding.getSubImage(layer, frame);
        } catch (thrown) {
          error = thrown;
        }
      });
      expect(error).toEqual(
        expect.objectContaining({
          name: 'InvalidStateError',
          message: 'Media layers have no subimages.',
        }),
      );
    });
  });

  describe('composition', () => {
    const textures = (layer: XRQuadLayer) =>
      layer[P_COMPOSITION_LAYER].textures as GPUMediaTextures;

    test("copies the video's current frame each frame, on IWER's own device", async () => {
      const layer = quad();
      session.updateRenderState({ layers: [layer] });
      await settle();
      expect(adapter.requestDevice).toHaveBeenCalledTimes(1);
      runFrame(session);
      runFrame(session);
      const { copyExternalImageToTexture } = iwerGPU.device.queue;
      expect(copyExternalImageToTexture).toHaveBeenCalledTimes(2);
      const [source, destination, size] =
        copyExternalImageToTexture.mock.calls[0];
      expect(source).toEqual({ source: video });
      expect(size).toEqual([400, 200]);
      expect(destination.texture).toMatchObject({
        width: 400,
        height: 200,
        depthOrArrayLayers: 1,
        format: 'rgba8unorm',
        usage: TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT,
      });
      expect(destination.texture.descriptor.textureBindingViewDimension).toBe(
        '2d-array',
      );
      // The same texture while the video size holds.
      expect(copyExternalImageToTexture.mock.calls[1][1].texture).toBe(
        destination.texture,
      );
      expect(iwerGPU.compositorPasses()).toHaveLength(2);
      expect(textures(layer).released!.color).toBe(destination.texture);
    });

    test('shares one device between media layers and sessions', async () => {
      const first = quad();
      const second = quad();
      session.updateRenderState({ layers: [first, second] });
      await settle();
      runFrame(session);
      await session.end();
      await startSession();
      mediaBinding = new XRMediaBinding(session);
      session.updateRenderState({ layers: [quad()] });
      await settle();
      runFrame(session);
      expect(adapter.requestDevice).toHaveBeenCalledTimes(1);
      expect(iwerGPU.compositorPasses()).toHaveLength(2);
    });

    test('a video with no frame to show leaves the layer transparent', async () => {
      Object.defineProperty(video, 'readyState', { value: 1 });
      const layer = quad();
      session.updateRenderState({ layers: [layer] });
      await settle();
      runFrame(session);
      expect(
        iwerGPU.device.queue.copyExternalImageToTexture,
      ).not.toHaveBeenCalled();
      expect(iwerGPU.compositorPasses()).toHaveLength(0);
      expect(xrDevice.appCanvas!.style.visibility).toBe('hidden');

      Object.defineProperty(video, 'readyState', { value: 2 });
      runFrame(session);
      expect(iwerGPU.compositorPasses()).toHaveLength(1);
      Object.defineProperty(video, 'videoWidth', { value: 0 });
      runFrame(session);
      expect(iwerGPU.compositorPasses()).toHaveLength(1);
      expect(textures(layer).released).toBeNull();
    });

    test('gets a new device after losing its own', async () => {
      session.updateRenderState({ layers: [quad()] });
      await settle();
      runFrame(session);
      expect(iwerGPU.compositorPasses()).toHaveLength(1);

      const lostGPU = iwerGPU;
      iwerGPU = createMockGPUDevice();
      adapter.requestDevice.mockImplementation(async () => iwerGPU.device);
      lostGPU.lose();
      await settle();
      // The next composite asks for a device, and the one after uses it.
      runFrame(session);
      await settle();
      runFrame(session);
      expect(adapter.requestDevice).toHaveBeenCalledTimes(2);
      expect(
        iwerGPU.device.queue.copyExternalImageToTexture,
      ).toHaveBeenCalled();
      expect(iwerGPU.compositorPasses()).toHaveLength(1);
    });

    test('a later layer asks again after a failed device request', async () => {
      adapter.requestDevice.mockImplementationOnce(async () => {
        throw new Error('no device');
      });
      session.updateRenderState({ layers: [quad()] });
      await settle();
      runFrame(session);
      expect(iwerGPU.compositorPasses()).toHaveLength(0);

      session.updateRenderState({ layers: [quad()] });
      await settle();
      runFrame(session);
      expect(adapter.requestDevice).toHaveBeenCalledTimes(2);
      expect(iwerGPU.compositorPasses()).toHaveLength(1);
    });

    test('shows nothing until its device is ready', () => {
      session.updateRenderState({ layers: [quad()] });
      runFrame(session);
      expect(
        iwerGPU.device.queue.copyExternalImageToTexture,
      ).not.toHaveBeenCalled();
      expect(iwerGPU.compositorPasses()).toHaveLength(0);
    });

    test('follows the video size', async () => {
      const layer = quad();
      session.updateRenderState({ layers: [layer] });
      await settle();
      runFrame(session);
      const first = textures(layer).released!.color as any;
      Object.defineProperty(video, 'videoWidth', { value: 640 });
      Object.defineProperty(video, 'videoHeight', { value: 360 });
      runFrame(session);
      const second = textures(layer).released!.color as any;
      expect(second).not.toBe(first);
      expect([second.width, second.height]).toEqual([640, 360]);
      expect(first.destroyMock).toHaveBeenCalled();
    });

    test('a video WebGPU cannot read leaves the layer transparent, with one warning', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const error = new DOMException('cross-origin', 'SecurityError');
      iwerGPU.device.queue.copyExternalImageToTexture.mockImplementation(() => {
        throw error;
      });
      session.updateRenderState({ layers: [quad()] });
      await settle();
      runFrame(session);
      runFrame(session);
      expect(iwerGPU.compositorPasses()).toHaveLength(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        'IWER cannot show this media layer:',
        error,
      );
    });

    test('splits a stereo video between the eyes, swapped by invertStereo', async () => {
      xrDevice.stereoEnabled = true;
      const uvRects = async (init: Record<string, unknown>) => {
        session.updateRenderState({ layers: [quad(init)] });
        await settle();
        runFrame(session);
        return iwerGPU.draws().map((draw) => [draw.uvRect, draw.arrayLayer]);
      };
      expect(await uvRects({ layout: 'stereo-left-right' })).toEqual([
        [[0, 0, 0.5, 1], 0],
        [[0.5, 0, 0.5, 1], 0],
      ]);
      expect(
        await uvRects({ layout: 'stereo-top-bottom', invertStereo: true }),
      ).toEqual([
        [[0, 0.5, 1, 0.5], 0],
        [[0, 0, 1, 0.5], 0],
      ]);
      // A video is one image, so a "stereo" layout shows all of it to each eye.
      expect(await uvRects({ layout: 'stereo' })).toEqual([
        [[0, 0, 1, 1], 0],
        [[0, 0, 1, 1], 0],
      ]);
    });

    test("stacks its canvas over the app's in render state order", async () => {
      const binding = new XRGPUBinding(session, appGPU.device);
      const projection = binding.createProjectionLayer({
        colorFormat: 'bgra8unorm',
      });
      session.updateRenderState({ layers: [projection, quad()] });
      await settle();
      runFrame(session, (frame) => {
        for (const view of frame.getViewerPose(space)!.views) {
          binding.getViewSubImage(projection, view);
        }
      });
      expect(appGPU.compositorPasses()).toHaveLength(1);
      expect(iwerGPU.compositorPasses()).toHaveLength(1);
      const canvases = xrDevice.canvasContainer.querySelectorAll('canvas');
      expect(canvases).toHaveLength(2);
      const [appCanvas, mediaCanvas] = canvases;
      expect(appCanvas).toBe(xrDevice.appCanvas);
      expect(mediaCanvas.style).toMatchObject({
        position: 'absolute',
        top: '0px',
        left: '0px',
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: appCanvas.style.zIndex,
      });
    });

    test('frames run with only media layers', () => {
      session.updateRenderState({ layers: [quad()] });
      const callback = jest.fn();
      runFrame(session, callback);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    test('ending the session or destroying the layer frees its texture', async () => {
      const layer = quad();
      const other = quad();
      session.updateRenderState({ layers: [layer, other] });
      await settle();
      runFrame(session);
      const texture = textures(layer).released!.color as any;
      const otherTexture = textures(other).released!.color as any;
      layer.destroy();
      expect(texture.destroyMock).toHaveBeenCalled();
      expect(textures(layer).released).toBeNull();
      runFrame(session);
      expect(
        iwerGPU.device.queue.copyExternalImageToTexture,
      ).toHaveBeenCalledTimes(3);
      await session.end();
      expect(otherTexture.destroyMock).toHaveBeenCalled();
    });

    test('a layer shown to one eye uses that half of the video', async () => {
      xrDevice.stereoEnabled = true;
      const layer = quad({ layout: 'stereo-left-right', invertStereo: true });
      layer.forceMonoPresentation = true;
      session.updateRenderState({ layers: [layer] });
      await settle();
      runFrame(session);
      // Both eyes see the left view, which invertStereo puts on the right.
      expect(iwerGPU.draws().map((draw) => draw.uvRect)).toEqual([
        [0.5, 0, 0.5, 1],
        [0.5, 0, 0.5, 1],
      ]);
    });
  });
});
