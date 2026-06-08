/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XRDevice, XRDeviceConfig } from '../../src/device/XRDevice.js';
import {
  XREnvironmentBlendMode,
  XRInteractionMode,
} from '../../src/session/XRSession.js';
import { GamepadMappingType } from '../../src/gamepad/Gamepad.js';
import { XRSystem } from '../../src/initialization/XRSystem.js';

// installRuntime references `WebGL2RenderingContext.prototype` (and optionally
// `WebGLRenderingContext.prototype`) directly to patch makeXRCompatible. jsdom
// does not provide these constructors, so we stub them in each test and restore
// the globals afterwards to avoid leaking across tests.
const g = globalThis as Record<string, unknown>;

function makeDeviceConfig(): XRDeviceConfig {
  return {
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
            axes: [],
          },
          numHapticActuators: 1,
        },
        right: {
          gamepad: {
            mapping: GamepadMappingType.XRStandard,
            buttons: [
              { id: 'trigger', type: 'analog', eventTrigger: 'select' },
            ],
            axes: [],
          },
          numHapticActuators: 1,
        },
      },
    },
    supportedSessionModes: ['immersive-vr', 'inline'],
    supportedFeatures: ['local'],
    supportedFrameRates: [60, 72, 90],
    isSystemKeyboardSupported: true,
    internalNominalFrameRate: 60,
    environmentBlendModes: {
      'immersive-vr': XREnvironmentBlendMode.Opaque,
    },
    interactionMode: XRInteractionMode.WorldSpace,
    userAgent: 'Test User Agent',
  };
}

// Globals installRuntime overwrites; snapshotted so afterEach can restore them
// and tests never leak emulated constructors into each other.
const XR_GLOBAL_NAMES = [
  'XRSystem',
  'XRSession',
  'XRRenderState',
  'XRFrame',
  'XRSpace',
  'XRReferenceSpace',
  'XRJointSpace',
  'XRView',
  'XRViewport',
  'XRRigidTransform',
  'XRPose',
  'XRViewerPose',
  'XRJointPose',
  'XRInputSource',
  'XRInputSourceArray',
  'XRHand',
  'XRLayer',
  'XRWebGLLayer',
  'XRSessionEvent',
  'XRInputSourceEvent',
  'XRInputSourcesChangeEvent',
  'XRReferenceSpaceEvent',
  'XRMediaBinding',
  'XRWebGLBinding',
];

