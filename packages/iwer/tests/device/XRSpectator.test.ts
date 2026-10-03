/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  XRReferenceSpace,
  XRReferenceSpaceType,
} from '../../src/spaces/XRReferenceSpace.js';
import { XRSession } from '../../src/session/XRSession.js';
import { Quaternion, Vector3 } from '../../src/utils/Math.js';
import { XRDevice } from '../../src/device/XRDevice.js';
import { XRFrame } from '../../src/frameloop/XRFrame.js';
import { XRSystem } from '../../src/initialization/XRSystem.js';
import { XRView } from '../../src/views/XRView.js';
import { XRWebGLLayer } from '../../src/layers/XRWebGLLayer.js';
import { metaQuest3 } from '../../src/device/configs/headset/meta.js';

console.log = () => {};

const createContext = () => ({
  getParameter: jest.fn(() => [0, 0, 0, 0]),
  clearColor: jest.fn(),
  clearDepth: jest.fn(),
  clearStencil: jest.fn(),
  clear: jest.fn(),
  canvas: document.createElement('canvas'),
});

describe('XRSpectator', () => {
  let xrDevice: XRDevice;
  let xrSystem: XRSystem;
  let layer: XRWebGLLayer;

  beforeEach(() => {
    jest.useFakeTimers();
    window.innerWidth = 800;
    window.innerHeight = 600;
    xrDevice = new XRDevice(metaQuest3);
    xrSystem = new XRSystem(xrDevice);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const startSession = async (
    mode: 'immersive-vr' | 'immersive-ar' = 'immersive-vr',
  ) => {
    const session = await xrSystem.requestSession(mode);
    layer = new XRWebGLLayer(session, createContext() as any);
    session.updateRenderState({ baseLayer: layer });
    const refSpace = await session.requestReferenceSpace(
      XRReferenceSpaceType.Local,
    );
    return { session, refSpace };
  };

  const nextViews = (session: XRSession, refSpace: XRReferenceSpace) => {
    let views: XRView[] = [];
    session.requestAnimationFrame((_time: number, frame: XRFrame) => {
      views = frame.getViewerPose(refSpace).views as XRView[];
    });
    jest.advanceTimersToNextTimer();
    return views;
  };

  test('starts behind the headset and placeBehind follows its heading', () => {
    const { position, quaternion } = xrDevice.spectator;
    expect([position.x, position.y, position.z]).toEqual([0, 2, 2]);
    const forward = new Vector3(0, 0, -1).applyQuaternion(quaternion);
    // the headset (0, 1.6, 0) is straight ahead
    expect(forward.x).toBeCloseTo(0);
    expect(forward.y / forward.z).toBeCloseTo(0.4 / 2);

    const yaw = new Quaternion().setFromAxisAngle(
      new Vector3(0, 1, 0),
      Math.PI / 2,
    );
    xrDevice.spectator.placeBehind(new Vector3(1, 1.6, 0), yaw);
    const { x, y, z } = xrDevice.spectator.position;
    // the headset faces -X, so behind it is +X
    expect([x, y, z].map((v) => +v.toFixed(5))).toEqual([3, 2, 0]);
  });

  test('toggles between frames and gives the spectator the whole framebuffer', async () => {
    const { session, refSpace } = await startSession();
    const initialViews = nextViews(session, refSpace);
    expect(initialViews).toHaveLength(2);
    expect(layer.getViewport(initialViews[0])).toMatchObject({
      x: 0,
      width: 800,
    });

    xrDevice.spectator.enabled = true;
    const views = nextViews(session, refSpace);
    expect(views).toHaveLength(3);
    expect(views[2].eye).toBe('none');
    // the eyes get zero-width viewports, like the right eye in mono
    expect(
      views
        .map((view) => layer.getViewport(view))
        .map(({ x, width }) => [x, width]),
    ).toEqual([
      [0, 0],
      [400, 0],
      [0, 800],
    ]);

    xrDevice.spectator.enabled = false;
    expect(nextViews(session, refSpace)).toHaveLength(2);
  });

  test('adds the spectator view in AR', async () => {
    xrDevice.spectator.enabled = true;
    const { session, refSpace } = await startSession('immersive-ar');
    expect(nextViews(session, refSpace)).toHaveLength(3);
  });

  test('inline sessions keep a single view', async () => {
    xrDevice.spectator.enabled = true;
    const session = await xrSystem.requestSession('inline');
    session.updateRenderState({
      baseLayer: new XRWebGLLayer(session, createContext() as any),
    });
    const refSpace = await session.requestReferenceSpace(
      XRReferenceSpaceType.Viewer,
    );
    expect(nextViews(session, refSpace)).toHaveLength(1);
  });

  test('view pose and projection follow the spectator', async () => {
    xrDevice.spectator.enabled = true;
    xrDevice.spectator.position.set(1, 2, 3);
    xrDevice.spectator.quaternion.set(0, 0, 0, 1);
    xrDevice.spectator.fovy = Math.PI / 2;
    const { session, refSpace } = await startSession();
    const view = nextViews(session, refSpace)[2];
    // local space is anchored at the headset's position at session start
    expect(view.transform.position.x).toBeCloseTo(1 - xrDevice.position.x);
    expect(view.transform.position.z).toBeCloseTo(3 - xrDevice.position.z);
    // m[5] = 1 / tan(fovy / 2)
    expect(view.projectionMatrix[5]).toBeCloseTo(1);
  });

  test('recenter keeps the spectator behind the headset, pitched and level', () => {
    xrDevice.position.set(1, 1.6, 1);
    xrDevice.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    xrDevice.spectator.placeBehind(xrDevice.position, xrDevice.quaternion);
    xrDevice.recenter();

    const { position, quaternion } = xrDevice.spectator;
    expect(position.x).toBeCloseTo(0);
    expect(position.z).toBeCloseTo(2);
    const forward = new Vector3(0, 0, -1).applyQuaternion(quaternion);
    const right = new Vector3(1, 0, 0).applyQuaternion(quaternion);
    expect(forward.x).toBeCloseTo(0);
    expect(forward.y / forward.z).toBeCloseTo(0.4 / 2);
    // no roll: the right axis stays horizontal
    expect(right.y).toBeCloseTo(0);
  });
});
