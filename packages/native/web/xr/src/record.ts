/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Reads the native frame record in place (docs/spec/09 XRF-1/2, XRF-IN-1/2). Every view below is made once over the
// ArrayBuffer the runtime hands out (native memory, an external backing store), so a frame allocates nothing:
// `refresh()` writes the scalar fields of one long-lived XRHostFrame object, and `copyInput()` copies each input
// field with one TypedArray.set from a pre-made view (the fallback of XRF-IN-2 while IWER owns its state arrays).

import type { XRHostFrame, XRHostInputState } from 'iwer/host';

import {
  COUNTS,
  F32,
  F64,
  HAND_F32,
  HAND_U32,
  HAND_U8,
  LAYOUT_VERSION,
  RECORD_BYTES,
  U32,
} from './layout.gen.ts';

const FLAG_SHOULD_RENDER = 1;
const FLAG_BASE_IS_STAGE = 2;
const INPUT_TARGET_RAY_VALID = 1;
const INPUT_GRIP_VALID = 2;
const INPUT_PALM_VALID = 4;
const MODE_CONTROLLER = 1;
const MODE_HAND = 2;
/** IWER's XRHostInputMode.HandPointer: a tracked hand used as a pointer (no hand-tracking feature). */
const MODE_HAND_POINTER = 3;
/** Native interaction profiles of held controllers (runtime/xr input_map.h: Touch, Touch Plus, Touch Pro). */
const PROFILE_TOUCH = 1;
const PROFILE_TOUCH_PRO = 3;
/** Controller and hand gamepad slots of the menu button (input_map.cc kMenu / kHandMenu). */
const CONTROLLER_MENU = 7;
const HAND_MENU = 4;

/** The XRHostFrame IWER reads during runHostFrame; its typed arrays are views onto the record. */
export interface RecordFrame extends XRHostFrame {
  views: Float32Array;
  localPose: Float32Array;
  /** Extra fields beyond XRHostFrame. */
  frameSerial: number;
  frameStartTime: number;
  displayPeriod: number;
  imageArraySize: number;
  viewerPose: Float32Array;
}

interface HandViews {
  mode: number;
  profile: number;
  flags: number;
  targetRay: Float32Array;
  grip: Float32Array;
  palm: Float32Array;
  buttonValues: Float32Array;
  axes: Float32Array;
  joints: Float32Array;
  buttonPressed: Uint8Array;
  buttonTouched: Uint8Array;
  jointValid: Uint8Array;
}

export class FrameRecordView {
  readonly buffer: ArrayBuffer;
  readonly u32: Uint32Array;
  readonly f32: Float32Array;
  readonly f64: Float64Array;
  readonly u8: Uint8Array;
  readonly frame: RecordFrame;
  private readonly hands: [HandViews, HandViews];

  constructor(buffer: ArrayBuffer) {
    if (buffer.byteLength < RECORD_BYTES) {
      throw new RangeError(
        `frame record is ${buffer.byteLength} bytes; layout v${LAYOUT_VERSION} needs ${RECORD_BYTES}`,
      );
    }
    this.buffer = buffer;
    this.u32 = new Uint32Array(buffer, 0, RECORD_BYTES / 4);
    this.f32 = new Float32Array(buffer, 0, RECORD_BYTES / 4);
    this.f64 = new Float64Array(buffer, 0, RECORD_BYTES / 8);
    this.u8 = new Uint8Array(buffer, 0, RECORD_BYTES);
    const f32 = (index: number, count: number) =>
      this.f32.subarray(index, index + count);
    const u8 = (index: number, count: number) =>
      this.u8.subarray(index, index + count);
    this.frame = {
      predictedDisplayTime: 0,
      shouldRender: false,
      viewCount: 2,
      views: f32(F32.views, COUNTS.views),
      localPose: f32(F32.localPose, COUNTS.localPose),
      baseIsStage: false,
      colorTexture: 0,
      frameRate: 0,
      frameSerial: 0,
      frameStartTime: 0,
      displayPeriod: 0,
      imageArraySize: 0,
      viewerPose: f32(F32.viewerPose, COUNTS.viewerPose),
    };
    const hand = (h: 0 | 1): HandViews => ({
      mode: HAND_U32.inputMode[h],
      profile: HAND_U32.inputProfile[h],
      flags: HAND_U32.inputFlags[h],
      targetRay: f32(HAND_F32.targetRay[h], COUNTS.targetRay),
      grip: f32(HAND_F32.grip[h], COUNTS.grip),
      palm: f32(HAND_F32.palm[h], COUNTS.palm),
      buttonValues: f32(HAND_F32.buttonValues[h], COUNTS.buttonValues),
      axes: f32(HAND_F32.axes[h], COUNTS.axes),
      joints: f32(HAND_F32.joints[h], COUNTS.joints),
      buttonPressed: u8(HAND_U8.buttonPressed[h], COUNTS.buttonPressed),
      buttonTouched: u8(HAND_U8.buttonTouched[h], COUNTS.buttonTouched),
      jointValid: u8(HAND_U8.jointValid[h], COUNTS.jointValid),
    });
    this.hands = [hand(0), hand(1)];
  }

