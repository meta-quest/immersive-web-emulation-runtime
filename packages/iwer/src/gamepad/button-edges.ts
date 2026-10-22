/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_GAMEPAD } from '../private.js';
import type { GamepadButton } from './Gamepad.js';

/**
 * Press and release levels for an analog button. A released button presses
 * once its value reaches `press`; a pressed button releases once its value
 * falls to `release` or below.
 */
export interface ButtonThresholds {
  press: number;
  release: number;
}

/**
 * What a frame did to a button: pressed it, released it, cancelled a press the
 * app had seen, or nothing.
 */
export type ButtonEdge = 'press' | 'release' | 'cancel' | null;

/**
 * The input source events for an edge, in WebXR order: `<trigger>start` on
 * press, `<trigger>` then `<trigger>end` on release, and `<trigger>end` alone
 * when the action is cancelled.
 */
export const edgeEventTypes = (
  edge: ButtonEdge,
  trigger: 'select' | 'squeeze',
): string[] => {
  switch (edge) {
    case 'press':
      return [`${trigger}start`];
    case 'release':
      return [trigger, `${trigger}end`];
    case 'cancel':
      return [`${trigger}end`];
    default:
      return [];
  }
};

/** The pressed flag after `value` is applied to a button whose flag is `pressed`. */
export const nextPressed = (
  button: GamepadButton,
  pressed: boolean,
  value: number,
): boolean => {
  const thresholds = button[P_GAMEPAD].thresholds;
  if (!thresholds) {
    return value > 0;
  }
  return pressed ? value > thresholds.release : value >= thresholds.press;
};

/** Sets the value the button takes on the next frame (the latest write wins). */
export const writePendingValue = (button: GamepadButton, value: number) => {
  button[P_GAMEPAD].pendingValue = value;
};

/**
 * Releases the button now without completing its action. If the app saw the
 * button pressed, the next frame reports a cancel (`<trigger>end` alone).
 */
export const cancelButton = (button: GamepadButton) => {
  const state = button[P_GAMEPAD];
  if (state.lastFramePressed) {
    state.cancelRequested = true;
  }
  state.value = 0;
  state.pendingValue = null;
  state.pressed = false;
  state.cancelGeneration++;
};

/**
 * Releases the button silently, for an input source that is going away after
 * its edges were already delivered (or can no longer be delivered).
 */
export const resetButton = (button: GamepadButton) => {
  cancelButton(button);
  const state = button[P_GAMEPAD];
  state.cancelRequested = false;
  state.lastFramePressed = false;
  state.lastFrameValue = 0;
};

/**
 * Sets a value that is readable right away. A write that releases a pressed
 * button cancels it, since immediate writes are how interactions get
 * cancelled; any other write takes effect now and its edge is reported on the
 * next frame.
 */
export const writeImmediateValue = (button: GamepadButton, value: number) => {
  const state = button[P_GAMEPAD];
  if (state.cancelRequested) {
    // A cancel is still to be reported this frame; a new press waits for the
    // next one, so the app never sees `pressed` with the cancel's end event.
    state.pendingValue = value;
    return;
  }
  const held = state.pressed || state.lastFramePressed;
  if (held && !nextPressed(button, true, value)) {
    cancelButton(button);
    // Keep the value that was asked for (a partial pinch stays partial).
    state.value = value;
    return;
  }
  state.value = value;
  state.pendingValue = null;
  if (state.type !== 'manual') {
    state.pressed = nextPressed(button, state.pressed, value);
  }
};

/**
 * Advances the button by one frame: applies the pending value, updates the
 * pressed flag, and reports the edge.
 */
export const advanceButton = (button: GamepadButton): ButtonEdge => {
  const state = button[P_GAMEPAD];
  const was = state.lastFramePressed;
  state.lastFrameValue = state.value;
  if (state.cancelRequested) {
    // Anything written after the cancel waits for the next frame.
    state.cancelRequested = false;
    state.lastFramePressed = false;
    return was ? 'cancel' : null;
  }
  if (state.pendingValue !== null) {
    state.value = state.pendingValue;
    state.pendingValue = null;
  }
  if (state.type !== 'manual') {
    state.pressed = nextPressed(button, state.pressed, state.value);
  }
  state.lastFramePressed = state.pressed;
  if (!was && state.pressed) {
    return 'press';
  }
  if (was && !state.pressed) {
    return 'release';
  }
  return null;
};
