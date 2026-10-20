/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRDevice, XRDeviceConfig } from '../../src/device/XRDevice';
import {
  XREnvironmentBlendMode,
  XRInteractionMode,
  XRSession,
} from '../../src/session/XRSession';
import {
  XRReferenceSpace,
  XRReferenceSpaceType,
} from '../../src/spaces/XRReferenceSpace';
import {
  XRRenderState,
  XRRenderStateInit,
} from '../../src/session/XRRenderState';

import { XRFrame } from '../../src/frameloop/XRFrame';
import { XRInputSourceArray } from '../../src/input/XRInputSource';
import { XRSystem } from '../../src/initialization/XRSystem';
import { XRViewerPose } from '../../src/pose/XRViewerPose';
import { XRWebGLLayer } from '../../src/layers/XRWebGLLayer';
import { mat4 } from 'gl-matrix';
import { metaQuestTouchPlus } from '../../src/device/configs/controller/meta';
import { P_DEVICE, P_FRAME, P_SESSION, P_SPACE } from '../../src/private.js';
import { NativeMesh } from '../../src/meshes/XRMesh';
import { NativePlane, XRPlaneOrientation } from '../../src/planes/XRPlane';
import { XRRigidTransform } from '../../src/primitives/XRRigidTransform';
import { XRSemanticLabels } from '../../src/labels/labels';

// silence console logs
console.log = () => {};

