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
  XRSessionMode,
} from '../../src/session/XRSession';

import { XRSystem } from '../../src/initialization/XRSystem';
import { metaQuestTouchPlus } from '../../src/device/configs/controller/meta';
import type { WebXRFeature } from '../../src/device/XRDevice';

describe('XRSystem', () => {
  let xrDevice: XRDevice;
  let xrSystem: XRSystem;
  const arvrDeviceConfig: XRDeviceConfig = {
    name: 'AR VR Device',
    controllerConfig: metaQuestTouchPlus,
    supportedSessionModes: ['inline', 'immersive-vr', 'immersive-ar'],
    supportedFeatures: ['viewer', 'local', 'local-floor', 'hand-tracking'],
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

  const vrOnlyDeviceConfig: XRDeviceConfig = {
    name: 'VR Device',
    controllerConfig: metaQuestTouchPlus,
    supportedSessionModes: ['inline', 'immersive-vr'],
    supportedFeatures: arvrDeviceConfig.supportedFeatures,
    supportedFrameRates: arvrDeviceConfig.supportedFrameRates,
    isSystemKeyboardSupported: true,
    internalNominalFrameRate: 90,
    environmentBlendModes: {
      'immersive-vr': XREnvironmentBlendMode.Opaque,
      'immersive-ar': XREnvironmentBlendMode.AlphaBlend,
    },
    interactionMode: XRInteractionMode.WorldSpace,
    userAgent: 'Test user agent',
  };

  test('isSessionSupported should resolve with correct value for ARVR device', async () => {
    xrDevice = new XRDevice(arvrDeviceConfig);
    xrSystem = new XRSystem(xrDevice);

    const vrSupportPromise = xrSystem.isSessionSupported(
      'immersive-vr' as XRSessionMode,
    );
    await expect(vrSupportPromise).resolves.toBeTruthy();
    const arSupportPromise = xrSystem.isSessionSupported(
      'immersive-ar' as XRSessionMode,
    );
    await expect(arSupportPromise).resolves.toBeTruthy();
  });

  test('isSessionSupported should resolve with correct value for VR-only device', async () => {
    xrDevice = new XRDevice(vrOnlyDeviceConfig);
    xrSystem = new XRSystem(xrDevice);
    const vrSupportPromise = xrSystem.isSessionSupported(
      'immersive-vr' as XRSessionMode,
    );
    await expect(vrSupportPromise).resolves.toBeTruthy();
    const arSupportPromise = xrSystem.isSessionSupported(
      'immersive-ar' as XRSessionMode,
    );
    await expect(arSupportPromise).resolves.toBeFalsy();
  });

  test('requestSession should reject unsupported session mode', async () => {
    xrDevice = new XRDevice(vrOnlyDeviceConfig);
    xrSystem = new XRSystem(xrDevice);
    await expect(
      xrSystem.requestSession('immersive-ar' as XRSessionMode),
    ).rejects.toMatchObject({ name: 'NotSupportedError' });
  });

  test('requestSession should reject when active session is detected', async () => {
    xrDevice = new XRDevice(arvrDeviceConfig);
    xrSystem = new XRSystem(xrDevice);
    const activeSession = await xrSystem.requestSession(
      'immersive-ar' as XRSessionMode,
    );
    expect(activeSession).not.toBeNull();
    await expect(
      xrSystem.requestSession('immersive-ar' as XRSessionMode),
    ).rejects.toMatchObject({ name: 'InvalidStateError' });
  });

  test('requestSession should reject when one or more required features are not supported', async () => {
    xrDevice = new XRDevice(arvrDeviceConfig);
    xrSystem = new XRSystem(xrDevice);
    await expect(
      xrSystem.requestSession('immersive-ar' as XRSessionMode, {
        requiredFeatures: ['anchors'],
      }),
    ).rejects.toThrow();
  });

  test('requestSession should return XRSession with default features', async () => {
    xrDevice = new XRDevice(arvrDeviceConfig);
    xrSystem = new XRSystem(xrDevice);
    const session = await xrSystem.requestSession(
      'immersive-ar' as XRSessionMode,
    );
    expect(session).not.toBeNull();
    expect(session.enabledFeatures).toContain('viewer');
    expect(session.enabledFeatures).toContain('local');
  });

  test('requestSession should return XRSession with correct list of enabled features', async () => {
    xrDevice = new XRDevice(arvrDeviceConfig);
    xrSystem = new XRSystem(xrDevice);
    const session = await xrSystem.requestSession(
      'immersive-ar' as XRSessionMode,
      {
        requiredFeatures: ['hand-tracking'],
        optionalFeatures: ['anchors'],
      },
    );
    expect(session).not.toBeNull();
    expect(session.enabledFeatures).toContain('hand-tracking');
    expect(session.enabledFeatures).not.toContain('anchors');
  });

  test.each<WebXRFeature>(['gaze-tracking', 'eye-tracking'])(
    'requestSession enables the exact requested gaze alias when the profile advertises the other alias: %s',
    async (feature) => {
      xrDevice = new XRDevice({
        ...arvrDeviceConfig,
        supportedFeatures: ['viewer', 'local', 'gaze-tracking'],
      });
      xrSystem = new XRSystem(xrDevice);

      const session = await xrSystem.requestSession('immersive-vr', {
        requiredFeatures: [feature],
      });

      expect(session.enabledFeatures).toContain(feature);
      expect(session.enabledFeatures).not.toContain(
        feature === 'gaze-tracking' ? 'eye-tracking' : 'gaze-tracking',
      );
    },
  );

  test('requestSession preserves both requested gaze aliases without creating separate capabilities', async () => {
    xrDevice = new XRDevice({
      ...arvrDeviceConfig,
      supportedFeatures: ['viewer', 'local', 'eye-tracking'],
    });
    xrSystem = new XRSystem(xrDevice);

    const session = await xrSystem.requestSession('immersive-vr', {
      requiredFeatures: ['gaze-tracking'],
      optionalFeatures: ['eye-tracking'],
    });

    expect(session.enabledFeatures).toEqual(
      expect.arrayContaining(['gaze-tracking', 'eye-tracking']),
    );
  });

  test('requestSession rejects required gaze on a profile without gaze capability', async () => {
    xrDevice = new XRDevice(arvrDeviceConfig);
    xrSystem = new XRSystem(xrDevice);

    await expect(
      xrSystem.requestSession('immersive-vr', {
        requiredFeatures: ['eye-tracking'],
      }),
    ).rejects.toThrow(
      'One or more required features are not supported by the device.',
    );
  });

  test('requestSession omits unsupported optional gaze', async () => {
    xrDevice = new XRDevice(arvrDeviceConfig);
    xrSystem = new XRSystem(xrDevice);

    const session = await xrSystem.requestSession('immersive-vr', {
      optionalFeatures: ['gaze-tracking'],
    });

    expect(session.enabledFeatures).not.toContain('gaze-tracking');
  });
});
