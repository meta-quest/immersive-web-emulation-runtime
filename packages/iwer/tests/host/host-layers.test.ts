/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Host mode quad and cylinder layers (WebXR Layers: createQuadLayer,
// createCylinderLayer, getSubImage, renderState.layers) and the host contract
// for them in src/host/types.ts (layer swapchains, getLayerColorTexture,
// releaseSwapchain, submitLayers). Fixture values are arbitrary.

import { P_CONTENT_LAYER } from '../../src/private';
import { XRDevice, XRDeviceConfig } from '../../src/device/XRDevice';
import { metaQuest3 } from '../../src/device/configs/headset/meta';
import { XRSession } from '../../src/session/XRSession';
import type {
  XRHostBackend,
  XRHostFrame,
  XRHostLayer,
  XRHostSwapchainOptions,
} from '../../src/host/types';
import { XRFrame } from '../../src/frameloop/XRFrame';
import { XRHostWebGLBinding } from '../../src/host/XRHostWebGLBinding';
import { XRWebGLBinding } from '../../src/depth/XRWebGLBinding';
import { XRCylinderLayer, XRQuadLayer } from '../../src/layers/XRContentLayer';
import { XRWebGLLayer } from '../../src/layers/XRWebGLLayer';
import { XRRigidTransform } from '../../src/primitives/XRRigidTransform';
import { XRReferenceSpace } from '../../src/spaces/XRReferenceSpace';

const EYE_FOV = [-0.82, 0.76, 0.85, -0.93];

const testHost: XRDeviceConfig = {
  ...metaQuest3,
  name: 'Test Host',
  supportedFeatures: [...metaQuest3.supportedFeatures, 'layers'],
};

type Submitted = Array<Omit<XRHostLayer, 'pose'> & { pose: number[] }>;

function makeBackend(over: Partial<XRHostBackend> = {}) {
  const rec = {
    swapchains: [] as XRHostSwapchainOptions[],
    released: [] as number[],
    frames: [] as Submitted[],
    textures: new Map<number, WebGLTexture>(),
    /** What IWER caught and reported during frames (`source: error`). */
    errors: [] as string[],
  };
  let nextId = 7;
  const backend: XRHostBackend = {
    beginSwapchain: (options) => {
      rec.swapchains.push(options);
      return {
        width: options.width ?? 1832,
        height: options.height ?? 1920,
        arraySize: options.arraySize,
        ...(options.layer ? { id: nextId++ } : {}),
      };
    },
    endSession: () => {},
    getOpaqueColorTexture: () => ({ opaque: true }) as unknown as WebGLTexture,
    getLayerColorTexture: (id) => {
      let t = rec.textures.get(id);
      if (!t) {
        t = { layerTexture: id } as unknown as WebGLTexture;
        rec.textures.set(id, t);
      }
      return t;
    },
    releaseSwapchain: (id) => {
      rec.released.push(id);
    },
    submitLayers: (layers) => {
      // a copy: IWER rewrites its entries every frame
      rec.frames.push(layers.map((l) => ({ ...l, pose: Array.from(l.pose) })));
    },
    postTask: (task) => task(),
    reportError: (e, source) => rec.errors.push(`${source}: ${String(e)}`),
    ...over,
  };
  return { backend, rec };
}

/** A host frame; `headX` moves the head (both eyes) along the base space's x. */
function makeFrame(headX = 0): XRHostFrame {
  const views = new Float32Array(22);
  views.set([headX - 0.03, 1.7, 0, 0, 0, 0, 1, ...EYE_FOV], 0);
  views.set([headX + 0.03, 1.7, 0, 0, 0, 0, 1, ...EYE_FOV], 11);
  return {
    predictedDisplayTime: 5000,
    shouldRender: true,
    viewCount: 2,
    views,
    localPose: new Float32Array([0.3, 1.5, -0.2, 0, 0, 0, 1]),
    baseIsStage: true,
    colorTexture: 41,
    frameRate: 72,
  };
}

type GLCall = [string, ...unknown[]];

/** A recording WebGL2 stand-in with what layers and clearOnAccess use. */
function makeGL() {
  const calls: GLCall[] = [];
  const state = {
    draw: 'page-fb' as unknown,
    scissor: true,
    mask: [true, false, true, true],
    clear: new Float32Array([0.1, 0.2, 0.3, 0.4]),
  };
  const gl: Record<string, unknown> = {
    DRAW_FRAMEBUFFER: 0x8ca9,
    createFramebuffer: () => ({ framebuffer: calls.length }),
    getParameter: (pname: number) => {
      if (pname === 0x8ca6) return state.draw;
      if (pname === 0x0c23) return state.mask.slice();
      if (pname === 0x0c22) return state.clear.slice();
      return null;
    },
    isEnabled: (cap: number) => (cap === 0x0c11 ? state.scissor : false),
    bindFramebuffer: (target: number, fb: unknown) => {
      calls.push(['bindFramebuffer', target, fb]);
      state.draw = fb;
    },
    enable: (cap: number) => {
      calls.push(['enable', cap]);
      if (cap === 0x0c11) state.scissor = true;
    },
    disable: (cap: number) => {
      calls.push(['disable', cap]);
      if (cap === 0x0c11) state.scissor = false;
    },
    colorMask: (...m: boolean[]) => {
      calls.push(['colorMask', ...m]);
      state.mask = m;
    },
    clearColor: (...c: number[]) => {
      calls.push(['clearColor', ...c]);
      state.clear = new Float32Array(c);
    },
    clear: (bits: number) => calls.push(['clear', bits]),
    framebufferTexture2D: (...a: unknown[]) =>
      calls.push(['framebufferTexture2D', ...a]),
    framebufferTextureLayer: (...a: unknown[]) =>
      calls.push(['framebufferTextureLayer', ...a]),
    deleteFramebuffer: (fb: unknown) => calls.push(['deleteFramebuffer', fb]),
    getContextAttributes: () => ({ premultipliedAlpha: true }),
  };
  return { gl: gl as unknown as WebGL2RenderingContext, calls, state };
}

async function startSession(
  over: Partial<XRHostBackend> = {},
  features: string[] = ['local-floor', 'layers'],
) {
  const { backend, rec } = makeBackend(over);
  const device = new XRDevice(testHost, { host: backend });
  const globalObject: Record<string, unknown> = {};
  device.installRuntime({ globalObject });
  const session = (await navigator.xr!.requestSession('immersive-vr', {
    optionalFeatures: features,
  })) as unknown as XRSession;
  const local = (await session.requestReferenceSpace(
    'local' as never,
  )) as unknown as XRReferenceSpace;
  const { gl, calls, state } = makeGL();
  const binding = new XRHostWebGLBinding(session, gl);
  return {
    device,
    session,
    backend,
    rec,
    globalObject,
    local,
    gl,
    glCalls: calls,
    glState: state,
    binding,
  };
}

/**
 * Runs one host frame with `read` as the XR callback. IWER catches what a
 * callback throws (and reports it), so a failed expectation inside `read` is
 * caught here and thrown once the frame has run.
 */
function frameWith(
  device: XRDevice,
  session: XRSession,
  read: (frame: XRFrame) => void = () => {},
  headX = 0,
): void {
  let ran = false;
  let failure: { error: unknown } | null = null;
  session.requestAnimationFrame((_t, f) => {
    ran = true;
    try {
      read(f as unknown as XRFrame);
    } catch (error) {
      failure = { error };
    }
  });
  device.runHostFrame(makeFrame(headX));
  if (!ran) throw new Error('the XR callback did not run');
  if (failure) throw (failure as { error: unknown }).error;
}

const quadInit = (space: XRReferenceSpace, over: object = {}) => ({
  space,
  viewPixelWidth: 512,
  viewPixelHeight: 256,
  transform: new XRRigidTransform({ x: 0, y: 0, z: -1 }),
  width: 0.4,
  height: 0.2,
  ...over,
});

describe('host mode quad and cylinder layers', () => {
  afterEach(() => {
    const nav = navigator as { xr?: unknown };
    if (nav.xr) delete nav.xr;
  });

  describe('creation', () => {
    test('host mode installs the layer classes and both create methods; the emulator does not', async () => {
      const { globalObject } = await startSession();
      expect(globalObject.XRQuadLayer).toBe(XRQuadLayer);
      expect(globalObject.XRCylinderLayer).toBe(XRCylinderLayer);
      const proto = XRHostWebGLBinding.prototype as unknown as Record<
        string,
        unknown
      >;
      expect(typeof proto.createQuadLayer).toBe('function');
      expect(typeof proto.createCylinderLayer).toBe('function');
      expect(typeof proto.getSubImage).toBe('function');
      expect('createQuadLayer' in XRWebGLBinding.prototype).toBe(false);
    });

    test('each layer gets a swapchain of its own, sized for its layout', async () => {
      const { binding, local, rec } = await startSession();
      const mono = binding.createQuadLayer(quadInit(local));
      binding.createQuadLayer(quadInit(local, { layout: 'stereo' }));
      binding.createQuadLayer(quadInit(local, { layout: 'stereo-top-bottom' }));
      binding.createCylinderLayer({
        space: local,
        viewPixelWidth: 300,
        viewPixelHeight: 100,
        layout: 'stereo',
        textureType: 'texture-array',
        isStatic: true,
      });
      expect(rec.swapchains).toEqual([
        expect.objectContaining({
          layer: 'quad',
          width: 512,
          height: 256,
          arraySize: 1,
          scale: 1,
          format: 0x8058,
          isStatic: false,
          mipLevels: 1,
          textureType: 'texture',
        }),
        expect.objectContaining({ layer: 'quad', width: 1024, height: 256 }),
        expect.objectContaining({ layer: 'quad', width: 512, height: 512 }),
        expect.objectContaining({
          layer: 'cylinder',
          width: 300,
          height: 100,
          arraySize: 2,
          isStatic: true,
          textureType: 'texture-array',
        }),
      ]);
      expect(mono).toBeInstanceOf(XRQuadLayer);
      expect(mono.layout).toBe('mono');
      expect(mono.needsRedraw).toBe(true);
      expect(mono.mipLevels).toBe(1);
      // WebXR Layers' default (Chromium, the Layers polyfill)
      expect(mono.blendTextureSourceAlpha).toBe(true);
      mono.blendTextureSourceAlpha = false;
      expect(mono.blendTextureSourceAlpha).toBe(false);
      // 'stereo' with a plain texture: the UA picks side by side
      expect(
        binding.createQuadLayer(quadInit(local, { layout: 'stereo' })).layout,
      ).toBe('stereo-left-right');
    });

    test('defaults follow the WebXR Layers IDL', async () => {
      const { binding, local } = await startSession();
      const quad = binding.createQuadLayer({
        space: local,
        viewPixelWidth: 16,
        viewPixelHeight: 16,
      });
      expect([quad.width, quad.height]).toEqual([1, 1]);
      expect(quad.transform.position.z).toBe(0);
      const cylinder = binding.createCylinderLayer({
        space: local,
        viewPixelWidth: 16,
        viewPixelHeight: 16,
      });
      expect(cylinder.radius).toBe(2);
      expect(cylinder.centralAngle).toBeCloseTo(Math.PI / 4, 4);
      expect(cylinder.aspectRatio).toBe(2);
    });

    test('invalid inits throw the WebXR Layers errors', async () => {
      const { binding, local } = await startSession();
      expect(() =>
        binding.createQuadLayer(quadInit(local, { layout: 'default' })),
      ).toThrow(TypeError);
      expect(() =>
        binding.createQuadLayer(
          quadInit(local, {
            layout: 'stereo-left-right',
            textureType: 'texture-array',
          }),
        ),
      ).toThrow(TypeError);
      expect(() =>
        binding.createQuadLayer(quadInit(local, { viewPixelWidth: 0 })),
      ).toThrow(TypeError);
      expect(() =>
        binding.createQuadLayer(quadInit(local, { space: {} })),
      ).toThrow(TypeError);
      expect(() =>
        binding.createQuadLayer(quadInit(local, { textureType: 'cube' })),
      ).toThrow(TypeError);
    });

    test('NotSupportedError without the layers feature or a host that presents layers; OperationError when the host fails', async () => {
      const noLayers = await startSession({}, ['local-floor']);
      expect(() =>
        noLayers.binding.createQuadLayer(quadInit(noLayers.local)),
      ).toThrow(expect.objectContaining({ name: 'NotSupportedError' }));
      delete (navigator as { xr?: unknown }).xr;

      const noHook = await startSession({ getLayerColorTexture: undefined });
      expect(() =>
        noHook.binding.createQuadLayer(quadInit(noHook.local)),
      ).toThrow(expect.objectContaining({ name: 'NotSupportedError' }));
      delete (navigator as { xr?: unknown }).xr;

      const failing = await startSession({ beginSwapchain: () => null });
      expect(() =>
        failing.binding.createCylinderLayer(quadInit(failing.local)),
      ).toThrow(expect.objectContaining({ name: 'OperationError' }));
    });

    test('an ended session refuses new layers', async () => {
      const { binding, local, session } = await startSession();
      await session.end();
      expect(() => binding.createQuadLayer(quadInit(local))).toThrow(
        expect.objectContaining({ name: 'InvalidStateError' }),
      );
    });
  });

  describe('getSubImage', () => {
    test('a view sub-image with the layer texture, inside an animation frame only', async () => {
      const { binding, local, device, session, rec } = await startSession();
      const layer = binding.createQuadLayer(
        quadInit(local, { clearOnAccess: false }),
      );
      let kept: XRFrame | null = null;
      frameWith(device, session, (frame) => {
        kept = frame;
        const sub = binding.getSubImage(layer, frame);
        expect(sub.colorTexture).toBe(rec.textures.get(7));
        expect([sub.viewport.x, sub.viewport.width]).toEqual([0, 512]);
        expect([sub.colorTextureWidth, sub.colorTextureHeight]).toEqual([
          512, 256,
        ]);
        expect(sub.imageIndex).toBe(0);
        // the same object every time
        expect(binding.getSubImage(layer, frame)).toBe(sub);
      });
      expect(layer.needsRedraw).toBe(false);
      expect(() => binding.getSubImage(layer, kept!)).toThrow(
        expect.objectContaining({ name: 'InvalidStateError' }),
      );
    });

    test('stereo layers need an eye; each eye gets its region', async () => {
      const { binding, local, device, session } = await startSession();
      const lr = binding.createQuadLayer(
        quadInit(local, { layout: 'stereo-left-right', clearOnAccess: false }),
      );
      const tb = binding.createQuadLayer(
        quadInit(local, { layout: 'stereo-top-bottom', clearOnAccess: false }),
      );
      const arr = binding.createQuadLayer(
        quadInit(local, {
          layout: 'stereo',
          textureType: 'texture-array',
          clearOnAccess: false,
        }),
      );
      frameWith(device, session, (frame) => {
        expect(() => binding.getSubImage(lr, frame)).toThrow(TypeError);
        expect(
          binding.getSubImage(lr, frame, 'right' as never).viewport.x,
        ).toBe(512);
        expect(binding.getSubImage(tb, frame, 'left' as never).viewport.y).toBe(
          256,
        );
        expect(
          binding.getSubImage(tb, frame, 'right' as never).viewport.y,
        ).toBe(0);
        expect(
          binding.getSubImage(arr, frame, 'right' as never).imageIndex,
        ).toBe(1);
      });
    });

    test('a static layer is drawn once; projection layers are refused', async () => {
      const { binding, local, device, session } = await startSession();
      const layer = binding.createQuadLayer(
        quadInit(local, { isStatic: true, clearOnAccess: false }),
      );
      const projection = binding.createProjectionLayer();
      frameWith(device, session, (frame) => {
        binding.getSubImage(layer, frame);
        expect(() => binding.getSubImage(projection as never, frame)).toThrow(
          TypeError,
        );
      });
      expect(layer.needsRedraw).toBe(false);
      frameWith(device, session, (frame) => {
        expect(() => binding.getSubImage(layer, frame)).toThrow(
          expect.objectContaining({ name: 'InvalidStateError' }),
        );
      });
    });

    test('a static layer is drawn whole in its first frame: both eyes of a stereo layer, any number of times', async () => {
      const { binding, local, device, session, rec } = await startSession();
      const lr = binding.createQuadLayer(
        quadInit(local, { isStatic: true, layout: 'stereo-left-right' }),
      );
      const arr = binding.createQuadLayer(
        quadInit(local, {
          isStatic: true,
          layout: 'stereo',
          textureType: 'texture-array',
        }),
      );
      const mono = binding.createQuadLayer(quadInit(local, { isStatic: true }));
      session.updateRenderState({ layers: [lr, arr, mono] } as never);
      const seen: unknown[] = [];
      frameWith(device, session, (frame) => {
        seen.push(binding.getSubImage(lr, frame, 'left' as never).viewport.x);
        seen.push(binding.getSubImage(lr, frame, 'right' as never).viewport.x);
        seen.push(binding.getSubImage(arr, frame, 'left' as never).imageIndex);
        seen.push(binding.getSubImage(arr, frame, 'right' as never).imageIndex);
        seen.push(
          binding.getSubImage(mono, frame) === binding.getSubImage(mono, frame),
        );
        // needsRedraw goes false once the frame is over
        seen.push(lr.needsRedraw);
      });
      expect(seen).toEqual([0, 512, 0, 1, true, true]);
      expect(rec.frames[0].map((l) => [l.id, l.redrawn])).toEqual([
        [7, true],
        [8, true],
        [9, true],
      ]);
      expect([lr.needsRedraw, arr.needsRedraw, mono.needsRedraw]).toEqual([
        false,
        false,
        false,
      ]);
      frameWith(device, session, (frame) => {
        expect(() => binding.getSubImage(lr, frame, 'right' as never)).toThrow(
          expect.objectContaining({ name: 'InvalidStateError' }),
        );
      });
      expect(rec.errors).toEqual([]);
    });

    test('a mono texture-array layer is a texture array of one layer', async () => {
      const { binding, local, device, session, rec, glCalls } =
        await startSession();
      const layer = binding.createQuadLayer(
        quadInit(local, { textureType: 'texture-array' }),
      );
      expect(layer.layout).toBe('mono');
      expect(rec.swapchains[0]).toMatchObject({
        arraySize: 1,
        textureType: 'texture-array',
        width: 512,
        height: 256,
      });
      let index = -1;
      frameWith(device, session, (frame) => {
        index = binding.getSubImage(layer, frame).imageIndex;
      });
      expect(index).toBe(0);
      // cleared as layer 0 of an array texture, not as a 2D texture
      expect(
        glCalls
          .filter((c) => c[0] === 'framebufferTextureLayer')
          .map((c) => c[5]),
      ).toEqual([0]);
      expect(glCalls.some((c) => c[0] === 'framebufferTexture2D')).toBe(false);
    });

    test('clearOnAccess clears every array layer once per frame and restores the page state', async () => {
      const { binding, local, device, session, glCalls, glState } =
        await startSession();
      const layer = binding.createQuadLayer(
        quadInit(local, { layout: 'stereo', textureType: 'texture-array' }),
      );
      frameWith(device, session, (frame) => {
        binding.getSubImage(layer, frame, 'left' as never);
        binding.getSubImage(layer, frame, 'right' as never);
      });
      expect(glCalls.filter((c) => c[0] === 'clear')).toHaveLength(2);
      expect(
        glCalls
          .filter((c) => c[0] === 'framebufferTextureLayer')
          .map((c) => c[5]),
      ).toEqual([0, 1]);
      expect(glState.draw).toBe('page-fb');
      expect(glState.scissor).toBe(true);
      expect(glState.mask).toEqual([true, false, true, true]);
      expect(Array.from(glState.clear)).toEqual(
        Array.from(new Float32Array([0.1, 0.2, 0.3, 0.4])),
      );
      frameWith(device, session, (frame) => {
        binding.getSubImage(layer, frame, 'left' as never);
      });
      expect(glCalls.filter((c) => c[0] === 'clear')).toHaveLength(4);
    });

    test('WebGL 2 clears with clearBufferfv and leaves the clear colour alone', async () => {
      const { binding, local, device, session, gl, glCalls, glState } =
        await startSession();
      (gl as unknown as Record<string, unknown>).clearBufferfv = (
        ...a: unknown[]
      ) =>
        glCalls.push([
          'clearBufferfv',
          a[0],
          a[1],
          Array.from(a[2] as Float32Array),
        ]);
      const layer = binding.createQuadLayer(quadInit(local));
      frameWith(device, session, (frame) => binding.getSubImage(layer, frame));
      expect(glCalls.filter((c) => c[0] === 'clearBufferfv')).toEqual([
        ['clearBufferfv', 0x1800, 0, [0, 0, 0, 0]],
      ]);
      expect(
        glCalls.some((c) => c[0] === 'clear' || c[0] === 'clearColor'),
      ).toBe(false);
      expect(glState.mask).toEqual([true, false, true, true]);
      expect(glState.draw).toBe('page-fb');
    });

    test('the clear framebuffer is deleted with its layer and at session end', async () => {
      const { binding, local, device, session, glCalls } = await startSession();
      const a = binding.createQuadLayer(quadInit(local));
      const b = binding.createQuadLayer(quadInit(local));
      const c = binding.createQuadLayer(
        quadInit(local, { clearOnAccess: false }),
      );
      frameWith(device, session, (frame) => {
        binding.getSubImage(a, frame);
        binding.getSubImage(b, frame);
        binding.getSubImage(c, frame);
      });
      const made = glCalls
        .filter((x) => x[0] === 'bindFramebuffer' && x[2] !== 'page-fb')
        .map((x) => x[2]);
      const [fbA, fbB] = [...new Set(made)];
      expect(fbA).not.toBe(fbB);
      a.destroy();
      expect(glCalls.filter((x) => x[0] === 'deleteFramebuffer')).toEqual([
        ['deleteFramebuffer', fbA],
      ]);
      await session.end();
      expect(glCalls.filter((x) => x[0] === 'deleteFramebuffer')).toEqual([
        ['deleteFramebuffer', fbA],
        ['deleteFramebuffer', fbB],
      ]);
      // a destroy after the end deletes nothing twice
      b.destroy();
      c.destroy();
      expect(glCalls.filter((x) => x[0] === 'deleteFramebuffer')).toHaveLength(
        2,
      );
    });

    test('clearOnAccess false leaves the image alone', async () => {
      const { binding, local, device, session, glCalls } = await startSession();
      const layer = binding.createQuadLayer(
        quadInit(local, { clearOnAccess: false }),
      );
      frameWith(device, session, (frame) => binding.getSubImage(layer, frame));
      expect(glCalls.filter((c) => c[0] === 'clear')).toHaveLength(0);
    });
  });

  describe('the frame layer list', () => {
    test('renderState.layers order, shapes in the host convention, base-space poses and redraws', async () => {
      const { binding, local, device, session, rec } = await startSession();
      const projection = binding.createProjectionLayer();
      const quad = binding.createQuadLayer(quadInit(local));
      const cylinder = binding.createCylinderLayer({
        space: local,
        viewPixelWidth: 64,
        viewPixelHeight: 32,
        radius: 1.5,
        centralAngle: 1,
        aspectRatio: 3,
      });
      cylinder.blendTextureSourceAlpha = false;
      session.updateRenderState({
        layers: [projection, cylinder, quad],
      } as never);
      frameWith(device, session, (frame) => binding.getSubImage(quad, frame));
      const [list] = rec.frames;
      expect(list.map((l) => [l.kind, l.listed])).toEqual([
        ['projection', true],
        ['cylinder', true],
        ['quad', true],
      ]);
      const [, cyl, q] = list;
      expect(q).toMatchObject({
        id: 7,
        redrawn: true,
        layout: 'mono',
        blendTextureSourceAlpha: true,
        located: true,
        viewerSpace: false,
        width: 0.8,
        height: 0.4,
      });
      // local = the host's LOCAL pose (0.3, 1.5, -0.2); the quad 1 m ahead
      expect(q.pose[0]).toBeCloseTo(0.3, 5);
      expect(q.pose[1]).toBeCloseTo(1.5, 5);
      expect(q.pose[2]).toBeCloseTo(-1.2, 5);
      expect(q.pose[6]).toBeCloseTo(1, 5);
      expect(cyl).toMatchObject({
        id: 8,
        redrawn: false,
        blendTextureSourceAlpha: false,
        radius: 1.5,
        centralAngle: 1,
        aspectRatio: 3,
      });

      // not drawn: the layer keeps its content
      frameWith(device, session);
      expect(rec.frames[1].map((l) => l.redrawn)).toEqual([true, false, false]);
    });

    test('a layer keeps its own copy of a transform (IWER rewrites the transforms of pooled poses)', async () => {
      const { binding, local, device, session, rec } = await startSession();
      const viewer = (await session.requestReferenceSpace(
        'viewer' as never,
      )) as unknown as XRReferenceSpace;
      const set = binding.createQuadLayer(quadInit(local));
      let made: XRQuadLayer | null = null;
      let placedX = NaN;
      // pinned where the head is (x -0.3), from the init and the attribute
      frameWith(
        device,
        session,
        (frame) => {
          const transform = frame.getPose(viewer, local)!.transform;
          placedX = transform.position.x;
          made = binding.createQuadLayer(quadInit(local, { transform }));
          set.transform = transform;
          session.updateRenderState({ layers: [made, set] } as never);
        },
        -0.3,
      );
      // the head moves on and the page keeps asking for its pose
      for (let i = 0; i < 4; i++) {
        frameWith(device, session, (frame) => frame.getPose(viewer, local), 1);
      }
      expect(made!.transform.position.x).toBeCloseTo(placedX, 5);
      expect(set.transform.position.x).toBeCloseTo(placedX, 5);
      const last = rec.frames[rec.frames.length - 1];
      expect(last.map((l) => l.pose[0])).toEqual([
        expect.closeTo(-0.3, 5),
        expect.closeTo(-0.3, 5),
      ]);
    });

    test('space and transform take only an XRSpace and an XRRigidTransform; a layer whose pose fails is left out, reported once', async () => {
      const { binding, local, device, session, rec } = await startSession();
      const a = binding.createQuadLayer(quadInit(local));
      const b = binding.createQuadLayer(quadInit(local));
      expect(() => {
        b.transform = null as never;
      }).toThrow(TypeError);
      expect(() => {
        a.space = undefined as never;
      }).toThrow(TypeError);
      expect(() =>
        binding.createQuadLayer(quadInit(local, { transform: {} })),
      ).toThrow(TypeError);
      session.updateRenderState({ layers: [a, b] } as never);
      // a state the attributes cannot produce: b's pose step throws
      (b as unknown as Record<symbol, { transform: unknown }>)[
        P_CONTENT_LAYER
      ].transform = null;
      frameWith(device, session);
      frameWith(device, session);
      expect(rec.frames.map((f) => f.map((l) => [l.id, l.located]))).toEqual([
        [
          [7, true],
          [8, false],
        ],
        [
          [7, true],
          [8, false],
        ],
      ]);
      expect(rec.errors).toHaveLength(1);
      expect(rec.errors[0]).toMatch(/^layer: TypeError/);
    });

    test('a head-locked layer is reported in the viewer space', async () => {
      const { binding, device, session, rec } = await startSession();
      const viewer = (await session.requestReferenceSpace(
        'viewer' as never,
      )) as unknown as XRReferenceSpace;
      const quad = binding.createQuadLayer(quadInit(viewer));
      session.updateRenderState({ layers: [quad] } as never);
      frameWith(device, session);
      const [q] = rec.frames[0];
      expect(q.viewerSpace).toBe(true);
      expect(q.pose.slice(0, 3)).toEqual([0, 0, -1]);
    });

    test('a layer drawn but not listed is appended unlisted; a repeated layer is listed once', async () => {
      const { binding, local, device, session, rec } = await startSession();
      const shown = binding.createQuadLayer(quadInit(local));
      const hidden = binding.createQuadLayer(quadInit(local));
      session.updateRenderState({ layers: [shown, shown] } as never);
      frameWith(device, session, (frame) => binding.getSubImage(hidden, frame));
      expect(rec.frames[0].map((l) => [l.id, l.listed, l.redrawn])).toEqual([
        [7, true, false],
        [8, false, true],
      ]);
      frameWith(device, session);
      expect(rec.frames[1].map((l) => l.id)).toEqual([7]);
    });

    test('destroy() releases the swapchain once and drops the layer from the list', async () => {
      const { binding, local, device, session, rec } = await startSession();
      const quad = binding.createQuadLayer(quadInit(local));
      session.updateRenderState({ layers: [quad] } as never);
      frameWith(device, session);
      quad.destroy();
      quad.destroy();
      expect(rec.released).toEqual([7]);
      frameWith(device, session, (frame) => {
        expect(() => binding.getSubImage(quad, frame)).toThrow(
          expect.objectContaining({ name: 'InvalidStateError' }),
        );
      });
      expect(rec.frames[1]).toEqual([]);
    });

    test('an XRWebGLLayer session submits no list; the end of the session destroys every layer without host calls', async () => {
      const { binding, local, device, session, rec, gl } = await startSession({
        wrapTexture: (name) => ({ name }) as unknown as WebGLTexture,
      });
      const quad = binding.createQuadLayer(quadInit(local));
      session.updateRenderState({
        baseLayer: new XRWebGLLayer(session, gl, { depth: false }),
      });
      frameWith(device, session);
      expect(rec.frames).toEqual([]);
      await session.end();
      quad.destroy();
      expect(rec.released).toEqual([]);
    });

    test('a list that throws in the host is reported as a layer error and the frame goes on', async () => {
      const errors: string[] = [];
      const { binding, local, device, session } = await startSession({
        submitLayers: () => {
          throw new Error('host broke');
        },
        reportError: (e, source) => errors.push(`${source}: ${String(e)}`),
      });
      session.updateRenderState({
        layers: [binding.createQuadLayer(quadInit(local))],
      } as never);
      frameWith(device, session);
      expect(errors).toEqual(['layer: Error: host broke']);
    });
  });
});
