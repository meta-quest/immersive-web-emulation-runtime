/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { vec4 } from 'gl-matrix';
import { XRDevice, XRDeviceConfig } from '../../src/device/XRDevice.js';
import {
  XREnvironmentBlendMode,
  XRInteractionMode,
  XRSession,
} from '../../src/session/XRSession.js';
import {
  XRGPUBinding,
  type XRGPULayerInit,
} from '../../src/layers/XRGPUBinding.js';
import {
  XRCompositionLayer,
  XRProjectionLayer,
} from '../../src/layers/XRProjectionLayer.js';
import {
  XRCubeLayer,
  XRCylinderLayer,
  XREquirectLayer,
  XRQuadLayer,
} from '../../src/layers/XRSpaceLayers.js';
import { XRLayer } from '../../src/layers/XRWebGLLayer.js';
import { XRLayerEvent } from '../../src/events/XRLayerEvent.js';
import { XRFrame } from '../../src/frameloop/XRFrame.js';
import {
  XRReferenceSpace,
  XRReferenceSpaceType,
} from '../../src/spaces/XRReferenceSpace.js';
import { XRSpace } from '../../src/spaces/XRSpace.js';
import { XRSystem } from '../../src/initialization/XRSystem.js';
import { XREye } from '../../src/views/XRView.js';
import { XRRigidTransform } from '../../src/primitives/XRRigidTransform.js';
import { metaQuestTouchPlus } from '../../src/device/configs/controller/meta.js';
import { P_COMPOSITION_LAYER, P_SYSTEM } from '../../src/private.js';
import type { GPULayerTextures } from '../../src/layers/GPULayerTextures.js';
import { createMockCanvasContext, createMockGPUDevice } from './mockWebGPU.js';

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

// The texture descriptors of a layer the app draws.
const descriptors = (layer: XRCompositionLayer) =>
  (layer[P_COMPOSITION_LAYER].textures as GPULayerTextures).descriptors;

