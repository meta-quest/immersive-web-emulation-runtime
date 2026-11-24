/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Host mode depth sensing (WebXR Depth Sensing, gpu-optimized): negotiation
// against XRHostBackend.depthSensing and per-frame depth from getDepth. The
// fixture values are arbitrary.

import { mat4 } from 'gl-matrix';

import { XRDevice, XRDeviceConfig } from '../../src/device/XRDevice';
import { metaQuest3 } from '../../src/device/configs/headset/meta';
import { XRSession } from '../../src/session/XRSession';
import type {
  XRHostBackend,
  XRHostDepth,
  XRHostFrame,
} from '../../src/host/types';
import { negotiateHostDepth } from '../../src/host/depth';
import { XRFrame } from '../../src/frameloop/XRFrame';
import { XRHostWebGLBinding } from '../../src/host/XRHostWebGLBinding';
import { XRWebGLDepthInformation } from '../../src/depth/XRWebGLBinding';
import { XRReferenceSpace } from '../../src/spaces/XRReferenceSpace';
import { XRView } from '../../src/views/XRView';

const EYE_FOV = [-0.82, 0.76, 0.85, -0.93];
const DEPTH_FOV = [-0.9, 0.9, 0.8, -0.8];
const EYE_HEIGHT = 1.6;
const HALF_IPD = 0.032;

const testHost: XRDeviceConfig = {
  ...metaQuest3,
  name: 'Test Host',
  supportedFeatures: [...metaQuest3.supportedFeatures, 'layers'],
};

// a head turned 30 degrees left and pitched 10 down, and depth cameras that saw the room 2 degrees further right
const TURNED = (() => {
  const q = mat4.getRotation(
    new Float32Array(4) as never,
    mat4.multiply(
      mat4.create(),
      mat4.fromYRotation(mat4.create(), Math.PI / 6),
      mat4.fromXRotation(mat4.create(), -Math.PI / 18),
    ),
  ) as unknown as Float32Array;
  return Array.from(q);
})();
const DEPTH_TURNED = (() => {
  const q = mat4.getRotation(
    new Float32Array(4) as never,
    mat4.fromYRotation(mat4.create(), Math.PI / 6 - Math.PI / 90),
  ) as unknown as Float32Array;
  return Array.from(q);
})();
let eyeOrientation = [0, 0, 0, 1];

function makeFrame(): XRHostFrame {
  const views = new Float32Array(22);
  views.set([-HALF_IPD, EYE_HEIGHT, 0, ...eyeOrientation, ...EYE_FOV], 0);
  views.set([HALF_IPD, EYE_HEIGHT, 0, ...eyeOrientation, ...EYE_FOV], 11);
  return {
    predictedDisplayTime: 1000,
    shouldRender: true,
    viewCount: 2,
    views,
    localPose: new Float32Array([0, 0, 0, 0, 0, 0, 1]),
    baseIsStage: false,
    colorTexture: 7,
    frameRate: 72,
  };
}

const depthTexture = { depthTexture: true } as unknown as WebGLTexture;

/** Depth views 5 cm above the eyes, as a headset's depth cameras might be. */
function makeDepth(
  over: Partial<XRHostDepth> = {},
  orientation = [0, 0, 0, 1],
): XRHostDepth {
  const views = new Float32Array(22);
  views.set([-HALF_IPD, EYE_HEIGHT + 0.05, 0, ...orientation, ...DEPTH_FOV], 0);
  views.set([HALF_IPD, EYE_HEIGHT + 0.05, 0, ...orientation, ...DEPTH_FOV], 11);
  return {
    texture: depthTexture,
    width: 320,
    height: 320,
    depthNear: 0.1,
    depthFar: Infinity,
    rawValueToMeters: 1,
    viewCount: 2,
    views,
    ...over,
  };
}

function makeBackend(over: Partial<XRHostBackend> = {}): XRHostBackend {
  return {
    beginSwapchain: (o) => ({
      width: 100,
      height: 100,
      arraySize: o.arraySize,
    }),
    endSession: () => {},
    postTask: (task) => task(),
    depthSensing: { usages: ['gpu-optimized'], dataFormats: ['float32'] },
    ...over,
  };
}

