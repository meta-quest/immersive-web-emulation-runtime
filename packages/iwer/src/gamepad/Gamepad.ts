/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_GAMEPAD } from '../private.js';

export enum GamepadMappingType {
  None = '',
  Standard = 'standard',
  XRStandard = 'xr-standard',
}

export interface Button {
  id: string;
  type: 'binary' | 'analog' | 'manual';
  eventTrigger?: 'select' | 'squeeze';
}

export interface Axis {
  id: string;
  type: 'x-axis' | 'y-axis' | 'manual';
}

export interface GamepadConfig {
  mapping: GamepadMappingType;
  buttons: (Button | null)[];
  axes: (Axis | null)[];
}

export class GamepadButton {
  [P_GAMEPAD]: {
    type: 'analog' | 'binary' | 'manual';
    eventTrigger: 'select' | 'squeeze' | null;
    pressed: boolean;
    touched: boolean;
    value: number;
    lastFrameValue: number;
    pendingValue: number | null;
  };

  constructor(
    type: 'analog' | 'binary' | 'manual',
    eventTrigger: 'select' | 'squeeze' | null,
  ) {
    this[P_GAMEPAD] = {
      type,
      eventTrigger,
      pressed: false,
      touched: false,
      value: 0,
      lastFrameValue: 0,
      pendingValue: null,
    };
  }

  get pressed() {
    if (this[P_GAMEPAD].type === 'manual') {
      return this[P_GAMEPAD].pressed;
    } else {
      return this[P_GAMEPAD].value > 0;
    }
  }

  get touched() {
    if (this[P_GAMEPAD].type === 'manual') {
      return this[P_GAMEPAD].touched;
    } else {
      return this[P_GAMEPAD].touched || this.pressed;
    }
  }

  get value() {
    return this[P_GAMEPAD].value;
  }
}

export class EmptyGamepadButton {
  pressed = false;
  touched = false;
  value = 0;
}

export type GamepadHapticActuatorType = 'vibration' | 'dual-rumble';

export class GamepadHapticActuator {
  [P_GAMEPAD]: {
    type: GamepadHapticActuatorType;
    lastPulse: {
      value: number;
      duration: number;
      startTime: DOMHighResTimeStamp;
    } | null;
  };

  constructor(type: GamepadHapticActuatorType = 'vibration') {
    this[P_GAMEPAD] = {
      type,
      lastPulse: null,
    };
  }

  get type() {
    return this[P_GAMEPAD].type;
  }

  pulse(value: number, duration: number): Promise<boolean> {
    this[P_GAMEPAD].lastPulse = {
      value,
      duration,
      startTime: performance.now(),
    };
    return Promise.resolve(true);
  }
}

export class Gamepad {
  [P_GAMEPAD]: {
    id: string;
    index: number;
    connected: boolean;
    timestamp: DOMHighResTimeStamp;
    mapping: GamepadMappingType;
    buttonsMap: {
      [id: string]: GamepadButton | null;
    };
    buttonsSequence: (string | null)[];
    axesMap: {
      [id: string]: { x: number; y: number };
    };
    axesSequence: (string | null)[];
    hapticActuators: GamepadHapticActuator[];
    // Cached views so the per-frame buttons/axes getters don't allocate.
    buttonsView: (GamepadButton | EmptyGamepadButton | null)[];
    axesView: (number | null)[];
    axesResolvers: ({ axisId: string; isY: boolean } | null)[];
  };

  constructor(
    gamepadConfig: GamepadConfig,
    id: string = '',
    index: number = -1,
    numHapticActuators: number = 0,
  ) {
    this[P_GAMEPAD] = {
      id,
      index,
      connected: false,
      timestamp: performance.now(),
      mapping: gamepadConfig.mapping,
      buttonsMap: {},
      buttonsSequence: [],
      axesMap: {},
      axesSequence: [],
      hapticActuators: Array.from(
        { length: Math.max(0, numHapticActuators) },
        () => new GamepadHapticActuator('vibration'),
      ),
      buttonsView: [],
      axesView: [],
      axesResolvers: [],
    };
    gamepadConfig.buttons.forEach((buttonConfig) => {
      if (buttonConfig === null) {
        this[P_GAMEPAD].buttonsSequence.push(null);
      } else {
        this[P_GAMEPAD].buttonsSequence.push(buttonConfig.id);
        this[P_GAMEPAD].buttonsMap[buttonConfig.id] = new GamepadButton(
          buttonConfig.type,
          buttonConfig.eventTrigger ?? null,
        );
      }
    });
    gamepadConfig.axes.forEach((axisConfig) => {
      if (axisConfig === null) {
        this[P_GAMEPAD].axesSequence.push(null);
      } else {
        this[P_GAMEPAD].axesSequence.push(axisConfig.id + axisConfig.type);
        if (!this[P_GAMEPAD].axesMap[axisConfig.id]) {
          this[P_GAMEPAD].axesMap[axisConfig.id] = { x: 0, y: 0 };
        }
      }
    });

    // Build the cached buttons array once. The GamepadButton instances are
    // stable references mutated in place, so the cached array always reflects
    // current state; null slots get a shared empty button.
    this[P_GAMEPAD].buttonsView = this[P_GAMEPAD].buttonsSequence.map((id) =>
      id === null ? new EmptyGamepadButton() : this[P_GAMEPAD].buttonsMap[id],
    );
    // Precompute axis resolvers and a reusable axes array (values written in
    // place on each read).
    this[P_GAMEPAD].axesResolvers = this[P_GAMEPAD].axesSequence.map((id) =>
      id === null
        ? null
        : {
            axisId: id.substring(0, id.length - 6),
            isY: id.substring(id.length - 6) === 'y-axis',
          },
    );
    this[P_GAMEPAD].axesView = this[P_GAMEPAD].axesResolvers.map(() => null);
  }

  get id() {
    return this[P_GAMEPAD].id;
  }

  get index() {
    return this[P_GAMEPAD].index;
  }

  get connected() {
    return this[P_GAMEPAD].connected;
  }

  get timestamp() {
    return this[P_GAMEPAD].timestamp;
  }

  get mapping() {
    return this[P_GAMEPAD].mapping;
  }

  get axes() {
    const { axesView, axesResolvers, axesMap } = this[P_GAMEPAD];
    for (let i = 0; i < axesResolvers.length; i++) {
      const resolver = axesResolvers[i];
      if (resolver === null) {
        axesView[i] = null;
      } else {
        const axis = axesMap[resolver.axisId];
        // manual axes fall through to the x value, matching the prior behavior
        axesView[i] = resolver.isY ? axis.y : axis.x;
      }
    }
    return axesView;
  }

  get buttons() {
    return this[P_GAMEPAD].buttonsView;
  }

  get hapticActuators() {
    return this[P_GAMEPAD].hapticActuators;
  }

  get vibrationActuator() {
    return this[P_GAMEPAD].hapticActuators[0] ?? null;
  }
}