describe('XRDevice runtime install/uninstall', () => {
  let webgl2Existed: boolean;
  let webgl1Existed: boolean;
  let navXrDescriptor: PropertyDescriptor | undefined;
  let userAgentDescriptor: PropertyDescriptor | undefined;
  const globalSnapshot = new Map<
    string,
    { existed: boolean; value: unknown }
  >();

  beforeEach(() => {
    // Provide minimal WebGL constructor stubs if jsdom did not supply them so
    // installRuntime can attach makeXRCompatible to their prototypes.
    webgl2Existed = 'WebGL2RenderingContext' in g;
    webgl1Existed = 'WebGLRenderingContext' in g;
    if (!webgl2Existed) {
      g.WebGL2RenderingContext = class WebGL2RenderingContext {};
    }
    if (!webgl1Existed) {
      g.WebGLRenderingContext = class WebGLRenderingContext {};
    }

    // Snapshot the navigator descriptors and the XR globals so afterEach can
    // fully restore them regardless of whether the test called uninstall.
    navXrDescriptor = Object.getOwnPropertyDescriptor(navigator, 'xr');
    userAgentDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      'userAgent',
    );
    globalSnapshot.clear();
    XR_GLOBAL_NAMES.forEach((name) => {
      globalSnapshot.set(name, {
        existed: name in g,
        value: g[name],
      });
    });
  });

  afterEach(() => {
    // Restore navigator.xr to its pre-test state.
    if (Object.getOwnPropertyDescriptor(navigator, 'xr')?.configurable) {
      delete (navigator as { xr?: unknown }).xr;
    }
    if (navXrDescriptor) {
      Object.defineProperty(navigator, 'xr', navXrDescriptor);
    }

    // Restore navigator.userAgent if a test overwrote it.
    if (userAgentDescriptor) {
      Object.defineProperty(navigator, 'userAgent', userAgentDescriptor);
    } else if (
      Object.getOwnPropertyDescriptor(navigator, 'userAgent')?.configurable
    ) {
      delete (navigator as { userAgent?: unknown }).userAgent;
    }

    // Restore overwritten XR global constructors.
    globalSnapshot.forEach(({ existed, value }, name) => {
      if (existed) {
        g[name] = value;
      } else {
        delete g[name];
      }
    });

    // Restore the WebGL constructor stubs.
    if (!webgl2Existed) {
      delete g.WebGL2RenderingContext;
    }
    if (!webgl1Existed) {
      delete g.WebGLRenderingContext;
    }
    jest.restoreAllMocks();
  });

  test('installRuntime defines navigator.xr as an XRSystem', () => {
    const device = new XRDevice(makeDeviceConfig());

    expect(navigator.xr).toBeUndefined();

    device.installRuntime();

    expect(navigator.xr).toBeDefined();
    expect(navigator.xr).toBeInstanceOf(XRSystem);
  });

  test('installRuntime sets the configured userAgent and global constructors', () => {
    const device = new XRDevice(makeDeviceConfig());

    device.installRuntime();

    expect(navigator.userAgent).toBe('Test User Agent');
    expect(g.XRSession).toBeDefined();
    expect(g.XRFrame).toBeDefined();
    expect(g.XRWebGLLayer).toBeDefined();
  });

  test('uninstallRuntime removes navigator.xr when there was no prior runtime', () => {
    const device = new XRDevice(makeDeviceConfig());

    device.installRuntime();
    expect(navigator.xr).toBeInstanceOf(XRSystem);

    device.uninstallRuntime();

    expect('xr' in navigator).toBe(false);
  });

  test('uninstallRuntime restores the overwritten global constructors', () => {
    const device = new XRDevice(makeDeviceConfig());

    const sentinel = function PreExistingXRSession() {};
    g.XRSession = sentinel;

    device.installRuntime();
    expect(g.XRSession).not.toBe(sentinel);

    device.uninstallRuntime();
    expect(g.XRSession).toBe(sentinel);
  });

  test('uninstallRuntime is a no-op when installRuntime was never called', () => {
    const device = new XRDevice(makeDeviceConfig());

    expect(() => device.uninstallRuntime()).not.toThrow();
    expect('xr' in navigator).toBe(false);
  });

  describe('isNativeXRAvailable', () => {
    test('returns false when navigator.xr is absent', () => {
      const device = new XRDevice(makeDeviceConfig());
      expect(device.isNativeXRAvailable()).toBe(false);
    });

    test('returns false when navigator.xr is an emulated XRSystem', () => {
      const device = new XRDevice(makeDeviceConfig());
      device.installRuntime();
      expect(navigator.xr).toBeInstanceOf(XRSystem);
      // An IWER-installed runtime is not considered "native".
      expect(device.isNativeXRAvailable()).toBe(false);
    });

    test('returns true when a non-IWER navigator.xr exists', () => {
      const device = new XRDevice(makeDeviceConfig());
      Object.defineProperty(navigator, 'xr', {
        value: { requestSession: () => {} },
        configurable: true,
      });
      expect(device.isNativeXRAvailable()).toBe(true);
    });
  });

  describe('forceInstall', () => {
    test('does not clobber a pre-existing native navigator.xr by default', () => {
      const device = new XRDevice(makeDeviceConfig());
      const nativeXR = { requestSession: () => {}, __native: true };
      Object.defineProperty(navigator, 'xr', {
        value: nativeXR,
        configurable: true,
      });

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      device.installRuntime({
        globalObject: g,
        polyfillLayers: false,
        forceInstall: false,
      });

      // The native runtime is left untouched.
      expect(navigator.xr).toBe(nativeXR);
      expect(navigator.xr).not.toBeInstanceOf(XRSystem);
      expect(warnSpy).toHaveBeenCalled();
    });

    test('overwrites a pre-existing native navigator.xr when forced', () => {
      const device = new XRDevice(makeDeviceConfig());
      const nativeXR = { requestSession: () => {}, __native: true };
      Object.defineProperty(navigator, 'xr', {
        value: nativeXR,
        configurable: true,
      });

      device.installRuntime({
        globalObject: g,
        polyfillLayers: false,
        forceInstall: true,
      });

      expect(navigator.xr).not.toBe(nativeXR);
      expect(navigator.xr).toBeInstanceOf(XRSystem);
    });
  });
});
