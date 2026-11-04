/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Behaviour that host mode's performance work must keep: per-frame pose
// caching, pooled result objects, in-place scene sets, projection reuse,
// and the allocation-free helpers. Expectations come from the WebXR Device
// API (poses within a frame, SameObject attributes), WebXR Plane / Mesh
// Detection, HOST-INPUT.md and the reuse rules in src/host/frame.ts.

import { mat4, quat, vec3 } from 'gl-matrix';

import { XRDevice, XRDeviceConfig } from '../../src/device/XRDevice';
import { metaQuest3 } from '../../src/device/configs/headset/meta';
import { XRSession } from '../../src/session/XRSession';
import type {
  XRHostBackend,
  XRHostFrame,
  XRHostSwapchainOptions,
} from '../../src/host/types';
import { XRFrame } from '../../src/frameloop/XRFrame';
import { XRHostWebGLBinding } from '../../src/host/XRHostWebGLBinding';
import { XRReferenceSpace } from '../../src/spaces/XRReferenceSpace';
import { XRRigidTransform } from '../../src/primitives/XRRigidTransform';
import { XRHostInputMode } from '../../src/device/XRHostInput';
import { NativePlane } from '../../src/planes/XRPlane';
import { XRSemanticLabels } from '../../src/labels/labels';
import { invertAffine, multiplyInto } from '../../src/host/affine';
import { truncateArray } from '../../src/utils/arrays';
import { edgeEventTypes } from '../../src/gamepad/button-edges';
import { P_DEVICE, P_SPACE, P_VIEW } from '../../src/private';

const FOV = [-0.82, 0.76, 0.85, -0.93];

const config: XRDeviceConfig = {
  ...metaQuest3,
  name: 'Perf Test Host',
  supportedFeatures: [...metaQuest3.supportedFeatures, 'layers'],
};

function makeBackend(over: Partial<XRHostBackend> = {}): XRHostBackend {
  return {
    beginSwapchain: (options: XRHostSwapchainOptions) => ({
      width: 1000,
      height: 1000,
      arraySize: options.arraySize,
      rates: [72, 90],
      rate: 72,
      hasStage: true,
    }),
    endSession: () => {},
    getOpaqueColorTexture: () => ({}) as WebGLTexture,
    postTask: (task) => task(),
    ...over,
  };
}

/** A host frame with both eyes at `x` (metres), looking down -z. */
function makeFrame(x = 0, over: Partial<XRHostFrame> = {}): XRHostFrame {
  const views = new Float32Array(22);
  views.set([x - 0.03, 1.6, 0, 0, 0, 0, 1], 0);
  views.set(FOV, 7);
  views.set([x + 0.03, 1.6, 0, 0, 0, 0, 1], 11);
  views.set(FOV, 18);
  return {
    predictedDisplayTime: 1000,
    shouldRender: true,
    viewCount: 2,
    views,
    localPose: new Float32Array([0, 1.6, 0, 0, 0, 0, 1]),
    baseIsStage: true,
    colorTexture: 3,
    frameRate: 72,
    ...over,
  };
}

const gl = {
  createFramebuffer: () => ({}),
  getContextAttributes: () => ({ premultipliedAlpha: true }),
} as unknown as WebGL2RenderingContext;

async function startSession(
  over: Partial<XRHostBackend> = {},
  features: string[] = ['local-floor', 'layers', 'hand-tracking'],
) {
  const device = new XRDevice(config, { host: makeBackend(over) });
  device.installRuntime({ globalObject: {} });
  const session = (await navigator.xr!.requestSession('immersive-vr', {
    optionalFeatures: features,
  })) as unknown as XRSession;
  const binding = new XRHostWebGLBinding(session, gl);
  session.updateRenderState({ layers: [binding.createProjectionLayer()] });
  const floor = (await session.requestReferenceSpace(
    'local-floor' as never,
  )) as unknown as XRReferenceSpace;
  return { device, session, floor };
}

function frameWith<T>(
  device: XRDevice,
  session: XRSession,
  read: (frame: XRFrame) => T,
  frame: XRHostFrame = makeFrame(),
): T {
  let seen: T | undefined;
  session.requestAnimationFrame((_t, xrFrame) => {
    seen = read(xrFrame as unknown as XRFrame);
  });
  device.runHostFrame(frame);
  return seen as T;
}

afterEach(() => {
  const nav = navigator as { xr?: unknown };
  if (nav.xr) delete nav.xr;
});

