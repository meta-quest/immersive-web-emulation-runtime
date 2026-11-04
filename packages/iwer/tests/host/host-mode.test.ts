/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Host mode behaviour tests. Expectations come from the WebXR Device API,
// WebXR Layers, Plane/Mesh Detection, HOST-INPUT.md and the host-mode
// contract in src/host/types.ts; the fixture values are arbitrary.

import { mat4, quat, vec3 } from 'gl-matrix';

import { XRDevice, XRDeviceConfig } from '../../src/device/XRDevice';
import { metaQuest3 } from '../../src/device/configs/headset/meta';
import { XRSession } from '../../src/session/XRSession';
import type {
  XRHostBackend,
  XRHostFrame,
  XRHostSwapchain,
  XRHostSwapchainOptions,
} from '../../src/host/types';
import { RATE_CONFIRMATION_FRAME_LIMIT } from '../../src/host/frame-rate';
import { ASSUMED_EYE_HEIGHT } from '../../src/host/reference-spaces';
import { XRFrame } from '../../src/frameloop/XRFrame';
import { XRHostWebGLBinding } from '../../src/host/XRHostWebGLBinding';
import {
  XRProjectionLayer,
  XRWebGLSubImage,
} from '../../src/layers/XRProjectionLayer';
import { XRWebGLLayer } from '../../src/layers/XRWebGLLayer';
import { XRWebGLBinding } from '../../src/depth/XRWebGLBinding';
import { XRReferenceSpace } from '../../src/spaces/XRReferenceSpace';
import { XRBoundedReferenceSpace } from '../../src/spaces/XRBoundedReferenceSpace';
import { XRRigidTransform } from '../../src/primitives/XRRigidTransform';
import { XRView } from '../../src/views/XRView';
import { NativePlane } from '../../src/planes/XRPlane';
import { NativeMesh } from '../../src/meshes/XRMesh';
import { XRSemanticLabels } from '../../src/labels/labels';
import { XRHostInputMode } from '../../src/device/XRHostInput';
import { P_DEVICE, P_SESSION, P_SPACE } from '../../src/private';

// ---------------------------------------------------------------------------
// fixtures

/** Field of view used for both eyes: left, right, up, down (radians). */
const EYE_FOV = [-0.82, 0.76, 0.85, -0.93];
const EYE_HEIGHT = 1.72;
const HALF_IPD = 0.031;
const SWAPCHAIN_IMAGE = 41;

const RGBA8 = 0x8058;
const DEPTH_COMPONENT24 = 0x81a6;
const DEPTH24_STENCIL8 = 0x88f0;
const DEPTH_ATTACHMENT = 0x8d00;
const DEPTH_STENCIL_ATTACHMENT = 0x821a;
const COLOR_ATTACHMENT0 = 0x8ce0;

const testHost: XRDeviceConfig = {
  ...metaQuest3,
  name: 'Test Host',
  supportedFeatures: [
    ...metaQuest3.supportedFeatures,
    'layers',
    'medium-fixed-foveation-level',
  ],
};

function stageSwapchain(over: Partial<XRHostSwapchain> = {}): XRHostSwapchain {
  return {
    width: 1832,
    height: 1920,
    arraySize: 2,
    rates: [60, 72, 90],
    rate: 60,
    hasStage: true,
    stageWidth: 4,
    stageDepth: 2.5,
    ...over,
  };
}

type Recorder = {
  swapchainRequests: XRHostSwapchainOptions[];
  endSessionCalls: number;
  rateRequests: number[];
  foveations: number[];
  passthrough: boolean[];
  windowFrames: number[];
  tasks: Array<() => void>;
  errors: Array<{ error: unknown; source: string }>;
};

function makeBackend(over: Partial<XRHostBackend> = {}) {
  const rec: Recorder = {
    swapchainRequests: [],
    endSessionCalls: 0,
    rateRequests: [],
    foveations: [],
    passthrough: [],
    windowFrames: [],
    tasks: [],
    errors: [],
  };
  const opaque = { opaqueTexture: true } as unknown as WebGLTexture;
  const backend: XRHostBackend = {
    beginSwapchain: (options) => {
      rec.swapchainRequests.push(options);
      return stageSwapchain({ arraySize: options.arraySize });
    },
    endSession: () => {
      rec.endSessionCalls++;
    },
    requestFrameRate: (rate) => {
      rec.rateRequests.push(rate);
      return true;
    },
    setFixedFoveation: (level) => {
      rec.foveations.push(level);
    },
    setPassthroughVisible: (visible) => {
      rec.passthrough.push(visible);
    },
    getOpaqueColorTexture: () => opaque,
    wrapTexture: (name) => ({ wrapped: name }) as unknown as WebGLTexture,
    runWindowFrame: (time) => {
      rec.windowFrames.push(time);
    },
    postTask: (task) => {
      rec.tasks.push(task);
    },
    ...over,
  };
  return { backend, rec, opaque };
}

/** A host frame with two eyes looking down -z from `head`. */
function makeFrame(over: Partial<XRHostFrame> = {}): XRHostFrame {
  const views = new Float32Array(22);
  const eye = (offset: number, x: number) => {
    views.set([x, EYE_HEIGHT, 0.05, 0, 0, 0, 1], offset);
    views.set(EYE_FOV, offset + 7);
  };
  eye(0, -HALF_IPD);
  eye(11, HALF_IPD);
  return {
    predictedDisplayTime: 5000,
    shouldRender: true,
    viewCount: 2,
    views,
    localPose: new Float32Array([0.3, 1.5, -0.2, 0, 0, 0, 1]),
    baseIsStage: true,
    colorTexture: SWAPCHAIN_IMAGE,
    frameRate: 60,
    ...over,
  };
}

type GLCall = [string, ...unknown[]];

/**
 * A recording WebGL2 stand-in with just what host layers use. Constant
 * values are those of the WebGL 2.0 IDL.
 */
function makeGL(
  options: {
    webgl1?: boolean;
    premultipliedAlpha?: boolean;
    /** WebGL2 without invalidateFramebuffer (a minimal host binding). */
    noInvalidate?: boolean;
  } = {},
) {
  const calls: GLCall[] = [];
  const state = {
    draw: null as unknown,
    read: null as unknown,
    renderbuffer: null as unknown,
  };
  const gl: Record<string, unknown> = {
    FRAMEBUFFER: 0x8d40,
    DRAW_FRAMEBUFFER: 0x8ca9,
    READ_FRAMEBUFFER: 0x8ca8,
    FRAMEBUFFER_BINDING: 0x8ca6,
    READ_FRAMEBUFFER_BINDING: 0x8caa,
    RENDERBUFFER: 0x8d41,
    RENDERBUFFER_BINDING: 0x8ca7,
    TEXTURE_2D: 0x0de1,
    COLOR_ATTACHMENT0,
    drawingBufferWidth: 300,
    drawingBufferHeight: 150,
    createFramebuffer: () => ({ framebuffer: calls.length }),
    createRenderbuffer: () => ({ renderbuffer: calls.length }),
    getParameter: (pname: number) => {
      if (pname === 0x8ca6) return state.draw;
      if (pname === 0x8caa) return state.read;
      if (pname === 0x8ca7) return state.renderbuffer;
      return null;
    },
    bindFramebuffer: (target: number, fb: unknown) => {
      calls.push(['bindFramebuffer', target, fb]);
      if (target === 0x8d40 || target === 0x8ca9) state.draw = fb;
      if (target === 0x8d40 || target === 0x8ca8) state.read = fb;
    },
    bindRenderbuffer: (target: number, rb: unknown) => {
      calls.push(['bindRenderbuffer', target, rb]);
      state.renderbuffer = rb;
    },
    renderbufferStorage: (...args: unknown[]) =>
      calls.push(['renderbufferStorage', ...args]),
    framebufferRenderbuffer: (...args: unknown[]) =>
      calls.push(['framebufferRenderbuffer', ...args]),
    framebufferTexture2D: (...args: unknown[]) =>
      calls.push(['framebufferTexture2D', ...args]),
    getContextAttributes: () => ({
      premultipliedAlpha: options.premultipliedAlpha ?? true,
    }),
  };
  if (options.webgl1) {
    // WebGL 1.0 has no separate draw and read framebuffer bindings
    delete gl.DRAW_FRAMEBUFFER;
    delete gl.READ_FRAMEBUFFER;
    delete gl.READ_FRAMEBUFFER_BINDING;
  } else if (!options.noInvalidate) {
    gl.invalidateFramebuffer = (...args: unknown[]) =>
      calls.push(['invalidateFramebuffer', ...args]);
  }
  return {
    gl: gl as unknown as WebGL2RenderingContext,
    calls,
    state,
  };
}

