/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Real tracking -> the two XRHostInputState blocks of the frame record (docs/spec/09 XRF-IN-1..3, docs/spec/10
// IN-1..7; contract: packages/iwer/HOST-INPUT.md). V8-free and OpenXR-call-free: the Android side samples OpenXR
// actions and hand joints into ControllerSample / HandSample, and these functions turn them into the record's
// layout, so the mapping is unit-tested on the host.
//
// Gamepad layouts (HOST-INPUT.md):
//   controller: 0 trigger, 1 squeeze, 2 empty, 3 thumbstick, 4 A/X, 5 B/Y, 6 thumbrest, 7 menu (left only);
//               axes [touchpad x, touchpad y, thumbstick x, thumbstick y], +y toward the user (OpenXR is +y up).
//   hand:       0 index pinch, 1-3 empty, 4 menu (the system gesture's menu bit), 5 swipe left, 6 swipe right,
//               7 swipe forward, 8 swipe backward, 9 thumb tap (XR_META_hand_tracking_microgestures, the order Quest
//               Browser reports them in).
// `pressed` is decided here or by OpenXR's own boolean conversion of a /value input (threshold with hysteresis,
// OpenXR 1.1 §11.4: the same conversion Chromium-based Quest Browser gets), never by IWER (XRF-IN-3).
//
// Hands or controllers (IN-4) follow the interaction profile the runtime reports for the hand, as in Quest Browser:
// with XR_EXT_hand_interaction bindings suggested, Horizon OS reports /interaction_profiles/ext/hand_interaction_ext
// while the hand is used without a controller and a Touch profile while a controller is held. With no hand profile
// suggested it binds a tracked hand to khr/simple_controller instead, grip and aim actions active (seen on Quest 3S
// and Quest 3, 2026-10), while a Touch controller binds to a Touch profile, which is always suggested: on
// Horizon OS khr/simple_controller only ever means a tracked hand, never a held controller.
#pragma once

#include <cstdint>

#include "iwn/xr/frame_record.h"
#include "iwn/xr/openxr_headers.h"

namespace iwn::xr {

enum class InputMode : uint32_t { kNone = 0, kController = 1, kHand = 2 };

// Interaction profile the runtime reports for a hand (recorded in the record's inputProfile slot).
enum class InputProfile : uint32_t {
  kNone = 0,
  kOculusTouch = 1,      // /interaction_profiles/oculus/touch_controller
  kTouchPlus = 2,        // /interaction_profiles/meta/touch_controller_plus (Quest 3 / 3S)
  kTouchPro = 3,         // /interaction_profiles/facebook/touch_controller_pro
  kSimple = 4,           // /interaction_profiles/khr/simple_controller
  kHandInteraction = 5,  // /interaction_profiles/ext/hand_interaction_ext
};

// A profile a held controller is bound to (Touch, Touch Plus, Touch Pro). Not khr/simple_controller: on Horizon OS
// the runtime binds it only to tracked hands (see the top of this file).
inline bool is_controller_profile(InputProfile p) {
  return p == InputProfile::kOculusTouch || p == InputProfile::kTouchPlus || p == InputProfile::kTouchPro;
}

// XR_META_hand_tracking_microgestures inputs, in hand gamepad order (buttons 5..9).
enum HandGesture : int { kSwipeLeft = 0, kSwipeRight, kSwipeForward, kSwipeBackward, kTapThumb, kHandGestureCount };
inline constexpr int kHandGestureFirstButton = 5;

struct PoseSample {
  XrPosef pose{{0, 0, 0, 1}, {0, 0, 0}};
  bool valid = false;
};

// A pose is usable when both position and orientation are valid (IN-2).
inline bool location_valid(XrSpaceLocationFlags flags) {
  return (flags & XR_SPACE_LOCATION_POSITION_VALID_BIT) && (flags & XR_SPACE_LOCATION_ORIENTATION_VALID_BIT);
}

struct ControllerSample {
  bool active = false;  // the grip/aim pose actions are active for this hand
  PoseSample aim, grip;
  float trigger = 0;
  bool trigger_pressed = false;
  bool trigger_touched = false;
  float squeeze = 0;
  bool squeeze_pressed = false;
  float stick_x = 0, stick_y = 0;  // OpenXR sign: +y up / forward
  bool stick_click = false, stick_touch = false;
  bool primary_click = false, primary_touch = false;      // A (right) / X (left)
  bool secondary_click = false, secondary_touch = false;  // B (right) / Y (left)
  bool thumbrest_touch = false;
  bool menu_click = false;  // left controller only
};

inline constexpr int kOpenXrJoints = 26;  // XR_HAND_JOINT_COUNT_EXT: palm first, then the 25 WebXR joints

// A located hand counts as tracked when XR_EXT_hand_tracking reports it active and its wrist has a valid position: a
// hand without one has nothing to draw or point from, so it is not listed (Quest Browser drops such a hand too).
inline bool hand_tracked(bool is_active, const XrHandJointLocationEXT joints[kOpenXrJoints]) {
  return is_active && (joints[XR_HAND_JOINT_WRIST_EXT].locationFlags & XR_SPACE_LOCATION_POSITION_VALID_BIT) != 0;
}

struct HandSample {
  bool tracked = false;  // hand_tracked(): XrHandJointLocationsEXT::isActive and a valid wrist position
  XrHandJointLocationEXT joints[kOpenXrJoints]{};
  // XR_FB_hand_tracking_aim (absent: derived from the joints, see derive_aim / PinchDetector).
  bool has_aim_state = false;
  PoseSample aim;
  float pinch_index = 0;  // 0..1
  bool pinching = false;
  bool menu_pressed = false;
  // Microgesture clicks (HandGesture order): true for the frames the runtime reports the gesture as recognised
  // (Horizon OS holds each click about 35 ms), from boolean actions on the hand_interaction_ext profile.
  bool gestures[kHandGestureCount]{};
};

struct HandInput {
  InputMode mode = InputMode::kNone;
  InputProfile profile = InputProfile::kNone;
  ControllerSample controller;
  HandSample hand;
};

// IN-4, per hand: a held controller wins (a controller profile with active pose actions); otherwise a tracked hand
// (hand_tracked) is a hand when the session enabled hand tracking, and without hand tracking
// it still points: controller mode driven by the hand (see hand_pointer), as before XR_EXT_hand_interaction, when
// the runtime bound the hand to khr/simple_controller; otherwise none.
InputMode decide_mode(const ControllerSample& controller, InputProfile profile, bool hand_tracking_enabled,
                      const HandSample& hand);

// The controller sample of a tracked hand in a session without hand tracking (WebXR exposes no joints then):
// target ray = the hand's aim, grip = the palm, trigger = the index pinch, menu = the system gesture (left).
ControllerSample hand_pointer(const HandSample& hand);

// Sets in.mode (decide_mode; none while the session is not focused, when OpenXR leaves the actions inactive) and,
// when a tracked hand stands in for a pointer, replaces in.controller with hand_pointer(in.hand).
void resolve_input(HandInput& in, bool hand_tracking_enabled, bool focused);

// Writes hand `index` (0 left, 1 right) of the record. `left_menu_button` follows XRHostInputOptions.
void write_hand_input(FrameRecord& record, int index, const HandInput& in, bool left_menu_button = true);

// Fallback pinch (no XR_FB_hand_tracking_aim): thumb-tip to index-tip distance with hysteresis (documented in
// runtime/xr/README.md): pressed below 1.5 cm, released above 3.0 cm; value 1 at <= 1 cm, 0 at >= 5 cm.
class PinchDetector {
 public:
  static constexpr float kPressMeters = 0.015f;
  static constexpr float kReleaseMeters = 0.030f;
  // Updates from the two tip positions; returns the pressed state.
  bool update(const XrVector3f& thumb_tip, const XrVector3f& index_tip);
  bool pressed() const { return pressed_; }
  float value() const { return value_; }
  void reset() {
    pressed_ = false;
    value_ = 0;
  }

 private:
  bool pressed_ = false;
  float value_ = 0;
};

// Fallback target ray (no XR_FB_hand_tracking_aim): origin at the index finger's proximal joint, orientation of the
// palm (OpenXR joint axes: -Z toward the fingertips, +Y out of the back of the hand). Valid when both joints are.
PoseSample derive_aim(const XrHandJointLocationEXT joints[kOpenXrJoints]);

}  // namespace iwn::xr
