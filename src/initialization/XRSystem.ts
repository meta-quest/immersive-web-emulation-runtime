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

import { P_SYSTEM } from '../private.js';

type SessionGrantConfig = {
  resolve: (value: XRSession) => void;
  reject: (reason?: any) => void;
  mode: XRSessionMode;
  options: XRSessionInit;
};

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
      grantSession: ({ resolve, reject, mode, options }) => {
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

        // Check if all required features are supported
        const allRequiredSupported = requiredFeatures.every((feature) =>
          supportedFeatures.includes(feature),
        );
        if (!allRequiredSupported) {
          reject(
            new Error(
              'One or more required features are not supported by the device.',
            ),
          );
          return;
        }

        // Filter out unsupported optional features
        const supportedOptionalFeatures = optionalFeatures.filter((feature) =>
          supportedFeatures.includes(feature),
        );

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
        );
        this[P_SYSTEM].activeSession = session;

        // Listen for session end to clear the active session
        session.addEventListener('end', () => {
          this[P_SYSTEM].activeSession = undefined;
        });

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

          const sessionGrantConfig = {
            resolve,
            reject,
            mode,
            options,
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
