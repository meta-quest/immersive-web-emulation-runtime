/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { HandPose, XRHandInput } from '../device/XRHandInput.js';
import {
  MicrogestureThumb,
  libraryHandPoses,
  microgestureThumbPoses,
} from '../device/configs/hand/library.js';

import type { Channel } from './channels.js';
import { XRHandedness } from '../input/XRInputSource.js';
import { ease } from './hand-motion.js';

/**
 * Thumb microgestures, as Quest reports them on the hand gamepad: swipes
 * along the side of the curled index finger (left / right, the user's left
 * and right), over it (forward) or back toward the palm (backward), and a
 * tap on its side.
 */
export const MICROGESTURES = [
  'swipe-left',
  'swipe-right',
  'swipe-forward',
  'swipe-backward',
  'tap',
] as const;
export type Microgesture = (typeof MICROGESTURES)[number];

export const isMicrogesture = (value: unknown): value is Microgesture =>
  (MICROGESTURES as readonly unknown[]).includes(value);

/** The hand gamepad button of each microgesture (5 to 9, as on Quest). */
export const microgestureButton = (gesture: Microgesture): number =>
  5 + MICROGESTURES.indexOf(gesture);

/** The hand pose microgestures start from and return to. */
export const MICROGESTURE_POSE = 'microgesture';

/** Seconds a hand not in the microgesture pose takes to get into it. */
export const MICROGESTURE_READY_S = 0.25;

/**
 * Whether a hand can start a microgesture at once: in the microgesture pose
 * (no finger blends, no pose change in progress) with `pinch` (the pinch last
 * written) open.
 */
export const readyForMicrogesture = (hand: XRHandInput, pinch: number) =>
  hand.poseId === MICROGESTURE_POSE &&
  Object.keys(hand.fingerPoses).length === 0 &&
  hand.poseTransitionProgress === null &&
  pinch === 0;

// Quest holds a recognized microgesture for about 35 ms (3 frames at 90 Hz).
const PULSE_S = 0.035;
const TOUCH_S = 0.07;
const SLIDE_S = 0.11;
const TAP_HOLD_S = 0.02;
const RETURN_S = 0.14;

/** Seconds a microgesture takes, from the thumb leaving rest to its return. */
export const microgestureSeconds = (gesture: Microgesture): number =>
  TOUCH_S + (gesture === 'tap' ? TAP_HOLD_S : SLIDE_S) + RETURN_S;

/**
 * The thumb's path on the index finger, from touching it to lifting off.
 * Swiping left moves the right thumb toward the index tip and the left thumb
 * toward the knuckle; a tap only touches.
 */
const slideOf = (
  gesture: Microgesture,
  handedness: XRHandedness,
): MicrogestureThumb[] => {
  const right = handedness === XRHandedness.Right;
  switch (gesture) {
    case 'swipe-left':
      return right
        ? ['touch', 'tip-mid', 'tip']
        : ['touch', 'knuckle-mid', 'knuckle'];
    case 'swipe-right':
      return right
        ? ['touch', 'knuckle-mid', 'knuckle']
        : ['touch', 'tip-mid', 'tip'];
    case 'swipe-forward':
      return ['forward-start', 'forward-mid', 'forward'];
    case 'swipe-backward':
      return ['backward-start', 'backward-mid', 'backward'];
    case 'tap':
      return ['touch'];
  }
};

/**
 * Plays one microgesture on a hand in the microgesture pose: the thumb
 * touches the index finger, slides (or taps) and lifts back to rest. Like
 * Quest, the gesture registers at the end of the motion, as the thumb lifts:
 * its button is pressed for 35 ms, and always for at least one frame.
 */
export class MicrogesturePlayer {
  /** Seconds the motion takes. */
  readonly duration: number;
  /** Seconds from the start at which the button is pressed. */
  readonly registerAt: number;
  /** The hand gamepad button it presses. */
  readonly button: number;
  private readonly rest: HandPose;
  private readonly slide: HandPose[];
  private readonly slideEnd: number;
  private pressed: number | null = null;
  private released = false;
  // The press was written by the latest apply(): the app has not seen it.
  private pressUnseen = false;
  private holding = false;

