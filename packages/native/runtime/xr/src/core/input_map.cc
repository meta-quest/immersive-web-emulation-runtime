#include "iwn/xr/input_map.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace iwn::xr {

namespace {

// HOST-INPUT controller slots.
enum ControllerSlot { kTrigger = 0, kSqueeze = 1, kStick = 3, kPrimary = 4, kSecondary = 5,
                      kThumbrest = 6, kMenu = 7 };
// HOST-INPUT hand slots.
enum HandSlot { kPinch = 0, kHandMenu = 4 };

constexpr int kIndexProximal = XR_HAND_JOINT_INDEX_PROXIMAL_EXT;  // 7
constexpr int kPalm = XR_HAND_JOINT_PALM_EXT;                   // 0

struct Buttons {
  float* value;
  uint8_t* pressed;
  uint8_t* touched;
  void set(int slot, float v, bool p, bool t) {
    value[slot] = v;
    pressed[slot] = p ? 1 : 0;
    touched[slot] = (t || p) ? 1 : 0;  // pressed implies touched (IN-3)
  }
};

float clamp01(float v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

}  // namespace

InputMode decide_mode(const ControllerSample& controller, InputProfile profile, bool hand_tracking_enabled,
                      const HandSample& hand) {
  if (controller.active && is_controller_profile(profile)) return InputMode::kController;
  if (hand.tracked) {
    if (hand_tracking_enabled) return InputMode::kHand;
    if (hand.aim.valid) return InputMode::kController;  // hand_pointer
  }
  return InputMode::kNone;
}

ControllerSample hand_pointer(const HandSample& hand) {
  ControllerSample c;
  c.active = true;
  c.aim = hand.aim;
  const XrHandJointLocationEXT& palm = hand.joints[kPalm];
  if (location_valid(palm.locationFlags)) c.grip = {palm.pose, true};
  c.trigger = hand.pinch_index;
  c.trigger_pressed = hand.pinching;
  c.trigger_touched = hand.pinching;
  c.menu_click = hand.menu_pressed;
  return c;
}

void resolve_input(HandInput& in, bool hand_tracking_enabled, bool focused) {
  in.mode = focused ? decide_mode(in.controller, in.profile, hand_tracking_enabled, in.hand) : InputMode::kNone;
  const bool held = in.controller.active && is_controller_profile(in.profile);
  if (in.mode == InputMode::kController && !held) in.controller = hand_pointer(in.hand);
}

void write_hand_input(FrameRecord& r, int i, const HandInput& in, bool left_menu_button) {
  Buttons b{r.at<float>(layout::kButtonValues[i]), r.at<uint8_t>(layout::kButtonPressed[i]),
            r.at<uint8_t>(layout::kButtonTouched[i])};
  std::memset(b.value, 0, layout::kButtonValuesCount * sizeof(float));
  std::memset(b.pressed, 0, layout::kButtonPressedCount);
  std::memset(b.touched, 0, layout::kButtonTouchedCount);
  float* axes = r.at<float>(layout::kAxes[i]);
  axes[0] = axes[1] = axes[2] = axes[3] = 0;

  r.set_u32(layout::kInputMode[i], static_cast<uint32_t>(in.mode));
  r.set_u32(layout::kInputProfile[i], static_cast<uint32_t>(in.profile));
  uint32_t flags = 0;

  if (in.mode == InputMode::kController) {
    const ControllerSample& c = in.controller;
    if (c.aim.valid) {
      r.write_pose(layout::kTargetRay[i], c.aim.pose);
      flags |= kInputTargetRayValid;
    }
    if (c.grip.valid) {
      r.write_pose(layout::kGrip[i], c.grip.pose);
      flags |= kInputGripValid;
    }
    // khr/simple_controller has only select/click (no analog value): a digital button reads 1 while pressed
    // (WebXR Gamepads Module).
    const float trigger = in.profile == InputProfile::kSimple ? (c.trigger_pressed ? 1.0f : 0.0f) : clamp01(c.trigger);
    b.set(kTrigger, trigger, c.trigger_pressed, c.trigger_touched);
    // Squeeze has no touch sensor on Touch controllers: touched while pressed or partly pulled.
    b.set(kSqueeze, clamp01(c.squeeze), c.squeeze_pressed, c.squeeze > 0.0f);
    b.set(kStick, c.stick_click ? 1.0f : 0.0f, c.stick_click, c.stick_touch);
    b.set(kPrimary, c.primary_click ? 1.0f : 0.0f, c.primary_click, c.primary_touch);
    b.set(kSecondary, c.secondary_click ? 1.0f : 0.0f, c.secondary_click, c.secondary_touch);
    b.set(kThumbrest, 0.0f, false, c.thumbrest_touch);
    if (i == 0 && left_menu_button) b.set(kMenu, c.menu_click ? 1.0f : 0.0f, c.menu_click, c.menu_click);
    axes[2] = std::clamp(c.stick_x, -1.0f, 1.0f);
    axes[3] = std::clamp(-c.stick_y, -1.0f, 1.0f);  // WebXR: +y toward the user
  } else if (in.mode == InputMode::kHand) {
    const HandSample& h = in.hand;
    float* joints = r.at<float>(layout::kJoints[i]);
    uint8_t* valid = r.at<uint8_t>(layout::kJointValid[i]);
    for (int j = 0; j < 25; ++j) {
      const XrHandJointLocationEXT& loc = h.joints[j + 1];  // WebXR joint j = OpenXR joint j + 1
      float* out = joints + j * 8;
      const bool ok = location_valid(loc.locationFlags);
      valid[j] = ok ? 1 : 0;
      if (ok) {
        out[0] = loc.pose.position.x;
        out[1] = loc.pose.position.y;
        out[2] = loc.pose.position.z;
        out[3] = loc.pose.orientation.x;
        out[4] = loc.pose.orientation.y;
        out[5] = loc.pose.orientation.z;
        out[6] = loc.pose.orientation.w;
        out[7] = loc.radius;
      }
    }
    const XrHandJointLocationEXT& palm = h.joints[kPalm];
    if (location_valid(palm.locationFlags)) {
      r.write_pose(layout::kPalm[i], palm.pose);
      flags |= kInputPalmValid;
    }
    if (h.aim.valid) {
      r.write_pose(layout::kTargetRay[i], h.aim.pose);
      flags |= kInputTargetRayValid;
    }
    // No grip pose for hands here: HOST-INPUT lets the palm stand in for it (gripValid false).
    b.set(kPinch, clamp01(h.pinch_index), h.pinching, h.pinching);
    b.set(kHandMenu, h.menu_pressed ? 1.0f : 0.0f, h.menu_pressed, h.menu_pressed);
    for (int g = 0; g < kHandGestureCount; ++g) {
      b.set(kHandGestureFirstButton + g, h.gestures[g] ? 1.0f : 0.0f, h.gestures[g], h.gestures[g]);
    }
  }
  r.set_u32(layout::kInputFlags[i], flags);
}

bool PinchDetector::update(const XrVector3f& a, const XrVector3f& b) {
  const float dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  const float d = std::sqrt(dx * dx + dy * dy + dz * dz);
  if (pressed_) {
    if (d > kReleaseMeters) pressed_ = false;
  } else if (d < kPressMeters) {
    pressed_ = true;
  }
  value_ = clamp01(1.0f - (d - 0.01f) / 0.04f);
  return pressed_;
}

PoseSample derive_aim(const XrHandJointLocationEXT joints[kOpenXrJoints]) {
  PoseSample out;
  const XrHandJointLocationEXT& palm = joints[kPalm];
  const XrHandJointLocationEXT& knuckle = joints[kIndexProximal];
  if (!location_valid(palm.locationFlags) || !location_valid(knuckle.locationFlags)) return out;
  out.pose.orientation = palm.pose.orientation;
  out.pose.position = knuckle.pose.position;
  out.valid = true;
  return out;
}

}  // namespace iwn::xr