async function start(
  backend: XRHostBackend,
  init: Record<string, unknown>,
): Promise<{ device: XRDevice; session: XRSession }> {
  const device = new XRDevice(testHost, { host: backend });
  device.installRuntime({ globalObject: {} });
  const session = (await navigator.xr!.requestSession(
    'immersive-ar',
    init as never,
  )) as unknown as XRSession;
  return { device, session };
}

/** Runs one host frame and hands the callback the frame and the viewer pose's views. */
function frameWith<T>(
  device: XRDevice,
  session: XRSession,
  space: XRReferenceSpace,
  read: (frame: XRFrame, views: readonly XRView[]) => T,
): T {
  let seen: T | undefined;
  session.requestAnimationFrame((_time, xrFrame) => {
    const frame = xrFrame as unknown as XRFrame;
    const pose = frame.getViewerPose(space as never);
    seen = read(frame, (pose?.views ?? []) as readonly XRView[]);
  });
  device.runHostFrame(makeFrame());
  return seen as T;
}

describe('host depth sensing', () => {
  afterEach(() => {
    const nav = navigator as { xr?: unknown };
    if (nav.xr) delete nav.xr;
    eyeOrientation = [0, 0, 0, 1];
  });

  describe('negotiation', () => {
    const support = {
      usages: ['gpu-optimized'],
      dataFormats: ['float32', 'luminance-alpha'],
    } as const;

    test('the first preference the host offers wins; empty lists take the host default', () => {
      expect(
        negotiateHostDepth(
          {
            usagePreference: ['cpu-optimized', 'gpu-optimized'],
            dataFormatPreference: ['luminance-alpha', 'float32'],
          },
          support,
        ),
      ).toEqual({ usage: 'gpu-optimized', dataFormat: 'luminance-alpha' });
      expect(
        negotiateHostDepth(
          { usagePreference: [], dataFormatPreference: [] },
          support,
        ),
      ).toEqual({ usage: 'gpu-optimized', dataFormat: 'float32' });
      expect(negotiateHostDepth(undefined, support)).toEqual({
        usage: 'gpu-optimized',
        dataFormat: 'float32',
      });
    });

    test("'unsigned-short' (Quest Browser's format for this texture) is granted when the host offers it", () => {
      expect(
        negotiateHostDepth(
          {
            usagePreference: ['gpu-optimized'],
            dataFormatPreference: ['unsigned-short'],
          },
          {
            usages: ['gpu-optimized'],
            dataFormats: ['unsigned-short', 'float32'],
          },
        ),
      ).toEqual({ usage: 'gpu-optimized', dataFormat: 'unsigned-short' });
    });

    test('no match in either list: not supported', () => {
      expect(
        negotiateHostDepth(
          { usagePreference: ['cpu-optimized'], dataFormatPreference: [] },
          support,
        ),
      ).toBeNull();
      expect(
        negotiateHostDepth(
          {
            usagePreference: [],
            dataFormatPreference: ['unsigned-short' as never],
          },
          support,
        ),
      ).toBeNull();
    });

    test('a required depth-sensing the host cannot serve rejects with NotSupportedError', async () => {
      await expect(
        start(makeBackend(), {
          requiredFeatures: ['depth-sensing'],
          depthSensing: {
            usagePreference: ['cpu-optimized'],
            dataFormatPreference: ['float32'],
          },
        }),
      ).rejects.toMatchObject({ name: 'NotSupportedError' });
    });

    test('an optional one is dropped', async () => {
      const { session } = await start(makeBackend(), {
        optionalFeatures: ['depth-sensing'],
        depthSensing: {
          usagePreference: ['cpu-optimized'],
          dataFormatPreference: ['float32'],
        },
      });
      expect(session.enabledFeatures).not.toContain('depth-sensing');
    });

    test('granted with the negotiated usage and format (IWSDK: gpu-optimized, float32)', async () => {
      const { session } = await start(makeBackend(), {
        requiredFeatures: ['depth-sensing'],
        depthSensing: {
          usagePreference: ['gpu-optimized'],
          dataFormatPreference: ['float32'],
        },
      });
      expect(session.enabledFeatures).toContain('depth-sensing');
      expect(session.depthUsage).toBe('gpu-optimized');
      expect(session.depthDataFormat).toBe('float32');
    });

    test('depthUsage and depthDataFormat throw InvalidStateError when depth-sensing is not enabled', async () => {
      const { session } = await start(makeBackend(), {
        optionalFeatures: ['depth-sensing'],
        depthSensing: {
          usagePreference: ['cpu-optimized'],
          dataFormatPreference: ['float32'],
        },
      });
      expect(session.enabledFeatures).not.toContain('depth-sensing');
      expect(() => session.depthUsage).toThrow(
        expect.objectContaining({ name: 'InvalidStateError' }),
      );
      expect(() => session.depthDataFormat).toThrow(
        expect.objectContaining({ name: 'InvalidStateError' }),
      );
    });

    test('a host without depthSensing keeps the old behaviour (first preference, no getDepth)', async () => {
      const getDepth = jest.fn(() => makeDepth());
      const { device, session } = await start(
        makeBackend({ depthSensing: undefined, getDepth }),
        {
          requiredFeatures: ['depth-sensing'],
          depthSensing: {
            usagePreference: ['cpu-optimized'],
            dataFormatPreference: ['float32'],
          },
        },
      );
      expect(session.depthUsage).toBe('cpu-optimized');
      const space = (await session.requestReferenceSpace(
        'local' as never,
      )) as unknown as XRReferenceSpace;
      frameWith(device, session, space, () => null);
      expect(getDepth).not.toHaveBeenCalled();
    });
  });

  describe('frames', () => {
    const init = {
      requiredFeatures: ['depth-sensing'],
      depthSensing: {
        usagePreference: ['gpu-optimized'],
        dataFormatPreference: ['float32'],
      },
    };

    test('getDepthInformation returns the host texture, one layer per eye, with Quest Browser values', async () => {
      const { device, session } = await start(
        makeBackend({ getDepth: () => makeDepth() }),
        init,
      );
      const binding = new XRHostWebGLBinding(session, {} as never);
      const space = (await session.requestReferenceSpace(
        'local' as never,
      )) as unknown as XRReferenceSpace;
      const [left, right] = frameWith(device, session, space, (_f, views) =>
        views.map((v) => binding.getDepthInformation(v)!),
      );
      for (const [info, index] of [
        [left, 0],
        [right, 1],
      ] as const) {
        expect(info).toBeInstanceOf(XRWebGLDepthInformation);
        expect(info.texture).toBe(depthTexture);
        expect(info.textureType).toBe('texture-array');
        expect(info.imageIndex).toBe(index);
        expect(info.width).toBe(320);
        expect(info.height).toBe(320);
        expect(info.depthNear).toBeCloseTo(0.1);
        expect(info.depthFar).toBe(Infinity);
        expect(info.rawValueToMeters).toBe(1);
        expect(info.isValid).toBe(true);
        expect(Array.from(info.normDepthBufferFromNormView.matrix)).toEqual(
          Array.from(mat4.create()),
        );
      }
    });

    test('the depth view projection and transform describe the depth camera, not the eye', async () => {
      const { device, session } = await start(
        makeBackend({ getDepth: () => makeDepth() }),
        init,
      );
      const binding = new XRHostWebGLBinding(session, {} as never);
      const space = (await session.requestReferenceSpace(
        'local' as never,
      )) as unknown as XRReferenceSpace;
      const seen = frameWith(device, session, space, (_f, views) => {
        const info = binding.getDepthInformation(views[0])!;
        return {
          projection: Array.from(info.projectionMatrix!),
          depthY: info.transform!.matrix[13],
          eyeY: views[0].transform.matrix[13],
          depthX: info.transform!.matrix[12],
          eyeX: views[0].transform.matrix[12],
        };
      });
      // symmetric 0.9 / 0.8 rad tangents: x scale 1 / tan(0.9), y scale 1 / tan(0.8)
      expect(seen.projection[0]).toBeCloseTo(1 / Math.tan(0.9), 5);
      expect(seen.projection[5]).toBeCloseTo(1 / Math.tan(0.8), 5);
      // infinite far plane: -1 and -2 near
      expect(seen.projection[10]).toBe(-1);
      expect(seen.projection[14]).toBeCloseTo(-0.2, 6);
      expect(seen.depthY - seen.eyeY).toBeCloseTo(0.05, 5);
      expect(seen.depthX).toBeCloseTo(seen.eyeX, 5);
    });

    test('matchDepthView (the default) with a host that reprojects: the depth in the render view, with its projection and pose', async () => {
      eyeOrientation = TURNED;
      const reprojected = { reprojected: true } as unknown as WebGLTexture;
      const calls: Float32Array[] = [];
      const { device, session } = await start(
        makeBackend({
          getDepth: () => makeDepth({}, DEPTH_TURNED),
          reprojectDepth: (_depth, matrices) => {
            calls.push(Float32Array.from(matrices));
            return reprojected;
          },
        }),
        init,
      );
      const binding = new XRHostWebGLBinding(session, {} as never);
      const space = (await session.requestReferenceSpace(
        'local' as never,
      )) as unknown as XRReferenceSpace;
      const seen = frameWith(device, session, space, (_f, views) =>
        views.map((v) => {
          const info = binding.getDepthInformation(v)!;
          return {
            texture: info.texture,
            index: info.imageIndex,
            projection: Array.from(info.projectionMatrix!),
            viewProjection: Array.from(v.projectionMatrix),
            transform: Array.from(info.transform!.matrix),
            viewTransform: Array.from(v.transform.matrix),
          };
        }),
      );
      expect(calls).toHaveLength(1);
      for (const [i, view] of seen.entries()) {
        expect(view.texture).toBe(reprojected);
        expect(view.index).toBe(i);
        expect(view.projection).toEqual(view.viewProjection);
        view.transform.forEach((x, k) =>
          expect(x).toBeCloseTo(view.viewTransform[k], 5),
        );
      }
      // the matrix takes a point seen by the eye to where the depth camera saw it: a world point projected by the eye,
      // then mapped, lands where the depth view projects the same point
      const point = [0.4, 1.2, -2.5, 1];
      const depth = makeDepth({}, DEPTH_TURNED);
      for (let view = 0; view < 2; view++) {
        const eyePose = mat4.fromRotationTranslation(
          mat4.create(),
          TURNED as never,
          [view ? HALF_IPD : -HALF_IPD, EYE_HEIGHT, 0],
        );
        const depthPose = mat4.fromRotationTranslation(
          mat4.create(),
          DEPTH_TURNED as never,
          [view ? HALF_IPD : -HALF_IPD, EYE_HEIGHT + 0.05, 0],
        );
        const eyeClip = transform(
          mat4.multiply(
            mat4.create(),
            new Float32Array(seen[view].viewProjection) as never,
            mat4.invert(mat4.create(), eyePose)!,
          ),
          point,
        );
        const mapped = transform(
          calls[0].subarray(view * 16, view * 16 + 16) as never,
          eyeClip,
        );
        const depthClip = transform(
          mat4.multiply(
            mat4.create(),
            perspective(DEPTH_FOV, depth.depthNear),
            mat4.invert(mat4.create(), depthPose)!,
          ),
          point,
        );
        expect(mapped[0] / mapped[3]).toBeCloseTo(
          depthClip[0] / depthClip[3],
          4,
        );
        expect(mapped[1] / mapped[3]).toBeCloseTo(
          depthClip[1] / depthClip[3],
          4,
        );
      }
    });

    test('matchDepthView false keeps the depth views: with a turned head the transform is still the depth camera pose', async () => {
      eyeOrientation = TURNED;
      const reprojectDepth = jest.fn(() => ({}) as unknown as WebGLTexture);
      const { device, session } = await start(
        makeBackend({
          getDepth: () => makeDepth({}, DEPTH_TURNED),
          reprojectDepth,
        }),
        {
          ...init,
          depthSensing: { ...init.depthSensing, matchDepthView: false },
        },
      );
      const binding = new XRHostWebGLBinding(session, {} as never);
      const space = (await session.requestReferenceSpace(
        'local' as never,
      )) as unknown as XRReferenceSpace;
      const transforms = frameWith(device, session, space, (_f, views) =>
        views.map((v) =>
          Array.from(binding.getDepthInformation(v)!.transform!.matrix),
        ),
      );
      expect(reprojectDepth).not.toHaveBeenCalled();
      for (let view = 0; view < 2; view++) {
        const depthPose = mat4.fromRotationTranslation(
          mat4.create(),
          DEPTH_TURNED as never,
          [view ? HALF_IPD : -HALF_IPD, EYE_HEIGHT + 0.05, 0],
        );
        transforms[view].forEach((x, k) =>
          expect(x).toBeCloseTo(depthPose[k], 5),
        );
      }
    });

    test('host mode installs XRWebGLDepthInformation as a global', async () => {
      const device = new XRDevice(testHost, { host: makeBackend() });
      const globalObject: Record<string, unknown> = {};
      device.installRuntime({ globalObject });
      expect(globalObject.XRWebGLDepthInformation).toBe(
        XRWebGLDepthInformation,
      );
    });

    test('XRFrame.getDepthInformation throws InvalidStateError on a gpu-optimized session', async () => {
      const { device, session } = await start(
        makeBackend({ getDepth: () => makeDepth() }),
        init,
      );
      const space = (await session.requestReferenceSpace(
        'local' as never,
      )) as unknown as XRReferenceSpace;
      const error = frameWith(device, session, space, (frame, views) => {
        try {
          frame.getDepthInformation(views[0]);
          return null;
        } catch (e) {
          return e as DOMException;
        }
      });
      expect(error).toMatchObject({ name: 'InvalidStateError' });
    });

    test('no depth from the host (null) means getDepthInformation returns null', async () => {
      let depth: XRHostDepth | null = makeDepth();
      const { device, session } = await start(
        makeBackend({ getDepth: () => depth }),
        init,
      );
      const binding = new XRHostWebGLBinding(session, {} as never);
      const space = (await session.requestReferenceSpace(
        'local' as never,
      )) as unknown as XRReferenceSpace;
      expect(
        frameWith(device, session, space, (_f, v) =>
          binding.getDepthInformation(v[0]),
        ),
      ).not.toBeNull();
      depth = null;
      expect(
        frameWith(device, session, space, (_f, v) =>
          binding.getDepthInformation(v[0]),
        ),
      ).toBeNull();
    });

    test('objects are reused every other frame, so steady frames allocate none', async () => {
      const { device, session } = await start(
        makeBackend({ getDepth: () => makeDepth() }),
        init,
      );
      const binding = new XRHostWebGLBinding(session, {} as never);
      const space = (await session.requestReferenceSpace(
        'local' as never,
      )) as unknown as XRReferenceSpace;
      const get = () =>
        frameWith(device, session, space, (_f, v) =>
          binding.getDepthInformation(v[0]),
        );
      const a = get();
      const b = get();
      const c = get();
      expect(a).not.toBe(b);
      expect(c).toBe(a);
    });

    test('a throwing getDepth is reported as host-hook and the frame goes on without depth', async () => {
      const errors: string[] = [];
      const { device, session } = await start(
        makeBackend({
          getDepth: () => {
            throw new Error('depth broke');
          },
          reportError: (_e, source) => {
            errors.push(source);
          },
        }),
        init,
      );
      const binding = new XRHostWebGLBinding(session, {} as never);
      const space = (await session.requestReferenceSpace(
        'local' as never,
      )) as unknown as XRReferenceSpace;
      expect(
        frameWith(device, session, space, (_f, v) =>
          binding.getDepthInformation(v[0]),
        ),
      ).toBeNull();
      expect(errors).toEqual(['host-hook']);
    });
  });
});

function transform(m: ArrayLike<number>, p: number[]): number[] {
  const out = [0, 0, 0, 0];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) out[r] += m[c * 4 + r] * p[c];
  }
  return out;
}

/** A projection from FOV angles (left, right, up, down) with an infinite far plane, as hostPerspective builds it. */
function perspective(fov: number[], near: number): mat4 {
  const [l, r, u, d] = fov.map(Math.tan);
  const m = new Float32Array(16) as unknown as mat4;
  m[0] = 2 / (r - l);
  m[5] = 2 / (u - d);
  m[8] = (r + l) / (r - l);
  m[9] = (u + d) / (u - d);
  m[10] = -1;
  m[11] = -1;
  m[14] = -2 * near;
  return m;
}