describe('XRSession', () => {
  let xrDevice: XRDevice;
  let xrSystem: XRSystem;
  let xrSession: XRSession;
  let xrRenderStateInit: XRRenderStateInit;
  let refSpace: XRReferenceSpace;

  beforeEach(async () => {
    jest.useFakeTimers();
    // Mocking the WebGL2RenderingContext
    const mockGetParameter = jest.fn((param) => {
      switch (param) {
        case 0:
          return [0, 0, 0, 0]; // Dummy clear color value
        case 1:
          return 1; // Dummy clear depth value
        case 2:
          return 0; // Dummy clear stencil value
        default:
          return null;
      }
    });
    const MockWebGL2RenderingContext = {
      getParameter: mockGetParameter,
      clearColor: jest.fn(),
      clearDepth: jest.fn(),
      clearStencil: jest.fn(),
      clear: jest.fn(),
      COLOR_CLEAR_VALUE: 0,
      DEPTH_CLEAR_VALUE: 1,
      STENCIL_CLEAR_VALUE: 2,
      DEPTH_BUFFER_BIT: 3,
      COLOR_BUFFER_BIT: 4,
      STENCIL_BUFFER_BIT: 5,
      canvas: document.createElement('canvas'),
    };
    const testDeviceConfig: XRDeviceConfig = {
      name: 'Test Device',
      controllerConfig: metaQuestTouchPlus,
      supportedSessionModes: ['inline', 'immersive-vr', 'immersive-ar'],
      supportedFeatures: [
        'viewer',
        'local',
        'local-floor',
        'gaze-tracking',
        'eye-tracking',
      ],
      supportedFrameRates: [72, 80, 90, 120],
      isSystemKeyboardSupported: true,
      internalNominalFrameRate: 90,
      environmentBlendModes: {
        'immersive-vr': XREnvironmentBlendMode.Opaque,
        'immersive-ar': XREnvironmentBlendMode.AlphaBlend,
      },
      interactionMode: XRInteractionMode.WorldSpace,
      userAgent: 'Test user agent',
    };
    xrDevice = new XRDevice(testDeviceConfig);
    xrSystem = new XRSystem(xrDevice);
    xrSession = await xrSystem.requestSession('immersive-vr');
    xrRenderStateInit = {};
    xrRenderStateInit.baseLayer = new XRWebGLLayer(
      xrSession,
      MockWebGL2RenderingContext as any,
    );
    xrSession.updateRenderState(xrRenderStateInit);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('XRFrame is correctly fired', () => {
    let frameFired = false;
    const onFrame = (_time: number, _frame: XRFrame) => {
      frameFired = true;
      xrSession.end();
    };
    xrSession.requestAnimationFrame(onFrame);
    jest.runAllTimers();
    expect(frameFired).toBe(true);
  });

  test('XRViewerPose always return identity matrix with viewer reference space', async () => {
    refSpace = await xrSession.requestReferenceSpace(
      XRReferenceSpaceType.Viewer,
    );
    let pose: XRViewerPose | undefined = undefined;
    const onFrame = (_time: number, frame: XRFrame) => {
      pose = frame.getViewerPose(refSpace);
      xrSession.end();
    };
    xrSession.requestAnimationFrame(onFrame);
    jest.runAllTimers();
    expect(pose).toBeDefined();
    expect(pose!.transform.matrix).toEqual(mat4.create());
  });

  test('XRView.projectionMatrix keeps a [-1, 1] depth range for WebGL sessions', async () => {
    refSpace = await xrSession.requestReferenceSpace(
      XRReferenceSpaceType.Viewer,
    );
    let projectionMatrix: Float32Array | undefined;
    const onFrame = (_time: number, frame: XRFrame) => {
      projectionMatrix =
        frame.getViewerPose(refSpace)!.views[0].projectionMatrix;
      xrSession.end();
    };
    xrSession.requestAnimationFrame(onFrame);
    jest.runAllTimers();
    const { depthNear: near, depthFar: far } = xrSession.renderState;
    expect(projectionMatrix![14]).toBeCloseTo(
      (2 * far * near) / (near - far),
      5,
    );
  });

  test('XRSession.renderState and XRSession.inputSources return the same object next frame', async () => {
    let frame1RenderState: XRRenderState | undefined = undefined;
    let frame2RenderState: XRRenderState | undefined = undefined;
    let frame1InputSources: XRInputSourceArray | undefined = undefined;
    let frame2InputSources: XRInputSourceArray | undefined = undefined;
    let frameId = 0;
    const onFrame = (_time: number, _frame: XRFrame) => {
      frameId++;
      if (frameId === 1) {
        frame1RenderState = xrSession.renderState;
        frame1InputSources = xrSession.inputSources;
        xrSession.requestAnimationFrame(onFrame);
      } else if (frameId === 2) {
        frame2RenderState = xrSession.renderState;
        frame2InputSources = xrSession.inputSources;
        xrSession.requestAnimationFrame(onFrame);
      } else {
        xrSession.end();
      }
    };
    xrSession.requestAnimationFrame(onFrame);
    jest.runAllTimers();
    expect(frame1InputSources).toBeDefined();
    expect(frame1RenderState).toBeDefined();
    expect(frame1InputSources).toBe(frame2InputSources);
    expect(frame1RenderState).toBe(frame2RenderState);
  });

  test('does not expose gaze unless the session requested a gaze alias', () => {
    xrSession[P_SESSION].updateActiveInputSources();

    expect(
      xrSession.inputSources.some((source) => source.targetRayMode === 'gaze'),
    ).toBe(false);
  });

  test('exposes exactly one stable gaze source for either or both aliases', async () => {
    await xrSession.end();
    xrSession = await xrSystem.requestSession('immersive-vr', {
      requiredFeatures: ['gaze-tracking'],
      optionalFeatures: ['eye-tracking'],
    });
    xrSession[P_SESSION].updateActiveInputSources();

    const gazeSources = xrSession.inputSources.filter(
      (source) => source.targetRayMode === 'gaze',
    );
    expect(gazeSources).toHaveLength(1);
    expect(gazeSources[0]).toMatchObject({
      handedness: 'none',
      targetRayMode: 'gaze',
      profiles: ['eye-gaze'],
      gamepad: undefined,
      gripSpace: undefined,
      hand: undefined,
    });

    const source = gazeSources[0];
    const changes: Event[] = [];
    xrSession.addEventListener('inputsourceschange', (event) => {
      changes.push(event);
    });

    xrDevice.gaze!.connected = false;
    xrSession[P_SESSION].updateActiveInputSources();
    expect(xrSession.inputSources).not.toContain(source);

    xrDevice.gaze!.connected = true;
    xrSession[P_SESSION].updateActiveInputSources();
    expect(xrSession.inputSources).toContain(source);
    expect(changes).toHaveLength(2);
  });

  test('removes gaze while hidden and restores the same connected source', async () => {
    await xrSession.end();
    xrSession = await xrSystem.requestSession('immersive-vr', {
      requiredFeatures: ['eye-tracking'],
    });
    xrSession[P_SESSION].updateActiveInputSources();
    const gazeSource = xrDevice.gaze!.inputSource;
    expect(xrSession.inputSources).toContain(gazeSource);

    xrDevice[P_DEVICE].visibilityState = 'hidden';
    xrSession[P_SESSION].updateActiveInputSources();
    expect(xrSession.inputSources).not.toContain(gazeSource);

    xrDevice[P_DEVICE].visibilityState = 'visible';
    xrSession[P_SESSION].updateActiveInputSources();
    expect(xrSession.inputSources).toContain(gazeSource);
  });

  test('XRFrame.predictedDisplayTime return a greater value next frame', async () => {
    let frame1Time: DOMHighResTimeStamp | undefined = undefined;
    let frame2Time: DOMHighResTimeStamp | undefined = undefined;
    let frameId = 0;
    const onFrame = (_time: number, frame: XRFrame) => {
      frameId++;
      if (frameId === 1) {
        frame1Time = frame.predictedDisplayTime;
        xrSession.requestAnimationFrame(onFrame);
      } else if (frameId === 2) {
        frame2Time = frame.predictedDisplayTime;
        xrSession.requestAnimationFrame(onFrame);
      } else {
        xrSession.end();
      }
    };
    xrSession.requestAnimationFrame(onFrame);
    jest.runAllTimers();
    expect(frame2Time).toBeGreaterThan(frame1Time!);
  });

  test('Inline XRSession.requestReferenceSpace should reject except for viewer', async () => {
    xrSession.end();
    const inlineSession = await xrSystem.requestSession('inline');
    expect(
      await inlineSession.requestReferenceSpace(XRReferenceSpaceType.Viewer),
    ).toBeDefined();
    await expect(
      inlineSession.requestReferenceSpace(XRReferenceSpaceType.Local),
    ).rejects.toThrow();
    await expect(
      inlineSession.requestReferenceSpace(XRReferenceSpaceType.LocalFloor),
    ).rejects.toThrow();
    await expect(
      inlineSession.requestReferenceSpace(XRReferenceSpaceType.BoundedFloor),
    ).rejects.toThrow();
    await expect(
      inlineSession.requestReferenceSpace(XRReferenceSpaceType.Unbounded),
    ).rejects.toThrow();
  });

  test('Inline XRSession.requestReferenceSpace should reject except for viewer', async () => {
    xrSession.end();
    const inlineSession = await xrSystem.requestSession('inline');
    expect(
      await inlineSession.requestReferenceSpace(XRReferenceSpaceType.Viewer),
    ).toBeDefined();
    await expect(
      inlineSession.requestReferenceSpace(XRReferenceSpaceType.Local),
    ).rejects.toThrow();
    await expect(
      inlineSession.requestReferenceSpace(XRReferenceSpaceType.LocalFloor),
    ).rejects.toThrow();
    await expect(
      inlineSession.requestReferenceSpace(XRReferenceSpaceType.BoundedFloor),
    ).rejects.toThrow();
    await expect(
      inlineSession.requestReferenceSpace(XRReferenceSpaceType.Unbounded),
    ).rejects.toThrow();
  });

  test('XRSession.requestReferenceSpace should return/reject according to session state', async () => {
    expect(
      await xrSession.requestReferenceSpace(XRReferenceSpaceType.Viewer),
    ).toBeDefined();
    expect(
      await xrSession.requestReferenceSpace(XRReferenceSpaceType.Local),
    ).toBeDefined();
    await expect(
      xrSession.requestReferenceSpace(XRReferenceSpaceType.BoundedFloor),
    ).rejects.toThrow();
    await expect(
      xrSession.requestReferenceSpace(XRReferenceSpaceType.Unbounded),
    ).rejects.toThrow();

    // should reject local-floor without requesting it
    await expect(
      xrSession.requestReferenceSpace(XRReferenceSpaceType.LocalFloor),
    ).rejects.toThrow();
    xrSession.end();
    // should return if local-floor is requested
    xrSession = await xrSystem.requestSession('immersive-vr', {
      requiredFeatures: ['local-floor'],
    });
    expect(
      await xrSession.requestReferenceSpace(XRReferenceSpaceType.LocalFloor),
    ).toBeDefined();
  });

  test('XRSession.end will fire the end XRSessionEvent', () => {
    const mockCallback = jest.fn();
    xrSession.addEventListener('end', mockCallback);
    xrSession.end();
    expect(mockCallback).toHaveBeenCalled();
  });

  test('XRSession.updateTargetFrameRate will fire the frameratechange XRSessionEvent', async () => {
    const mockCallback = jest.fn().mockImplementation(() => {
      expect(xrSession.frameRate).toBe(72);
    });
    xrSession.addEventListener('frameratechange', mockCallback);
    await xrSession.updateTargetFrameRate(72);
    expect(mockCallback).toHaveBeenCalled();
  });

  test('Visibility change on XRSession will fire the visibilitychange XRSessionEvent', async () => {
    const mockCallback = jest.fn().mockImplementation(() => {
      expect(xrSession.visibilityState).toBe('visible-blurred');
    });
    xrSession.addEventListener('visibilitychange', mockCallback);
    xrDevice.updateVisibilityState('visible-blurred');
    const onFrame = (_time: number, _frame: XRFrame) => {
      xrSession.end();
    };
    xrSession.requestAnimationFrame(onFrame);
    jest.runAllTimers();
    expect(mockCallback).toHaveBeenCalled();
  });

  test('XRInputSources change on XRSession will fire the inputsourceschange XRSessionEvent', async () => {
    const mockCallback = jest.fn();
    xrSession.addEventListener('inputsourceschange', mockCallback);
    xrDevice.controllers.left!.connected = false;
    const onFrame = (_time: number, _frame: XRFrame) => {
      xrSession.end();
    };
    xrSession.requestAnimationFrame(onFrame);
    jest.runAllTimers();
    expect(mockCallback).toHaveBeenCalled();
  });

  test('Select, selectstart, selectend events are correctly fired', async () => {
    const mockOnSelect = jest.fn();
    const mockOnSelectStart = jest.fn();
    const mockOnSelectEnd = jest.fn();
    xrSession.addEventListener('select', mockOnSelect);
    xrSession.addEventListener('selectstart', mockOnSelectStart);
    xrSession.addEventListener('selectend', mockOnSelectEnd);
    let frameId = 0;
    const onFrame = (_time: number, _frame: XRFrame) => {
      frameId++;
      if (frameId == 5) {
        // press down trigger on frame #5
        xrDevice.controllers.right!.updateButtonValue('trigger', 1);
      } else if (frameId == 10) {
        // let go of trigger on frame #10
        xrDevice.controllers.right!.updateButtonValue('trigger', 0);
      } else if (frameId == 15) {
        xrSession.end();
        return;
      }
      xrSession.requestAnimationFrame(onFrame);
    };
    xrSession.requestAnimationFrame(onFrame);
    jest.runAllTimers();
    expect(mockOnSelect).toHaveBeenCalled();
    expect(mockOnSelectStart).toHaveBeenCalled();
    expect(mockOnSelectEnd).toHaveBeenCalled();
  });

  test('Squeeze, squeezestart, squeezeend events are correctly fired', async () => {
    const mockOnSqueeze = jest.fn();
    const mockOnSqueezeStart = jest.fn();
    const mockOnSqueezeEnd = jest.fn();
    xrSession.addEventListener('squeeze', mockOnSqueeze);
    xrSession.addEventListener('squeezestart', mockOnSqueezeStart);
    xrSession.addEventListener('squeezeend', mockOnSqueezeEnd);
    let frameId = 0;
    const onFrame = (_time: number, _frame: XRFrame) => {
      frameId++;
      if (frameId == 5) {
        // press down trigger on frame #5
        xrDevice.controllers.right!.updateButtonValue('squeeze', 1);
      } else if (frameId == 10) {
        // let go of trigger on frame #10
        xrDevice.controllers.right!.updateButtonValue('squeeze', 0);
      } else if (frameId == 15) {
        xrSession.end();
        return;
      }
      xrSession.requestAnimationFrame(onFrame);
    };
    xrSession.requestAnimationFrame(onFrame);
    jest.runAllTimers();
    expect(mockOnSqueeze).toHaveBeenCalled();
    expect(mockOnSqueezeStart).toHaveBeenCalled();
    expect(mockOnSqueezeEnd).toHaveBeenCalled();
  });

  test('XRSession.environmentBlendMode returns the correct value', async () => {
    expect(xrSession.environmentBlendMode).toBe(XREnvironmentBlendMode.Opaque);
    xrSession.end();
    xrSession = await xrSystem.requestSession('immersive-ar');
    expect(xrSession.environmentBlendMode).toBe(
      XREnvironmentBlendMode.AlphaBlend,
    );
  });

  test('moving planes and meshes update their space but not lastChangedTime', () => {
    const at = (x: number) =>
      new XRRigidTransform({ x, y: 0, z: 0, w: 1 }, { x: 0, y: 0, z: 0, w: 1 });
    const plane = new NativePlane(
      at(0),
      [new DOMPointReadOnly(0, 0, 0), new DOMPointReadOnly(1, 0, 0)],
      XRSemanticLabels.Table,
    );
    const mesh = new NativeMesh(
      at(0),
      new Float32Array(9),
      new Uint32Array([0, 1, 2]),
      XRSemanticLabels.Other,
    );
    // A minimal SEM: the session only reads the tracked sets here.
    xrDevice[P_DEVICE].sem = {
      trackedPlanes: new Set([plane]),
      trackedMeshes: new Set([mesh]),
    } as any;
    const frame = (time: number) =>
      ({
        predictedDisplayTime: time,
        [P_FRAME]: { detectedPlanes: new Set(), detectedMeshes: new Set() },
      }) as unknown as XRFrame;
    const update = (time: number) => {
      xrSession[P_SESSION].updateTrackedPlanes(frame(time));
      xrSession[P_SESSION].updateTrackedMeshes(frame(time));
    };

    update(1);
    const xrPlane = xrSession[P_SESSION].trackedPlanes.get(plane)!;
    const xrMesh = xrSession[P_SESSION].trackedMeshes.get(mesh)!;
    // Set from the frame that first reports them.
    expect(xrPlane.lastChangedTime).toBe(1);
    expect(xrMesh.lastChangedTime).toBe(1);
    const planeChanged = xrPlane.lastChangedTime;
    const meshChanged = xrMesh.lastChangedTime;

    plane.transform = at(2);
    mesh.transform = at(3);
    update(2);

    expect(xrSession[P_SESSION].trackedPlanes.get(plane)).toBe(xrPlane);
    expect(xrSession[P_SESSION].trackedMeshes.get(mesh)).toBe(xrMesh);
    expect(xrPlane.planeSpace[P_SPACE].offsetMatrix[12]).toBe(2);
    expect(xrMesh.meshSpace[P_SPACE].offsetMatrix[12]).toBe(3);
    expect(xrPlane.lastChangedTime).toBe(planeChanged);
    expect(xrMesh.lastChangedTime).toBe(meshChanged);
  });

  test('a plane that turns updates its orientation and lastChangedTime', () => {
    const turned = (x: number) =>
      new XRRigidTransform(
        { x: 0, y: 0, z: 0, w: 1 },
        { x, y: 0, z: 0, w: Math.sqrt(1 - x * x) },
      );
    const plane = new NativePlane(
      turned(0),
      [new DOMPointReadOnly(0, 0, 0), new DOMPointReadOnly(1, 0, 0)],
      XRSemanticLabels.Table,
    );
    xrDevice[P_DEVICE].sem = {
      trackedPlanes: new Set([plane]),
      trackedMeshes: new Set(),
    } as any;
    const update = (time: number) =>
      xrSession[P_SESSION].updateTrackedPlanes({
        predictedDisplayTime: time,
        [P_FRAME]: { detectedPlanes: new Set(), detectedMeshes: new Set() },
      } as unknown as XRFrame);

    update(1);
    const xrPlane = xrSession[P_SESSION].trackedPlanes.get(plane)!;
    expect(xrPlane.orientation).toBe(XRPlaneOrientation.Horizontal);

    // Tilted 30 degrees: still horizontal, so unchanged.
    plane.transform = turned(Math.sin(Math.PI / 12));
    update(2);
    expect(xrPlane.orientation).toBe(XRPlaneOrientation.Horizontal);
    expect(xrPlane.lastChangedTime).toBe(1);

    // Tipped onto its side: vertical.
    plane.transform = turned(Math.SQRT1_2);
    update(3);
    expect(xrPlane.orientation).toBe(XRPlaneOrientation.Vertical);
    expect(xrPlane.lastChangedTime).toBe(3);
  });

  test('XRSession.interactionMode returns the correct value', async () => {
    expect(xrSession.interactionMode).toBe(XRInteractionMode.WorldSpace);
  });
});