async function startSession(
  over: Partial<XRHostBackend> = {},
  init: {
    mode?: 'immersive-vr' | 'immersive-ar';
    features?: string[];
    required?: string[];
    config?: XRDeviceConfig;
  } = {},
) {
  const { backend, rec, opaque } = makeBackend(over);
  const device = new XRDevice(init.config ?? testHost, { host: backend });
  const globalObject: Record<string, unknown> = {};
  device.installRuntime({ globalObject });
  const session = (await navigator.xr!.requestSession(
    init.mode ?? 'immersive-vr',
    {
      optionalFeatures: init.features ?? ['local-floor', 'layers'],
      requiredFeatures: init.required,
    },
  )) as unknown as XRSession;
  return { device, session, backend, rec, opaque, globalObject };
}

function projectionLayer(
  session: XRSession,
  init: Record<string, unknown> = {},
  gl = makeGL().gl,
) {
  return new XRHostWebGLBinding(session, gl).createProjectionLayer(
    init as never,
  );
}

/** Runs one host frame with one XR callback and returns what it saw. */
function frameWith<T>(
  device: XRDevice,
  session: XRSession,
  read: (time: number, frame: XRFrame) => T,
  frame: XRHostFrame = makeFrame(),
): T {
  let seen: T | undefined;
  let ran = false;
  session.requestAnimationFrame((time, xrFrame) => {
    ran = true;
    seen = read(time, xrFrame as unknown as XRFrame);
  });
  device.runHostFrame(frame);
  if (!ran) {
    throw new Error('the XR callback did not run');
  }
  return seen as T;
}

/** requestReferenceSpace with a plain string type. */
const requestSpace = (session: XRSession, type: string) =>
  session.requestReferenceSpace(type as never);

const position = (m: ArrayLike<number>) => [m[12], m[13], m[14]];

// ---------------------------------------------------------------------------

