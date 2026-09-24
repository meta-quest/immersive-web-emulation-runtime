/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRDevice, XRDeviceConfig } from '../../src/device/XRDevice.js';
import { GamepadMappingType } from '../../src/gamepad/Gamepad.js';
import {
  XREnvironmentBlendMode,
  XRInteractionMode,
} from '../../src/session/XRSession.js';
import { Vector3, Quaternion } from '../../src/utils/Math.js';
import {
  metaQuest2,
  metaQuest3,
  metaQuestPro,
  oculusQuest1,
} from '../../src/device/configs/headset/meta.js';
import { P_DEVICE, P_SPACE } from '../../src/private.js';
import { XRSpaceUtils } from '../../src/spaces/XRSpace.js';
import { mat4 } from 'gl-matrix';

describe('XRDevice', () => {
  let mockDeviceConfig: XRDeviceConfig;

  beforeEach(() => {
    mockDeviceConfig = {
      name: 'Test Device',
      controllerConfig: {
        profileId: 'test-controller',
        fallbackProfileIds: [],
        layout: {
          left: {
            gamepad: {
              mapping: GamepadMappingType.XRStandard,
              buttons: [
                { id: 'trigger', type: 'analog', eventTrigger: 'select' },
              ],
              axes: [
                { id: 'thumbstick', type: 'x-axis' },
                { id: 'thumbstick', type: 'y-axis' },
              ],
            },
            numHapticActuators: 1,
          },
          right: {
            gamepad: {
              mapping: GamepadMappingType.XRStandard,
              buttons: [
                { id: 'trigger', type: 'analog', eventTrigger: 'select' },
              ],
              axes: [
                { id: 'thumbstick', type: 'x-axis' },
                { id: 'thumbstick', type: 'y-axis' },
              ],
            },
            numHapticActuators: 1,
          },
        },
      },
      supportedSessionModes: ['immersive-vr', 'inline'],
      supportedFeatures: ['local', 'hand-tracking'],
      supportedFrameRates: [60, 72, 90],
      isSystemKeyboardSupported: true,
      internalNominalFrameRate: 60,
      environmentBlendModes: {
        'immersive-vr': XREnvironmentBlendMode.Opaque,
      },
      interactionMode: XRInteractionMode.WorldSpace,
      userAgent: 'Test User Agent',
    };
  });

  test('should create XRDevice with default options', () => {
    const device = new XRDevice(mockDeviceConfig);

    expect(device.name).toBe('Test Device');
    expect(device.supportedSessionModes).toEqual(['immersive-vr', 'inline']);
    expect(device.supportedFeatures).toEqual(['local', 'hand-tracking']);
    expect(device.supportedFrameRates).toEqual([60, 72, 90]);
    expect(device.isSystemKeyboardSupported).toBe(true);
    expect(device.internalNominalFrameRate).toBe(60);
    expect(device.stereoEnabled).toBe(false);
    expect(device.ipd).toBe(0.063);
    expect(device.fovy).toBe(Math.PI / 2);
    expect(device.primaryInputMode).toBe('controller');
    expect(device.visibilityState).toBe('visible');
  });

  test('should create XRDevice with custom options', () => {
    const customPosition = new Vector3(1, 2, 3);
    const customQuaternion = new Quaternion(0.5, 0.5, 0.5, 0.5);
    const canvasContainer = document.createElement('div');

    const device = new XRDevice(mockDeviceConfig, {
      ipd: 0.07,
      fovy: Math.PI / 3,
      stereoEnabled: true,
      headsetPosition: customPosition,
      headsetQuaternion: customQuaternion,
      canvasContainer,
    });

    expect(device.ipd).toBe(0.07);
    expect(device.fovy).toBe(Math.PI / 3);
    expect(device.stereoEnabled).toBe(true);
    expect(device.position).toBe(customPosition);
    expect(device.quaternion).toBe(customQuaternion);
    expect(device.canvasContainer).toBe(canvasContainer);
  });

  test('should handle primary input mode changes', () => {
    const device = new XRDevice(mockDeviceConfig);

    device.primaryInputMode = 'hand';
    expect(device.primaryInputMode).toBe('hand');

    device.primaryInputMode = 'controller';
    expect(device.primaryInputMode).toBe('controller');

    // Should warn and not change for invalid mode
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
    device.primaryInputMode = 'invalid' as any;
    expect(device.primaryInputMode).toBe('controller');
    expect(consoleSpy).toHaveBeenCalledWith(
      'primary input mode can only be "controller" or "hand"',
    );
    consoleSpy.mockRestore();
  });

  test('should handle property getters and setters', () => {
    const device = new XRDevice(mockDeviceConfig);

    device.stereoEnabled = true;
    expect(device.stereoEnabled).toBe(true);

    device.ipd = 0.08;
    expect(device.ipd).toBe(0.08);

    device.fovy = Math.PI / 4;
    expect(device.fovy).toBe(Math.PI / 4);
  });

  test('should get controllers and hands', () => {
    const device = new XRDevice(mockDeviceConfig);

    expect(device.controllers).toBeDefined();
    expect(device.hands).toBeDefined();
    expect(device.controllers.left).toBeDefined();
    expect(device.controllers.right).toBeDefined();
    expect(device.hands.left).toBeDefined();
    expect(device.hands.right).toBeDefined();
    expect(device.gaze).toBeUndefined();
  });

  test('creates one additive gaze input for gaze-capable profiles', () => {
    const device = new XRDevice({
      ...mockDeviceConfig,
      supportedFeatures: ['local', 'eye-tracking'],
    });
    const gaze = device.gaze;

    expect(gaze).toBeDefined();
    expect(device.activeInputs).toContain(gaze);

    device.primaryInputMode = 'hand';
    expect(device.activeInputs).toContain(gaze);
    expect(device.gaze).toBe(gaze);
  });

  test('advertises gaze only on the built-in Quest Pro profile', () => {
    expect(metaQuestPro.supportedFeatures).toEqual(
      expect.arrayContaining(['gaze-tracking', 'eye-tracking']),
    );
    for (const config of [oculusQuest1, metaQuest2, metaQuest3]) {
      expect(config.supportedFeatures).not.toContain('gaze-tracking');
      expect(config.supportedFeatures).not.toContain('eye-tracking');
    }
  });

  test('recenters viewer-relative gaze without transforming it twice', () => {
    const device = new XRDevice({
      ...mockDeviceConfig,
      supportedFeatures: ['local', 'gaze-tracking'],
    });
    const gaze = device.gaze!;
    gaze.quaternion.set(0.1, -0.2, 0.05, 0.97).normalize();
    const localOrientation = Array.from(gaze.quaternion.quat);

    device.position.set(2, 1.6, -3);
    device.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), 0.7);
    device.recenter();
    device[P_DEVICE].updateViews();
    gaze.updateTargetRaySpace();

    expect(Array.from(gaze.quaternion.quat)).toEqual(localOrientation);
    expect(Array.from(gaze.position.vec3)).toEqual([0, 0, 0]);

    const actual = XRSpaceUtils.calculateGlobalOffsetMatrix(
      gaze.inputSource.targetRaySpace,
    );
    const expected = mat4.multiply(
      mat4.create(),
      XRSpaceUtils.calculateGlobalOffsetMatrix(device.viewerSpace),
      gaze.inputSource.targetRaySpace[P_SPACE].offsetMatrix,
    );
    Array.from(expected).forEach((value, index) => {
      expect(actual[index]).toBeCloseTo(value, 5);
    });
  });

  test('should handle device without controller config', () => {
    const configWithoutController = {
      ...mockDeviceConfig,
      controllerConfig: undefined,
    };

    const device = new XRDevice(configWithoutController);

    expect(Object.keys(device.controllers)).toHaveLength(0);
    expect(device.hands.left).toBeDefined();
    expect(device.hands.right).toBeDefined();
  });

  test('should handle visibility state updates', () => {
    const device = new XRDevice(mockDeviceConfig);

    device.updateVisibilityState('hidden');
    // This should be pending until frames are produced
    expect(device.visibilityState).toBe('visible'); // unchanged until frame processing

    // Should throw for invalid visibility state
    expect(() => {
      device.updateVisibilityState('invalid' as any);
    }).toThrow('Invalid XRVisibilityState value');
  });

  test('should get canvas dimensions when canvas data exists', () => {
    const device = new XRDevice(mockDeviceConfig);

    // Initially no canvas data
    expect(device.canvasDimensions).toBeUndefined();
  });

  test('should get devui and sem when installed', () => {
    const device = new XRDevice(mockDeviceConfig);

    expect(device.devui).toBeUndefined();
    expect(device.sem).toBeUndefined();
  });

  describe('controlMode', () => {
    test('should default to manual', () => {
      const device = new XRDevice(mockDeviceConfig);
      expect(device.controlMode).toBe('manual');
    });

    test('should allow setting to programmatic', () => {
      const device = new XRDevice(mockDeviceConfig);
      device.controlMode = 'programmatic';
      expect(device.controlMode).toBe('programmatic');
    });

    test('should allow setting back to manual', () => {
      const device = new XRDevice(mockDeviceConfig);
      device.controlMode = 'programmatic';
      device.controlMode = 'manual';
      expect(device.controlMode).toBe('manual');
    });

    test('should warn and not change for invalid mode', () => {
      const device = new XRDevice(mockDeviceConfig);
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      device.controlMode = 'invalid' as any;
      expect(device.controlMode).toBe('manual');
      expect(consoleSpy).toHaveBeenCalledWith(
        'control mode can only be "manual" or "programmatic"',
      );
      consoleSpy.mockRestore();
    });

    test('should not notify listeners if mode unchanged', () => {
      const device = new XRDevice(mockDeviceConfig);
      const listener = jest.fn();
      device.onControlModeChange(listener);
      device.controlMode = 'manual'; // Already manual
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('onControlModeChange', () => {
    test('should register listener and invoke on change', () => {
      const device = new XRDevice(mockDeviceConfig);
      const listener = jest.fn();
      device.onControlModeChange(listener);
      device.controlMode = 'programmatic';
      expect(listener).toHaveBeenCalledWith('programmatic');
    });

    test('should return unsubscribe function', () => {
      const device = new XRDevice(mockDeviceConfig);
      const listener = jest.fn();
      const unsubscribe = device.onControlModeChange(listener);
      unsubscribe();
      device.controlMode = 'programmatic';
      expect(listener).not.toHaveBeenCalled();
    });

    test('should support multiple listeners', () => {
      const device = new XRDevice(mockDeviceConfig);
      const listener1 = jest.fn();
      const listener2 = jest.fn();
      device.onControlModeChange(listener1);
      device.onControlModeChange(listener2);
      device.controlMode = 'programmatic';
      expect(listener1).toHaveBeenCalledWith('programmatic');
      expect(listener2).toHaveBeenCalledWith('programmatic');
    });
  });

  describe('onStateChange', () => {
    test('should register listener', () => {
      const device = new XRDevice(mockDeviceConfig);
      const listener = jest.fn();
      device.onStateChange(listener);
      device.notifyStateChange();
      expect(listener).toHaveBeenCalled();
    });

    test('should return unsubscribe function', () => {
      const device = new XRDevice(mockDeviceConfig);
      const listener = jest.fn();
      const unsubscribe = device.onStateChange(listener);
      unsubscribe();
      device.notifyStateChange();
      expect(listener).not.toHaveBeenCalled();
    });

    test('should support multiple listeners', () => {
      const device = new XRDevice(mockDeviceConfig);
      const listener1 = jest.fn();
      const listener2 = jest.fn();
      device.onStateChange(listener1);
      device.onStateChange(listener2);
      device.notifyStateChange();
      expect(listener1).toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();
    });
  });

  describe('notifyStateChange', () => {
    test('should call all registered state change listeners', () => {
      const device = new XRDevice(mockDeviceConfig);
      const listener1 = jest.fn();
      const listener2 = jest.fn();
      device.onStateChange(listener1);
      device.onStateChange(listener2);
      device.notifyStateChange();
      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
    });

    test('should not fail with no listeners', () => {
      const device = new XRDevice(mockDeviceConfig);
      expect(() => device.notifyStateChange()).not.toThrow();
    });
  });
});