  constructor(
    private readonly hand: XRHandInput,
    readonly gesture: Microgesture,
  ) {
    this.rest = libraryHandPoses[MICROGESTURE_POSE];
    this.slide = slideOf(gesture, hand.inputSource.handedness).map(
      (id) => microgestureThumbPoses[id],
    );
    this.duration = microgestureSeconds(gesture);
    this.slideEnd = this.duration - RETURN_S;
    // Once the thumb has come off the finger.
    this.registerAt = this.slideEnd + 0.4 * RETURN_S;
    this.button = microgestureButton(gesture);
  }

  /** Seconds from the start at which the button was pressed, or null. */
  get pressedAt(): number | null {
    return this.pressed;
  }

  /**
   * True when finish() kept the button down because it was pressed on the
   * same frame: call finish() again on the next frame.
   */
  get releasePending(): boolean {
    return this.holding;
  }

  /** Shows the thumb `elapsed` seconds in. */
  private showThumb(elapsed: number) {
    const { slide } = this;
    const last = slide.length - 1;
    if (elapsed < TOUCH_S) {
      this.hand.thumbMotion = {
        from: this.rest,
        to: slide[0],
        weight: ease('minimum-jerk', elapsed / TOUCH_S),
      };
    } else if (elapsed < this.slideEnd) {
      // One smooth slide through the keyframes, without stopping at each.
      const u =
        last > 0
          ? ease(
              'minimum-jerk',
              (elapsed - TOUCH_S) / (this.slideEnd - TOUCH_S),
            ) * last
          : 0;
      const i = Math.max(0, Math.min(last - 1, Math.floor(u)));
      this.hand.thumbMotion =
        last > 0
          ? { from: slide[i], to: slide[i + 1], weight: u - i }
          : { from: slide[0], to: slide[0], weight: 0 };
    } else {
      this.hand.thumbMotion = {
        from: slide[last],
        to: this.rest,
        weight: ease(
          'minimum-jerk',
          Math.min(1, (elapsed - this.slideEnd) / RETURN_S),
        ),
      };
    }
  }

  private writeButton(value: 0 | 1) {
    this.hand.updateGestureButton(this.gesture, value);
  }

  /**
   * Shows the thumb `elapsed` seconds into the gesture and writes the button.
   * Call once per frame; returns 'press' on the frame the gesture registers.
   */
  apply(elapsed: number): 'press' | null {
    this.pressUnseen = false;
    this.showThumb(elapsed);
    if (this.pressed === null && elapsed >= this.registerAt) {
      this.pressed = elapsed;
      this.pressUnseen = true;
      this.writeButton(1);
      return 'press';
    }
    // Released on a later frame, so the app always sees the press.
    if (
      this.pressed !== null &&
      !this.released &&
      elapsed >= this.pressed + PULSE_S
    ) {
      this.released = true;
      this.writeButton(0);
    }
    return null;
  }

  /**
   * Ends the gesture: the thumb back at rest and the button up. A button
   * pressed on this very frame stays down for it (`releasePending`); call
   * finish() again on the next frame to release it.
   */
  finish(): void {
    this.hand.thumbMotion = null;
    if (this.pressed === null || this.released) {
      this.holding = false;
      return;
    }
    if (this.pressUnseen) {
      this.pressUnseen = false;
      this.holding = true;
      return;
    }
    this.holding = false;
    this.released = true;
    this.writeButton(0);
  }

  /** Stops the gesture now: the thumb at rest, the button up. */
  cancel(): void {
    this.hand.thumbMotion = null;
    this.holding = false;
    if (this.pressed !== null && !this.released) {
      this.released = true;
      this.writeButton(0);
    }
  }

  /**
   * The gesture as a `thumb` channel of `device`, starting `delayMs` into its
   * run. Its last frame calls finish(); stopping it early cancels.
   */
  channel(device: string, delayMs = 0): Channel {
    return {
      device,
      kind: 'thumb',
      delayMs,
      durationMs: this.duration * 1000,
      easing: 'linear',
      apply: (progress) => {
        this.apply(progress * this.duration);
        if (progress >= 1) this.finish();
      },
      cancel: () => this.cancel(),
    };
  }
}
