/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  XRDeviceBase,
  XRDeviceConfig,
  XRDeviceExtensions,
  XRDeviceOptions,
} from './XRDeviceBase.js';
import { ActionPlayer } from '../action/ActionPlayer.js';
import { RemoteControlInterface } from '../remote/RemoteControlInterface.js';
// @ts-ignore
import WebXRLayerPolyfill from 'webxr-layers-polyfill';

export * from './XRDeviceBase.js';

/** Everything the full entry offers on top of the shared device model. */
const EMULATOR_EXTENSIONS: XRDeviceExtensions = {
  createRemoteControl: (device) =>
    new RemoteControlInterface(device as XRDevice),
  createActionPlayer: (refSpace, recording, ipd, options) =>
    new ActionPlayer(refSpace, recording, ipd, options),
  installLayersPolyfill: () => {
    new WebXRLayerPolyfill();
  },
};

/**
 * XRDevice is not a standard API class outlined in the WebXR Device API Specifications
 * Instead, it serves as an user-facing interface to control the emulated XR Device
 */
export class XRDevice extends XRDeviceBase {
  constructor(
    deviceConfig: XRDeviceConfig,
    deviceOptions: Partial<XRDeviceOptions> = {},
  ) {
    super(deviceConfig, deviceOptions, EMULATOR_EXTENSIONS);
  }

  /** Always present on the full entry's device. */
  get remote(): RemoteControlInterface {
    return super.remote!;
  }
}
