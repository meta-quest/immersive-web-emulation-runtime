/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { GamepadConfig, GamepadMappingType } from '../../../gamepad/Gamepad.js';
import { XRControllerConfig } from '../../XRController.js';

const bluetoothGamepadLayout: GamepadConfig = {
  mapping: GamepadMappingType.Standard,
  buttons: [
    { id: 'a-button', type: 'binary', eventTrigger: 'select' },
    { id: 'b-button', type: 'binary' },
    { id: 'x-button', type: 'binary' },
    { id: 'y-button', type: 'binary' },
    { id: 'left-bumper', type: 'binary' },
    { id: 'right-bumper', type: 'binary', eventTrigger: 'squeeze' },
    { id: 'left-trigger', type: 'analog' },
    { id: 'right-trigger', type: 'analog', eventTrigger: 'squeeze' },
    { id: 'view-button', type: 'binary' },
    { id: 'menu-button', type: 'binary' },
    { id: 'left-thumbstick-press', type: 'binary' },
    { id: 'right-thumbstick-press', type: 'binary' },
  ],
  axes: [
    { id: 'left-thumbstick', type: 'x-axis' },
    { id: 'left-thumbstick', type: 'y-axis' },
    { id: 'right-thumbstick', type: 'x-axis' },
    { id: 'right-thumbstick', type: 'y-axis' },
  ],
};

export const bluetoothGamepad: XRControllerConfig = {
  profileId: 'generic-gamepad',
  fallbackProfileIds: ['gamepad'],
  layout: {
    none: {
      gamepad: bluetoothGamepadLayout,
      numHapticActuators: 0,
    },
  },
};
