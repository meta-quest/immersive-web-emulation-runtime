/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Generic controller config used as the universal fallback profile. The
// profile id 'generic-trigger-squeeze-thumbstick' is referenced as a
// fallbackProfileId by every meta controller config but was never defined as
// an authorable config. This mirrors the meta Touch xr-standard layout
// (trigger/squeeze/thumbstick) so consumers always have a concrete config for
// the generic profile.

import { GamepadConfig, GamepadMappingType } from '../../../gamepad/Gamepad.js';

import { XRControllerConfig } from '../../XRController.js';

const gamepadConfig: GamepadConfig = {
  mapping: GamepadMappingType.XRStandard,
  buttons: [
    { id: 'trigger', type: 'analog', eventTrigger: 'select' },
    { id: 'squeeze', type: 'analog', eventTrigger: 'squeeze' },
    null,
    { id: 'thumbstick', type: 'binary' },
  ],
  axes: [
    null,
    null,
    { id: 'thumbstick', type: 'x-axis' },
    { id: 'thumbstick', type: 'y-axis' },
  ],
};

export const generic: XRControllerConfig = {
  profileId: 'generic-trigger-squeeze-thumbstick',
  fallbackProfileIds: [],
  layout: {
    left: {
      gamepad: gamepadConfig,
      numHapticActuators: 1,
    },
    right: {
      gamepad: gamepadConfig,
      numHapticActuators: 1,
    },
    none: {
      gamepad: gamepadConfig,
      numHapticActuators: 1,
    },
  },
};
