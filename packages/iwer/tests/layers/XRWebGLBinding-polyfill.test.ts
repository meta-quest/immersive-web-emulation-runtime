/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRDevice } from '../../src/device/XRDevice.js';
import { metaQuest3 } from '../../src/device/configs/headset/meta.js';
import {
  XRWebGLBinding,
  XRWebGLDepthInformation,
} from '../../src/depth/XRWebGLBinding.js';
import { XRFrame } from '../../src/frameloop/XRFrame.js';
import { P_DEVICE, P_FRAME, P_SESSION } from '../../src/private.js';
import { XRRigidTransform } from '../../src/primitives/XRRigidTransform.js';
import { XRSession } from '../../src/session/XRSession.js';
import { XREye, XRView } from '../../src/views/XRView.js';

// The real layers polyfill permanently patches XRSession.prototype, so keep
// these tests separate from tests that install the runtime without it.
const g = globalThis as Record<string, unknown>;
type PolyfilledBinding = Pick<
  globalThis.XRWebGLBinding,
  'createProjectionLayer'
> &
  Pick<XRWebGLBinding, 'getDepthInformation'>;

describe('XRWebGLBinding with the layers polyfill', () => {
  const device = new XRDevice(metaQuest3);
  let session: XRSession;
  let frame: XRFrame;
  let binding: PolyfilledBinding;
  let view: XRView;

  beforeAll(() => {
    g.WebGLRenderingContext = class WebGLRenderingContext {};
    g.WebGL2RenderingContext = class WebGL2RenderingContext {};
    jest.spyOn(console, 'log').mockImplementation(() => {});
    device.installRuntime({ forceInstall: true, polyfillLayers: true });
  });

  beforeEach(async () => {
    jest.useFakeTimers();
    session = await device[P_DEVICE].xrSystem!.requestSession('immersive-vr', {
      requiredFeatures: ['depth-sensing'],
      depthSensing: {
        usagePreference: ['gpu-optimized'],
        dataFormatPreference: ['float32'],
      },
    });
    const context = Object.assign(new WebGL2RenderingContext(), {
      drawingBufferWidth: 800,
      drawingBufferHeight: 600,
      isContextLost: () => false,
      createFramebuffer: () => ({}),
      getParameter: () => 4096,
    });
    const Binding = g.XRWebGLBinding as new (
      session: XRSession,
      context: WebGL2RenderingContext,
    ) => PolyfilledBinding;
    binding = new Binding(session, context);
    frame = new XRFrame(session, 1, true, true, 0);
    session[P_SESSION].activeFrame = frame;
    view = new XRView(
      XREye.Left,
      new Float32Array(16),
      new XRRigidTransform(),
      session,
    );
  });

  afterEach(async () => {
    await session.end();
    jest.useRealTimers();
  });

  afterAll(() => {
    device.uninstallRuntime();
    jest.restoreAllMocks();
  });

  test('installs the layer API alongside GPU depth sensing', () => {
    for (const method of [
      'createProjectionLayer',
      'createQuadLayer',
      'createCylinderLayer',
      'createEquirectLayer',
      'createCubeLayer',
      'getSubImage',
      'getViewSubImage',
      'getDepthInformation',
    ]) {
      expect(binding).toHaveProperty(method, expect.any(Function));
    }
    expect(g.XRMediaBinding).toEqual(expect.any(Function));
  });

  test('creates a projection layer and returns the current eye depth data', () => {
    expect(binding.createProjectionLayer()).toMatchObject({
      textureWidth: 800,
      textureHeight: 600,
    });
    const depth = new XRWebGLDepthInformation(
      {},
      8,
      8,
      new XRRigidTransform(),
      1,
      0.1,
      100,
      'texture-array',
      0,
    );
    frame[P_FRAME].gpuDepthDataMap.set(XREye.Left, depth);

    expect(binding.getDepthInformation(view)).toBe(depth);
    const rightView = new XRView(
      XREye.Right,
      new Float32Array(16),
      new XRRigidTransform(),
      session,
    );
    expect(binding.getDepthInformation(rightView)).toBeNull();
  });

  test('keeps depth frame, feature and usage validation after creating a layer', () => {
    binding.createProjectionLayer();
    session[P_SESSION].activeFrame = null;
    expect(() => binding.getDepthInformation(view)).toThrow(
      new DOMException(
        'XRFrame access outside the callback that produced it is invalid.',
        'InvalidStateError',
      ),
    );
    session[P_SESSION].activeFrame = frame;
    frame[P_FRAME].active = false;
    expect(() => binding.getDepthInformation(view)).toThrow(
      'XRFrame access outside the callback',
    );
    frame[P_FRAME].active = true;
    session[P_SESSION].enabledFeatures = [];
    expect(() => binding.getDepthInformation(view)).toThrow(
      'depth-sensing feature is not enabled',
    );
    session[P_SESSION].enabledFeatures = ['depth-sensing'];
    session[P_SESSION].depthSensingUsage = 'cpu-optimized';
    expect(() => binding.getDepthInformation(view)).toThrow(
      'requires gpu-optimized depth sensing usage',
    );
  });
});