describe('host mode performance paths', () => {
  describe('affine helpers', () => {
    const rigid = (seed: number) => {
      const q = quat.setAxisAngle(
        quat.create(),
        vec3.normalize(vec3.create(), [seed, 1, -seed / 2]),
        seed,
      );
      return mat4.fromRotationTranslation(mat4.create(), q, [
        seed,
        -2 * seed,
        0.5,
      ]);
    };

    test('multiplyInto matches gl-matrix for affine and general matrices', () => {
      const projective = mat4.perspective(mat4.create(), 1, 1.2, 0.1, 50);
      const pairs: Array<[mat4, mat4]> = [
        [rigid(0.3), rigid(1.7)],
        [rigid(2.1), projective],
        [projective, rigid(0.9)],
      ];
      for (const [a, b] of pairs) {
        const expected = mat4.multiply(mat4.create(), a, b);
        const packed = new Float32Array(48);
        multiplyInto(packed, 16, a, b);
        for (let i = 0; i < 16; i++) {
          expect(packed[16 + i]).toBeCloseTo(expected[i], 5);
        }
        // the rest of the array is untouched
        expect(packed[15]).toBe(0);
        expect(packed[32]).toBe(0);
      }
    });

    test('invertAffine matches gl-matrix, also in place, and reports singular input', () => {
      const scaled = mat4.scale(mat4.create(), rigid(1.1), [2, 0.5, 3]);
      const projective = mat4.perspective(mat4.create(), 1, 1.2, 0.1, 50);
      for (const m of [rigid(0.4), scaled, projective]) {
        const expected = mat4.invert(mat4.create(), m)!;
        const out = mat4.create();
        expect(invertAffine(out, m)).toBe(true);
        const copy = mat4.clone(m);
        expect(invertAffine(copy, copy)).toBe(true);
        for (let i = 0; i < 16; i++) {
          expect(out[i]).toBeCloseTo(expected[i], 4);
          expect(copy[i]).toBeCloseTo(expected[i], 4);
        }
      }
      const flat = mat4.fromScaling(mat4.create(), [1, 0, 1]);
      const out = mat4.fromValues(
        7,
        7,
        7,
        7,
        7,
        7,
        7,
        7,
        7,
        7,
        7,
        7,
        7,
        7,
        7,
        7,
      );
      expect(invertAffine(out, flat)).toBe(false);
      expect(out[0]).toBe(7);
    });
  });

  describe('poses', () => {
    test('a space asked against two bases in one frame gets two objects, each right, each stable within the frame', async () => {
      const { device, session, floor } = await startSession();
      const ahead = floor.getOffsetReferenceSpace(
        new XRRigidTransform({ x: 0, y: 0, z: -2 }),
      );
      const viewer = device.viewerSpace;
      const r = frameWith(device, session, (frame) => {
        const a = frame.getPose(viewer, floor)!;
        const b = frame.getPose(viewer, ahead)!;
        return {
          a,
          b,
          aAgain: frame.getPose(viewer, floor),
          bAgain: frame.getPose(viewer, ahead),
          aZ: a.transform.matrix[14],
          bZ: b.transform.matrix[14],
        };
      });
      expect(r.a).not.toBe(r.b);
      expect(r.aAgain).toBe(r.a);
      expect(r.bAgain).toBe(r.b);
      expect(r.aZ).toBeCloseTo(0, 6);
      expect(r.bZ).toBeCloseTo(2, 6);
    });

    test('a new base space every frame keeps results right with a bounded set of pose objects', async () => {
      const { device, session, floor } = await startSession();
      const seen = new Set<unknown>();
      let kept: { pose: { transform: XRRigidTransform }; x: number } | null =
        null;
      for (let i = 0; i < 10; i++) {
        const base = floor.getOffsetReferenceSpace(
          new XRRigidTransform({ x: i, y: 0, z: 0 }),
        );
        frameWith(
          device,
          session,
          (frame) => {
            // the pose handed out last frame still reads what it said
            if (kept) {
              expect(kept.pose.transform.matrix[12]).toBeCloseTo(kept.x, 6);
            }
            const pose = frame.getPose(device.viewerSpace, base)!;
            seen.add(pose);
            expect(pose.transform.matrix[12]).toBeCloseTo(0.25 - i, 5);
            kept = { pose, x: pose.transform.matrix[12] };
          },
          makeFrame(0.25),
        );
      }
      expect(seen.size).toBe(2);
    });

    test('offset chains follow the head every frame, and an untracked ancestor gives null', async () => {
      const { device, session, floor } = await startSession();
      const input = device.enableHostInput();
      input.right.mode = XRHostInputMode.Controller;
      input.right.grip.set([0.2, 1, -0.4, 0, 0, 0, 1]);
      input.right.gripValid = true;
      input.right.targetRayValid = true;
      const turnedAndMoved = floor
        .getOffsetReferenceSpace(new XRRigidTransform({ x: 1, y: 0, z: 0 }))
        .getOffsetReferenceSpace(
          new XRRigidTransform(
            { x: 0, y: 0, z: -1 },
            { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 },
          ),
        );
      for (const headX of [0, 0.5, -0.5]) {
        const expected = mat4.create();
        // head in the chain's space, computed independently
        const chain = mat4.multiply(
          mat4.create(),
          mat4.fromTranslation(mat4.create(), [1, 0, 0]),
          mat4.fromRotationTranslation(
            mat4.create(),
            [0, Math.SQRT1_2, 0, Math.SQRT1_2],
            [0, 0, -1],
          ),
        );
        mat4.multiply(
          expected,
          mat4.invert(mat4.create(), chain)!,
          mat4.fromTranslation(mat4.create(), [headX, 1.6, 0]),
        );
        const got = frameWith(
          device,
          session,
          (frame) =>
            Array.from(frame.getViewerPose(turnedAndMoved).transform.matrix),
          makeFrame(headX),
        );
        got.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 5));
      }

      const source = () => session.inputSources[0];
      const tracked = frameWith(device, session, (frame) =>
        frame.getPose(device.viewerSpace, source().gripSpace!),
      );
      expect(tracked).not.toBeNull();
      input.right.gripValid = false;
      const lost = frameWith(device, session, (frame) => [
        frame.getPose(device.viewerSpace, source().gripSpace!),
        frame.getPose(source().gripSpace!, floor),
      ]);
      expect(lost).toEqual([null, null]);
    });

    test('a space made inside a callback is located in that same frame', async () => {
      const { device, session } = await startSession(undefined, [
        'local',
        'local-floor',
        'layers',
      ]);
      const local = (await session.requestReferenceSpace(
        'local' as never,
      )) as unknown as XRReferenceSpace;
      const z = frameWith(device, session, (frame) => {
        // locate against `local` first, so its world matrix is cached
        frame.getPose(device.viewerSpace, local);
        const offset = local.getOffsetReferenceSpace(
          new XRRigidTransform({ x: 0, y: 0, z: 1 }),
        );
        return frame.getPose(device.viewerSpace, offset)!.transform.matrix[14];
      });
      expect(z).toBeCloseTo(-1, 6);
    });
  });

  describe('views', () => {
    test('projections follow FOV and clip-plane changes, and a page cannot make a change stick', async () => {
      const { device, session, floor } = await startSession();
      const read = (frame: XRHostFrame) =>
        frameWith(
          device,
          session,
          (f) => f.getViewerPose(floor).views[0].projectionMatrix,
          frame,
        );
      const first = Array.from(read(makeFrame()));
      const scribbled = read(makeFrame());
      scribbled[0] = 42;
      expect(Array.from(read(makeFrame()))).toEqual(first);

      const wider = makeFrame();
      (wider.views as Float32Array)[7] = -1.1;
      const changed = Array.from(read(wider));
      expect(changed[0]).not.toBeCloseTo(first[0], 3);
      const expected = 2 / (Math.tan(FOV[1]) - Math.tan(-1.1));
      expect(changed[0]).toBeCloseTo(expected, 5);

      session.updateRenderState({ depthNear: 0.5, depthFar: 10 });
      const clipped = Array.from(read(wider));
      expect(clipped[10]).toBeCloseTo((10 + 0.5) / (0.5 - 10), 5);
      expect(clipped[14]).toBeCloseTo((2 * 10 * 0.5) / (0.5 - 10), 5);
    });
  });

  describe('scene', () => {
    const plane = (x: number) =>
      new NativePlane(
        new XRRigidTransform({ x, y: 0, z: -1 }),
        [new DOMPointReadOnly(0, 0, 0), new DOMPointReadOnly(1, 0, 0)],
        XRSemanticLabels.Floor,
      );

    test('detectedPlanes is brought up to date in place on both alternating frame objects', async () => {
      const a = plane(0);
      const b = plane(1);
      const c = plane(2);
      let listed: NativePlane[] = [a, b];
      let fail = false;
      const { device, session } = await startSession(
        {
          getPlanes: () => {
            if (fail) throw new Error('scene service down');
            return listed;
          },
          reportError: () => {},
        },
        ['layers', 'local-floor', 'plane-detection'],
      );
      const xs = () =>
        frameWith(device, session, (frame) =>
          [...frame.detectedPlanes]
            .map(
              (p) =>
                frame.getPose(p.planeSpace, device[P_DEVICE].globalSpace)!
                  .transform.matrix[12],
            )
            .sort(),
        );
      expect(xs()).toEqual([0, 1]);
      expect(xs()).toEqual([0, 1]);
      listed = [b];
      expect(xs()).toEqual([1]);
      expect(xs()).toEqual([1]);
      listed = [c, a, b];
      expect(xs()).toEqual([0, 1, 2]);
      expect(xs()).toEqual([0, 1, 2]);
      fail = true;
      expect(xs()).toEqual([0, 1, 2]);
      fail = false;
      listed = [];
      expect(xs()).toEqual([]);
      expect(xs()).toEqual([]);
    });
  });

  describe('input', () => {
    test('session.inputSources is one array, refilled, and empty after the end', async () => {
      const { device, session } = await startSession();
      const input = device.enableHostInput();
      input.left.mode = XRHostInputMode.Controller;
      const first = frameWith(device, session, () => session.inputSources);
      expect(first).toHaveLength(1);
      input.right.mode = XRHostInputMode.Controller;
      const second = frameWith(device, session, () => session.inputSources);
      expect(second).toBe(first);
      expect(second).toHaveLength(2);
      input.left.mode = XRHostInputMode.None;
      input.right.mode = XRHostInputMode.None;
      frameWith(device, session, () => null);
      expect(session.inputSources).toHaveLength(0);
      input.left.mode = XRHostInputMode.Controller;
      frameWith(device, session, () => null);
      expect(session.inputSources).toHaveLength(1);
      await session.end();
      expect(session.inputSources).toHaveLength(0);
      expect(session.inputSources).toBe(first);
    });

    test('host controller axes read back fractional values in a stable array', async () => {
      const { device, session } = await startSession();
      const input = device.enableHostInput();
      input.left.mode = XRHostInputMode.Controller;
      input.left.axes.set([0.125, -0.25, 0.375, -0.5]);
      const first = frameWith(device, session, () => {
        const axes = session.inputSources[0].gamepad!.axes;
        return { axes, values: Array.from(axes) };
      });
      expect(first.values).toEqual([0.125, -0.25, 0.375, -0.5]);
      input.left.axes.set([0.75, 0.5, -0.125, 0.25]);
      const second = frameWith(
        device,
        session,
        () => session.inputSources[0].gamepad!.axes,
      );
      expect(second).toBe(first.axes);
      expect(Array.from(second)).toEqual([0.75, 0.5, -0.125, 0.25]);
    });

    test('edge event types come in WebXR order', () => {
      expect(edgeEventTypes('press', 'select')).toEqual(['selectstart']);
      expect(edgeEventTypes('release', 'select')).toEqual([
        'select',
        'selectend',
      ]);
      expect(edgeEventTypes('cancel', 'squeeze')).toEqual(['squeezeend']);
      expect(edgeEventTypes('release', 'squeeze')).toEqual([
        'squeeze',
        'squeezeend',
      ]);
      expect(edgeEventTypes(null, 'select')).toEqual([]);
    });
  });

  test('truncateArray shortens a list in order', () => {
    const list = [1, 2, 3, 4];
    truncateArray(list, 2);
    expect(list).toEqual([1, 2]);
    truncateArray(list, 5);
    expect(list).toEqual([1, 2]);
    truncateArray(list, 0);
    expect(list).toEqual([]);
    list.push(9);
    expect(list).toEqual([9]);
  });

  describe('edge cases: deep chains, event order, non-finite input, reuse', () => {
    test('offset chains of any depth resolve without recursion, also when grown every frame', async () => {
      const { device, session, floor } = await startSession();
      // a step float32 sums exactly
      const step = new XRRigidTransform({ x: 0, y: 0, z: -1 / 1024 });
      let chain: XRReferenceSpace = floor;
      for (let i = 0; i < 100000; i++) {
        chain = chain.getOffsetReferenceSpace(step);
      }
      // the head (at floor z 0) is behind the end of the chain
      const z = frameWith(
        device,
        session,
        (frame) => frame.getViewerPose(chain)!.transform.matrix[14],
      );
      expect(z).toBeCloseTo(100000 / 1024, 6);
      // smooth locomotion that derives each frame's space from the last
      let grown: XRReferenceSpace = chain;
      for (let i = 1; i <= 3; i++) {
        grown = grown.getOffsetReferenceSpace(step);
        const zi = frameWith(
          device,
          session,
          (frame) =>
            frame.getPose(device.viewerSpace, grown)!.transform.matrix[14],
        );
        expect(zi).toBeCloseTo((100000 + i) / 1024, 6);
      }
    });

    test('an untracked space deep in a chain makes every descendant unlocatable', async () => {
      const { device, session, floor } = await startSession();
      const input = device.enableHostInput();
      input.right.mode = XRHostInputMode.Controller;
      input.right.gripValid = true;
      input.right.targetRayValid = true;
      input.right.grip.set([0.5, 1, 0, 0, 0, 0, 1]);
      frameWith(device, session, () => null);
      const grip = session.inputSources[0].gripSpace!;
      const step = new XRRigidTransform({ x: 0, y: 0.001, z: 0 });
      // XRSpace has no getOffsetReferenceSpace, so chain under the grip by
      // hand, as the record allows: each child's parent is the previous
      const spaces = [grip];
      for (let i = 0; i < 20000; i++) {
        const child = floor.getOffsetReferenceSpace(step);
        child[P_SPACE].parentSpace = spaces[spaces.length - 1];
        spaces.push(child);
      }
      const end = spaces[spaces.length - 1];
      const y = frameWith(
        device,
        session,
        (frame) => frame.getPose(end, floor)!.transform.matrix[13],
      );
      expect(y).toBeCloseTo(1 + 20, 3);
      input.right.gripValid = false;
      const lost = frameWith(device, session, (frame) => [
        frame.getPose(end, floor),
        frame.getPose(spaces[10000], floor),
        frame.getPose(floor, end),
      ]);
      expect(lost).toEqual([null, null, null]);
    });

    test("an input event handler sees every source's state for this frame, and rAF sees the same", async () => {
      const { device, session, floor } = await startSession();
      const input = device.enableHostInput();
      for (const hand of [input.left, input.right]) {
        hand.mode = XRHostInputMode.Controller;
        hand.gripValid = true;
        hand.targetRayValid = true;
      }
      input.left.grip.set([-0.3, 1, 0, 0, 0, 0, 1]);
      input.right.grip.set([0.5, 1, 0, 0, 0, 0, 1]);
      input.right.targetRay.set([0.5, 1, -0.3, 0, 0, 0, 1]);
      frameWith(device, session, () => null);
      const right = session.inputSources.find((s) => s.handedness === 'right')!;
      const seen: Array<unknown> = [];
      session.addEventListener('selectstart', (event) => {
        const frame = (event as unknown as { frame: XRFrame }).frame;
        const pose = frame.getPose(right.gripSpace!, floor);
        seen.push(pose ? pose.transform.matrix[12] : null);
      });
      const fill = new Float32Array(16);
      const rafRead = (frame: XRFrame) => {
        const pose = frame.getPose(right.gripSpace!, floor);
        const ok = frame.fillPoses!([right.gripSpace!], floor, fill);
        const ray = frame.getPose(right.targetRaySpace, right.gripSpace!);
        return {
          pose: pose ? pose.transform.matrix[12] : null,
          ok,
          filled: fill[12],
          ray: ray ? ray.transform.matrix[14] : null,
        };
      };
      // frame 2: the right grip is lost while the left trigger goes down
      input.right.gripValid = false;
      input.left.buttonValues[0] = 1;
      input.left.buttonPressed[0] = 1;
      const lost = frameWith(device, session, rafRead);
      expect(seen).toEqual([null]);
      expect(lost.pose).toBeNull();
      expect(lost.ok).toBe(false);
      expect(lost.filled).toBeNaN();
      expect(lost.ray).toBeNull();
      // frame 3: found again (and moved) while the trigger goes down again
      input.left.buttonValues[0] = 0;
      input.left.buttonPressed[0] = 0;
      frameWith(device, session, () => null);
      input.right.gripValid = true;
      input.right.grip.set([-0.5, 1, 0, 0, 0, 0, 1]);
      input.left.buttonValues[0] = 1;
      input.left.buttonPressed[0] = 1;
      const found = frameWith(device, session, rafRead);
      expect(seen).toEqual([null, -0.5]);
      expect(found.pose).toBeCloseTo(-0.5, 5);
      expect(found.ok).toBe(true);
      expect(found.filled).toBeCloseTo(-0.5, 5);
      expect(found.ray).toBeCloseTo(-0.3, 5);
    });

    test('poses cached by an input event handler do not outlive the input update', async () => {
      // emulated controllers (no host input) move their spaces in their own
      // frame start, after the sources before them fired their events
      const { device, session, floor } = await startSession();
      frameWith(device, session, () => null);
      const right = session.inputSources.find((s) => s.handedness === 'right')!;
      const left = device.controllers.left!;
      const rightController = device.controllers.right!;
      const inHandler: number[] = [];
      session.addEventListener('selectstart', (event) => {
        const frame = (event as unknown as { frame: XRFrame }).frame;
        inHandler.push(
          frame.getPose(right.targetRaySpace, floor)!.transform.matrix[12],
        );
      });
      rightController.position.x = 0.75;
      left.updateButtonValue('trigger', 1);
      const x = frameWith(
        device,
        session,
        (frame) =>
          frame.getPose(right.targetRaySpace, floor)!.transform.matrix[12],
      );
      expect(inHandler).toHaveLength(1);
      expect(x).toBeCloseTo(0.75, 5);
    });

    test('a non-finite base or pose gives what the general matrix math gives', async () => {
      const { device, session, floor } = await startSession();
      const nanFloor = frameWith(
        device,
        session,
        (frame) => frame.getViewerPose(floor),
        makeFrame(0, {
          localPose: new Float32Array([NaN, 1.6, 0, 0, 0, 0, 1]),
        }),
      );
      expect(nanFloor).toBeNull();
      // helpers: non-finite entries take gl-matrix's path
      const t = mat4.fromTranslation(mat4.create(), [1, 2, 3]);
      const bad = mat4.fromTranslation(mat4.create(), [NaN, 0, Infinity]);
      expect(invertAffine(mat4.create(), bad)).toBe(false);
      expect(mat4.invert(mat4.create(), bad)).toBeNull();
      const offDiagonal = mat4.create();
      offDiagonal[4] = Infinity;
      for (const m of [
        mat4.fromScaling(mat4.create(), [Infinity, 1, 1]),
        mat4.fromScaling(mat4.create(), [NaN, 1, 1]),
        offDiagonal,
        mat4.fromTranslation(mat4.create(), [0, -Infinity, 0]),
      ]) {
        const expected = mat4.invert(mat4.create(), m);
        const out = mat4.create();
        expect(invertAffine(out, m)).toBe(expected !== null);
        if (expected) {
          expect(Array.from(out).map(String)).toEqual(
            Array.from(expected).map(String),
          );
        }
      }
      for (const [a, b] of [
        [bad, t],
        [t, bad],
        [mat4.fromScaling(mat4.create(), [Infinity, 1, 1]), t],
      ]) {
        const out = mat4.create();
        multiplyInto(out, 0, a, b);
        const expected = mat4.multiply(mat4.create(), a, b);
        expect(Array.from(out).map(String)).toEqual(
          Array.from(expected).map(String),
        );
      }
      // in place, for finite input
      const r = mat4.fromRotationTranslation(
        mat4.create(),
        quat.setAxisAngle(quat.create(), [0, 1, 0], 0.7),
        [1, 2, 3],
      );
      const expected = mat4.multiply(mat4.create(), r, t);
      multiplyInto(r, 0, r, t);
      Array.from(r).forEach((v, i) => expect(v).toBeCloseTo(expected[i], 6));
    });

    test('fillPoses writes 16 NaNs for each space it cannot locate', async () => {
      const { device, session, floor } = await startSession();
      const input = device.enableHostInput();
      input.right.mode = XRHostInputMode.Controller;
      input.right.gripValid = false;
      input.right.targetRayValid = true;
      input.right.targetRay.set([0.1, 1, 0, 0, 0, 0, 1]);
      frameWith(device, session, () => null);
      const source = session.inputSources[0];
      const out = new Float32Array(48).fill(7);
      const ok = frameWith(device, session, (frame) =>
        frame.fillPoses!(
          [source.targetRaySpace, source.gripSpace!, device.viewerSpace],
          floor,
          out,
        ),
      );
      expect(ok).toBe(false);
      expect(out[12]).toBeCloseTo(0.1, 5);
      expect(Array.from(out.subarray(16, 32)).every(Number.isNaN)).toBe(true);
      expect(out[32]).toBe(1);
    });

    test('when the plane list fails, a reused frame object drops planes pruned since it was last used', async () => {
      const make = (x: number) =>
        new NativePlane(
          new XRRigidTransform({ x, y: 0, z: -1 }),
          [new DOMPointReadOnly(0, 0, 0), new DOMPointReadOnly(1, 0, 0)],
          XRSemanticLabels.Floor,
        );
      const a = make(0);
      const b = make(1);
      let listed: NativePlane[] = [a, b];
      let fail = false;
      const { device, session } = await startSession(
        {
          getPlanes: () => {
            if (fail) throw new Error('scene service down');
            return listed;
          },
          reportError: () => {},
        },
        ['layers', 'local-floor', 'plane-detection'],
      );
      const read = () =>
        frameWith(device, session, (frame) => ({
          frame,
          xs: [...frame.detectedPlanes]
            .map(
              (p) =>
                frame.getPose(p.planeSpace, device[P_DEVICE].globalSpace)!
                  .transform.matrix[12],
            )
            .sort(),
        }));
      const first = read();
      expect(first.xs).toEqual([0, 1]);
      listed = [a];
      const second = read();
      expect(second.xs).toEqual([0]);
      fail = true;
      const third = read();
      // the frame object alternates, so this one last listed a and b
      expect(third.frame).toBe(first.frame);
      expect(third.xs).toEqual([0]);
    });

    test('edge event lists are frozen, and an unknown trigger still gets its events', () => {
      const list = edgeEventTypes('release', 'select') as string[];
      expect(Object.isFrozen(list)).toBe(true);
      expect(() => list.push('x')).toThrow(TypeError);
      expect(edgeEventTypes('release', 'select')).toEqual([
        'select',
        'selectend',
      ]);
      const untyped = edgeEventTypes as (e: string, t: string) => string[];
      expect(untyped('press', 'grab')).toEqual(['grabstart']);
      expect(untyped('release', 'grab')).toEqual(['grab', 'grabend']);
      expect(untyped('cancel', 'toString')).toEqual(['toStringend']);
      expect(Object.isFrozen(edgeEventTypes(null, 'select'))).toBe(true);
    });

    test('a later session on the same device gets viewer poses with its own views', async () => {
      const first = await startSession();
      const viewer1 = (await first.session.requestReferenceSpace(
        'viewer' as never,
      )) as unknown as XRReferenceSpace;
      const read = (
        device: XRDevice,
        session: XRSession,
        space: XRReferenceSpace,
      ) =>
        frameWith(device, session, (frame) =>
          frame.getViewerPose(space)!.views.map((v) => v),
        );
      const views1 = read(first.device, first.session, viewer1);
      read(first.device, first.session, viewer1);
      await first.session.end();
      const session2 = (await navigator.xr!.requestSession('immersive-vr', {
        optionalFeatures: ['local-floor', 'layers'],
      })) as unknown as XRSession;
      const binding = new XRHostWebGLBinding(session2, gl);
      session2.updateRenderState({ layers: [binding.createProjectionLayer()] });
      const viewer2 = (await session2.requestReferenceSpace(
        'viewer' as never,
      )) as unknown as XRReferenceSpace;
      expect(viewer2).toBe(viewer1);
      for (let i = 0; i < 4; i++) {
        const views2 = read(first.device, session2, viewer2);
        for (const view of views2) {
          expect(views1).not.toContain(view);
          expect(
            (view as unknown as { [P_VIEW]: { session: unknown } })[P_VIEW]
              .session,
          ).toBe(session2);
        }
      }
    });
  });

  test('every space keeps one internal record shape, with the host cache slot', () => {
    const device = new XRDevice(config, { host: makeBackend() });
    const spaces = [
      device[P_DEVICE].globalSpace,
      device.viewerSpace,
      device.viewSpaces.left,
    ];
    for (const space of spaces) {
      expect(Object.keys(space[P_SPACE])).toEqual([
        'parentSpace',
        'offsetMatrix',
        'emulated',
        'tracked',
        'hostPose',
      ]);
    }
  });
});