describe('host mode', () => {
  let windowRaf: jest.SpyInstance;

  beforeEach(() => {
    windowRaf = jest.spyOn(globalThis, 'requestAnimationFrame');
  });

  afterEach(() => {
    windowRaf.mockRestore();
    jest.useRealTimers();
    const nav = navigator as { xr?: unknown };
    if (nav.xr) delete nav.xr;
  });

  describe('device and runtime install', () => {
    test('a host device creates no DOM and leaves navigator.userAgent alone', () => {
      const before = navigator.userAgent;
      const appended = jest.spyOn(document.body, 'appendChild');
      const device = new XRDevice(testHost, { host: makeBackend().backend });
      device.installRuntime({ globalObject: {} });
      expect(navigator.userAgent).toBe(before);
      expect(appended).not.toHaveBeenCalled();
      expect(device.hostBackend).toBeDefined();
      appended.mockRestore();
      device.uninstallRuntime();
    });

    test('only host mode installs an XRWebGLBinding that can create projection layers', () => {
      const hostGlobals: Record<string, unknown> = {};
      new XRDevice(testHost, { host: makeBackend().backend }).installRuntime({
        globalObject: hostGlobals,
      });
      const binding = hostGlobals.XRWebGLBinding as typeof XRWebGLBinding;
      expect(binding).toBe(XRHostWebGLBinding);
      expect('createProjectionLayer' in binding.prototype).toBe(true);
      expect(hostGlobals.XRProjectionLayer).toBe(XRProjectionLayer);
      expect(hostGlobals.XRWebGLSubImage).toBe(XRWebGLSubImage);

      const emulatorGlobals: Record<string, unknown> = {};
      new XRDevice(testHost).installRuntime({
        globalObject: emulatorGlobals,
        forceInstall: true,
      });
      const emulated = emulatorGlobals.XRWebGLBinding as typeof XRWebGLBinding;
      expect(emulated).toBe(XRWebGLBinding);
      expect('createProjectionLayer' in emulated.prototype).toBe(false);
    });

    test('a required feature the host lacks makes requestSession fail with NotSupportedError', async () => {
      await expect(
        startSession({}, { required: ['dom-overlay'] }),
      ).rejects.toMatchObject({ name: 'NotSupportedError' });
    });

    test('offerSession is granted at once when the host auto-grants', async () => {
      const { backend } = makeBackend({ autoGrantOfferedSession: true });
      const device = new XRDevice(testHost, { host: backend });
      device.installRuntime({ globalObject: {} });
      const session = await (
        navigator.xr as unknown as {
          offerSession(mode: string, init: object): Promise<XRSession>;
        }
      ).offerSession('immersive-vr', { optionalFeatures: ['layers'] });
      expect(session).toBeInstanceOf(XRSession);
      expect(device.activeSession).toBe(session);
    });
  });

  describe('session start and swapchain', () => {
    test('a host session runs no window frame loop and starts with an empty layers list', async () => {
      const { session } = await startSession();
      expect(windowRaf).not.toHaveBeenCalled();
      expect(session.renderState.layers).toEqual([]);
      expect(session.renderState.baseLayer).toBeNull();
    });

    test('neither requestSession nor requestReferenceSpace creates the swapchain; the first layer does', async () => {
      const { session, rec } = await startSession();
      await requestSpace(session, 'local-floor');
      expect(rec.swapchainRequests).toHaveLength(0);
      const first = projectionLayer(session, { textureType: 'texture-array' });
      expect(rec.swapchainRequests).toHaveLength(1);
      expect(rec.swapchainRequests[0]).toMatchObject({
        arraySize: 2,
        scale: 1,
        format: RGBA8,
      });
      expect(first.textureArrayLength).toBe(2);
      // a second layer shares it, whatever it asks for
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const second = projectionLayer(session, { textureType: 'texture' });
      warn.mockRestore();
      expect(rec.swapchainRequests).toHaveLength(1);
      expect(second.textureWidth).toBe(first.textureWidth);
    });

    test('swapchain options: texture type, scale, colour format, scene and startup foveation', async () => {
      const { session, rec } = await startSession(
        {},
        {
          features: [
            'layers',
            'plane-detection',
            'medium-fixed-foveation-level',
          ],
        },
      );
      projectionLayer(session, {
        textureType: 'texture',
        scaleFactor: -3,
        colorFormat: 0x8c43,
      });
      const options = rec.swapchainRequests[0];
      expect(options.arraySize).toBe(1);
      expect(options.scale).toBe(1);
      expect(options.format).toBe(0x8c43);
      expect(options.scene).toBe(true);
      expect(options.foveation).toBeCloseTo(2 / 3);
      expect(options.passthrough).toBeUndefined();
    });

    test('the host-applied foveation, rates and current rate are adopted', async () => {
      const { session } = await startSession({
        beginSwapchain: () =>
          stageSwapchain({ rates: [50, 100], rate: 100, foveation: 0.25 }),
      });
      const layer = projectionLayer(session);
      expect(layer.fixedFoveation).toBe(0.25);
      expect(Array.from(session.supportedFrameRates!)).toEqual([50, 100]);
      expect(session.frameRate).toBe(100);
    });

    test('a host that cannot make a swapchain turns into OperationError; an ended session into InvalidStateError', async () => {
      const failing = await startSession({ beginSwapchain: () => null });
      expect(() => projectionLayer(failing.session)).toThrow(
        expect.objectContaining({ name: 'OperationError' }),
      );
      await failing.session.end();

      const ended = await startSession();
      const binding = new XRHostWebGLBinding(ended.session, makeGL().gl);
      await ended.session.end();
      expect(() => binding.createProjectionLayer({})).toThrow(
        expect.objectContaining({ name: 'InvalidStateError' }),
      );
      expect(() => new XRHostWebGLBinding(ended.session, makeGL().gl)).toThrow(
        expect.objectContaining({ name: 'InvalidStateError' }),
      );
      expect(
        () => new XRHostWebGLBinding({} as XRSession, makeGL().gl),
      ).toThrow(TypeError);
    });

    test('createProjectionLayer rejects unknown texture types', async () => {
      const { session } = await startSession();
      expect(() => projectionLayer(session, { textureType: 'cube' })).toThrow(
        TypeError,
      );
    });
  });

  describe('projection layers', () => {
    test('texture-array: each eye has the whole image on its own array layer', async () => {
      const { session } = await startSession();
      const layer = projectionLayer(session, { textureType: 'texture-array' });
      expect(layer.layout).toBe('default');
      const binding = new XRHostWebGLBinding(session, makeGL().gl);
      const views = frameWith(
        session[P_SESSION].device,
        session,
        (_t, frame) => {
          const space = session[P_SESSION].device.viewerSpace;
          return frame.getViewerPose(space).views;
        },
      );
      const left = binding.getViewSubImage(layer, views[0] as XRView);
      const right = binding.getViewSubImage(layer, views[1] as XRView);
      expect(left.imageIndex).toBe(0);
      expect(right.imageIndex).toBe(1);
      for (const image of [left, right]) {
        expect([image.viewport.x, image.viewport.width]).toEqual([0, 1832]);
        expect(image.viewport.height).toBe(1920);
        expect(image.colorTextureWidth).toBe(1832);
      }
    });

    test('texture: one image split side by side, left gets floor(width / 2)', async () => {
      const { session } = await startSession({
        beginSwapchain: () => stageSwapchain({ width: 2001, arraySize: 1 }),
      });
      const layer = projectionLayer(session, { textureType: 'texture' });
      expect(layer.layout).toBe('stereo');
      const binding = new XRHostWebGLBinding(session, makeGL().gl);
      const views = frameWith(
        session[P_SESSION].device,
        session,
        (_t, frame) =>
          frame.getViewerPose(session[P_SESSION].device.viewerSpace).views,
      );
      const left = binding.getViewSubImage(layer, views[0] as XRView);
      const right = binding.getViewSubImage(layer, views[1] as XRView);
      expect([left.viewport.x, left.viewport.width]).toEqual([0, 1000]);
      expect([right.viewport.x, right.viewport.width]).toEqual([1000, 1001]);
      expect(left.imageIndex).toBe(0);
      expect(right.imageIndex).toBe(0);
    });

    test('sub-images are stable per eye and report the opaque colour texture', async () => {
      const { device, session, opaque } = await startSession();
      const layer = projectionLayer(session);
      const binding = new XRHostWebGLBinding(session, makeGL().gl);
      const pick = () =>
        frameWith(device, session, (_t, frame) => {
          const views = frame.getViewerPose(device.viewerSpace).views;
          return [
            binding.getViewSubImage(layer, views[0] as XRView),
            binding.getViewSubImage(layer, views[1] as XRView),
          ];
        });
      const a = pick();
      const b = pick();
      expect(b[0]).toBe(a[0]);
      expect(b[1]).toBe(a[1]);
      expect(a[0]).not.toBe(a[1]);
      expect(a[0].colorTexture).toBe(opaque);
      expect(() =>
        binding.getViewSubImage({} as XRProjectionLayer, {} as XRView),
      ).toThrow(TypeError);
    });

    test('formats, depth handling and constant attributes', async () => {
      const { session } = await startSession();
      const plain = projectionLayer(session);
      expect(plain.colorFormat).toBe(RGBA8);
      expect(plain.depthFormat).toBe(DEPTH_COMPONENT24);
      expect(plain.ignoreDepthValues).toBe(true);
      expect(plain.deltaPose).toBeNull();
      expect(plain.opacity).toBe(1);
      plain.opacity = 0.2;
      expect(plain.opacity).toBe(1);
      // three.js passes depthFormat: null when its context has no depth
      const noDepth = projectionLayer(session, { depthFormat: null });
      expect(noDepth.depthFormat).toBeNull();
    });

    test('fixedFoveation is session wide, clamped to 0..1 and NaN becomes 0', async () => {
      const { session, rec } = await startSession();
      const a = projectionLayer(session);
      const b = projectionLayer(session);
      a.fixedFoveation = 0.4;
      expect(b.fixedFoveation).toBe(0.4);
      a.fixedFoveation = 7;
      expect(a.fixedFoveation).toBe(1);
      a.fixedFoveation = NaN;
      expect(a.fixedFoveation).toBe(0);
      expect(rec.foveations).toEqual([0.4, 1, 0]);
    });
  });

  describe('frames', () => {
    test('XR callbacks run inside runHostFrame with the host time and per-eye views', async () => {
      const { device, session } = await startSession();
      projectionLayer(session);
      session.updateRenderState({ depthNear: 0.2, depthFar: 250 });
      const space = (await requestSpace(
        session,
        'local-floor',
      )) as unknown as XRReferenceSpace;
      const seen = frameWith(
        device,
        session,
        (time, frame) => {
          const pose = frame.getViewerPose(space);
          return {
            time,
            eyes: pose.views.map((v) => v.eye),
            leftPos: [...pose.views[0].transform.matrix.slice(12, 15)],
            rightPos: [...pose.views[1].transform.matrix.slice(12, 15)],
            headPos: [...pose.transform.matrix.slice(12, 15)],
            projection: Array.from(pose.views[0].projectionMatrix),
          };
        },
        makeFrame({ predictedDisplayTime: 777 }),
      );
      expect(seen.time).toBe(777);
      expect(seen.eyes).toEqual(['left', 'right']);
      // local-floor on a stage: LOCAL's x/z, floor height
      expect(seen.leftPos[0]).toBeCloseTo(-HALF_IPD - 0.3, 5);
      expect(seen.leftPos[1]).toBeCloseTo(EYE_HEIGHT, 5);
      expect(seen.rightPos[0]).toBeCloseTo(HALF_IPD - 0.3, 5);
      expect(seen.headPos[0]).toBeCloseTo(-0.3, 5);
      expect(seen.headPos[2]).toBeCloseTo(0.05 + 0.2, 5);

      // independent derivation: glFrustum with near * tan(angle) edges
      const [l, r, u, d] = EYE_FOV;
      const expected = mat4.frustum(
        mat4.create(),
        0.2 * Math.tan(l),
        0.2 * Math.tan(r),
        0.2 * Math.tan(d),
        0.2 * Math.tan(u),
        0.2,
        250,
      );
      seen.projection.forEach((value, i) =>
        expect(value).toBeCloseTo(expected[i], 4),
      );
    });

    test('an infinite far plane gives the limit projection', async () => {
      const { device, session } = await startSession();
      projectionLayer(session);
      session.updateRenderState({ depthNear: 0.5, depthFar: Infinity });
      const projection = frameWith(device, session, (_t, frame) =>
        Array.from(
          frame.getViewerPose(device.viewerSpace).views[0].projectionMatrix,
        ),
      );
      expect(projection[10]).toBe(-1);
      expect(projection[14]).toBeCloseTo(-1, 6);
      expect(projection[11]).toBe(-1);
    });

    test('a mono frame has one view with eye none', async () => {
      const { device, session } = await startSession();
      projectionLayer(session);
      const eyes = frameWith(
        device,
        session,
        (_t, frame) =>
          frame.getViewerPose(device.viewerSpace).views.map((v) => v.eye),
        makeFrame({ viewCount: 1 }),
      );
      expect(eyes).toEqual(['none']);
    });

    test('a pose kept from one frame still holds its values inside the next frame', async () => {
      const { device, session } = await startSession();
      projectionLayer(session);
      const local = (await requestSpace(
        session,
        'local',
      )) as unknown as XRReferenceSpace;
      const viewer = device.viewerSpace;
      let kept: { pose: XRPose; x: number } | null = null;
      const results: Array<{ keptX: number; nowX: number; same: boolean }> = [];
      for (let i = 0; i < 6; i++) {
        const frame = makeFrame();
        const views = frame.views as Float32Array;
        views[0] += i * 0.1; // move the head a bit every frame
        views[11] += i * 0.1;
        frameWith(
          device,
          session,
          (_t, xrFrame) => {
            const pose = xrFrame.getPose(viewer, local)!;
            const again = xrFrame.getPose(viewer, local)!;
            if (kept) {
              results.push({
                keptX: kept.pose.transform.matrix[12],
                nowX: pose.transform.matrix[12],
                same: pose === kept.pose,
              });
              expect(kept.pose.transform.matrix[12]).toBeCloseTo(kept.x, 6);
            }
            expect(again).toBe(pose);
            kept = { pose, x: pose.transform.matrix[12] };
          },
          frame,
        );
      }
      for (const r of results) {
        expect(r.same).toBe(false);
        expect(r.nowX - r.keptX).toBeCloseTo(0.1, 5);
      }
    });

    test('steady frames reuse a bounded set of pose, frame and callback objects', async () => {
      const { device, session } = await startSession();
      projectionLayer(session);
      const local = (await requestSpace(
        session,
        'local',
      )) as unknown as XRReferenceSpace;
      const poses = new Set<unknown>();
      const viewerPoses = new Set<unknown>();
      const frames = new Set<unknown>();
      const registrations = new Set<unknown>();
      for (let i = 0; i < 12; i++) {
        session.requestAnimationFrame((_t, frame) => {
          frames.add(frame);
          poses.add(frame.getPose(device.viewerSpace, local));
          viewerPoses.add(frame.getViewerPose(local));
        });
        registrations.add(session[P_SESSION].frameCallbacks[0]);
        device.runHostFrame(makeFrame());
      }
      expect(frames.size).toBe(2);
      expect(poses.size).toBe(2);
      expect(viewerPoses.size).toBe(2);
      expect(registrations.size).toBeLessThanOrEqual(2);
    });

    test('consecutive frames get different XRFrame objects, inactive outside their callbacks', async () => {
      const { device, session } = await startSession();
      projectionLayer(session);
      const a = frameWith(device, session, (_t, f) => f);
      const b = frameWith(device, session, (_t, f) => f);
      expect(a).not.toBe(b);
      expect(() => a.getPose(device.viewerSpace, device.viewerSpace)).toThrow(
        expect.objectContaining({ name: 'InvalidStateError' }),
      );
    });

    test('an untracked space has no pose, also when asked twice in a frame', async () => {
      const { device, session } = await startSession();
      projectionLayer(session);
      const local = (await requestSpace(
        session,
        'local',
      )) as unknown as XRReferenceSpace;
      const offset = local.getOffsetReferenceSpace(
        new XRRigidTransform({ x: 0, y: 0, z: -2 }),
      );
      offset[P_SPACE].tracked = false;
      const answers = frameWith(device, session, (_t, frame) => [
        frame.getPose(device.viewerSpace, offset),
        frame.getPose(device.viewerSpace, offset),
        frame.getPose(offset, local),
      ]);
      expect(answers).toEqual([null, null, null]);
    });

    test('callbacks registered during a frame wait for the next one; cancelled ones are skipped', async () => {
      const { device, session } = await startSession();
      projectionLayer(session);
      const order: string[] = [];
      const second = () => order.push('second');
      session.requestAnimationFrame(() => {
        order.push('first');
        session.requestAnimationFrame(() => order.push('late'));
        session.cancelAnimationFrame(cancelled);
      });
      const cancelled = session.requestAnimationFrame(second);
      device.runHostFrame(makeFrame());
      expect(order).toEqual(['first']);
      device.runHostFrame(makeFrame());
      expect(order).toEqual(['first', 'late']);
    });

    test('handles increase strictly', async () => {
      const { device, session } = await startSession();
      projectionLayer(session);
      const handles: number[] = [];
      for (let i = 0; i < 5; i++) {
        handles.push(session.requestAnimationFrame(() => {}));
        device.runHostFrame(makeFrame());
      }
      for (let i = 1; i < handles.length; i++) {
        expect(handles[i]).toBeGreaterThan(handles[i - 1]);
      }
    });
  });

  describe('errors thrown during a frame', () => {
    test('a throwing XR callback goes to reportError and the others still run', async () => {
      const { device, session, rec } = await startSession({
        reportError: (error, source) => rec.errors.push({ error, source }),
      });
      projectionLayer(session);
      const boom = new Error('callback failed');
      let afterRan = false;
      session.requestAnimationFrame(() => {
        throw boom;
      });
      session.requestAnimationFrame(() => {
        afterRan = true;
      });
      device.runHostFrame(makeFrame());
      expect(afterRan).toBe(true);
      expect(rec.errors).toEqual([
        { error: boom, source: 'xr-frame-callback' },
      ]);
    });

    test('a throwing window frame is reported as window-frame', async () => {
      const boom = new Error('window rAF failed');
      const { device, session, rec } = await startSession({
        runWindowFrame: () => {
          throw boom;
        },
        reportError: (error, source) => rec.errors.push({ error, source }),
      });
      projectionLayer(session);
      device.runHostFrame(makeFrame());
      expect(rec.errors).toEqual([{ error: boom, source: 'window-frame' }]);
    });

    test('without reportError, errors go to console.error', async () => {
      const { device, session } = await startSession();
      projectionLayer(session);
      const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
      const boom = new Error('plain');
      session.requestAnimationFrame(() => {
        throw boom;
      });
      device.runHostFrame(makeFrame());
      expect(logged).toHaveBeenCalledWith(boom);
      logged.mockRestore();
    });
  });

  describe('visibility', () => {
    test('host visibility maps to WebXR states and fires only on change', async () => {
      const { device, session } = await startSession();
      const states: string[] = [];
      session.addEventListener('visibilitychange', () =>
        states.push(session.visibilityState),
      );
      device.dispatchHostEvent({
        type: 'visibilitychange',
        visible: true,
        focused: false,
      });
      device.dispatchHostEvent({
        type: 'visibilitychange',
        visible: true,
        focused: false,
      });
      device.dispatchHostEvent({
        type: 'visibilitychange',
        visible: false,
        focused: false,
      });
      device.dispatchHostEvent({
        type: 'visibilitychange',
        visible: true,
        focused: true,
      });
      expect(states).toEqual(['visible-blurred', 'hidden', 'visible']);
    });

    test('hidden frames skip XR callbacks but still run the window frame', async () => {
      const { device, session, rec } = await startSession();
      projectionLayer(session);
      device.dispatchHostEvent({
        type: 'visibilitychange',
        visible: false,
        focused: false,
      });
      let ran = 0;
      session.requestAnimationFrame(() => ran++);
      device.runHostFrame(makeFrame({ predictedDisplayTime: 11 }));
      device.runHostFrame(makeFrame({ predictedDisplayTime: 22 }));
      expect(ran).toBe(0);
      expect(rec.windowFrames).toEqual([11, 22]);
      device.dispatchHostEvent({
        type: 'visibilitychange',
        visible: true,
        focused: true,
      });
      device.runHostFrame(makeFrame({ predictedDisplayTime: 33 }));
      expect(ran).toBe(1);
    });
  });

  describe('ending', () => {
    test('end() from an XR callback completes after the frame, through postTask', async () => {
      const { device, session, rec } = await startSession();
      projectionLayer(session);
      const events: string[] = [];
      session.addEventListener('end', () => events.push('end event'));
      let ending: Promise<void> | null = null;
      session.requestAnimationFrame(() => {
        ending = session.end().then(() => {
          events.push('promise');
        });
      });
      device.runHostFrame(makeFrame());
      expect(events).toEqual([]);
      expect(rec.endSessionCalls).toBe(0);
      expect(rec.tasks).toHaveLength(1);
      rec.tasks[0]();
      await ending;
      expect(rec.endSessionCalls).toBe(1);
      expect(events).toEqual(['end event', 'promise']);
      await expect(session.end()).rejects.toMatchObject({
        name: 'InvalidStateError',
      });
    });

    test('without postTask the deferred end uses setTimeout', async () => {
      jest.useFakeTimers();
      const { device, session, rec } = await startSession({
        postTask: undefined,
      });
      projectionLayer(session);
      let ended = false;
      session.addEventListener('end', () => (ended = true));
      session.requestAnimationFrame(() => {
        session.end();
      });
      device.runHostFrame(makeFrame());
      expect(ended).toBe(false);
      jest.runOnlyPendingTimers();
      expect(ended).toBe(true);
      expect(rec.endSessionCalls).toBe(1);
    });

    test('end() outside a frame finishes at once and frames afterwards do nothing', async () => {
      const { device, session, rec } = await startSession();
      projectionLayer(session);
      let ran = false;
      session.requestAnimationFrame(() => (ran = true));
      await session.end();
      expect(rec.endSessionCalls).toBe(1);
      device.runHostFrame(makeFrame());
      expect(ran).toBe(false);
    });

    test('an end reported by the host is not echoed back to it', async () => {
      const { device, session, rec } = await startSession();
      projectionLayer(session);
      const ended = new Promise<void>((resolve) =>
        session.addEventListener('end', () => resolve()),
      );
      device.dispatchHostEvent({ type: 'end' });
      await ended;
      expect(rec.endSessionCalls).toBe(0);
      expect(device.activeSession).toBeUndefined();
    });
  });

  describe('frame rate', () => {
    test('rates outside the list are rejected; the current rate resolves without asking', async () => {
      const { session, rec } = await startSession();
      projectionLayer(session);
      await expect(session.updateTargetFrameRate(144)).rejects.toMatchObject({
        name: 'InvalidStateError',
      });
      await session.updateTargetFrameRate(60);
      expect(rec.rateRequests).toEqual([]);
    });

    test('a refusing or throwing host rejects the request', async () => {
      const refusing = await startSession({ requestFrameRate: () => false });
      projectionLayer(refusing.session);
      await expect(
        refusing.session.updateTargetFrameRate(90),
      ).rejects.toMatchObject({ name: 'InvalidStateError' });
      await refusing.session.end();

      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const throwing = await startSession({
        requestFrameRate: () => {
          throw new Error('no');
        },
      });
      projectionLayer(throwing.session);
      await expect(
        throwing.session.updateTargetFrameRate(90),
      ).rejects.toMatchObject({ name: 'InvalidStateError' });
      warn.mockRestore();
    });

    test('an accepted request resolves after frameratechange for the new rate', async () => {
      const { device, session, rec } = await startSession();
      projectionLayer(session);
      const log: string[] = [];
      session.addEventListener('frameratechange', () =>
        log.push(`event ${session.frameRate}`),
      );
      const request = session.updateTargetFrameRate(90).then(() => {
        log.push('resolved');
      });
      expect(rec.rateRequests).toEqual([90]);
      device.runHostFrame(makeFrame({ frameRate: 60 }));
      await Promise.resolve();
      expect(log).toEqual([]);
      device.runHostFrame(makeFrame({ frameRate: 90 }));
      await request;
      expect(log).toEqual(['event 90', 'resolved']);
    });

    test('a frameratechange host event also settles the request', async () => {
      const { device, session } = await startSession();
      projectionLayer(session);
      const request = session.updateTargetFrameRate(72);
      device.dispatchHostEvent({ type: 'frameratechange', rate: 72 });
      await expect(request).resolves.toBeUndefined();
      expect(session.frameRate).toBe(72);
    });

    test('a request the display never confirms settles after the frame limit', async () => {
      const { device, session } = await startSession();
      projectionLayer(session);
      let settled = false;
      session.updateTargetFrameRate(72).then(() => (settled = true));
      for (let i = 0; i < RATE_CONFIRMATION_FRAME_LIMIT; i++) {
        device.runHostFrame(makeFrame());
      }
      await new Promise((r) => setTimeout(r, 0));
      expect(settled).toBe(false);
      device.runHostFrame(makeFrame());
      await new Promise((r) => setTimeout(r, 0));
      expect(settled).toBe(true);
    });
  });

  describe('reference spaces', () => {
    test('local follows a recentre of the host LOCAL space on the next frame', async () => {
      const { device, session } = await startSession();
      projectionLayer(session);
      const local = (await requestSpace(
        session,
        'local',
      )) as unknown as XRReferenceSpace;
      const origin = (localPose: number[]) =>
        frameWith(
          device,
          session,
          () => position(local[P_SPACE].offsetMatrix),
          makeFrame({ localPose: new Float32Array(localPose) }),
        );
      expect(origin([0.3, 1.5, -0.2, 0, 0, 0, 1])).toEqual([
        expect.closeTo(0.3),
        expect.closeTo(1.5),
        expect.closeTo(-0.2),
      ]);
      expect(origin([-1.1, 1.4, 0.6, 0, 0, 0, 1])).toEqual([
        expect.closeTo(-1.1),
        expect.closeTo(1.4),
        expect.closeTo(0.6),
      ]);
    });

    test('local-floor sits on the stage floor, or an assumed eye height below LOCAL', async () => {
      const { device, session } = await startSession();
      projectionLayer(session);
      const floor = (await requestSpace(
        session,
        'local-floor',
      )) as unknown as XRReferenceSpace;
      const height = (baseIsStage: boolean) =>
        frameWith(
          device,
          session,
          () => floor[P_SPACE].offsetMatrix[13],
          makeFrame({ baseIsStage }),
        );
      expect(height(true)).toBe(0);
      expect(height(false)).toBeCloseTo(1.5 - ASSUMED_EYE_HEIGHT, 6);
      // a recentre moves its x/z with LOCAL
      const moved = frameWith(
        device,
        session,
        () => position(floor[P_SPACE].offsetMatrix),
        makeFrame({ localPose: new Float32Array([2, 1.5, 3, 0, 0, 0, 1]) }),
      );
      expect(moved).toEqual([2, 0, 3]);
    });

    test('a space requested inside a frame is placed at once', async () => {
      const { device, session } = await startSession();
      projectionLayer(session);
      let inFrame: XRReferenceSpace | null = null;
      session.requestAnimationFrame(() => {
        inFrame = session[P_SESSION].host!.createReferenceSpace(
          'local' as never,
        );
      });
      device.runHostFrame(makeFrame());
      expect(position(inFrame![P_SPACE].offsetMatrix)).toEqual([
        expect.closeTo(0.3),
        expect.closeTo(1.5),
        expect.closeTo(-0.2),
      ]);
    });

    test('viewer is the device viewer space; unbounded is not offered', async () => {
      const { device, session } = await startSession(
        {},
        { features: ['layers', 'unbounded'] },
      );
      expect(await requestSpace(session, 'viewer')).toBe(device.viewerSpace);
      await expect(requestSpace(session, 'unbounded')).rejects.toMatchObject({
        name: 'NotSupportedError',
      });
    });

    test('a recentre fires reset at requested and offset spaces, never at viewer', async () => {
      const { device, session } = await startSession();
      const viewer = (await requestSpace(
        session,
        'viewer',
      )) as unknown as XRReferenceSpace;
      const floor = (await requestSpace(
        session,
        'local-floor',
      )) as unknown as XRReferenceSpace;
      const shifted = floor.getOffsetReferenceSpace(
        new XRRigidTransform({ x: 0.5, y: 0, z: -1.25 }),
      );
      const shiftedTwice = shifted.getOffsetReferenceSpace(
        new XRRigidTransform({ x: 0, y: 0, z: 3 }),
      );
      const fired: string[] = [];
      const carried: unknown[] = [];
      const note = (name: string) => (e: Event) => {
        fired.push(name);
        // checked after dispatch: dispatchEvent swallows listener exceptions
        carried.push(
          (e as unknown as { referenceSpace: unknown }).referenceSpace,
        );
      };
      viewer.addEventListener('reset', note('viewer'));
      floor.addEventListener('reset', note('floor'));
      shifted.addEventListener('reset', note('shifted'));
      shiftedTwice.onreset = note('shiftedTwice');
      device.dispatchHostEvent({ type: 'referencespacereset' });
      expect(fired).toEqual(['floor', 'shifted', 'shiftedTwice']);
      expect(carried[0]).toBe(floor);
      expect(carried[1]).toBe(shifted);
      expect(carried[2]).toBe(shiftedTwice);
    });

    test('getOffsetReferenceSpace accepts an XRRigidTransform', async () => {
      const { device, session } = await startSession();
      projectionLayer(session);
      const floor = (await requestSpace(
        session,
        'local-floor',
      )) as unknown as XRReferenceSpace;
      const ahead = floor.getOffsetReferenceSpace(
        new XRRigidTransform({ x: 0, y: 0, z: -2 }),
      );
      const z = frameWith(
        device,
        session,
        (_t, frame) => frame.getPose(ahead, floor)!.transform.matrix[14],
      );
      expect(z).toBeCloseTo(-2, 6);
    });

    test('bounded-floor: an XRBoundedReferenceSpace with a clockwise stage rectangle', async () => {
      const { session } = await startSession(
        {},
        { features: ['layers', 'bounded-floor'] },
      );
      projectionLayer(session);
      const bounded = (await requestSpace(
        session,
        'bounded-floor',
      )) as unknown as XRBoundedReferenceSpace;
      expect(bounded).toBeInstanceOf(XRBoundedReferenceSpace);
      const corners = bounded.boundsGeometry;
      expect(corners).toHaveLength(4);
      expect(bounded.boundsGeometry).toBe(corners);
      const xs = corners.map((p) => Math.abs(p.x));
      const zs = corners.map((p) => Math.abs(p.z));
      expect(new Set(xs)).toEqual(new Set([2]));
      expect(new Set(zs)).toEqual(new Set([1.25]));
      corners.forEach((p) => expect(p.y).toBe(0));
      // clockwise seen from above (looking down -y, x right, -z up): the
      // shoelace sum over (x, -z) is negative
      let twiceArea = 0;
      for (let i = 0; i < 4; i++) {
        const a = corners[i];
        const b = corners[(i + 1) % 4];
        twiceArea += a.x * -b.z - b.x * -a.z;
      }
      expect(twiceArea).toBeLessThan(0);
      const offset = bounded.getOffsetReferenceSpace(new XRRigidTransform());
      expect(offset).toBeInstanceOf(XRBoundedReferenceSpace);
    });

    test('bounded-floor without a stage is NotSupportedError; its bounds stay empty before a layer', async () => {
      const early = await startSession(
        {},
        { features: ['layers', 'bounded-floor'] },
      );
      const before = (await requestSpace(
        early.session,
        'bounded-floor',
      )) as unknown as XRBoundedReferenceSpace;
      expect(before.boundsGeometry).toEqual([]);
      await early.session.end();

      const stageless = await startSession(
        { beginSwapchain: () => stageSwapchain({ hasStage: false }) },
        { features: ['layers', 'bounded-floor'] },
      );
      projectionLayer(stageless.session);
      await expect(
        requestSpace(stageless.session, 'bounded-floor'),
      ).rejects.toMatchObject({ name: 'NotSupportedError' });
    });
  });

  describe('render state', () => {
    test('layers and baseLayer together, non-layers and foreign layers are rejected', async () => {
      const { session } = await startSession();
      const gl = makeGL().gl;
      const layer = projectionLayer(session, {}, gl);
      const base = new XRWebGLLayer(session, gl);
      expect(() =>
        session.updateRenderState({
          layers: [layer],
          baseLayer: base,
        } as never),
      ).toThrow(TypeError);
      expect(() =>
        session.updateRenderState({ layers: [{}] } as never),
      ).toThrow(TypeError);

      const other = await (async () => {
        const nav = navigator as { xr?: unknown };
        delete nav.xr;
        return startSession();
      })();
      const foreign = projectionLayer(other.session);
      expect(() =>
        session.updateRenderState({ layers: [foreign] } as never),
      ).toThrow(expect.objectContaining({ name: 'InvalidStateError' }));
    });

    test('pending state applies at the next frame and builds on queued state', async () => {
      const { device, session } = await startSession();
      const gl = makeGL().gl;
      const layer = projectionLayer(session, {}, gl);
      session.updateRenderState({ layers: [layer] } as never);
      session.updateRenderState({ depthNear: 0.3 });
      expect(session.renderState.layers).toEqual([]);
      device.runHostFrame(makeFrame());
      expect(session.renderState.layers).toEqual([layer]);
      expect(Object.isFrozen(session.renderState.layers)).toBe(true);
      expect(session.renderState.depthNear).toBe(0.3);
    });

    test('a base layer clears a layer list; an empty layer list keeps the base layer', async () => {
      const { device, session } = await startSession();
      const gl = makeGL().gl;
      const layer = projectionLayer(session, {}, gl);
      const base = new XRWebGLLayer(session, gl);
      session.updateRenderState({ layers: [layer] } as never);
      device.runHostFrame(makeFrame());
      session.updateRenderState({ baseLayer: base });
      device.runHostFrame(makeFrame());
      expect(session.renderState.baseLayer).toBe(base);
      expect(session.renderState.layers).toEqual([]);
      // current behaviour (an open question): [] does not clear baseLayer
      session.updateRenderState({ layers: [] } as never);
      device.runHostFrame(makeFrame());
      expect(session.renderState.baseLayer).toBe(base);
      // a non-empty list does
      session.updateRenderState({ layers: [layer] } as never);
      device.runHostFrame(makeFrame());
      expect(session.renderState.baseLayer).toBeNull();
    });

    test('passthroughFullyObscured is coerced to boolean and carried over', async () => {
      const { device, session } = await startSession();
      projectionLayer(session);
      session.updateRenderState({ passthroughFullyObscured: 1 } as never);
      device.runHostFrame(makeFrame());
      expect(session.renderState.passthroughFullyObscured).toBe(true);
      session.updateRenderState({ depthFar: 80 });
      device.runHostFrame(makeFrame());
      expect(session.renderState.passthroughFullyObscured).toBe(true);
    });

    test('the emulator keeps layers undefined', () => {
      const device = new XRDevice(testHost);
      device.installRuntime({ globalObject: {}, forceInstall: true });
      return navigator.xr!.requestSession('immersive-vr').then((s) => {
        expect((s as unknown as XRSession).renderState.layers).toBeUndefined();
        return s.end();
      });
    });
  });

  describe('XRWebGLLayer in host mode', () => {
    test('owns a framebuffer the size of the swapchain with its own depth', async () => {
      const { session, rec } = await startSession({
        beginSwapchain: (o) => {
          rec.swapchainRequests.push(o);
          return stageSwapchain({ width: 3001, height: 1600, arraySize: 1 });
        },
      });
      const { gl, calls } = makeGL();
      const layer = new XRWebGLLayer(session, gl, {
        framebufferScaleFactor: 0.75,
      });
      expect(rec.swapchainRequests[0]).toMatchObject({
        arraySize: 1,
        scale: 0.75,
      });
      expect(layer.framebuffer).not.toBeNull();
      expect([layer.framebufferWidth, layer.framebufferHeight]).toEqual([
        3001, 1600,
      ]);
      const storage = calls.find((c) => c[0] === 'renderbufferStorage')!;
      expect(storage.slice(2)).toEqual([DEPTH_COMPONENT24, 3001, 1600]);
      const attach = calls.find((c) => c[0] === 'framebufferRenderbuffer')!;
      expect(attach[2]).toBe(DEPTH_ATTACHMENT);
    });

    test('stencil selects a depth-stencil buffer', async () => {
      const { session } = await startSession();
      const { gl, calls } = makeGL();
      new XRWebGLLayer(session, gl, { stencil: true });
      const storage = calls.find((c) => c[0] === 'renderbufferStorage')!;
      expect(storage[2]).toBe(DEPTH24_STENCIL8);
      const attach = calls.find((c) => c[0] === 'framebufferRenderbuffer')!;
      expect(attach[2]).toBe(DEPTH_STENCIL_ATTACHMENT);
    });

    test('each frame re-points colour at the acquired image and leaves page bindings alone', async () => {
      const { device, session } = await startSession();
      const { gl, calls, state } = makeGL();
      const layer = new XRWebGLLayer(session, gl);
      session.updateRenderState({ baseLayer: layer });
      const pageDraw = { page: 'draw' };
      const pageRead = { page: 'read' };
      state.draw = pageDraw;
      state.read = pageRead;
      let duringCallback: unknown[] = [];
      session.requestAnimationFrame(() => {
        duringCallback = [state.draw, state.read];
      });
      calls.length = 0;
      device.runHostFrame(makeFrame({ colorTexture: 12 }));
      expect(duringCallback).toEqual([pageDraw, pageRead]);
      expect([state.draw, state.read]).toEqual([pageDraw, pageRead]);
      const attach = calls.filter((c) => c[0] === 'framebufferTexture2D');
      expect(attach).toHaveLength(1);
      expect(attach[0][2]).toBe(COLOR_ATTACHMENT0);
      expect(attach[0][4]).toEqual({ wrapped: 12 });
      // the same image again: nothing to re-point
      calls.length = 0;
      session.requestAnimationFrame(() => {});
      device.runHostFrame(makeFrame({ colorTexture: 12 }));
      expect(calls.filter((c) => c[0] === 'framebufferTexture2D')).toHaveLength(
        0,
      );
    });

    test('depth is invalidated after the frame unless the host opts out', async () => {
      const on = await startSession();
      const glOn = makeGL();
      on.session.updateRenderState({
        baseLayer: new XRWebGLLayer(on.session, glOn.gl),
      });
      on.device.runHostFrame(makeFrame());
      const invalidations = glOn.calls.filter(
        (c) => c[0] === 'invalidateFramebuffer',
      );
      expect(invalidations).toHaveLength(1);
      expect(invalidations[0][2]).toEqual([DEPTH_ATTACHMENT]);
      await on.session.end();

      const off = await startSession({ invalidateDepth: false });
      const glOff = makeGL();
      off.session.updateRenderState({
        baseLayer: new XRWebGLLayer(off.session, glOff.gl),
      });
      off.device.runHostFrame(makeFrame());
      expect(
        glOff.calls.filter((c) => c[0] === 'invalidateFramebuffer'),
      ).toHaveLength(0);
    });

    test('per-eye viewports split the image; fixedFoveation exists only in host mode', async () => {
      const { device, session } = await startSession({
        beginSwapchain: () => stageSwapchain({ width: 999, arraySize: 1 }),
      });
      const layer = new XRWebGLLayer(session, makeGL().gl);
      const views = frameWith(
        device,
        session,
        (_t, frame) => frame.getViewerPose(device.viewerSpace).views,
      );
      const left = layer.getViewport(views[0] as XRView);
      const right = layer.getViewport(views[1] as XRView);
      expect([left!.x, left!.width]).toEqual([0, 499]);
      expect([right!.x, right!.width]).toEqual([499, 500]);
      expect(typeof layer.fixedFoveation).toBe('number');
    });
  });

  describe('immersive-ar', () => {
    test('asks for passthrough, notes straight alpha, and toggles passthrough on change only', async () => {
      const { device, session, rec } = await startSession(
        {},
        { mode: 'immersive-ar' },
      );
      projectionLayer(session, {}, makeGL({ premultipliedAlpha: false }).gl);
      expect(rec.swapchainRequests[0]).toMatchObject({
        passthrough: true,
        unpremultiplied: true,
      });
      device.runHostFrame(makeFrame());
      session.updateRenderState({ passthroughFullyObscured: true } as never);
      device.runHostFrame(makeFrame());
      device.runHostFrame(makeFrame());
      session.updateRenderState({ passthroughFullyObscured: false } as never);
      device.runHostFrame(makeFrame());
      expect(rec.passthrough).toEqual([false, true]);
    });
  });

  describe('plane and mesh detection', () => {
    const turned = quat.setAxisAngle(
      quat.create(),
      vec3.fromValues(1, 0, 0),
      Math.PI / 2,
    );

    test('host planes appear in detectedPlanes, follow updates and disappear', async () => {
      const table = new NativePlane(
        new XRRigidTransform({ x: 0.4, y: 0.74, z: -0.9 }),
        [
          new DOMPointReadOnly(-0.3, 0, -0.2),
          new DOMPointReadOnly(0.3, 0, -0.2),
          new DOMPointReadOnly(0.3, 0, 0.2),
        ],
        XRSemanticLabels.Table,
      );
      const planes = new Set<NativePlane>([table]);
      const { device, session, rec } = await startSession(
        { getPlanes: () => planes },
        { features: ['layers', 'plane-detection', 'local-floor'] },
      );
      projectionLayer(session);
      expect(rec.swapchainRequests[0].scene).toBe(true);
      const floor = (await requestSpace(
        session,
        'local-floor',
      )) as unknown as XRReferenceSpace;

      const first = frameWith(
        device,
        session,
        (_t, frame) => {
          const [plane] = [...frame.detectedPlanes];
          return {
            plane,
            count: frame.detectedPlanes.size,
            y: frame.getPose(plane.planeSpace, device[P_DEVICE].globalSpace)!
              .transform.matrix[13],
            changed: plane.lastChangedTime,
            orientation: plane.orientation,
          };
        },
        makeFrame({ predictedDisplayTime: 100 }),
      );
      expect(first.count).toBe(1);
      expect(first.y).toBeCloseTo(0.74, 6);
      expect(first.changed).toBe(100);
      expect(first.orientation).toBe('horizontal');
      void floor;

      // moving does not count as a change; a new polygon does
      table.transform = new XRRigidTransform({ x: 0.4, y: 0.8, z: -0.9 });
      const moved = frameWith(
        device,
        session,
        (_t, frame) => [...frame.detectedPlanes][0],
        makeFrame({ predictedDisplayTime: 200 }),
      );
      expect(moved).toBe(first.plane);
      expect(moved.lastChangedTime).toBe(100);
      table.polygon = [...table.polygon, new DOMPointReadOnly(-0.3, 0, 0.2)];
      table.transform = new XRRigidTransform(
        { x: 0.4, y: 0.8, z: -0.9 },
        { x: turned[0], y: turned[1], z: turned[2], w: turned[3] },
      );
      const reshaped = frameWith(
        device,
        session,
        (_t, frame) => [...frame.detectedPlanes][0],
        makeFrame({ predictedDisplayTime: 300 }),
      );
      expect(reshaped.polygon).toHaveLength(4);
      expect(reshaped.lastChangedTime).toBe(300);
      expect(reshaped.orientation).toBe('vertical');

      planes.clear();
      const gone = frameWith(
        device,
        session,
        (_t, frame) => frame.detectedPlanes.size,
      );
      expect(gone).toBe(0);
      expect(session[P_SESSION].trackedPlanes.size).toBe(0);
    });

    test('host meshes appear in detectedMeshes; an array source works too', async () => {
      const couch = new NativeMesh(
        new XRRigidTransform({ x: -1, y: 0, z: 1.5 }),
        new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        new Uint32Array([0, 1, 2]),
        XRSemanticLabels.Couch,
      );
      const { device, session } = await startSession(
        { getMeshes: () => [couch] },
        { features: ['layers', 'mesh-detection'] },
      );
      projectionLayer(session);
      const first = frameWith(
        device,
        session,
        (_t, frame) => [...frame.detectedMeshes][0],
        makeFrame({ predictedDisplayTime: 40 }),
      );
      expect(first.semanticLabel).toBe(XRSemanticLabels.Couch);
      expect(first.lastChangedTime).toBe(40);
      couch.vertices = new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]);
      const second = frameWith(
        device,
        session,
        (_t, frame) => [...frame.detectedMeshes][0],
        makeFrame({ predictedDisplayTime: 50 }),
      );
      expect(second).toBe(first);
      expect(second.vertices[3]).toBe(2);
      expect(second.lastChangedTime).toBe(50);
    });

    test('without the feature, getPlanes is never called', async () => {
      const getPlanes = jest.fn(() => new Set<NativePlane>());
      const { device, session } = await startSession({ getPlanes });
      projectionLayer(session);
      frameWith(device, session, () => 0);
      expect(getPlanes).not.toHaveBeenCalled();
    });
  });

  describe('host input', () => {
    test('host input drives the input sources and their poses', async () => {
      const { device, session } = await startSession(
        {},
        { features: ['layers', 'local-floor', 'hand-tracking'] },
      );
      projectionLayer(session);
      const input = device.enableHostInput();
      const right = input.right;
      right.mode = XRHostInputMode.Controller;
      right.grip.set([0.25, 1.1, -0.5, 0, 0, 0, 1]);
      right.gripValid = true;
      right.targetRay.set([0.27, 1.05, -0.62, 0, 0, 0, 1]);
      right.targetRayValid = true;
      const floor = (await requestSpace(
        session,
        'local-floor',
      )) as unknown as XRReferenceSpace;
      const seen = frameWith(device, session, (_t, frame) => {
        const source = [...session.inputSources][0];
        return {
          count: session.inputSources.length,
          handedness: source.handedness,
          grip: position(
            frame.getPose(source.gripSpace!, floor)!.transform.matrix,
          ),
          ray: position(
            frame.getPose(source.targetRaySpace, floor)!.transform.matrix,
          ),
        };
      });
      expect(seen.count).toBe(1);
      expect(seen.handedness).toBe('right');
      // local-floor sits at LOCAL's x/z (0.3, -0.2) on the stage floor
      expect(seen.grip[0]).toBeCloseTo(0.25 - 0.3, 5);
      expect(seen.grip[1]).toBeCloseTo(1.1, 5);
      expect(seen.grip[2]).toBeCloseTo(-0.5 + 0.2, 5);
      expect(seen.ray[2]).toBeCloseTo(-0.62 + 0.2, 5);
    });

    test('trackedSources lists the input sources; ending disconnects their gamepads', async () => {
      const { device, session } = await startSession();
      projectionLayer(session);
      const input = device.enableHostInput();
      input.left.mode = XRHostInputMode.Controller;
      input.left.gripValid = true;
      input.left.targetRayValid = true;
      frameWith(device, session, () => 0);
      expect(session.trackedSources).toBe(session.inputSources);
      const gamepad = session.inputSources[0].gamepad!;
      expect(gamepad.connected).toBe(true);
      await session.end();
      expect(gamepad.connected).toBe(false);
    });
  });
  describe('edge cases: spaces, frame rate, errors, detection, layers', () => {
    test('a reset handler that derives a new offset space gets one reset per recentre', async () => {
      const { device, session } = await startSession();
      const floor = (await requestSpace(
        session,
        'local-floor',
      )) as unknown as XRReferenceSpace;
      let resets = 0;
      let rootResets = 0;
      let current = floor.getOffsetReferenceSpace(
        new XRRigidTransform({ x: 1, y: 0, z: 0 }),
      );
      const rederive = () => {
        resets++;
        current = floor.getOffsetReferenceSpace(
          new XRRigidTransform({ x: 1, y: 0, z: 0 }),
        );
        current.onreset = rederive;
        if (resets > 20) {
          throw new Error('reset loop');
        }
      };
      current.onreset = rederive;
      // a root-space handler that makes spaces too: an offset space and a
      // newly requested root space (registered synchronously)
      floor.addEventListener('reset', () => {
        rootResets++;
        void requestSpace(session, 'local');
        const spaces = session[P_SESSION].referenceSpaces;
        spaces[spaces.length - 1].addEventListener('reset', () => resets++);
        floor
          .getOffsetReferenceSpace(new XRRigidTransform({ x: 0, y: 0, z: 2 }))
          .addEventListener('reset', () => resets++);
      });
      device.dispatchHostEvent({ type: 'referencespacereset' });
      expect(rootResets).toBe(1);
      expect(resets).toBe(1);
      // the next recentre reaches the spaces made during the first one
      resets = 0;
      device.dispatchHostEvent({ type: 'referencespacereset' });
      expect(resets).toBeGreaterThanOrEqual(2);
      expect(resets).toBeLessThan(20);
    });

    test('a pose cached under a device-lifetime space is not reused by the next session', async () => {
      const { device, session } = await startSession();
      projectionLayer(session);
      const input = device.enableHostInput();
      const right = input.right;
      right.mode = XRHostInputMode.Controller;
      right.grip.set([0.25, 1.1, -0.5, 0, 0, 0, 1]);
      right.gripValid = true;
      right.targetRayValid = true;
      const viewer = device.viewerSpace;
      const firstX = frameWith(device, session, (_t, frame) => {
        const source = session.inputSources[0];
        return frame.getPose(source.gripSpace!, viewer)!.transform.matrix[12];
      });
      await session.end();

      const next = (await navigator.xr!.requestSession('immersive-vr', {
        optionalFeatures: ['layers'],
      })) as unknown as XRSession;
      projectionLayer(next);
      right.grip.set([-0.4, 1.1, -0.5, 0, 0, 0, 1]);
      const secondX = frameWith(device, next, (_t, frame) => {
        const source = next.inputSources[0];
        return frame.getPose(source.gripSpace!, viewer)!.transform.matrix[12];
      });
      expect(secondX).not.toBeCloseTo(firstX, 3);
      expect(secondX - firstX).toBeCloseTo(-0.65, 5);
    });

    test('poses against a new base space every frame stay correct', async () => {
      const { device, session } = await startSession();
      projectionLayer(session);
      const floor = (await requestSpace(
        session,
        'local-floor',
      )) as unknown as XRReferenceSpace;
      for (let i = 0; i < 5; i++) {
        const base = floor.getOffsetReferenceSpace(
          new XRRigidTransform({ x: i, y: 0, z: 0 }),
        );
        const x = frameWith(
          device,
          session,
          (_t, frame) => frame.getViewerPose(base)!.transform.matrix[12],
        );
        // the viewer is at the eyes' midpoint, x = 0; local-floor is at x 0.3
        expect(x).toBeCloseTo(-0.3 - i, 5);
      }
    });

    test('an updateTargetFrameRate request still waiting at the end rejects with InvalidStateError', async () => {
      const { device, session } = await startSession();
      projectionLayer(session);
      device.runHostFrame(makeFrame({ frameRate: 60 }));
      const pending = session.updateTargetFrameRate(90);
      await session.end();
      await expect(pending).rejects.toMatchObject({
        name: 'InvalidStateError',
      });
    });

    test('errors from layer work are reported as layer', async () => {
      const boom = new Error('cannot wrap');
      const { device, session, rec } = await startSession({
        wrapTexture: () => {
          throw boom;
        },
        reportError: (error, source) => rec.errors.push({ error, source }),
      });
      session.updateRenderState({
        baseLayer: new XRWebGLLayer(session, makeGL().gl),
      });
      let ran = false;
      session.requestAnimationFrame(() => {
        ran = true;
      });
      device.runHostFrame(makeFrame());
      expect(ran).toBe(true);
      expect(rec.errors).toEqual([{ error: boom, source: 'layer' }]);
    });

    test('a reporter that throws falls back to console.error for both errors', async () => {
      const reporterFailure = new Error('reporter broke');
      const { device, session } = await startSession({
        reportError: () => {
          throw reporterFailure;
        },
      });
      projectionLayer(session);
      const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
      const boom = new Error('callback failed');
      session.requestAnimationFrame(() => {
        throw boom;
      });
      device.runHostFrame(makeFrame());
      expect(logged).toHaveBeenCalledWith(reporterFailure);
      expect(logged).toHaveBeenCalledWith(boom);
      logged.mockRestore();
    });

    test('a throwing getPlanes is reported as host-hook; the frame runs and keeps the known planes', async () => {
      const desk = new NativePlane(
        new XRRigidTransform({ x: 0, y: 0.7, z: 0 }),
        [
          new DOMPointReadOnly(-0.5, 0, -0.5),
          new DOMPointReadOnly(0.5, 0, -0.5),
          new DOMPointReadOnly(0, 0, 0.5),
        ],
        XRSemanticLabels.Table,
      );
      let failing = false;
      const boom = new Error('plane list unavailable');
      const { device, session, rec } = await startSession(
        {
          getPlanes: () => {
            if (failing) throw boom;
            return [desk];
          },
          reportError: (error, source) => rec.errors.push({ error, source }),
        },
        { features: ['layers', 'plane-detection'] },
      );
      projectionLayer(session);
      const before = frameWith(
        device,
        session,
        (_t, frame) => [...frame.detectedPlanes][0],
      );
      failing = true;
      const during = frameWith(device, session, (_t, frame) => [
        ...frame.detectedPlanes,
      ]);
      expect(during).toEqual([before]);
      expect(rec.errors).toEqual([{ error: boom, source: 'host-hook' }]);
      expect(rec.windowFrames).toHaveLength(2);
    });

    test('a throwing getMeshes and setPassthroughVisible are reported as host-hook', async () => {
      const meshFailure = new Error('meshes');
      const passthroughFailure = new Error('passthrough');
      const { device, session, rec } = await startSession(
        {
          getMeshes: () => {
            throw meshFailure;
          },
          setPassthroughVisible: () => {
            throw passthroughFailure;
          },
          reportError: (error, source) => rec.errors.push({ error, source }),
        },
        { mode: 'immersive-ar', features: ['layers', 'mesh-detection'] },
      );
      projectionLayer(session);
      session.updateRenderState({ passthroughFullyObscured: true } as never);
      const count = frameWith(
        device,
        session,
        (_t, frame) => frame.detectedMeshes.size,
      );
      expect(count).toBe(0);
      expect(rec.errors).toEqual([
        { error: passthroughFailure, source: 'host-hook' },
        { error: meshFailure, source: 'host-hook' },
      ]);
    });

    test('lastChangedTime moves on a polygon-only change and on a label-only change', async () => {
      const shelf = new NativePlane(
        new XRRigidTransform({ x: 0, y: 1.2, z: 0 }),
        [
          new DOMPointReadOnly(-0.2, 0, -0.1),
          new DOMPointReadOnly(0.2, 0, -0.1),
          new DOMPointReadOnly(0, 0, 0.1),
        ],
        XRSemanticLabels.Table,
      );
      const { device, session } = await startSession(
        { getPlanes: () => [shelf] },
        { features: ['layers', 'plane-detection'] },
      );
      projectionLayer(session);
      const at = (time: number) =>
        frameWith(
          device,
          session,
          (_t, frame) => [...frame.detectedPlanes][0],
          makeFrame({ predictedDisplayTime: time }),
        );
      expect(at(10).lastChangedTime).toBe(10);
      expect(at(20).lastChangedTime).toBe(10);
      shelf.polygon = shelf.polygon
        .slice(0, 2)
        .concat([new DOMPointReadOnly(0, 0, 0.3)]);
      const reshaped = at(30);
      expect(reshaped.lastChangedTime).toBe(30);
      expect(reshaped.orientation).toBe('horizontal');
      shelf.semanticLabel = XRSemanticLabels.Other;
      expect(at(40).lastChangedTime).toBe(40);
      expect(at(50).lastChangedTime).toBe(40);
    });

    test('mesh indices or label changes move lastChangedTime; unlisted meshes are dropped', async () => {
      const box = new NativeMesh(
        new XRRigidTransform({ x: 0, y: 0, z: -2 }),
        new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
        new Uint32Array([0, 1, 2]),
        XRSemanticLabels.Other,
      );
      let listed: NativeMesh[] = [box];
      const { device, session } = await startSession(
        { getMeshes: () => listed },
        { features: ['layers', 'mesh-detection'] },
      );
      projectionLayer(session);
      const at = (time: number) =>
        frameWith(
          device,
          session,
          (_t, frame) => [...frame.detectedMeshes],
          makeFrame({ predictedDisplayTime: time }),
        );
      const [mesh] = at(1);
      expect(mesh.lastChangedTime).toBe(1);
      box.indices = new Uint32Array([1, 3, 2]);
      expect(at(2)[0].lastChangedTime).toBe(2);
      box.semanticLabel = XRSemanticLabels.Couch;
      expect(at(3)[0].lastChangedTime).toBe(3);
      box.transform = new XRRigidTransform({ x: 0, y: 0, z: -3 });
      expect(at(4)[0].lastChangedTime).toBe(3);
      listed = [];
      expect(at(5)).toHaveLength(0);
      expect(session[P_SESSION].trackedMeshes.size).toBe(0);
    });

    test('joint poses carry the radius of this frame, also on reused objects', async () => {
      const { device, session } = await startSession(
        {},
        { features: ['layers', 'local-floor', 'hand-tracking'] },
      );
      projectionLayer(session);
      const input = device.enableHostInput();
      const left = input.left;
      left.mode = XRHostInputMode.Hand;
      const setRadius = (r: number) => {
        for (let j = 0; j < 25; j++) {
          left.joints.set([-0.2, 1, -0.3, 0, 0, 0, 1, r], j * 8);
          left.jointValid[j] = 1;
        }
      };
      const radii: number[] = [];
      for (const r of [0.011, 0.007, 0.013, 0.005]) {
        setRadius(r);
        radii.push(
          frameWith(device, session, (_t, frame) => {
            const hand = session.inputSources[0].hand!;
            const joint = [...hand.values()][3];
            return frame.getJointPose!(joint, device.viewerSpace)!.radius;
          }),
        );
      }
      expect(radii[0]).toBeCloseTo(0.011, 6);
      expect(radii[1]).toBeCloseTo(0.007, 6);
      expect(radii[2]).toBeCloseTo(0.013, 6);
      expect(radii[3]).toBeCloseTo(0.005, 6);
    });

    test('the page renderbuffer binding is restored after the layer makes its depth', async () => {
      const { session } = await startSession();
      const { gl, state } = makeGL();
      const pageRenderbuffer = { page: 'renderbuffer' };
      state.renderbuffer = pageRenderbuffer;
      new XRWebGLLayer(session, gl);
      expect(state.renderbuffer).toBe(pageRenderbuffer);
    });

    test('WebGL2 without invalidateFramebuffer still binds only DRAW_FRAMEBUFFER', async () => {
      const { device, session } = await startSession();
      const { gl, calls, state } = makeGL({ noInvalidate: true });
      const pageDraw = { page: 'draw' };
      const pageRead = { page: 'read' };
      state.draw = pageDraw;
      state.read = pageRead;
      session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
      device.runHostFrame(makeFrame({ colorTexture: 7 }));
      expect([state.draw, state.read]).toEqual([pageDraw, pageRead]);
      const targets = calls
        .filter((c) => c[0] === 'bindFramebuffer')
        .map((c) => c[1]);
      expect(targets.length).toBeGreaterThan(0);
      expect(targets.every((t) => t === 0x8ca9)).toBe(true);
    });

    test('WebGL1 binds FRAMEBUFFER and invalidates nothing', async () => {
      const { device, session } = await startSession();
      const { gl, calls } = makeGL({ webgl1: true });
      session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
      device.runHostFrame(makeFrame());
      const targets = calls
        .filter((c) => c[0] === 'bindFramebuffer')
        .map((c) => c[1]);
      expect(targets.every((t) => t === 0x8d40)).toBe(true);
      expect(calls.some((c) => c[0] === 'invalidateFramebuffer')).toBe(false);
    });

    test('frames without plane or mesh detection do not clear the empty detection sets', async () => {
      const { device, session } = await startSession();
      projectionLayer(session);
      device.runHostFrame(makeFrame());
      device.runHostFrame(makeFrame());
      const clear = jest.spyOn(Set.prototype, 'clear');
      try {
        for (let i = 0; i < 4; i++) {
          session.requestAnimationFrame(() => {});
          device.runHostFrame(makeFrame());
        }
        expect(clear).not.toHaveBeenCalled();
      } finally {
        clear.mockRestore();
      }
    });
  });
});

type XRPose = import('../../src/pose/XRPose').XRPose;
