/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { WebXRFeature, XRDevice } from '../device/XRDevice.js';
import {
  XRSession,
  XRSessionInit,
  XRSessionMode,
} from '../session/XRSession.js';

import { P_DEVICE, P_SYSTEM } from '../private.js';
import { findWebGPUDepthConfiguration } from '../depth/XRDepthInformation.js';
import {
  isGazeTrackingFeature,
  supportsGazeTracking,
} from '../device/XRGazeInput.js';

type SessionGrantConfig = {
  resolve: (value: XRSession) => void;
  reject: (reason?: any) => void;
  mode: XRSessionMode;
  options: XRSessionInit;
  webgpuAvailable?: boolean;
};

const WEBGPU_PROBE_TIMEOUT_MS = 2000;

type WebGPUProbe = {
  check: Promise<boolean>;
  result: boolean | null;
  timedOut: boolean;
};
const webgpuProbes = new WeakMap<GPU, WebGPUProbe>();

// Some browsers expose navigator.gpu but can't provide an adapter (blocklisted
// GPUs, hardware acceleration off), and WebGPU apps then fall back to WebGL.
// Only advertise 'webgpu' when an adapter is actually available. The adapter
// check runs once per GPU object and its real result is kept when it arrives.
// Each session request waits for it at most WEBGPU_PROBE_TIMEOUT_MS, because
// requestAdapter() can hang in some headless environments, and only the first
// request pays that wait while the check is still pending.
const probeWebGPU = (): Promise<boolean> => {
  const gpu = globalThis.navigator?.gpu;
  if (!gpu) {
    return Promise.resolve(false);
  }
  let probe = webgpuProbes.get(gpu);
  if (!probe) {
    const created: WebGPUProbe = {
      check: Promise.resolve()
        .then(() =>
          gpu.requestAdapter({
            xrCompatible: true,
          } as GPURequestAdapterOptions),
        )
        .then(
          (adapter) => Boolean(adapter),
          () => false,
        )
        .then((available) => {
          created.result = available;
          return available;
        }),
      result: null,
      timedOut: false,
    };
    probe = created;
    webgpuProbes.set(gpu, probe);
  }
  if (probe.result !== null) {
    return Promise.resolve(probe.result);
  }
  if (probe.timedOut) {
    return Promise.resolve(false);
  }
  const pending = probe;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pending.timedOut = true;
      resolve(false);
    }, WEBGPU_PROBE_TIMEOUT_MS);
    pending.check.then((available) => {
      clearTimeout(timer);
      resolve(available);
    });
  });
};

const requestsWebGPU = (mode: XRSessionMode, options: XRSessionInit) =>
  mode !== 'inline' &&
  [...(options.requiredFeatures ?? []), ...(options.optionalFeatures ?? [])]
    .map(String)
    .includes('webgpu');

// WebGPU layers aren't offered alongside the WebGL-only layers polyfill.
const canRequestWebGPU = (
  device: XRDevice,
  mode: XRSessionMode,
  options: XRSessionInit,
) => requestsWebGPU(mode, options) && !device[P_DEVICE].polyfillLayers;

export class XRSystem extends EventTarget {
  [P_SYSTEM]: {
    device: XRDevice;
    activeSession?: XRSession;
    grantSession: (SessionGrantConfig: SessionGrantConfig) => void;
    offeredSessionConfig?: SessionGrantConfig;
  };

  constructor(device: XRDevice) {
    super();
    this[P_SYSTEM] = {
      device,
      grantSession: ({ resolve, reject, mode, options, webgpuAvailable }) => {
        // Check for active sessions and other constraints here
        if (this[P_SYSTEM].activeSession) {
          reject(
            new DOMException(
              'An active XRSession already exists.',
              'InvalidStateError',
            ),
          );
          return;
        }

        // Handle required and optional features
        const { requiredFeatures = [], optionalFeatures = [] } = options;
        const { supportedFeatures } = this[P_SYSTEM].device;
        const webgpuSession =
          requestsWebGPU(mode, options) && webgpuAvailable === true;
        const isFeatureSupported = (feature: WebXRFeature): boolean => {
          if (feature === 'webgpu') {
            // A host browser capability rather than part of the device profile.
            return mode !== 'inline' && webgpuAvailable === true;
          }
          if (
            feature === 'depth-sensing' &&
            webgpuSession &&
            !findWebGPUDepthConfiguration(options.depthSensing)
          ) {
            return false;
          }
          return isGazeTrackingFeature(feature)
            ? supportsGazeTracking(supportedFeatures)
            : supportedFeatures.includes(feature);
        };

        // Check if all required features are supported
        const allRequiredSupported = requiredFeatures.every(isFeatureSupported);
        if (!allRequiredSupported) {
          reject(
            new Error(
              'One or more required features are not supported by the device.',
            ),
          );
          return;
        }

        // Filter out unsupported optional features
        const supportedOptionalFeatures =
          optionalFeatures.filter(isFeatureSupported);

        // Combine required and supported optional features into enabled features
        const enabledFeatures: WebXRFeature[] = Array.from(
          new Set([
            ...requiredFeatures,
            ...supportedOptionalFeatures,
            'viewer',
            'local',
          ]),
        );

        // Proceed with session creation
        const session = new XRSession(
          this[P_SYSTEM].device,
          mode,
          enabledFeatures,
          options.depthSensing,
        );
        this[P_SYSTEM].activeSession = session;

        // Listen for session end to clear the active session
        session.addEventListener(
          'end',
          () => {
            this[P_SYSTEM].activeSession = undefined;
          },
          { once: true },
        );

        resolve(session);
      },
    };
    // Initialize device change monitoring here if applicable
  }

  isSessionSupported(mode: XRSessionMode): Promise<boolean> {
    return new Promise<boolean>((resolve, _reject) => {
      if (mode === 'inline') {
        resolve(true);
      } else {
        // Check for spatial tracking permission if necessary
        resolve(this[P_SYSTEM].device.supportedSessionModes.includes(mode));
      }
    });
  }

  requestSession(
    mode: XRSessionMode,
    options: XRSessionInit = {},
  ): Promise<XRSession> {
    return new Promise<XRSession>((resolve, reject) => {
      this.isSessionSupported(mode)
        .then(async (isSupported) => {
          if (!isSupported) {
            reject(
              new DOMException(
                'The requested XRSession mode is not supported.',
                'NotSupportedError',
              ),
            );
            return;
          }

          const webgpuAvailable = canRequestWebGPU(
            this[P_SYSTEM].device,
            mode,
            options,
          )
            ? await probeWebGPU()
            : false;

          const sessionGrantConfig = {
            resolve,
            reject,
            mode,
            options,
            webgpuAvailable,
          };

          this[P_SYSTEM].grantSession(sessionGrantConfig);
        })
        .catch(reject);
    });
  }

  offerSession(
    mode: XRSessionMode,
    options: XRSessionInit = {},
  ): Promise<XRSession> {
    return new Promise<XRSession>((resolve, reject) => {
      this.isSessionSupported(mode)
        .then((isSupported) => {
          if (!isSupported) {
            reject(
              new DOMException(
                'The requested XRSession mode is not supported.',
                'NotSupportedError',
              ),
            );
            return;
          }

          // Reject any previously pending offer so its promise settles
          // instead of being silently orphaned by this newer offer.
          this[P_SYSTEM].offeredSessionConfig?.reject(
            new Error('Offer superseded by a new offerSession call.'),
          );

          this[P_SYSTEM].offeredSessionConfig = {
            resolve,
            reject,
            mode,
            options,
          };
        })
        .catch(reject);
    });
  }
}
