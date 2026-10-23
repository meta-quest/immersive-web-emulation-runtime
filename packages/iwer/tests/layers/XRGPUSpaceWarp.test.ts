/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { mat4, vec4 } from 'gl-matrix';
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
import {
  XRGPUBinding,
  type XRGPUProjectionLayerInit,
  type XRGPUSubImage,
} from '../../src/layers/XRGPUBinding.js';
import { XRProjectionLayer } from '../../src/layers/XRProjectionLayer.js';
import { XRFrame } from '../../src/frameloop/XRFrame.js';
import {
  XRReferenceSpace,
  XRReferenceSpaceType,
} from '../../src/spaces/XRReferenceSpace.js';
import { XRSpaceUtils } from '../../src/spaces/XRSpace.js';
import { XRSystem } from '../../src/initialization/XRSystem.js';
import { XREye } from '../../src/views/XRView.js';
import { XRRigidTransform } from '../../src/primitives/XRRigidTransform.js';
import { metaQuestTouchPlus } from '../../src/device/configs/controller/meta.js';
import {
  P_COMPOSITION_LAYER,
  P_DEVICE,
  P_SESSION,
  P_SPACE,
  P_SYSTEM,
} from '../../src/private.js';
import { createMockCanvasContext, createMockGPUDevice } from './mockWebGPU.js';

const COPY_SRC = 0x01;
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

// Runs one emulated device frame with `callback` as its only rAF callback.
const runFrame = (
  session: XRSession,
  callback: (frame: XRFrame) => void = () => {},
) => {
  session.requestAnimationFrame((_time, frame) => callback(frame));
  jest.runOnlyPendingTimers();
};

// Runs one emulated device frame.
const tick = () => jest.runOnlyPendingTimers();

// Where a world point is in a view's NDC.
const project = (point: number[], view: mat4, projection: mat4) => {
  const clip = vec4.transformMat4(
    vec4.create(),
    [point[0], point[1], point[2], 1],
    mat4.multiply(mat4.create(), projection, view),
  );
  return [clip[0] / clip[3], clip[1] / clip[3], clip[2] / clip[3]];
};

// Where a space warp view's matrix takes a point at `ndc` in the drawn frame.
const warp = (ndc: number[], matrix: number[]) => {
  const clip = vec4.transformMat4(
    vec4.create(),
    [ndc[0], ndc[1], ndc[2], 1],
    matrix as unknown as mat4,
  );
  return [clip[0] / clip[3], clip[1] / clip[3], clip[2] / clip[3]];
};

const expectClose = (actual: number[], expected: number[], digits: number) =>
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i], digits));