  /** The layout version the native writer stamped into the record (XRF-4). */
  get version(): number {
    return this.u32[U32.layoutVersion];
  }

  /** Brings the frame object up to date with the record; returns it (the same object every frame). */
  refresh(): RecordFrame {
    const f = this.frame;
    const u32 = this.u32;
    const flags = u32[U32.flags];
    f.predictedDisplayTime = this.f64[F64.predictedDisplayTime];
    f.frameStartTime = this.f64[F64.frameStartTime];
    f.displayPeriod = this.f64[F64.displayPeriod];
    f.shouldRender = (flags & FLAG_SHOULD_RENDER) !== 0;
    f.baseIsStage = (flags & FLAG_BASE_IS_STAGE) !== 0;
    f.viewCount = u32[U32.viewCount];
    f.colorTexture = u32[U32.colorTexture];
    f.imageArraySize = u32[U32.imageArraySize];
    f.frameSerial = u32[U32.frameSerial];
    f.frameRate = this.f32[F32.frameRate];
    return f;
  }

  /** Copies both hands into IWER's host input states (one TypedArray.set per field, no allocation). */
  copyInput(left: XRHostInputState, right: XRHostInputState): void {
    this.copyHand(this.hands[0], left);
    this.copyHand(this.hands[1], right);
  }

  private copyHand(v: HandViews, s: XRHostInputState): void {
    let mode = this.u32[v.mode];
    const flags = this.u32[v.flags];
    // The native side drives a tracked hand in a session without hand-tracking as a controller (hand_pointer) with
    // the hand's own profile; browsers list it as a hand source without joints (hand profiles, hand gamepad), not as
    // the headset's controllers.
    const profile = this.u32[v.profile];
    const pointer =
      mode === MODE_CONTROLLER &&
      (profile < PROFILE_TOUCH || profile > PROFILE_TOUCH_PRO);
    if (pointer) mode = MODE_HAND_POINTER;
    s.mode = mode;
    s.targetRayValid = (flags & INPUT_TARGET_RAY_VALID) !== 0;
    s.gripValid = (flags & INPUT_GRIP_VALID) !== 0;
    s.palmValid = (flags & INPUT_PALM_VALID) !== 0;
    s.targetRay.set(v.targetRay);
    s.grip.set(v.grip);
    s.palm.set(v.palm);
    s.buttonValues.set(v.buttonValues);
    s.buttonPressed.set(v.buttonPressed);
    s.buttonTouched.set(v.buttonTouched);
    s.axes.set(v.axes);
    if (pointer) {
      // Pinch stays at button 0; the menu gesture moves from the controller slot to the hand gamepad's.
      s.buttonValues[HAND_MENU] = s.buttonValues[CONTROLLER_MENU];
      s.buttonPressed[HAND_MENU] = s.buttonPressed[CONTROLLER_MENU];
      s.buttonTouched[HAND_MENU] = s.buttonTouched[CONTROLLER_MENU];
      s.buttonValues[CONTROLLER_MENU] = 0;
      s.buttonPressed[CONTROLLER_MENU] = 0;
      s.buttonTouched[CONTROLLER_MENU] = 0;
    }
    if (mode === MODE_HAND) {
      s.joints.set(v.joints);
      s.jointValid.set(v.jointValid);
    }
  }
}