// Calls `action` and returns what it threw, so checks run outside frames.
const thrown = (action: () => unknown) => {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('WebGPU composition layers', () => {
  let xrDevice: XRDevice;
  let xrSystem: XRSystem;
  let gpu: ReturnType<typeof createMockGPUDevice>;
  let contexts: ReturnType<typeof createMockCanvasContext>[];
  let session: XRSession;
  let binding: XRGPUBinding;
  let space: XRReferenceSpace;

  const init = (overrides: Partial<XRGPULayerInit> = {}): XRGPULayerInit => ({
    colorFormat: 'rgba8unorm',
    space,
    viewPixelWidth: 128,
    viewPixelHeight: 64,
    ...overrides,
  });

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
    session = await xrSystem.requestSession('immersive-vr', {
      requiredFeatures: ['webgpu', 'layers'],
    });
    binding = new XRGPUBinding(session, gpu.device);
    space = await session.requestReferenceSpace(XRReferenceSpaceType.Local);
  });

  afterEach(async () => {
    await xrSystem[P_SYSTEM].activeSession?.end();
    delete (navigator as any).gpu;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe("the 'layers' feature", () => {
    test('is granted to WebGPU sessions', async () => {
      expect(session.enabledFeatures).toContain('layers');
      await session.end();
      const optional = await xrSystem.requestSession('immersive-ar', {
        requiredFeatures: ['webgpu'],
        optionalFeatures: ['layers'],
      });
      expect(optional.enabledFeatures).toContain('layers');
    });

    test('is not granted to WebGL sessions on a device without layers', async () => {
      await session.end();
      await expect(
        xrSystem.requestSession('immersive-vr', {
          requiredFeatures: ['layers'],
        }),
      ).rejects.toThrow();
      const webgl = await xrSystem.requestSession('immersive-vr', {
        optionalFeatures: ['layers'],
      });
      expect(webgl.enabledFeatures).not.toContain('layers');
    });

    test('sessions report maxRenderLayers', () => {
      expect(session.maxRenderLayers).toBe(16);
    });
  });

  describe('creation', () => {
    test('needs the layers feature', async () => {
      await session.end();
      const plain = await xrSystem.requestSession('immersive-vr', {
        requiredFeatures: ['webgpu'],
      });
      const plainBinding = new XRGPUBinding(plain, gpu.device);
      const plainSpace = await plain.requestReferenceSpace(
        XRReferenceSpaceType.Local,
      );
      expect(() =>
        plainBinding.createQuadLayer({ ...init(), space: plainSpace }),
      ).toThrow(notSupported);
    });

    test('converts the init dictionary like WebIDL', () => {
      for (const member of [
        'colorFormat',
        'space',
        'viewPixelWidth',
        'viewPixelHeight',
      ] as const) {
        expect(() =>
          binding.createQuadLayer({ ...init(), [member]: undefined }),
        ).toThrow(TypeError);
      }
      expect(() =>
        binding.createQuadLayer(init({ layout: 'sideways' as any })),
      ).toThrow(TypeError);
      expect(() => binding.createQuadLayer({ ...init(), width: NaN })).toThrow(
        TypeError,
      );
      expect(() =>
        binding.createQuadLayer({ ...init(), transform: {} as any }),
      ).toThrow(TypeError);
      // unsigned long wraps, then fails the device limits.
      expect(() =>
        binding.createQuadLayer(init({ viewPixelWidth: -1 })),
      ).toThrow(notSupported);
    });

    test('validates in the order the WebGPU binding gives', async () => {
      expect(() =>
        binding.createQuadLayer(init({ layout: 'default' })),
      ).toThrow(TypeError);
      expect(() =>
        binding.createQuadLayer(init({ viewPixelWidth: 0 })),
      ).toThrow(TypeError);
      expect(() =>
        binding.createQuadLayer(init({ colorFormat: 'r8unorm' })),
      ).toThrow(notSupported);
      expect(() =>
        binding.createQuadLayer(init({ depthStencilFormat: 'rgba8unorm' })),
      ).toThrow(notSupported);
      expect(() => binding.createQuadLayer(init({ mipLevels: 0 }))).toThrow(
        invalidState,
      );
      expect(() =>
        binding.createQuadLayer(init({ viewPixelWidth: 9000 })),
      ).toThrow(notSupported);
      expect(() => binding.createQuadLayer(init({ textureUsage: 0 }))).toThrow(
        notSupported,
      );

      gpu.lose();
      await Promise.resolve();
      expect(() => binding.createQuadLayer(init())).toThrow(invalidState);
      await session.end();
      expect(() => binding.createQuadLayer(init())).toThrow(invalidState);
    });

    test('lays out the color texture for each layout', () => {
      const color = (layer: XRCompositionLayer) => descriptors(layer).color;
      expect(color(binding.createQuadLayer(init()))).toMatchObject({
        size: [128, 64, 1],
        format: 'rgba8unorm',
        usage: RENDER_ATTACHMENT,
        dimension: '2d',
        mipLevelCount: 1,
        sampleCount: 1,
      });
      expect(
        color(binding.createQuadLayer(init({ layout: 'stereo' }))).size,
      ).toEqual([128, 64, 2]);
      expect(
        color(binding.createQuadLayer(init({ layout: 'stereo-left-right' })))
          .size,
      ).toEqual([256, 64, 1]);
      expect(
        color(binding.createQuadLayer(init({ layout: 'stereo-top-bottom' })))
          .size,
      ).toEqual([128, 128, 1]);
      const withDepth = binding.createQuadLayer(
        init({ depthStencilFormat: 'depth24plus', layout: 'stereo' }),
      );
      expect(descriptors(withDepth).depthStencil).toMatchObject({
        size: [128, 64, 2],
        format: 'depth24plus',
      });
    });

    test('limits mipLevels to the mip chain of the texture', () => {
      const layer = binding.createQuadLayer(init({ mipLevels: 20 }));
      expect(layer.mipLevels).toBe(8);
      expect(descriptors(layer).color.mipLevelCount).toBe(8);
      expect(binding.createQuadLayer(init({ mipLevels: 3 })).mipLevels).toBe(3);
    });

    test('checks the layer space', async () => {
      const otherSystem = new XRSystem(new XRDevice(deviceConfig));
      const otherSession = await otherSystem.requestSession('immersive-vr');
      const otherSpace = await otherSession.requestReferenceSpace(
        XRReferenceSpaceType.Local,
      );
      expect(() =>
        binding.createQuadLayer(init({ space: otherSpace })),
      ).toThrow(TypeError);
      // Offset spaces belong to the session of the space they came from.
      expect(() =>
        binding.createQuadLayer(
          init({
            space: otherSpace.getOffsetReferenceSpace(
              new XRRigidTransform().matrix,
            ),
          }),
        ),
      ).toThrow(TypeError);
      expect(() => binding.createQuadLayer(init({ space: {} as any }))).toThrow(
        TypeError,
      );
      await otherSession.end();

      const viewer = await session.requestReferenceSpace(
        XRReferenceSpaceType.Viewer,
      );
      // Head-locked quads and cylinders are fine; equirect and cube aren't.
      expect(() =>
        binding.createQuadLayer(init({ space: viewer })),
      ).not.toThrow();
      expect(() =>
        binding.createCylinderLayer(init({ space: viewer })),
      ).not.toThrow();
      expect(() =>
        binding.createEquirectLayer(init({ space: viewer })),
      ).toThrow(TypeError);
      expect(() =>
        binding.createCubeLayer(init({ space: viewer, viewPixelWidth: 64 })),
      ).toThrow(TypeError);
      expect(() =>
        binding.createEquirectLayer(init({ space: new XRSpace() })),
      ).toThrow(TypeError);
    });

    test('quad layers start with their init values', () => {
      const transform = new XRRigidTransform(
        { x: 1, y: 2, z: -3, w: 1 },
        { x: 0, y: 0, z: 0, w: 1 },
      );
      const layer = binding.createQuadLayer({
        ...init({ isStatic: true }),
        transform,
        width: 2,
        height: 0.5,
      });
      expect(layer).toBeInstanceOf(XRQuadLayer);
      expect(layer).toBeInstanceOf(XRCompositionLayer);
      expect(layer).toBeInstanceOf(XRLayer);
      expect(layer).toMatchObject({
        space,
        width: 2,
        height: 0.5,
        layout: 'mono',
        isStatic: true,
        needsRedraw: true,
        mipLevels: 1,
        opacity: 1,
        quality: 'default',
      });
      // A copy, like every transform the layer is given at creation.
      expect(layer.transform).not.toBe(transform);
      expect(layer.transform.position).toMatchObject({ x: 1, y: 2, z: -3 });
      expect(binding.createQuadLayer(init()).transform.matrix).toEqual(
        new XRRigidTransform().matrix,
      );
      expect(binding.createQuadLayer(init())).toMatchObject({
        width: 1,
        height: 1,
        isStatic: false,
      });
    });

    test('cylinder and equirect layers default to the spec values', () => {
      expect(binding.createCylinderLayer(init())).toBeInstanceOf(
        XRCylinderLayer,
      );
      expect(binding.createCylinderLayer(init())).toMatchObject({
        radius: 2,
        centralAngle: 0.78539,
        aspectRatio: 2,
      });
      const equirect = binding.createEquirectLayer(init());
      expect(equirect).toBeInstanceOf(XREquirectLayer);
      expect(equirect).toMatchObject({
        radius: 0,
        centralHorizontalAngle: 6.28318,
        upperVerticalAngle: 1.570795,
        lowerVerticalAngle: -1.570795,
      });
      expect(
        binding.createCylinderLayer({ ...init(), radius: 3, aspectRatio: 1 }),
      ).toMatchObject({ radius: 3, aspectRatio: 1 });
    });

    test('cube layers need square faces and a mono or stereo layout', () => {
      const square = init({ viewPixelWidth: 64, viewPixelHeight: 64 });
      const mono = binding.createCubeLayer(square);
      expect(mono).toBeInstanceOf(XRCubeLayer);
      expect(descriptors(mono).color.size).toEqual([64, 64, 6]);
      expect(mono.orientation).toMatchObject({ x: 0, y: 0, z: 0, w: 1 });
      const orientation = new DOMPointReadOnly(0, 1, 0, 0);
      const stereo = binding.createCubeLayer({
        ...square,
        layout: 'stereo',
        orientation,
      });
      expect(descriptors(stereo).color.size).toEqual([64, 64, 12]);
      expect(stereo.orientation).not.toBe(orientation);
      expect(stereo.orientation).toMatchObject({ x: 0, y: 1, z: 0, w: 0 });

      expect(() => binding.createCubeLayer(init())).toThrow(TypeError);
      expect(() =>
        binding.createCubeLayer({ ...square, layout: 'stereo-left-right' }),
      ).toThrow(TypeError);
      expect(() =>
        binding.createCubeLayer({ ...square, orientation: {} as any }),
      ).toThrow(TypeError);
    });
  });

  describe('attributes', () => {
    test('setters convert like WebIDL', async () => {
      const quad = binding.createQuadLayer(init());
      quad.width = 3;
      quad.transform = new XRRigidTransform({ x: 0, y: 0, z: -1, w: 1 });
      expect(quad.width).toBe(3);
      expect(quad.transform.position.z).toBe(-1);
      expect(() => (quad.width = Infinity)).toThrow(TypeError);
      expect(() => (quad.transform = {} as any)).toThrow(TypeError);
      expect(() => (quad.space = null as any)).toThrow(TypeError);

      const cylinder = binding.createCylinderLayer(init());
      cylinder.centralAngle = 1;
      expect(cylinder.centralAngle).toBe(1);
      expect(() => (cylinder.radius = NaN)).toThrow(TypeError);

      const viewer = await session.requestReferenceSpace(
        XRReferenceSpaceType.Viewer,
      );
      quad.space = viewer;
      expect(quad.space).toBe(viewer);
      const equirect = binding.createEquirectLayer(init());
      expect(() => (equirect.space = viewer)).toThrow(TypeError);
      equirect.upperVerticalAngle = 0.5;
      expect(equirect.upperVerticalAngle).toBe(0.5);

      const cube = binding.createCubeLayer(init({ viewPixelWidth: 64 }));
      const orientation = new DOMPointReadOnly(0, 0, 1, 0);
      cube.orientation = orientation;
      expect(cube.orientation).toBe(orientation);
      expect(() => (cube.orientation = { w: 1 } as any)).toThrow(TypeError);
    });

    test('onredraw handles the redraw event', () => {
      const layer = binding.createQuadLayer(init());
      const first = jest.fn();
      const second = jest.fn();
      layer.onredraw = first;
      expect(layer.onredraw).toBe(first);
      const event = new XRLayerEvent('redraw', { layer });
      expect(event.layer).toBe(layer);
      layer.dispatchEvent(event);
      layer.onredraw = second;
      layer.dispatchEvent(new XRLayerEvent('redraw', { layer }));
      layer.onredraw = null;
      layer.dispatchEvent(new XRLayerEvent('redraw', { layer }));
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
      expect(() => new XRLayerEvent('redraw', {} as any)).toThrow(TypeError);
    });
  });

  describe('render state', () => {
    test('takes several layers of any kind with the layers feature', () => {
      const layers = [
        binding.createProjectionLayer({ colorFormat: 'rgba8unorm' }),
        binding.createQuadLayer(init()),
        binding.createCylinderLayer(init()),
      ];
      session.updateRenderState({ layers });
      runFrame(session);
      expect(session.renderState.layers).toEqual(layers);
    });

    test('rejects too many layers, repeats and a baseLayer with layers', () => {
      const quads = Array.from({ length: 17 }, () =>
        binding.createQuadLayer(init()),
      );
      expect(() => session.updateRenderState({ layers: quads })).toThrow(
        notSupported,
      );
      expect(() =>
        session.updateRenderState({ layers: [quads[0], quads[0]] }),
      ).toThrow(TypeError);
      expect(() =>
        session.updateRenderState({
          baseLayer: {} as any,
          layers: [quads[0]],
        }),
      ).toThrow(notSupported);
      expect(() =>
        session.updateRenderState({ layers: quads.slice(0, 16) }),
      ).not.toThrow();
    });

    test('destroy() takes a layer out of the pending render state', () => {
      const quad = binding.createQuadLayer(init());
      const cylinder = binding.createCylinderLayer(init());
      session.updateRenderState({ layers: [quad, cylinder] });
      runFrame(session);

      quad.destroy();
      expect(session.renderState.layers).toEqual([quad, cylinder]);
      runFrame(session);
      expect(session.renderState.layers).toEqual([cylinder]);

      // A layer that is only pending leaves the pending state too.
      const pendingQuad = binding.createQuadLayer(init());
      session.updateRenderState({ layers: [cylinder, pendingQuad] });
      pendingQuad.destroy();
      runFrame(session);
      expect(session.renderState.layers).toEqual([cylinder]);
    });

    test('frames run while only a quad layer is set', () => {
      session.updateRenderState({ layers: [binding.createQuadLayer(init())] });
      const callback = jest.fn();
      runFrame(session);
      runFrame(session, callback);
      expect(callback).toHaveBeenCalledTimes(1);
    });
  });

  describe('getSubImage', () => {
    const activate = <T extends XRCompositionLayer>(layer: T) => {
      session.updateRenderState({ layers: [layer] });
      runFrame(session);
      return layer;
    };
    const subImages = (layer: XRCompositionLayer, eyes: XREye[]) => {
      let results: unknown[] = [];
      runFrame(session, (frame) => {
        results = eyes.map(
          (eye) =>
            thrown(() => binding.getSubImage(layer, frame, eye)) ??
            binding.getSubImage(layer, frame, eye),
        );
      });
      return results as any[];
    };

    test('returns each eye of every layout', () => {
      const viewports = (layout: XRGPULayerInit['layout']) =>
        subImages(activate(binding.createQuadLayer(init({ layout }))), [
          XREye.None,
          XREye.Left,
          XREye.Right,
        ]).map((result) =>
          result instanceof Error
            ? result.constructor.name
            : [
                result.viewport.x,
                result.viewport.y,
                result.viewport.width,
                result.viewport.height,
                result.getViewDescriptor().baseArrayLayer,
              ],
        );
      expect(viewports('mono')).toEqual([
        [0, 0, 128, 64, 0],
        [0, 0, 128, 64, 0],
        [0, 0, 128, 64, 0],
      ]);
      expect(viewports('stereo')).toEqual([
        'TypeError',
        [0, 0, 128, 64, 0],
        [0, 0, 128, 64, 1],
      ]);
      expect(viewports('stereo-left-right')).toEqual([
        'TypeError',
        [0, 0, 128, 64, 0],
        [128, 0, 128, 64, 0],
      ]);
      expect(viewports('stereo-top-bottom')).toEqual([
        'TypeError',
        [0, 0, 128, 64, 0],
        [0, 64, 128, 64, 0],
      ]);
    });

    test('gives a stereo cube layer six faces per eye', () => {
      const cube = activate(
        binding.createCubeLayer(
          init({ viewPixelWidth: 64, viewPixelHeight: 64, layout: 'stereo' }),
        ),
      );
      const [left, right] = subImages(cube, [XREye.Left, XREye.Right]);
      expect(left.getViewDescriptor()).toEqual({
        dimension: '2d',
        mipLevelCount: 1,
        arrayLayerCount: 1,
        baseArrayLayer: 0,
      });
      expect(right.getViewDescriptor().baseArrayLayer).toBe(6);
      expect(right.viewport).toMatchObject({ width: 64, height: 64 });
    });

    test('shares the frame textures between eyes, with depth when asked', () => {
      const layer = activate(
        binding.createQuadLayer(
          init({ layout: 'stereo', depthStencilFormat: 'depth16unorm' }),
        ),
      );
      const [left, right] = subImages(layer, [XREye.Left, XREye.Right]);
      expect(left.colorTexture).toBe(right.colorTexture);
      expect(left.depthStencilTexture).toBe(right.depthStencilTexture);
      expect(left.depthStencilTexture.format).toBe('depth16unorm');
      expect(left.motionVectorTexture).toBeNull();
      expect((left.colorTexture as any).destroyMock).toHaveBeenCalled();
    });

    test('validates the layer and frame', async () => {
      const layer = binding.createQuadLayer(init());
      const projection = binding.createProjectionLayer({
        colorFormat: 'rgba8unorm',
      });
      session.updateRenderState({ layers: [projection] });
      runFrame(session);
      const errors: unknown[] = [];
      let frame: XRFrame | undefined;
      runFrame(session, (current) => {
        frame = current;
        errors.push(thrown(() => binding.getSubImage(layer, current)));
        errors.push(thrown(() => binding.getSubImage(projection, current)));
        errors.push(
          thrown(() => binding.getSubImage(layer, current, 'up' as any)),
        );
      });
      errors.push(thrown(() => binding.getSubImage(projection, frame!)));
      expect(errors).toEqual([
        expect.any(TypeError),
        expect.any(TypeError),
        expect.any(TypeError),
        invalidState,
      ]);

      await session.end();
      const plain = await xrSystem.requestSession('immersive-vr', {
        requiredFeatures: ['webgpu'],
      });
      const plainBinding = new XRGPUBinding(plain, gpu.device);
      const plainProjection = plainBinding.createProjectionLayer({
        colorFormat: 'rgba8unorm',
      });
      plain.updateRenderState({ layers: [plainProjection] });
      runFrame(plain);
      let error: unknown;
      runFrame(plain, (current) => {
        error = thrown(() =>
          plainBinding.getSubImage(plainProjection, current),
        );
      });
      expect(error).toEqual(notSupported);
    });

    test('a static layer can only be drawn while it needs a redraw', () => {
      const layer = activate(binding.createQuadLayer(init({ isStatic: true })));
      expect(layer.needsRedraw).toBe(true);
      const [first] = subImages(layer, [XREye.None]);
      expect(first).not.toBeInstanceOf(Error);
      expect(layer.needsRedraw).toBe(false);
      const [second] = subImages(layer, [XREye.None]);
      expect(second).toEqual(invalidState);
    });
  });

  describe('composition', () => {
    // Draws every layer in a frame, the way an app would.
    const drawFrame = (layers: XRCompositionLayer[]) =>
      runFrame(session, (frame) => {
        for (const layer of layers) {
          if (layer instanceof XRProjectionLayer) {
            for (const view of frame.getViewerPose(space)!.views) {
              binding.getViewSubImage(layer, view);
            }
          } else {
            binding.getSubImage(
              layer,
              frame,
              layer.layout === 'mono' ? XREye.None : XREye.Left,
            );
          }
        }
      });
    const show = (layers: XRCompositionLayer[]) => {
      session.updateRenderState({ layers });
      runFrame(session);
      drawFrame(layers);
    };
    const pipelines = () =>
      gpu
        .compositorPasses()
        .slice(-1)[0]
        .setPipeline.mock.calls.map(
          ([pipeline]: any[]) => pipeline.descriptor.label,
        );

    test("doesn't clip layers to the app's depth range", () => {
      session.updateRenderState({ depthNear: 1, depthFar: 10 });
      const at = (z: number) =>
        binding.createQuadLayer({
          ...init(),
          transform: new XRRigidTransform({ x: 0, y: 0, z }),
        });
      show([at(-25), at(-0.5)]);
      // Each quad's centre is inside WebGPU's clip volume (one mono view).
      expect(
        gpu.draws().map(({ matrix }) => {
          const [, , z, w] = vec4.transformMat4(
            vec4.create(),
            [0, 0, 0, 1],
            matrix as any,
          );
          return w > 0 && z >= 0 && z <= w;
        }),
      ).toEqual([true, true]);
    });

    test('draws the layers in render state order with their pipelines', () => {
      const projection = binding.createProjectionLayer({
        colorFormat: 'rgba8unorm',
      });
      const quad = binding.createQuadLayer(init());
      const cylinder = binding.createCylinderLayer({
        ...init(),
        centralAngle: Math.PI,
      });
      const equirect = binding.createEquirectLayer(init());
      const cube = binding.createCubeLayer(init({ viewPixelWidth: 64 }));
      show([projection, quad, cylinder, equirect, cube]);

      expect(pipelines()).toEqual([
        'IWER layer compositor projection',
        'IWER layer compositor surface',
        'IWER layer compositor surface',
        'IWER layer compositor surface',
        'IWER layer compositor cube',
      ]);
      const [pass] = gpu.compositorPasses().slice(-1);
      expect(pass.draw.mock.calls).toEqual([
        [3],
        [6],
        [32 * 6],
        [64 * 32 * 6],
        [3],
      ]);
      // Source-over blending of premultiplied color.
      const surface = gpu.device.createRenderPipeline.mock.calls.find(
        ([descriptor]: any[]) =>
          descriptor.label === 'IWER layer compositor surface',
      )[0];
      expect(surface.fragment.targets[0].blend.color).toEqual({
        srcFactor: 'one',
        dstFactor: 'one-minus-src-alpha',
        operation: 'add',
      });
      expect(surface.primitive.cullMode).toBe('back');
    });

    test('describes each surface to the shader', () => {
      const quad = binding.createQuadLayer({ ...init(), width: 2, height: 3 });
      const cylinder = binding.createCylinderLayer({
        ...init(),
        radius: 2,
        centralAngle: 1,
        aspectRatio: 4,
      });
      const equirect = binding.createEquirectLayer({
        ...init(),
        radius: 5,
        centralHorizontalAngle: 2,
        upperVerticalAngle: 0.5,
        lowerVerticalAngle: -0.25,
      });
      const infinite = binding.createEquirectLayer(init());
      show([quad, cylinder, equirect, infinite]);
      const draws = gpu.draws();
      expect(draws[0]).toMatchObject({
        kind: 0,
        dims: [2, 3, 0, 0],
        grid: [1, 1],
        infinite: 0,
      });
      expect(draws[1]).toMatchObject({
        kind: 1,
        dims: [2, 1, 0.5, 0],
        infinite: 0,
      });
      expect(draws[2]).toMatchObject({
        kind: 2,
        dims: [5, 2, 0.5, -0.25],
        infinite: 0,
      });
      expect(draws[3]).toMatchObject({ kind: 2, infinite: 1 });
      expect(draws[3].dims[0]).toBe(1);
    });

    test('draws nothing for degenerate shapes', () => {
      const flat = binding.createQuadLayer({ ...init(), height: 0 });
      const squashed = binding.createCylinderLayer({
        ...init(),
        aspectRatio: 0,
      });
      const inverted = binding.createEquirectLayer({
        ...init(),
        upperVerticalAngle: -0.5,
        lowerVerticalAngle: 0.5,
      });
      const fine = binding.createQuadLayer(init());
      show([flat, squashed, inverted, fine]);
      expect(gpu.compositorPasses()[0].draw.mock.calls).toEqual([[6]]);
    });

    test('places a quad in front of the viewer', () => {
      const quad = binding.createQuadLayer({
        ...init(),
        transform: new XRRigidTransform({ x: 0, y: 0, z: -2, w: 1 }),
      });
      show([quad]);
      const m = gpu.draws()[0].matrix;
      // The clip-space position of the quad's centre.
      const [x, y, , w] = [0, 1, 2, 3].map((row) => m[12 + row]);
      expect(w).toBeGreaterThan(0);
      expect(Math.abs(x / w)).toBeLessThan(0.1);
      expect(Math.abs(y / w)).toBeLessThan(0.1);
    });

    test('shows each eye its part of a stereo layer', () => {
      xrDevice.stereoEnabled = true;
      const leftRight = binding.createQuadLayer(
        init({ layout: 'stereo-left-right' }),
      );
      const topBottom = binding.createQuadLayer(
        init({ layout: 'stereo-top-bottom' }),
      );
      const stereo = binding.createQuadLayer(init({ layout: 'stereo' }));
      show([leftRight, topBottom, stereo]);
      // Left eye draws all three layers, then the right eye.
      const draws = gpu.draws();
      expect(draws.map((draw) => draw.uvRect)).toEqual([
        [0, 0, 0.5, 1],
        [0, 0, 1, 0.5],
        [0, 0, 1, 1],
        [0.5, 0, 0.5, 1],
        [0, 0.5, 1, 0.5],
        [0, 0, 1, 1],
      ]);
      expect(draws.map((draw) => draw.arrayLayer)).toEqual([0, 0, 0, 0, 0, 1]);

      stereo.forceMonoPresentation = true;
      drawFrame([leftRight, topBottom, stereo]);
      expect(gpu.draws()[5].arrayLayer).toBe(0);
    });

    test('samples a cube layer through a cube view per eye', () => {
      xrDevice.stereoEnabled = true;
      const cube = binding.createCubeLayer(
        init({ viewPixelWidth: 64, layout: 'stereo' }),
      );
      show([cube]);
      const compositorTexture = cube[P_COMPOSITION_LAYER].textures.released!
        .color as any;
      expect(compositorTexture.descriptor.textureBindingViewDimension).toBe(
        'cube',
      );
      expect(
        compositorTexture.createView.mock.calls.map(([view]: any[]) => view),
      ).toEqual([
        { dimension: 'cube', baseArrayLayer: 0, arrayLayerCount: 6 },
        { dimension: 'cube', baseArrayLayer: 6, arrayLayerCount: 6 },
      ]);
    });

    test('keeps showing a static layer after its one draw', () => {
      const quad = binding.createQuadLayer(init({ isStatic: true }));
      show([quad]);
      runFrame(session);
      runFrame(session);
      expect(gpu.copies).toHaveLength(1);
      expect(gpu.compositorPasses()).toHaveLength(3);
      expect(gpu.compositorPasses()[2].draw).toHaveBeenCalledWith(6);
    });

    test('skips layers that have not been drawn yet', () => {
      const drawn = binding.createQuadLayer(init());
      const undrawn = binding.createQuadLayer(init());
      session.updateRenderState({ layers: [drawn, undrawn] });
      runFrame(session);
      drawFrame([drawn]);
      expect(gpu.draws()).toHaveLength(1);
      expect(gpu.compositorPasses()[0].draw.mock.calls).toEqual([[6]]);
    });

    test('filters layers with mips trilinearly and text anisotropically', () => {
      const mipped = binding.createQuadLayer(init({ mipLevels: 4 }));
      const text = binding.createQuadLayer(init());
      text.quality = 'text-optimized';
      const plain = binding.createQuadLayer(init());
      show([mipped, text, plain]);
      const samplers = gpu.device.createSampler.mock.calls.map(
        ([descriptor]: any[]) => descriptor,
      );
      // A single mip level still filters linearly between mips when the
      // sampler is anisotropic, since WebGPU requires it.
      expect(samplers).toEqual([
        expect.objectContaining({ mipmapFilter: 'linear', maxAnisotropy: 1 }),
        expect.objectContaining({ mipmapFilter: 'linear', maxAnisotropy: 16 }),
        expect.objectContaining({ mipmapFilter: 'nearest', maxAnisotropy: 1 }),
      ]);
      // The release copies every mip level.
      expect(
        gpu.copies
          .filter(({ source }: any) => source.texture.mipLevelCount === 4)
          .map(({ size }: any) => size),
      ).toEqual([
        [128, 64, 1],
        [64, 32, 1],
        [32, 16, 1],
        [16, 8, 1],
      ]);
    });

    test('stacks a canvas for each run of layers from another device', () => {
      const other = createMockGPUDevice();
      const otherBinding = new XRGPUBinding(session, other.device);
      const first = binding.createQuadLayer(init());
      const second = otherBinding.createQuadLayer(init());
      const third = binding.createQuadLayer(init());
      session.updateRenderState({ layers: [first, second, third] });
      runFrame(session);
      runFrame(session, (frame) => {
        binding.getSubImage(first, frame);
        otherBinding.getSubImage(second, frame);
        binding.getSubImage(third, frame);
      });
      const canvases = [...xrDevice.canvasContainer.querySelectorAll('canvas')];
      expect(canvases).toHaveLength(3);
      expect(canvases.map((canvas) => canvas.style.visibility)).toEqual([
        '',
        '',
        '',
      ]);
      expect(
        contexts.map((context) => context.configure.mock.calls[0][0].device),
      ).toEqual([gpu.device, other.device, gpu.device]);
      expect(gpu.compositorPasses()).toHaveLength(2);
      expect(other.compositorPasses()).toHaveLength(1);
      // The others cover the first, which the device mounts, in order.
      for (const canvas of canvases.slice(1)) {
        expect(canvas.style).toMatchObject({
          position: 'absolute',
          top: '0px',
          left: '0px',
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          zIndex: canvases[0].style.zIndex,
        });
      }

      // Back to one run: the extra canvases hide, and go when the session ends.
      session.updateRenderState({ layers: [first] });
      runFrame(session);
      expect(canvases.map((canvas) => canvas.style.visibility)).toEqual([
        '',
        'hidden',
        'hidden',
      ]);
      session.end();
      jest.runOnlyPendingTimers();
      expect(canvases[1].isConnected).toBe(false);
      expect(canvases[2].isConnected).toBe(false);
    });
  });
});