describe('WebGPU space warp', () => {
  let xrDevice: XRDevice;
  let xrSystem: XRSystem;
  let gpu: ReturnType<typeof createMockGPUDevice>;
  let session: XRSession;
  let binding: XRGPUBinding;
  let space: XRReferenceSpace;

  const startSession = async (features: WebXRFeature[]) => {
    session = await xrSystem.requestSession('immersive-vr', {
      requiredFeatures: features,
    });
    binding = new XRGPUBinding(session, gpu.device);
    space = await session.requestReferenceSpace(XRReferenceSpaceType.Local);
  };
  const createLayer = (init: Partial<XRGPUProjectionLayerInit> = {}) =>
    binding.createProjectionLayer({
      colorFormat: 'rgba8unorm',
      depthStencilFormat: 'depth24plus',
      ...init,
    });
  const showLayer = (init: Partial<XRGPUProjectionLayerInit> = {}) => {
    const layer = createLayer(init);
    session.updateRenderState({ layers: [layer] });
    return layer;
  };
  // What an app does to render into a subimage: make a view of each texture.
  const draw = (subImage: XRGPUSubImage) => {
    subImage.colorTexture.createView();
    subImage.depthStencilTexture?.createView();
    subImage.motionVectorTexture?.createView();
  };
  // Runs a frame in which the app draws the layer, plus `callback`.
  const drawFrame = (
    layer: XRProjectionLayer,
    callback: (frame: XRFrame) => void = () => {},
  ) =>
    runFrame(session, (frame) => {
      for (const view of frame.getViewerPose(space)!.views) {
        draw(binding.getViewSubImage(layer, view));
      }
      callback(frame);
    });
  const viewMatrix = (eye = XREye.Left) =>
    mat4.invert(
      mat4.create(),
      XRSpaceUtils.calculateGlobalOffsetMatrix(xrDevice.viewSpaces[eye]),
    )!;
  const projectionMatrix = (eye = XREye.Left) =>
    mat4.clone(session[P_SESSION].getProjectionMatrix(eye));
  const turnHead = (yaw: number) =>
    xrDevice.quaternion.set(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));

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
    Object.defineProperty(navigator, 'gpu', {
      value: {
        getPreferredCanvasFormat: () => 'bgra8unorm',
        requestAdapter: jest.fn(async () => ({})),
      },
      configurable: true,
    });
    gpu = createMockGPUDevice();
    jest
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(((type: string) =>
        type === 'webgpu' ? createMockCanvasContext() : null) as any);
    xrDevice = new XRDevice(deviceConfig);
    xrSystem = new XRSystem(xrDevice);
    await startSession(['webgpu', 'space-warp']);
  });

  afterEach(async () => {
    await xrSystem[P_SYSTEM].activeSession?.end();
    delete (navigator as any).gpu;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe("the 'space-warp' feature", () => {
    test('is granted to WebGPU sessions', async () => {
      expect(session.enabledFeatures).toContain('space-warp');
      await session.end();
      const optional = await xrSystem.requestSession('immersive-ar', {
        requiredFeatures: ['webgpu'],
        optionalFeatures: ['space-warp'],
      });
      expect(optional.enabledFeatures).toContain('space-warp');
    });

    test('is not granted to WebGL sessions', async () => {
      await session.end();
      await expect(
        xrSystem.requestSession('immersive-vr', {
          requiredFeatures: ['space-warp'],
        }),
      ).rejects.toThrow();
      const webgl = await xrSystem.requestSession('immersive-vr', {
        optionalFeatures: ['space-warp'],
      });
      expect(webgl.enabledFeatures).not.toContain('space-warp');
    });

    test('makes the binding use depth values', async () => {
      expect(binding.usesDepthValues).toBe(true);
      await session.end();
      await startSession(['webgpu']);
      expect(binding.usesDepthValues).toBe(false);
    });
  });

  describe('createProjectionLayer', () => {
    const textures = (layer: XRProjectionLayer) =>
      layer[P_COMPOSITION_LAYER].textures;

    test('adds motion vectors and depth at a quarter of the view resolution', () => {
      const usage = RENDER_ATTACHMENT | TEXTURE_BINDING;
      const layer = createLayer({ textureUsage: usage });
      const { descriptors, releaseDepth } = textures(layer);
      expect(descriptors.color).toMatchObject({
        size: [1200, 800, 2],
        usage,
      });
      expect(descriptors.depthStencil).toMatchObject({
        size: [300, 200, 2],
        format: 'depth24plus',
        usage,
      });
      expect(descriptors.motionVector).toEqual({
        label: 'XRProjectionLayer motion vectors',
        size: [300, 200, 2],
        mipLevelCount: 1,
        sampleCount: 1,
        dimension: '2d',
        format: 'rgba16float',
        usage,
        viewFormats: [],
      });
      expect([layer.textureWidth, layer.textureHeight]).toEqual([1200, 800]);
      expect(layer.ignoreDepthValues).toBe(false);
      // The compositor gets the depth and motion vectors too.
      expect(releaseDepth).toBe(true);
    });

    test.each([
      'depth16unorm',
      'depth24plus',
      'depth24plus-stencil8',
      'depth32float',
      'depth32float-stencil8',
    ] as GPUTextureFormat[])('%s gets motion vectors', (depthStencilFormat) => {
      gpu.device.features.add('depth32float-stencil8');
      const layer = createLayer({ depthStencilFormat });
      expect(textures(layer).descriptors.motionVector).not.toBeNull();
      expect(layer.ignoreDepthValues).toBe(false);
    });

    test('stencil8 and no depth/stencil texture get no motion vectors', () => {
      for (const depthStencilFormat of ['stencil8', undefined] as const) {
        const layer = createLayer({ depthStencilFormat });
        const { descriptors, releaseDepth } = textures(layer);
        expect(descriptors.motionVector).toBeNull();
        expect(releaseDepth).toBe(false);
        expect(layer.ignoreDepthValues).toBe(true);
      }
      const stencil = createLayer({ depthStencilFormat: 'stencil8' });
      expect(textures(stencil).descriptors.depthStencil!.size).toEqual([
        1200, 800, 2,
      ]);
    });

    test('rounds the quarter up and applies scaleFactor', () => {
      Object.defineProperty(window, 'innerWidth', { value: 1202 });
      expect(textures(createLayer()).descriptors.motionVector!.size).toEqual([
        301, 200, 2,
      ]);
      const scaled = createLayer({ scaleFactor: 0.5 });
      expect(textures(scaled).descriptors.motionVector!.size).toEqual([
        150, 100, 2,
      ]);
      expect([scaled.textureWidth, scaled.textureHeight]).toEqual([601, 400]);
    });

    test('follows the view size in stereo', () => {
      xrDevice.stereoEnabled = true;
      expect(textures(createLayer()).descriptors.motionVector!.size).toEqual([
        150, 200, 2,
      ]);
    });

    test('fits motion vectors in maxTextureDimension2D', () => {
      gpu.device.limits.maxTextureDimension2D = 250;
      const layer = createLayer();
      expect([layer.textureWidth, layer.textureHeight]).toEqual([250, 166]);
      expect(textures(layer).descriptors.motionVector!.size).toEqual([
        250, 166, 2,
      ]);
    });

    test('a session without space warp gets no motion vectors', async () => {
      await session.end();
      await startSession(['webgpu']);
      const layer = createLayer();
      expect(textures(layer).descriptors.motionVector).toBeNull();
      expect(textures(layer).descriptors.depthStencil!.size).toEqual([
        1200, 800, 2,
      ]);
      expect(layer.ignoreDepthValues).toBe(true);
    });
  });

  describe('deltaPose', () => {
    test('keeps the transform the app sets until it changes it', () => {
      const layer = showLayer();
      expect(layer.deltaPose).toBeNull();
      const transform = new XRRigidTransform({ x: 0, y: 0, z: -1, w: 1 });
      layer.deltaPose = transform;
      expect(layer.deltaPose).toBe(transform);
      drawFrame(layer);
      tick();
      drawFrame(layer);
      expect(layer.deltaPose).toBe(transform);
      expect(() => (layer.deltaPose = {} as any)).toThrow(TypeError);
      expect(layer.deltaPose).toBe(transform);
      layer.deltaPose = undefined as any;
      expect(layer.deltaPose).toBeNull();
      layer.deltaPose = transform;
      layer.deltaPose = null;
      expect(layer.deltaPose).toBeNull();
    });
  });

  describe('getViewSubImage', () => {
    test('gives motion vector and depth textures at their own size', () => {
      const layer = showLayer();
      let subImages: XRGPUSubImage[] = [];
      runFrame(session, (frame) => {
        subImages = frame
          .getViewerPose(space)!
          .views.map((view) => binding.getViewSubImage(layer, view));
      });
      const [left, right] = subImages;
      expect(left.motionVectorTexture).toMatchObject({
        format: 'rgba16float',
        width: 300,
        height: 200,
        depthOrArrayLayers: 2,
        // IWER copies them for its compositor.
        usage: RENDER_ATTACHMENT | COPY_SRC,
      });
      expect(left.depthStencilTexture).toMatchObject({
        format: 'depth24plus',
        width: 300,
        height: 200,
        usage: RENDER_ATTACHMENT | COPY_SRC,
      });
      expect(right.motionVectorTexture).toBe(left.motionVectorTexture);
      expect(right.depthStencilTexture).toBe(left.depthStencilTexture);
      // The viewport is the color texture's.
      expect(left.viewport).toMatchObject({ width: 1200, height: 800 });
      expect(right.getViewDescriptor()).toMatchObject({
        baseArrayLayer: 1,
        arrayLayerCount: 1,
      });
    });

    test('keeps depth and motion vectors the app destroys', () => {
      const layer = showLayer();
      runFrame(session, (frame) => {
        const subImage = binding.getViewSubImage(
          layer,
          frame.getViewerPose(space)!.views[0],
        );
        draw(subImage);
        subImage.depthStencilTexture!.destroy();
        subImage.motionVectorTexture!.destroy();
      });
      const released = layer[P_COMPOSITION_LAYER].textures.released!;
      // Each is copied when destroyed, and the color when the frame ends.
      expect(
        gpu.copies
          .filter((copy) => copy.label === 'IWER layer release')
          .map((copy) => copy.destination.texture),
      ).toEqual([released.depthStencil, released.motionVector, released.color]);
      // They still drive space warp.
      tick();
      expect(gpu.warpPasses()).toHaveLength(1);
    });

    test('hands the depth and motion vectors to the compositor', () => {
      const layer = showLayer();
      drawFrame(layer);
      const released = layer[P_COMPOSITION_LAYER].textures.released!;
      expect(
        gpu.copies
          .filter((copy) => copy.label === 'IWER layer release')
          .map((copy) => [copy.destination.texture, copy.size]),
      ).toEqual([
        [released.color, [1200, 800, 2]],
        [released.depthStencil, [300, 200, 2]],
        [released.motionVector, [300, 200, 2]],
      ]);
      expect(released.depthStencil).toMatchObject({
        format: 'depth24plus',
        usage: TEXTURE_BINDING | COPY_DST,
      });
      expect(released.motionVector).toMatchObject({
        format: 'rgba16float',
        usage: TEXTURE_BINDING | COPY_DST,
      });
    });
  });

  describe('frame synthesis', () => {
    test('the device frame after one with motion vectors is synthesized', () => {
      const layer = showLayer();
      drawFrame(layer);
      expect(gpu.warpPasses()).toHaveLength(0);
      const callback = jest.fn();
      runFrame(session, callback);
      expect(callback).not.toHaveBeenCalled();
      expect(gpu.warpPasses()).toHaveLength(1);
      expect(gpu.compositorPasses()).toHaveLength(2);
      tick();
      expect(callback).toHaveBeenCalledTimes(1);
    });

    test('runs the app at half rate while it submits motion vectors', () => {
      const layer = showLayer();
      let frames = 0;
      session.requestAnimationFrame(function onFrame(_time, frame) {
        frames++;
        session.requestAnimationFrame(onFrame);
        for (const view of frame.getViewerPose(space)!.views) {
          draw(binding.getViewSubImage(layer, view));
        }
      });
      for (let i = 0; i < 10; i++) {
        tick();
      }
      expect(frames).toBe(5);
      expect(gpu.warpPasses()).toHaveLength(5);
      expect(gpu.compositorPasses()).toHaveLength(10);
    });

    test.each([
      ['color only', []],
      ['depth but no motion vectors', ['depthStencilTexture']],
      ['motion vectors but no depth', ['motionVectorTexture']],
    ] as const)(
      'runs the app at full rate when it draws %s',
      (_name, drawn) => {
        const layer = showLayer();
        let frames = 0;
        session.requestAnimationFrame(function onFrame(_time, frame) {
          frames++;
          session.requestAnimationFrame(onFrame);
          for (const view of frame.getViewerPose(space)!.views) {
            const subImage = binding.getViewSubImage(layer, view);
            subImage.colorTexture.createView();
            for (const key of drawn) {
              subImage[key]!.createView();
            }
          }
        });
        for (let i = 0; i < 10; i++) {
          tick();
        }
        expect(frames).toBe(10);
        expect(gpu.warpPasses()).toHaveLength(0);
      },
    );

    test('frames that do not draw the layer run as if space warp was off', () => {
      showLayer();
      let frames = 0;
      session.requestAnimationFrame(function onFrame() {
        frames++;
        session.requestAnimationFrame(onFrame);
      });
      for (let i = 0; i < 4; i++) {
        tick();
      }
      expect(frames).toBe(4);
      expect(gpu.warpPasses()).toHaveLength(0);
    });

    test('layers without motion vectors never synthesize frames', async () => {
      for (const depthStencilFormat of ['stencil8', undefined] as const) {
        const layer = showLayer({ depthStencilFormat });
        const callback = jest.fn();
        drawFrame(layer);
        runFrame(session, callback);
        expect(callback).toHaveBeenCalledTimes(1);
      }
      await session.end();
      await startSession(['webgpu']);
      const layer = showLayer();
      const callback = jest.fn();
      drawFrame(layer);
      runFrame(session, callback);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(gpu.warpPasses()).toHaveLength(0);
    });

    test('warps the released frame into its own texture, then composites that', () => {
      const layer = showLayer();
      drawFrame(layer);
      const realGroup = gpu.compositorPasses()[0].setBindGroup.mock.calls[1][1];
      tick();
      const { textures } = layer[P_COMPOSITION_LAYER];
      const released = textures.released! as any;
      const targets = textures.synthesisTargets() as any;
      expect(targets.color).toMatchObject({
        width: 1200,
        height: 800,
        depthOrArrayLayers: 2,
        format: 'rgba8unorm',
        usage: RENDER_ATTACHMENT | TEXTURE_BINDING,
      });
      expect(targets.color.descriptor.textureBindingViewDimension).toBe(
        '2d-array',
      );
      expect(targets.depth).toMatchObject({
        width: 1200,
        height: 800,
        depthOrArrayLayers: 1,
        format: 'depth24plus',
        usage: RENDER_ATTACHMENT,
      });

      const [pass] = gpu.warpPasses();
      expect(pass.descriptor.colorAttachments[0]).toMatchObject({
        clearValue: [0, 0, 0, 0],
        loadOp: 'clear',
        storeOp: 'store',
      });
      expect(targets.color.createView).toHaveBeenCalledWith({
        dimension: '2d',
        baseArrayLayer: 0,
        arrayLayerCount: 1,
      });
      expect(pass.descriptor.depthStencilAttachment).toMatchObject({
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
      });
      expect(pass.setViewport).toHaveBeenCalledWith(0, 0, 1200, 800, 0, 1);
      // A cell per motion vector texel.
      expect(pass.draw).toHaveBeenCalledWith(300 * 200 * 6);
      // It reads the released color, depth and motion vectors; depth as a
      // float texture, which compatibility mode allows.
      expect(released.color.createView).toHaveBeenCalledWith({
        dimension: '2d-array',
      });
      expect(released.depthStencil.createView).toHaveBeenCalledWith({
        dimension: '2d-array',
        aspect: 'depth-only',
      });
      expect(released.motionVector.createView).toHaveBeenCalledWith({
        dimension: '2d-array',
      });
      const textureLayout = gpu.device.createBindGroupLayout.mock.calls.find(
        ([descriptor]: any[]) =>
          descriptor.label === 'IWER space warp textures',
      )[0];
      expect(
        textureLayout.entries.map((entry: any) => entry.texture?.sampleType),
      ).toEqual([
        undefined,
        'float',
        'unfilterable-float',
        'unfilterable-float',
      ]);

      // The compositor shows the synthesized frame, then the next real one.
      const synthesizedGroup =
        gpu.compositorPasses()[1].setBindGroup.mock.calls[1][1];
      expect(synthesizedGroup).not.toBe(realGroup);
      expect(targets.color.createView).toHaveBeenCalledWith({
        dimension: '2d-array',
      });
      drawFrame(layer);
      expect(gpu.compositorPasses()[2].setBindGroup.mock.calls[1][1]).toBe(
        realGroup,
      );
    });

    test('extrapolates by the time since the frame over the time between frames', () => {
      const now = jest.spyOn(performance, 'now');
      const layer = showLayer();
      now.mockReturnValue(1000);
      drawFrame(layer);
      now.mockReturnValue(1016);
      tick();
      // Without an earlier frame, half a frame.
      expect(gpu.warps()).toEqual([
        expect.objectContaining({
          grid: [300, 200],
          arrayLayer: 0,
          extrapolation: 0.5,
          colorScale: 1,
        }),
      ]);
      now.mockReturnValue(1100);
      drawFrame(layer);
      now.mockReturnValue(1125);
      tick();
      expect(gpu.warps()[0].extrapolation).toBeCloseTo(0.25);
      now.mockReturnValue(1300);
      drawFrame(layer);
      now.mockReturnValue(1700);
      tick();
      expect(gpu.warps()[0].extrapolation).toBe(1);
    });

    test("uses each view's viewport scale", () => {
      const layer = showLayer();
      runFrame(session, (frame) => {
        for (const view of frame.getViewerPose(space)!.views) {
          view.requestViewportScale(0.5);
          draw(binding.getViewSubImage(layer, view));
        }
      });
      tick();
      expect(gpu.warps()[0].colorScale).toBe(0.5);
      expect(gpu.warpPasses()[0].setViewport).toHaveBeenCalledWith(
        0,
        0,
        600,
        400,
        0,
        1,
      );
      expect(gpu.draws()[0].uvRect).toEqual([0, 0, 0.5, 0.5]);
    });

    test('warps both views in stereo, and only the left with forceMonoPresentation', () => {
      xrDevice.stereoEnabled = true;
      const layer = showLayer();
      drawFrame(layer);
      tick();
      expect(gpu.warps().map((view) => [view.arrayLayer, view.grid])).toEqual([
        [0, [150, 200]],
        [1, [150, 200]],
      ]);
      expect(gpu.warpPasses()).toHaveLength(2);
      expect(gpu.draws().map((draw) => draw.arrayLayer)).toEqual([0, 1]);

      layer.forceMonoPresentation = true;
      drawFrame(layer);
      tick();
      expect(gpu.warps().map((view) => view.arrayLayer)).toEqual([0]);
      expect(gpu.draws().map((draw) => draw.arrayLayer)).toEqual([0, 0]);
    });

    test("leaves a still head's frame in place", () => {
      const layer = showLayer();
      drawFrame(layer);
      tick();
      expectClose(gpu.warps()[0].matrix, [...mat4.create()], 5);
      const pipeline = gpu.device.createRenderPipeline.mock.calls.find(
        ([descriptor]: any[]) => descriptor.label === 'IWER space warp',
      )[0];
      expect(pipeline).toMatchObject({
        fragment: { targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: {
          format: 'depth24plus',
          depthWriteEnabled: true,
          depthCompare: 'less',
        },
      });
    });

    test('follows a window resize', () => {
      const layer = showLayer();
      drawFrame(layer);
      const drawnProjection = projectionMatrix();
      Object.defineProperty(window, 'innerWidth', { value: 1600 });
      tick();
      const expected = mat4.multiply(
        mat4.create(),
        projectionMatrix(),
        mat4.invert(mat4.create(), drawnProjection)!,
      );
      expect(projectionMatrix()).not.toEqual(drawnProjection);
      expectClose(gpu.warps()[0].matrix, [...expected], 5);
    });

    test('reprojects with depth to where the head is now', () => {
      const layer = showLayer();
      drawFrame(layer);
      const drawnView = viewMatrix();
      const projection = projectionMatrix();
      xrDevice.position.x += 0.1;
      turnHead(0.05);
      tick();
      const [{ matrix }] = gpu.warps();
      for (const point of [
        [0, 1.6, -1],
        [0.5, 1.4, -4],
        [-1, 2, -20],
      ]) {
        const drawn = project(point, drawnView, projection);
        const now = project(point, viewMatrix(), projectionMatrix());
        expectClose(warp(drawn, matrix), now, 4);
      }
    });

    test('a frame extrapolated along camera motion lands where a stopped head sees it', () => {
      const now = jest.spyOn(performance, 'now');
      const layer = showLayer();
      now.mockReturnValue(1000);
      drawFrame(layer);
      const before = viewMatrix();
      now.mockReturnValue(1016);
      tick();
      turnHead(0.05);
      xrDevice.position.x += 0.02;
      now.mockReturnValue(1032);
      drawFrame(layer);
      const after = viewMatrix();
      const projection = projectionMatrix();
      // The head stops, so the frame should show what it drew.
      now.mockReturnValue(1048);
      tick();
      const [{ matrix, extrapolation }] = gpu.warps();
      expect(extrapolation).toBe(0.5);
      for (const point of [
        [0, 1.6, -1],
        [0.3, 1.5, -3],
        [-0.5, 1.8, -8],
      ]) {
        const previous = project(point, before, projection);
        const drawn = project(point, after, projection);
        // Motion vectors include the camera's motion.
        const extrapolated = drawn.map(
          (value, i) => value + extrapolation * (value - previous[i]),
        );
        expectClose(warp(extrapolated, matrix), drawn, 2);
      }
    });

    test('tracking moves on in real and synthesized frames alike', () => {
      const layer = showLayer();
      const update = jest.spyOn(xrDevice[P_DEVICE].remote, 'update');
      drawFrame(layer);
      expect(update).toHaveBeenCalledTimes(1);
      xrDevice.position.x = 0.3;
      tick();
      expect(update).toHaveBeenCalledTimes(2);
      expect(
        xrDevice[P_DEVICE].viewerSpace[P_SPACE].offsetMatrix[12],
      ).toBeCloseTo(0.3);
    });

    test('applies a pending render state in the next real frame only', () => {
      const layer = showLayer();
      drawFrame(layer);
      session.updateRenderState({ layers: [] });
      tick();
      expect(session.renderState.layers).toEqual([layer]);
      expect(gpu.warpPasses()).toHaveLength(1);
      expect(xrDevice.appCanvas!.style.visibility).toBe('');
      tick();
      expect(session.renderState.layers).toEqual([]);
      expect(xrDevice.appCanvas!.style.visibility).toBe('hidden');
    });

    test('a layer destroyed after its frame is not shown', () => {
      const layer = showLayer();
      drawFrame(layer);
      layer.destroy();
      tick();
      expect(gpu.warpPasses()).toHaveLength(0);
      expect(xrDevice.appCanvas!.style.visibility).toBe('hidden');
    });

    test('destroy() frees the synthesized frame textures', () => {
      const layer = showLayer();
      drawFrame(layer);
      tick();
      const targets = layer[P_COMPOSITION_LAYER].textures.synthesisTargets();
      layer.destroy();
      expect(targets.color.destroy).toHaveBeenCalled();
      expect(targets.depth.destroy).toHaveBeenCalled();
    });

    test('reuses its pipeline, bind groups and buffer', () => {
      const layer = showLayer();
      drawFrame(layer);
      tick();
      drawFrame(layer);
      tick();
      expect(gpu.warpPasses()).toHaveLength(2);
      const labels = (mock: jest.Mock) =>
        mock.mock.calls
          .map(([descriptor]: any[]) => descriptor.label)
          .filter((label: string) => label?.startsWith('IWER space warp'));
      expect(labels(gpu.device.createRenderPipeline)).toHaveLength(1);
      expect(labels(gpu.device.createBuffer)).toHaveLength(1);
      const groups = gpu
        .warpPasses()
        .map((pass: any) => pass.setBindGroup.mock.calls[1][1]);
      expect(groups[1]).toBe(groups[0]);
    });

    test('stops when the session ends', async () => {
      const layer = showLayer();
      drawFrame(layer);
      await session.end();
      tick();
      expect(gpu.warpPasses()).toHaveLength(0);
    });

    test('other layers show their last frame', async () => {
      await session.end();
      await startSession(['webgpu', 'space-warp', 'layers']);
      const projection = createLayer();
      const quad = binding.createQuadLayer({
        colorFormat: 'rgba8unorm',
        space,
        viewPixelWidth: 64,
        viewPixelHeight: 64,
      });
      session.updateRenderState({ layers: [projection, quad] });
      runFrame(session, (frame) => {
        for (const view of frame.getViewerPose(space)!.views) {
          draw(binding.getViewSubImage(projection, view));
        }
        binding.getSubImage(quad, frame);
      });
      tick();
      expect(gpu.warpPasses()).toHaveLength(1);
      expect(gpu.draws().map((draw) => draw.kind)).toHaveLength(2);
      const quadView = (
        quad[P_COMPOSITION_LAYER].textures.released!.color as any
      ).createView;
      expect(quadView).toHaveBeenCalledTimes(1);
    });
  });
});
