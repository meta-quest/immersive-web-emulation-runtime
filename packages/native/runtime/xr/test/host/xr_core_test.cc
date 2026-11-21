// Host tests for the V8-free XR core (HL-3): frame record layout and writer (XRF-1..5), input mapping (XRF-IN-1,
// IN-2..6), pacing (XR-LOOP-5, PERF-JS-3), perf-level policy (XR-PERF-1), session-lifetime policy (XR-LIFE-4/5/7),
// config parsing, the PNG writer (DBG-SHOT), the XR-thread/JS-thread handoff and the loading screen (XR-IDLE-1:
// when it is shown, the hand-over to the app's first frame, its placement, layout and spinner image).
#include <zlib.h>

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstring>
#include <thread>
#include <vector>

#include "iwn/core/json.h"
#include "iwn/xr/frame_record.h"
#include "iwn/xr/handoff.h"
#include "iwn/xr/input_map.h"
#include "iwn/xr/layers.h"
#include "iwn/xr/loading.h"
#include "iwn/xr/pacing.h"
#include "iwn/xr/perf_policy.h"
#include "iwn/xr/png.h"
#include "iwn/xr/session_policy.h"
#include "iwn/xr/xr_config.h"
#include "iwn_test.h"

using namespace iwn::xr;
namespace L = iwn::xr::layout;

namespace {

XrPosef pose(float x, float y, float z, float qx = 0, float qy = 0, float qz = 0, float qw = 1) {
  XrPosef p;
  p.position = {x, y, z};
  p.orientation = {qx, qy, qz, qw};
  return p;
}

bool near(double a, double b, double eps = 1e-6) { return std::fabs(a - b) <= eps; }

constexpr XrSpaceLocationFlags kValid = XR_SPACE_LOCATION_POSITION_VALID_BIT | XR_SPACE_LOCATION_ORIENTATION_VALID_BIT;

}  // namespace

// --- record ---------------------------------------------------------------------------------------------------------

IWN_TEST(Record, StartsWithLayoutVersionAndIsAligned) {
  FrameRecord r;
  IWN_CHECK_EQ(r.u32(L::kLayoutVersion), L::kVersion);
  IWN_CHECK_EQ(reinterpret_cast<uintptr_t>(r.data()) % L::kAlign, 0u);
  IWN_CHECK_EQ(FrameRecord::size(), L::kBytes);
  // identity defaults
  IWN_CHECK_EQ(r.f32(L::kLocalPose + 6 * 4), 1.0f);
  IWN_CHECK_EQ(r.f32(L::kTargetRay[1] + 6 * 4), 1.0f);
  IWN_CHECK_EQ(r.f32(L::kJoints[0] + (24 * 8 + 6) * 4), 1.0f);
}

IWN_TEST(Record, ViewsUseHostViewStride) {
  FrameRecord r;
  XrFovf fov{-0.82f, 0.76f, 0.85f, -0.93f};
  r.write_view(0, pose(-0.031f, 1.72f, 0.05f), fov);
  r.write_view(1, pose(0.031f, 1.72f, 0.05f, 0, 0.1f, 0, 0.995f), fov);
  const float* v = r.at<float>(L::kViews);
  IWN_CHECK(near(v[0], -0.031f));
  IWN_CHECK(near(v[1], 1.72f));
  IWN_CHECK(near(v[7], -0.82f));
  IWN_CHECK(near(v[10], -0.93f));
  IWN_CHECK(near(v[11], 0.031f));   // second view starts at 11 (HOST_VIEW_STRIDE)
  IWN_CHECK(near(v[15], 0.1f));     // its qy
  IWN_CHECK(near(v[21], -0.93f));
}

IWN_TEST(Record, HeaderFlagsAndSerial) {
  FrameRecord r;
  r.write_header(true, true, 2, 41, 2, 5000.25, 4990.5, 13.888, 72.0f, 2.0f / 3.0f);
  IWN_CHECK_EQ(r.u32(L::kFlags), kFlagShouldRender | kFlagBaseIsStage);
  IWN_CHECK_EQ(r.u32(L::kViewCount), 2u);
  IWN_CHECK_EQ(r.u32(L::kColorTexture), 41u);
  IWN_CHECK_EQ(r.u32(L::kImageArraySize), 2u);
  IWN_CHECK_EQ(r.f64(L::kPredictedDisplayTime), 5000.25);
  IWN_CHECK_EQ(r.f64(L::kFrameStartTime), 4990.5);
  IWN_CHECK(near(r.f32(L::kFrameRate), 72.0));
  r.write_header(false, false, 1, 0, 0, 1, 1, 1, 0, 0);
  IWN_CHECK_EQ(r.u32(L::kFlags), 0u);
  IWN_CHECK_EQ(r.next_serial(), 1u);
  IWN_CHECK_EQ(r.next_serial(), 2u);
  IWN_CHECK_EQ(r.u32(L::kFrameSerial), 2u);
}

IWN_TEST(Record, Float32PoseKeepsSubMillimetreAt50m) {
  // XRF-5: float32 positions at 50 m: the representable step is ~3.8 µm.
  FrameRecord r;
  r.write_pose(L::kLocalPose, pose(50.0005f, -49.9993f, 50.0001f));
  const float* p = r.at<float>(L::kLocalPose);
  IWN_CHECK(std::fabs(p[0] - 50.0005) < 1e-4);
  IWN_CHECK(std::fabs(p[1] + 49.9993) < 1e-4);
  IWN_CHECK(std::fabs(std::nextafter(50.0f, 51.0f) - 50.0f) < 1e-5);
}

// --- input ----------------------------------------------------------------------------------------------------------

IWN_TEST(Input, ControllerLayoutAndAxes) {
  FrameRecord r;
  HandInput in;
  in.mode = InputMode::kController;
  in.profile = InputProfile::kTouchPlus;
  ControllerSample& c = in.controller;
  c.active = true;
  c.aim = {pose(0.1f, 1.2f, -0.3f), true};
  c.grip = {pose(0.11f, 1.19f, -0.29f), false};
  c.trigger = 0.8f;
  c.trigger_pressed = true;
  c.squeeze = 0.2f;
  c.stick_x = 0.5f;
  c.stick_y = 0.25f;  // OpenXR +y forward
  c.stick_touch = true;
  c.primary_click = true;
  c.secondary_touch = true;
  c.thumbrest_touch = true;
  c.menu_click = true;
  write_hand_input(r, 0, in);
  IWN_CHECK_EQ(r.u32(L::kInputMode[0]), 1u);
  IWN_CHECK_EQ(r.u32(L::kInputProfile[0]), static_cast<uint32_t>(InputProfile::kTouchPlus));
  IWN_CHECK_EQ(r.u32(L::kInputFlags[0]), static_cast<uint32_t>(kInputTargetRayValid));
  const float* bv = r.at<float>(L::kButtonValues[0]);
  const uint8_t* bp = r.at<uint8_t>(L::kButtonPressed[0]);
  const uint8_t* bt = r.at<uint8_t>(L::kButtonTouched[0]);
  IWN_CHECK(near(bv[0], 0.8f));
  IWN_CHECK_EQ(bp[0], 1);
  IWN_CHECK_EQ(bt[0], 1);  // pressed implies touched
  IWN_CHECK(near(bv[1], 0.2f));
  IWN_CHECK_EQ(bp[1], 0);
  IWN_CHECK_EQ(bt[1], 1);  // squeeze partly pulled counts as touched
  IWN_CHECK_EQ(bt[3], 1);  // thumbstick touched, not pressed
  IWN_CHECK_EQ(bp[3], 0);
  IWN_CHECK_EQ(bp[4], 1);  // X
  IWN_CHECK_EQ(bt[5], 1);  // Y touched
  IWN_CHECK_EQ(bp[5], 0);
  IWN_CHECK_EQ(bt[6], 1);  // thumbrest
  IWN_CHECK_EQ(bp[6], 0);
  IWN_CHECK_EQ(bp[7], 1);  // left menu
  const float* axes = r.at<float>(L::kAxes[0]);
  IWN_CHECK(near(axes[0], 0) && near(axes[1], 0));
  IWN_CHECK(near(axes[2], 0.5f));
  IWN_CHECK(near(axes[3], -0.25f));  // WebXR: +y toward the user
  const float* ray = r.at<float>(L::kTargetRay[0]);
  IWN_CHECK(near(ray[0], 0.1f) && near(ray[2], -0.3f));

  // the right controller has no menu slot; the left one omits it when leftMenuButton is false
  write_hand_input(r, 1, in);
  IWN_CHECK_EQ(r.at<uint8_t>(L::kButtonPressed[1])[7], 0);
  write_hand_input(r, 0, in, false);
  IWN_CHECK_EQ(r.at<uint8_t>(L::kButtonPressed[0])[7], 0);
}

IWN_TEST(Input, SimpleControllerSelectIsADigitalButton) {
  // khr/simple_controller binds only select/click: pressed reads value 1, released 0 (no analog trigger value).
  FrameRecord r;
  HandInput in;
  in.mode = InputMode::kController;
  in.profile = InputProfile::kSimple;
  in.controller.active = true;
  in.controller.trigger_pressed = true;
  write_hand_input(r, 1, in);
  IWN_CHECK_EQ(r.at<uint8_t>(L::kButtonPressed[1])[0], 1);
  IWN_CHECK(near(r.at<float>(L::kButtonValues[1])[0], 1.0f));
  in.controller.trigger_pressed = false;
  write_hand_input(r, 1, in);
  IWN_CHECK(near(r.at<float>(L::kButtonValues[1])[0], 0.0f));
  // a Touch trigger keeps its analog value (pressed by OpenXR's threshold below 1)
  in.profile = InputProfile::kTouchPlus;
  in.controller.trigger = 0.62f;
  in.controller.trigger_pressed = true;
  write_hand_input(r, 1, in);
  IWN_CHECK(near(r.at<float>(L::kButtonValues[1])[0], 0.62f));
}

IWN_TEST(Input, HandJointsAreOpenXrPlusOneAndPalmSeparate) {
  FrameRecord r;
  HandInput in;
  in.mode = InputMode::kHand;
  HandSample& h = in.hand;
  h.tracked = true;
  for (int j = 0; j < kOpenXrJoints; ++j) {
    h.joints[j].locationFlags = kValid;
    h.joints[j].pose = pose(static_cast<float>(j), 0, 0);
    h.joints[j].radius = 0.001f * static_cast<float>(j);
  }
  h.joints[3].locationFlags = XR_SPACE_LOCATION_POSITION_VALID_BIT;  // orientation invalid: untracked joint
  h.aim = {pose(1, 2, 3), true};
  h.pinch_index = 0.9f;
  h.pinching = true;
  h.menu_pressed = true;
  write_hand_input(r, 1, in);
  IWN_CHECK_EQ(r.u32(L::kInputMode[1]), 2u);
  IWN_CHECK_EQ(r.u32(L::kInputFlags[1]), static_cast<uint32_t>(kInputTargetRayValid | kInputPalmValid));
  const float* joints = r.at<float>(L::kJoints[1]);
  const uint8_t* valid = r.at<uint8_t>(L::kJointValid[1]);
  IWN_CHECK(near(joints[0], 1.0f));              // WebXR wrist = OpenXR joint 1
  IWN_CHECK(near(joints[24 * 8], 25.0f));        // WebXR little tip = OpenXR joint 25
  IWN_CHECK(near(joints[24 * 8 + 7], 0.025f));   // radius passed through
  IWN_CHECK_EQ(valid[2], 0);                     // OpenXR joint 3
  IWN_CHECK_EQ(valid[3], 1);
  const float* palm = r.at<float>(L::kPalm[1]);
  IWN_CHECK(near(palm[0], 0.0f));  // OpenXR joint 0
  const float* bv = r.at<float>(L::kButtonValues[1]);
  const uint8_t* bp = r.at<uint8_t>(L::kButtonPressed[1]);
  IWN_CHECK(near(bv[0], 0.9f));
  IWN_CHECK_EQ(bp[0], 1);
  IWN_CHECK_EQ(bp[4], 1);  // menu at 4 in the hand layout
  IWN_CHECK_EQ(bp[1] + bp[2] + bp[3], 0);
}

IWN_TEST(Input, ModeDecision) {
  ControllerSample c;
  HandSample h;
  IWN_CHECK(decide_mode(c, InputProfile::kNone, true, h) == InputMode::kNone);
  h.tracked = true;
  IWN_CHECK(decide_mode(c, InputProfile::kNone, true, h) == InputMode::kHand);
  IWN_CHECK(decide_mode(c, InputProfile::kNone, false, h) == InputMode::kNone);  // no hand-tracking, no aim: nothing
  c.active = true;
  IWN_CHECK(decide_mode(c, InputProfile::kTouchPlus, true, h) == InputMode::kController);
  // a hand-interaction profile is not a controller even when its pose actions are active
  IWN_CHECK(decide_mode(c, InputProfile::kHandInteraction, true, h) == InputMode::kHand);
}

IWN_TEST(Input, HeldControllerWinsOverATrackedHand) {
  ControllerSample c;
  c.active = true;
  HandSample h;
  h.tracked = true;
  h.aim.valid = true;
  for (InputProfile p : {InputProfile::kOculusTouch, InputProfile::kTouchPlus, InputProfile::kTouchPro}) {
    IWN_CHECK(decide_mode(c, p, true, h) == InputMode::kController);
    IWN_CHECK(decide_mode(c, p, false, h) == InputMode::kController);
  }
  // a controller profile whose pose actions are inactive holds no controller: the tracked hand shows
  c.active = false;
  IWN_CHECK(decide_mode(c, InputProfile::kTouchPlus, true, h) == InputMode::kHand);
  h.tracked = false;
  IWN_CHECK(decide_mode(c, InputProfile::kTouchPlus, true, h) == InputMode::kNone);
}

IWN_TEST(Input, SimpleControllerProfileIsTheRuntimesHandFallback) {
  // Seen on a headset: Horizon OS bound tracked hands to khr/simple_controller (its hand device's fallback when no hand
  // profile is suggested) with active grip/aim actions, and the runtime showed controllers following the hands.
  // khr/simple_controller never means a held controller on Horizon OS: a tracked hand shows as a hand.
  IWN_CHECK(!is_controller_profile(InputProfile::kSimple));
  IWN_CHECK(!is_controller_profile(InputProfile::kHandInteraction));
  IWN_CHECK(!is_controller_profile(InputProfile::kNone));
  ControllerSample c;
  c.active = true;  // the runtime drives the profile's grip/aim actions from the hand
  HandSample h;
  h.tracked = true;
  IWN_CHECK(decide_mode(c, InputProfile::kSimple, true, h) == InputMode::kHand);
  h.tracked = false;
  IWN_CHECK(decide_mode(c, InputProfile::kSimple, true, h) == InputMode::kNone);
}

IWN_TEST(Input, HandWithoutSessionHandTrackingIsAPointer) {
  // A session without 'hand-tracking' gets no joints, but a tracked hand still points and selects (as it did through
  // khr/simple_controller): controller mode with the hand's aim, palm, pinch and system gesture.
  HandInput in;
  in.profile = InputProfile::kHandInteraction;
  in.controller.active = true;  // hand_interaction_ext's grip/aim actions
  in.controller.trigger = 0.3f; // stale values must not survive
  HandSample& h = in.hand;
  h.tracked = true;
  h.aim = {pose(0.2f, 1.1f, -0.4f), true};
  h.joints[XR_HAND_JOINT_PALM_EXT].locationFlags = kValid;
  h.joints[XR_HAND_JOINT_PALM_EXT].pose = pose(0.21f, 1.05f, -0.35f);
  h.joints[XR_HAND_JOINT_WRIST_EXT].locationFlags = kValid;
  h.pinch_index = 0.95f;
  h.pinching = true;
  h.menu_pressed = true;
  h.gestures[kSwipeLeft] = true;
  resolve_input(in, /*hand_tracking_enabled=*/false, /*focused=*/true);
  IWN_CHECK(in.mode == InputMode::kController);
  IWN_CHECK(in.controller.active);
  IWN_CHECK(in.controller.aim.valid && near(in.controller.aim.pose.position.z, -0.4f));
  IWN_CHECK(in.controller.grip.valid && near(in.controller.grip.pose.position.y, 1.05f));
  IWN_CHECK(near(in.controller.trigger, 0.95f));
  IWN_CHECK(in.controller.trigger_pressed);
  IWN_CHECK(in.controller.menu_click);
  FrameRecord r;
  write_hand_input(r, 0, in);
  IWN_CHECK_EQ(r.u32(L::kInputMode[0]), 1u);
  IWN_CHECK_EQ(r.u32(L::kInputFlags[0]), static_cast<uint32_t>(kInputTargetRayValid | kInputGripValid));
  const uint8_t* bp = r.at<uint8_t>(L::kButtonPressed[0]);
  IWN_CHECK_EQ(bp[0], 1);  // select
  IWN_CHECK_EQ(bp[7], 1);  // left controller menu slot
  IWN_CHECK_EQ(bp[5], 0);  // no gesture slots in the controller layout (5 is B/Y)
  IWN_CHECK_EQ(r.at<uint8_t>(L::kJointValid[0])[0], 0);  // no joints without hand-tracking
  // no aim: nothing to point with
  in.hand.aim.valid = false;
  in.controller = ControllerSample{};
  in.controller.active = true;
  resolve_input(in, false, true);
  IWN_CHECK(in.mode == InputMode::kNone);
}

IWN_TEST(Input, AHandWithoutAWristPositionIsNotTracked) {
  // An active hand whose wrist has no valid position has no joints to draw and nothing to point from: it is not
  // listed, neither as a hand nor as a pointer (the runtime can report such a hand as active).
  XrHandJointLocationEXT joints[kOpenXrJoints]{};
  for (XrHandJointLocationEXT& j : joints) j.locationFlags = kValid;
  IWN_CHECK(hand_tracked(true, joints));
  IWN_CHECK(!hand_tracked(false, joints));
  joints[XR_HAND_JOINT_WRIST_EXT].locationFlags = XR_SPACE_LOCATION_ORIENTATION_VALID_BIT;
  IWN_CHECK(!hand_tracked(true, joints));
  joints[XR_HAND_JOINT_WRIST_EXT].locationFlags = 0;
  IWN_CHECK(!hand_tracked(true, joints));
  // the wrist alone decides: a valid wrist with the other joints lost is still a tracked hand
  for (XrHandJointLocationEXT& j : joints) j.locationFlags = 0;
  joints[XR_HAND_JOINT_WRIST_EXT].locationFlags = XR_SPACE_LOCATION_POSITION_VALID_BIT;
  IWN_CHECK(hand_tracked(true, joints));

  HandInput in;
  in.profile = InputProfile::kHandInteraction;
  in.controller.active = true;
  in.hand.aim = {pose(0, 1, -0.3f), true};
  joints[XR_HAND_JOINT_WRIST_EXT].locationFlags = XR_SPACE_LOCATION_ORIENTATION_VALID_BIT;
  in.hand.tracked = hand_tracked(true, joints);
  for (bool hand_tracking : {true, false}) {
    resolve_input(in, hand_tracking, true);
    IWN_CHECK(in.mode == InputMode::kNone);
    FrameRecord r;
    write_hand_input(r, 1, in);
    IWN_CHECK_EQ(r.u32(L::kInputMode[1]), 0u);
    IWN_CHECK_EQ(r.u32(L::kInputFlags[1]), 0u);
  }
}

IWN_TEST(Input, ResolveKeepsAHeldControllersSampleAndIdlesWhenNotFocused) {
  HandInput in;
  in.profile = InputProfile::kTouchPlus;
  in.controller.active = true;
  in.controller.trigger = 0.7f;
  in.controller.trigger_pressed = true;
  in.controller.stick_x = 0.4f;
  in.hand.tracked = true;  // never located while a controller is held, but even if it were
  in.hand.aim.valid = true;
  resolve_input(in, true, true);
  IWN_CHECK(in.mode == InputMode::kController);
  IWN_CHECK(near(in.controller.trigger, 0.7f) && near(in.controller.stick_x, 0.4f));
  resolve_input(in, true, false);  // not focused: OpenXR's actions are inactive, nothing is listed
  IWN_CHECK(in.mode == InputMode::kNone);
}

IWN_TEST(Input, ControllersDownHandsUpAndBackAgain) {
  // IN-4 transitions as the runtime reports them with hand_interaction_ext suggested: the profile follows what the
  // hand is doing; the hand tracker is active only while no controller is held.
  struct Frame {
    InputProfile profile;
    bool pose_actions;
    bool hand_tracked;
    InputMode want;
  };
  const Frame frames[] = {
      {InputProfile::kTouchPlus, true, false, InputMode::kController},       // holding the controller
      {InputProfile::kTouchPlus, false, false, InputMode::kNone},            // set down: tracking drops
      {InputProfile::kHandInteraction, true, true, InputMode::kHand},        // the runtime switches to hands
      {InputProfile::kHandInteraction, true, false, InputMode::kNone},       // hand out of view
      {InputProfile::kHandInteraction, true, true, InputMode::kHand},        // back in view
      {InputProfile::kTouchPlus, true, false, InputMode::kController},       // picked up again
      {InputProfile::kHandInteraction, true, true, InputMode::kHand},        // and down again
  };
  for (const Frame& f : frames) {
    HandInput in;
    in.profile = f.profile;
    in.controller.active = f.pose_actions;
    in.hand.tracked = f.hand_tracked;
    in.hand.aim.valid = f.hand_tracked;
    resolve_input(in, true, true);
    IWN_CHECK(in.mode == f.want);
  }
}

IWN_TEST(Input, HandGestureButtonsFiveToNine) {
  // XR_META_hand_tracking_microgestures in Quest Browser's hand gamepad order: 5 swipe left, 6 swipe right,
  // 7 swipe forward, 8 swipe backward, 9 thumb tap; pressed (value 1, touched) only for the frames the runtime
  // reports the gesture.
  FrameRecord r;
  HandInput in;
  in.mode = InputMode::kHand;
  in.profile = InputProfile::kHandInteraction;
  in.hand.tracked = true;
  for (int g = 0; g < kHandGestureCount; ++g) {
    in.hand.gestures[g] = true;
    write_hand_input(r, 1, in);
    const float* bv = r.at<float>(L::kButtonValues[1]);
    const uint8_t* bp = r.at<uint8_t>(L::kButtonPressed[1]);
    const uint8_t* bt = r.at<uint8_t>(L::kButtonTouched[1]);
    for (int b = 0; b < 10; ++b) {
      const bool want = b == 5 + g;
      IWN_CHECK_EQ(bp[b], want ? 1 : 0);
      IWN_CHECK_EQ(bt[b], want ? 1 : 0);
      IWN_CHECK(near(bv[b], want ? 1.0f : 0.0f));
    }
    in.hand.gestures[g] = false;
  }
  IWN_CHECK_EQ(kSwipeLeft, 0);
  IWN_CHECK_EQ(kTapThumb, 4);
  // with pinch and menu at once: 0 and 4 keep their meaning next to a gesture
  in.hand.pinch_index = 1.0f;
  in.hand.pinching = true;
  in.hand.menu_pressed = true;
  in.hand.gestures[kSwipeForward] = true;
  write_hand_input(r, 0, in);
  const uint8_t* bp = r.at<uint8_t>(L::kButtonPressed[0]);
  IWN_CHECK(bp[0] == 1 && bp[4] == 1 && bp[7] == 1);
  IWN_CHECK(bp[1] + bp[2] + bp[3] + bp[5] + bp[6] + bp[8] + bp[9] == 0);
  // released the next frame: the slot clears
  in.hand.gestures[kSwipeForward] = false;
  write_hand_input(r, 0, in);
  IWN_CHECK_EQ(r.at<uint8_t>(L::kButtonPressed[0])[7], 0);
  // the controller layout never carries gestures (its slot 7 is the left menu)
  in.mode = InputMode::kController;
  in.hand.gestures[kSwipeForward] = true;
  write_hand_input(r, 1, in);
  IWN_CHECK_EQ(r.at<uint8_t>(L::kButtonPressed[1])[7], 0);
}

IWN_TEST(Input, NoneClearsButtonsAndFlags) {
  FrameRecord r;
  HandInput in;
  in.mode = InputMode::kController;
  in.controller.active = true;
  in.controller.trigger = 1;
  in.controller.trigger_pressed = true;
  in.controller.aim.valid = true;
  write_hand_input(r, 0, in);
  in.mode = InputMode::kNone;
  write_hand_input(r, 0, in);
  IWN_CHECK_EQ(r.u32(L::kInputMode[0]), 0u);
  IWN_CHECK_EQ(r.u32(L::kInputFlags[0]), 0u);
  IWN_CHECK_EQ(r.at<uint8_t>(L::kButtonPressed[0])[0], 0);
  IWN_CHECK_EQ(r.f32(L::kButtonValues[0]), 0.0f);
}

IWN_TEST(Input, PinchHysteresis) {
  PinchDetector p;
  XrVector3f thumb{0, 0, 0};
  IWN_CHECK(!p.update(thumb, {0.02f, 0, 0}));  // 2 cm: not yet
  IWN_CHECK(p.update(thumb, {0.012f, 0, 0}));  // 1.2 cm: pressed
  IWN_CHECK(p.update(thumb, {0.025f, 0, 0}));  // 2.5 cm: still pressed (release at 3 cm)
  IWN_CHECK(!p.update(thumb, {0.031f, 0, 0}));
  IWN_CHECK(p.value() > 0.0f && p.value() < 1.0f);
  p.update(thumb, {0.005f, 0, 0});
  IWN_CHECK(near(p.value(), 1.0f));
}

IWN_TEST(Input, DerivedAim) {
  XrHandJointLocationEXT joints[kOpenXrJoints]{};
  IWN_CHECK(!derive_aim(joints).valid);
  joints[XR_HAND_JOINT_PALM_EXT].locationFlags = kValid;
  joints[XR_HAND_JOINT_PALM_EXT].pose = pose(0, 1, 0, 0, 0.7071f, 0, 0.7071f);
  joints[XR_HAND_JOINT_INDEX_PROXIMAL_EXT].locationFlags = kValid;
  joints[XR_HAND_JOINT_INDEX_PROXIMAL_EXT].pose = pose(0.05f, 1.02f, -0.08f);
  PoseSample a = derive_aim(joints);
  IWN_CHECK(a.valid);
  IWN_CHECK(near(a.pose.position.z, -0.08f));
  IWN_CHECK(near(a.pose.orientation.y, 0.7071f));
}

// --- pacing ---------------------------------------------------------------------------------------------------------

IWN_TEST(Pacing, MissedPeriodsAndStrictTimes) {
  FramePacing p;
  const int64_t period = 13888889;  // 72 Hz
  IWN_CHECK_EQ(p.observe(1000000000, period), 0);
  IWN_CHECK_EQ(p.observe(1000000000 + period, period), 0);
  IWN_CHECK_EQ(p.observe(1000000000 + 3 * period, period), 1);
  IWN_CHECK_EQ(p.observe(1000000000 + 3 * period + period + 1000, period), 0);  // jitter
  IWN_CHECK_EQ(p.missed(), 1u);
  IWN_CHECK_EQ(p.frames(), 4u);
  double a = p.strictly_increasing(100.0);
  double b = p.strictly_increasing(100.0);
  double c = p.strictly_increasing(99.0);
  IWN_CHECK(a == 100.0 && b > a && c > b);
}

IWN_TEST(Pacing, ClockConversion) {
  XrClock clk;
  clk.calibrate(1234.5, 5000000000LL);
  IWN_CHECK(near(clk.to_perf_ms(5013888889LL), 1234.5 + 13.888889, 1e-6));
  IWN_CHECK_EQ(clk.to_xr_ns(1234.5), 5000000000LL);
}

IWN_TEST(Pacing, TaskBudget) {
  IWN_CHECK(near(task_budget_ms(100, 110), 8.0));        // capped
  IWN_CHECK(near(task_budget_ms(100, 105), 4.0));        // slack - 1 ms
  IWN_CHECK(near(task_budget_ms(100, 101.5), 1.0));      // floor
  IWN_CHECK(near(task_budget_ms(100, 90), 1.0));         // late
}

// --- perf policy ----------------------------------------------------------------------------------------------------

IWN_TEST(Perf, StartsAtConfiguredLevelsAndRaisesTheLimitingDomain) {
  PerfPolicy p;  // CPU sustained low, GPU default
  IWN_CHECK(p.cpu() == PerfLevel::kSustainedLow);
  IWN_CHECK(p.gpu() == PerfLevel::kUnset);
  double t = 0;
  // steady, GPU-bound (JS 6 ms of 13.9): no change
  for (int i = 0; i < 100; ++i) IWN_CHECK(!p.on_frame(t += 13.9, 0, 6.0, 13.9).any());
  // three misses inside a second -> GPU raised from the runtime default
  p.on_frame(t += 27.8, 1, 6.0, 13.9);
  p.on_frame(t += 27.8, 1, 6.0, 13.9);
  PerfPolicy::Change c = p.on_frame(t += 27.8, 1, 6.0, 13.9);
  IWN_CHECK(c.gpu && !c.cpu);
  IWN_CHECK(p.gpu() == PerfLevel::kSustainedHigh);
  // CPU-bound misses after the cooldown raise the CPU
  for (int i = 0; i < 200; ++i) p.on_frame(t += 13.9, 0, 13.0, 13.9);
  p.on_frame(t += 27.8, 1, 13.0, 13.9);
  p.on_frame(t += 27.8, 1, 13.0, 13.9);
  c = p.on_frame(t += 27.8, 1, 13.0, 13.9);
  IWN_CHECK(c.cpu);
  IWN_CHECK(p.cpu() == PerfLevel::kSustainedHigh);
  // at the maxima nothing more happens
  for (int i = 0; i < 200; ++i) p.on_frame(t += 13.9, 0, 13.0, 13.9);
  p.on_frame(t += 27.8, 1, 13.0, 13.9);
  p.on_frame(t += 27.8, 1, 13.0, 13.9);
  IWN_CHECK(!p.on_frame(t += 27.8, 1, 13.0, 13.9).any());
  // 10 s of headroom steps back toward the start, never below it
  for (int i = 0; i < 3000; ++i) p.on_frame(t += 13.9, 0, 3.0, 13.9);
  IWN_CHECK(p.cpu() == PerfLevel::kSustainedLow);
  IWN_CHECK(p.gpu() == PerfLevel::kSustainedLow);  // gpu floor after leaving the runtime default
  IWN_CHECK(p.lowers() >= 2u);
}

IWN_TEST(Perf, SpreadOutMissesDoNotRaise) {
  PerfPolicy p;
  double t = 0;
  for (int i = 0; i < 20; ++i) {
    IWN_CHECK(!p.on_frame(t += 1500, 1, 5, 13.9).any());  // one miss every 1.5 s
  }
  PerfPolicyConfig fixed;
  fixed.adaptive = false;
  PerfPolicy q(fixed);
  for (int i = 0; i < 20; ++i) IWN_CHECK(!q.on_frame(t += 10, 2, 5, 13.9).any());
}

IWN_TEST(Perf, WarmupMissesAreIgnored) {
  PerfPolicy p;
  double t = 1000;
  p.restart_warmup(t);
  // a first-frame stall right after the session started: many misses, no raise
  for (int i = 0; i < 10; ++i) IWN_CHECK(!p.on_frame(t += 100, 5, 6.0, 13.9).any());
  // after the warm-up the same misses raise
  t += 3000;
  p.on_frame(t += 27.8, 1, 6.0, 13.9);
  p.on_frame(t += 27.8, 1, 6.0, 13.9);
  IWN_CHECK(p.on_frame(t += 27.8, 1, 6.0, 13.9).gpu);
}

IWN_TEST(Perf, RelapseAfterAStepDownDoublesTheHeadroom) {
  PerfPolicy p;
  double t = 0;
  auto three_misses = [&] {
    p.on_frame(t += 27.8, 1, 6.0, 13.9);
    p.on_frame(t += 27.8, 1, 6.0, 13.9);
    return p.on_frame(t += 27.8, 1, 6.0, 13.9);
  };
  auto idle = [&](double ms) {
    PerfPolicy::Change last;
    for (double end = t + ms; t < end;) {
      PerfPolicy::Change c = p.on_frame(t += 13.9, 0, 6.0, 13.9);
      if (c.any()) last = c;
    }
    return last;
  };
  IWN_CHECK(three_misses().gpu);                 // default -> sustained high
  IWN_CHECK_EQ(p.headroom_ms(), 10000.0);
  IWN_CHECK(idle(10500).gpu);                    // headroom: down to the floor
  IWN_CHECK(p.gpu() == PerfLevel::kSustainedLow);
  idle(5000);
  IWN_CHECK(three_misses().gpu);                 // relapse 5 s after the step down
  IWN_CHECK_EQ(p.headroom_ms(), 20000.0);
  IWN_CHECK(!idle(15000).any());                 // 10 s is no longer enough
  IWN_CHECK(idle(6000).gpu);                     // 20 s is
  idle(40000);                                   // a raise long after the step down starts over
  IWN_CHECK(three_misses().gpu);
  IWN_CHECK_EQ(p.headroom_ms(), 10000.0);
}

IWN_TEST(Perf, ParseLevels) {
  IWN_CHECK(parse_perf_level("sustained-high", PerfLevel::kBoost) == PerfLevel::kSustainedHigh);
  IWN_CHECK(parse_perf_level("default", PerfLevel::kBoost) == PerfLevel::kUnset);
  IWN_CHECK(parse_perf_level("nope", PerfLevel::kBoost) == PerfLevel::kBoost);
  IWN_CHECK_EQ(std::string(perf_level_name(PerfLevel::kPowerSavings)), std::string("power-savings"));
}

// --- session policy -------------------------------------------------------------------------------------------------

IWN_TEST(Session, VisibilityMapping) {
  IWN_CHECK_EQ(std::string(web_visibility(visibility_for(XR_SESSION_STATE_FOCUSED))), std::string("visible"));
  IWN_CHECK_EQ(std::string(web_visibility(visibility_for(XR_SESSION_STATE_VISIBLE))), std::string("visible-blurred"));
  IWN_CHECK_EQ(std::string(web_visibility(visibility_for(XR_SESSION_STATE_SYNCHRONIZED))), std::string("hidden"));
  IWN_CHECK_EQ(std::string(web_visibility(visibility_for(XR_SESSION_STATE_STOPPING))), std::string("hidden"));
  IWN_CHECK(frame_loop_state(XR_SESSION_STATE_SYNCHRONIZED));
  IWN_CHECK(!frame_loop_state(XR_SESSION_STATE_READY));
}

IWN_TEST(Session, NeverOfferedLogsThenExits) {
  LifePolicy p;
  p.on_xr_visible(true, 0);
  p.on_entry_evaluated(1000);
  IWN_CHECK(p.tick(5000).action == LifePolicy::Action::kNone);
  IWN_CHECK(p.tick(11000).action == LifePolicy::Action::kLogNeverOffered);
  IWN_CHECK(p.tick(12000).action == LifePolicy::Action::kNone);  // once
  IWN_CHECK(p.tick(31000).action == LifePolicy::Action::kRequestExit);
  IWN_CHECK(p.tick(40000).action == LifePolicy::Action::kNone);
}

IWN_TEST(Session, NeverOfferedDebugBuildStays) {
  LifePolicyConfig c;
  c.debug_endpoint = true;
  LifePolicy p(c);
  p.on_entry_evaluated(0);
  IWN_CHECK(p.tick(10000).action == LifePolicy::Action::kLogNeverOffered);
  IWN_CHECK(p.tick(60000).action == LifePolicy::Action::kNone);
}

IWN_TEST(Session, HeldOfferCountsAsOffered) {
  LifePolicy p;
  p.on_entry_evaluated(0);
  p.on_offered(100);
  IWN_CHECK(p.tick(60000).action == LifePolicy::Action::kNone);
}

IWN_TEST(Session, RejectedRequestsDoNotCountAsOffered) {
  // The app's only request is rejected (a required feature the runtime does not grant): XR-LIFE-7's error line
  // and exit still come, counted from the entry evaluation, with the rejection named as the reason.
  LifePolicy p;
  p.on_xr_visible(true, 0);
  p.on_entry_evaluated(1000);
  p.on_offered(2000);
  IWN_CHECK(p.tick(12000).action == LifePolicy::Action::kNone);  // pending: counts as offered
  p.on_offer_rejected(12500);
  IWN_CHECK(p.offers_rejected());
  LifePolicy::Result r = p.tick(12600);
  IWN_CHECK(r.action == LifePolicy::Action::kLogNeverOffered);
  IWN_CHECK(std::string(r.reason).find("rejected") != std::string::npos);
  IWN_CHECK(p.tick(30500).action == LifePolicy::Action::kNone);
  IWN_CHECK(p.tick(31000).action == LifePolicy::Action::kRequestExit);

  // a later request is pending again: no exit while it is
  LifePolicy q;
  q.on_entry_evaluated(0);
  q.on_offered(100);
  q.on_offer_rejected(200);
  q.on_offered(5000);
  IWN_CHECK(q.tick(60000).action == LifePolicy::Action::kNone);

  // once the page had a session, XR-LIFE-5's grace period applies (counted from the rejection), not XR-LIFE-7's
  LifePolicy s;
  s.on_xr_visible(true, 0);
  s.on_entry_evaluated(0);
  s.on_session_started(100);
  s.on_session_ended(1000);
  s.on_offer_rejected(1100);
  IWN_CHECK(!s.offers_rejected());
  IWN_CHECK(s.tick(3000).action == LifePolicy::Action::kNone);
  IWN_CHECK(s.tick(3100).action == LifePolicy::Action::kRequestExit);
}

IWN_TEST(Session, EndGracePeriod) {
  LifePolicy p;
  p.on_xr_visible(true, 0);
  p.on_entry_evaluated(0);
  p.on_session_started(100);
  p.on_session_ended(5000);
  IWN_CHECK(p.tick(6000).action == LifePolicy::Action::kNone);
  p.on_session_started(6500);  // re-entered within the grace period
  IWN_CHECK(p.tick(9000).action == LifePolicy::Action::kNone);
  p.on_session_ended(10000);
  IWN_CHECK(p.tick(11999).action == LifePolicy::Action::kNone);
  IWN_CHECK(p.tick(12000).action == LifePolicy::Action::kRequestExit);
}

// PROC-8: location.reload() (or DevTools Page.reload) ends the old page's session; the new page needs longer than
// the 2 s end grace period to boot and offer again (the showcase: ~4.7 s). Its timers are XR-LIFE-7's, counted from
// its own load; the end grace never runs for it.
IWN_TEST(Session, ReloadStartsTheTimersOver) {
  using A = LifePolicy::Action;
  LifePolicy p;  // a release build (no debug endpoint)
  p.on_xr_visible(true, 0);
  p.on_entry_evaluated(2700);
  p.on_offered(5000);
  p.on_session_started(5100);
  // reload at 30 s: the binding ends the old page's session, then the new page starts
  p.on_session_ended(30000);
  p.on_page_started(30000);
  IWN_CHECK(p.tick(31000).action == A::kNone);
  p.on_entry_evaluated(31800);  // the new page's load
  IWN_CHECK(p.tick(32100).action == A::kNone);  // past the end grace period
  IWN_CHECK(p.tick(34600).action == A::kNone);
  IWN_CHECK(!p.ever_offered());  // the old page's offer does not count for the new one
  IWN_CHECK(p.tick(41700).action == A::kNone);
  LifePolicy::Result r = p.tick(41800);  // 10 s after the new page's load: its own error line
  IWN_CHECK(r.action == A::kLogNeverOffered);
  IWN_CHECK(p.tick(61700).action == A::kNone);
  IWN_CHECK(p.tick(61800).action == A::kRequestExit);

  // the same reload, the new page offers 4.7 s later and gets its session: it keeps running
  LifePolicy q;
  q.on_xr_visible(true, 0);
  q.on_entry_evaluated(2700);
  q.on_offered(5000);
  q.on_session_started(5100);
  q.on_session_ended(30000);
  q.on_page_started(30000);
  q.on_entry_evaluated(31800);
  IWN_CHECK(q.tick(34000).action == A::kNone);
  q.on_offered(34700);
  q.on_session_started(34750);
  for (double t = 35000; t <= 120000; t += 5000) IWN_CHECK(q.tick(t).action == A::kNone);
  // and once that session ends, XR-LIFE-5 applies to the new page as usual
  q.on_session_ended(130000);
  IWN_CHECK(q.tick(131999).action == A::kNone);
  IWN_CHECK(q.tick(132000).action == A::kRequestExit);
}

IWN_TEST(Session, ReloadedPageInADebugBuildStays) {
  // A reloaded page that throws while booting stays reachable over the inspector (PROC-9): XR-LIFE-7 logs and never
  // exits while the inspector or the debug endpoint is served.
  LifePolicyConfig c;
  c.debug_endpoint = true;
  LifePolicy p(c);
  p.on_xr_visible(true, 0);
  p.on_entry_evaluated(1000);
  p.on_session_started(2000);
  p.on_session_ended(10000);
  p.on_page_started(10000);
  p.on_entry_evaluated(10500);
  IWN_CHECK(p.tick(20500).action == LifePolicy::Action::kLogNeverOffered);
  IWN_CHECK(p.tick(120000).action == LifePolicy::Action::kNone);
}

IWN_TEST(Session, AnOfferAfterTheEndHoldsTheGracePeriod) {
  // XR-LIFE-5 counts until a new session is requested: a re-offer held in explicit-grant mode waits for the grant.
  using A = LifePolicy::Action;
  LifePolicy p;
  p.on_xr_visible(true, 0);
  p.on_entry_evaluated(0);
  p.on_session_started(100);
  p.on_session_ended(1000);
  p.on_offered(1500);
  IWN_CHECK(p.tick(3000).action == A::kNone);
  IWN_CHECK(p.tick(60000).action == A::kNone);
  p.on_session_started(60500);  // granted
  p.on_session_ended(70000);
  IWN_CHECK(p.tick(71999).action == A::kNone);
  IWN_CHECK(p.tick(72000).action == A::kRequestExit);

  // the re-request is rejected: the grace period runs again, from the rejection
  LifePolicy q;
  q.on_xr_visible(true, 0);
  q.on_entry_evaluated(0);
  q.on_session_started(100);
  q.on_session_ended(1000);
  q.on_offered(1500);
  q.on_offer_rejected(5000);
  IWN_CHECK(!q.offers_rejected());
  IWN_CHECK(q.tick(6900).action == A::kNone);
  IWN_CHECK(q.tick(7000).action == A::kRequestExit);

  // a request made while the session runs is rejected at once (InvalidStateError) and holds nothing afterwards
  LifePolicy r;
  r.on_xr_visible(true, 0);
  r.on_entry_evaluated(0);
  r.on_session_started(100);
  r.on_offered(500);
  r.on_session_ended(1000);
  IWN_CHECK(r.tick(2999).action == A::kNone);
  IWN_CHECK(r.tick(3000).action == A::kRequestExit);
}

IWN_TEST(Session, SystemEndInBackgroundWaitsForVisibility) {
  LifePolicy p;
  p.on_xr_visible(true, 0);
  p.on_session_started(0);
  p.on_xr_visible(false, 1000);  // headset off: STOPPING
  p.on_session_ended(1000);
  IWN_CHECK(p.tick(60000).action == LifePolicy::Action::kNone);  // nobody sees the empty scene
  p.on_xr_visible(true, 60000);
  IWN_CHECK(p.tick(61000).action == LifePolicy::Action::kNone);
  IWN_CHECK(p.tick(62000).action == LifePolicy::Action::kRequestExit);
}

// --- config ---------------------------------------------------------------------------------------------------------

IWN_TEST(Config, ParsesXrSection) {
  std::vector<std::string> w;
  auto json = iwn::Json::parse(R"({
    "stats": {"logIntervalMs": 2000},
    "xr": {"frameRate": 90, "foveation": {"level": "medium", "dynamic": true}, "grant": "explicit",
           "endGraceMs": -1, "neverOffered": {"errorMs": 5000, "exitMs": 20000},
           "perf": {"cpu": "sustained-high", "gpu": "sustained-low", "adaptive": false},
           "eyeBufferScale": 0.9, "colorSpace": "", "bogus": 1, "disableExtensions": ["XR_FB_passthrough"]}
  })");
  IWN_CHECK(json.has_value());
  XrConfig c = parse_xr_config(*json, &w);
  IWN_CHECK_EQ(c.frame_rate, 90.0);
  IWN_CHECK(near(c.foveation, 2.0 / 3.0));
  IWN_CHECK(c.foveation_dynamic);
  IWN_CHECK(c.explicit_grant);
  IWN_CHECK_EQ(c.life.end_grace_ms, -1.0);
  IWN_CHECK_EQ(c.life.never_offered_error_ms, 5000.0);
  IWN_CHECK(c.perf.cpu_start == PerfLevel::kSustainedHigh);
  IWN_CHECK(c.perf.gpu_start == PerfLevel::kSustainedLow);
  IWN_CHECK(!c.perf.adaptive);
  IWN_CHECK(near(c.eye_buffer_scale, 0.9));
  IWN_CHECK_EQ(c.color_space, std::string(""));
  IWN_CHECK_EQ(c.stats_interval_ms, 2000.0);
  IWN_CHECK_EQ(c.disabled_extensions.size(), 1u);
  IWN_CHECK_EQ(w.size(), 1u);  // xr.bogus
}

IWN_TEST(Config, DefaultsAndFoveationMapping) {
  XrConfig c = parse_xr_config(*iwn::Json::parse("{}"), nullptr);
  IWN_CHECK_EQ(c.frame_rate, 0.0);
  IWN_CHECK(c.foveation < 0);
  IWN_CHECK(!c.explicit_grant);
  IWN_CHECK_EQ(c.life.end_grace_ms, 2000.0);
  IWN_CHECK(foveation_level_for(0) == FoveationLevel::kNone);
  IWN_CHECK(foveation_level_for(1.0 / 3.0) == FoveationLevel::kLow);
  IWN_CHECK(foveation_level_for(2.0 / 3.0) == FoveationLevel::kMedium);
  IWN_CHECK(foveation_level_for(1) == FoveationLevel::kHigh);
  IWN_CHECK(foveation_level_for(0.1) == FoveationLevel::kNone);
  IWN_CHECK(foveation_level_for(0.2) == FoveationLevel::kLow);
  IWN_CHECK(foveation_level_for(NAN) == FoveationLevel::kNone);
  IWN_CHECK(near(foveation_value_for(FoveationLevel::kMedium), 2.0 / 3.0));
}

IWN_TEST(Config, PackerKeysAreAccepted) {
  // The packer's runtime config (packager/src/runtime-config.ts): frameRate null when unset, foveation as an object,
  // and the manifest features record. None of them is a warning.
  std::vector<std::string> w;
  auto json = iwn::Json::parse(R"({"xr": {"frameRate": null, "foveation": {"level": "none", "dynamic": false},
                                          "features": {"handTracking": "optional"}}})");
  IWN_CHECK(json.has_value());
  XrConfig c = parse_xr_config(*json, &w);
  IWN_CHECK_EQ(w.size(), 0u);
  IWN_CHECK_EQ(c.frame_rate, 0.0);
  IWN_CHECK_EQ(c.foveation, 0.0);
}

IWN_TEST(Foveation, ParamsGrowWithTheLevel) {
  // none: no falloff; low/medium/high: full density out to 1/gain NDC (area 0), shrinking with the level.
  IWN_CHECK_EQ(foveation_params_for(FoveationLevel::kNone).gain, 0.0f);
  float prev = 0;
  for (FoveationLevel l : {FoveationLevel::kLow, FoveationLevel::kMedium, FoveationLevel::kHigh}) {
    FoveationParams p = foveation_params_for(l);
    IWN_CHECK(p.gain > prev);
    IWN_CHECK(p.area >= 0.0f);
    prev = p.gain;
  }
  IWN_CHECK(near(1.0 / foveation_params_for(FoveationLevel::kLow).gain, 0.5));
  IWN_CHECK(near(1.0 / foveation_params_for(FoveationLevel::kHigh).gain, 0.25));
}

IWN_TEST(Foveation, FocalPointIsTheProjectionCentre) {
  float x = 9, y = 9;
  foveation_focal_point(-0.8f, 0.8f, 0.8f, -0.8f, &x, &y);  // symmetric
  IWN_CHECK(near(x, 0.0) && near(y, 0.0));
  // A left eye that sees further out to the left than toward the nose: the straight-ahead point lies right of the
  // image centre. Check against the frustum directly: NDC x of direction (0, 0, -1).
  const float l = -0.9f, r = 0.7f, u = 0.85f, d = -0.95f;
  foveation_focal_point(l, r, u, d, &x, &y);
  const double tl = std::tan(l), tr = std::tan(r), tu = std::tan(u), td = std::tan(d);
  IWN_CHECK(near(x, (0.0 - (tr + tl)) / (tr - tl), 1e-5));
  IWN_CHECK(near(y, (0.0 - (tu + td)) / (tu - td), 1e-5));
  IWN_CHECK(x > 0.0f && y > 0.0f);
  // Mirror image for the right eye.
  float xr = 0, yr = 0;
  foveation_focal_point(-r, -l, u, d, &xr, &yr);
  IWN_CHECK(near(xr, -x, 1e-5) && near(yr, y, 1e-5));
  // Degenerate FOV: centred, never NaN.
  foveation_focal_point(0, 0, 0, 0, &x, &y);
  IWN_CHECK_EQ(x, 0.0f);
  IWN_CHECK_EQ(y, 0.0f);
}

// --- png ------------------------------------------------------------------------------------------------------------

namespace {

uint32_t be32(const uint8_t* p) { return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 8) | p[3]; }

// Minimal decoder for what encode_png_rgba writes: checks CRCs, inflates IDAT, undoes the Sub filter.
bool decode_png(const std::vector<uint8_t>& png, uint32_t* w, uint32_t* h, std::vector<uint8_t>* rgba) {
  static const uint8_t sig[8] = {0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'};
  if (png.size() < 8 || std::memcmp(png.data(), sig, 8) != 0) return false;
  std::vector<uint8_t> idat;
  size_t at = 8;
  bool end = false;
  while (at + 12 <= png.size()) {
    uint32_t len = be32(&png[at]);
    const uint8_t* type = &png[at + 4];
    if (at + 12 + len > png.size()) return false;
    uLong crc = crc32(0, type, len + 4);
    if (crc != be32(&png[at + 8 + len])) return false;
    if (!std::memcmp(type, "IHDR", 4)) {
      *w = be32(type + 4);
      *h = be32(type + 8);
      if (type[12] != 8 || type[13] != 6) return false;
    } else if (!std::memcmp(type, "IDAT", 4)) {
      idat.insert(idat.end(), type + 4, type + 4 + len);
    } else if (!std::memcmp(type, "IEND", 4)) {
      end = true;
    }
    at += 12 + len;
  }
  if (!end) return false;
  const size_t row = size_t(*w) * 4 + 1;
  std::vector<uint8_t> raw(row * *h);
  uLongf out_len = raw.size();
  if (uncompress(raw.data(), &out_len, idat.data(), idat.size()) != Z_OK || out_len != raw.size()) return false;
  rgba->assign(size_t(*w) * 4 * *h, 0);
  for (uint32_t y = 0; y < *h; ++y) {
    const uint8_t* src = &raw[y * row];
    if (src[0] != 1) return false;
    uint8_t* dst = &(*rgba)[size_t(y) * *w * 4];
    for (size_t i = 0; i < size_t(*w) * 4; ++i) dst[i] = uint8_t(src[1 + i] + (i >= 4 ? dst[i - 4] : 0));
  }
  return true;
}

}  // namespace

IWN_TEST(Png, RoundTrip) {
  const uint32_t W = 37, H = 23, stride = W * 4 + 8;
  std::vector<uint8_t> img(stride * H);
  for (uint32_t y = 0; y < H; ++y)
    for (uint32_t x = 0; x < W; ++x)
      for (int c = 0; c < 4; ++c) img[y * stride + x * 4 + c] = uint8_t(x * 7 + y * 13 + c * 61);
  std::vector<uint8_t> png = encode_png_rgba(img.data(), W, H, stride);
  IWN_CHECK(!png.empty());
  uint32_t w = 0, h = 0;
  std::vector<uint8_t> back;
  IWN_CHECK(decode_png(png, &w, &h, &back));
  IWN_CHECK_EQ(w, W);
  IWN_CHECK_EQ(h, H);
  bool same = true;
  for (uint32_t y = 0; y < H; ++y) same = same && !std::memcmp(&back[y * W * 4], &img[y * stride], W * 4);
  IWN_CHECK(same);
  IWN_CHECK(encode_png_rgba(img.data(), 0, H, stride).empty());
}

IWN_TEST(Png, LargeBlackImageCompresses) {
  const uint32_t W = 1680 * 2, H = 1760;
  std::vector<uint8_t> img(size_t(W) * 4 * H, 0);
  std::vector<uint8_t> png = encode_png_rgba(img.data(), W, H, W * 4);
  IWN_CHECK(!png.empty());
  IWN_CHECK(png.size() < 200000);
}

// --- handoff --------------------------------------------------------------------------------------------------------

IWN_TEST(Handoff, BeginAndCancelAreExclusive) {
  for (int round = 0; round < 2000; ++round) {
    FrameSlot slot;
    IWN_CHECK(slot.post());
    IWN_CHECK(!slot.post());
    std::atomic<int> began{0}, cancelled{0};
    std::thread js([&] { began += slot.begin() ? 1 : 0; });
    cancelled += slot.cancel() ? 1 : 0;
    js.join();
    IWN_CHECK_EQ(began.load() + cancelled.load(), 1);
  }
}

IWN_TEST(Handoff, WaitDoneRunsCommandsAndHonoursTheDeadline) {
  FrameSlot slot;
  CommandQueue q;
  q.set_slot(&slot);
  IWN_CHECK(slot.post());
  std::atomic<bool> js_done{false};
  int command_ran_on_xr = 0;
  std::thread js([&] {
    IWN_CHECK(slot.begin());
    // a blocking command issued from inside the JS frame is served while the XR thread waits for the frame
    bool ok = q.call([&] { ++command_ran_on_xr; }, std::chrono::milliseconds(2000));
    IWN_CHECK(ok);
    js_done = true;
    slot.finish();
  });
  auto st = slot.wait_done(std::chrono::steady_clock::now() + std::chrono::seconds(5), &q);
  js.join();
  IWN_CHECK(st == FrameSlot::kDone);
  IWN_CHECK_EQ(command_ran_on_xr, 1);
  slot.reset();
  IWN_CHECK(slot.state() == FrameSlot::kIdle);

  // deadline: nobody begins the frame
  IWN_CHECK(slot.post());
  auto t0 = std::chrono::steady_clock::now();
  st = slot.wait_done(t0 + std::chrono::milliseconds(30), &q);
  auto waited = std::chrono::steady_clock::now() - t0;
  IWN_CHECK(st == FrameSlot::kPosted);
  IWN_CHECK(waited >= std::chrono::milliseconds(29));
  IWN_CHECK(slot.cancel());
  IWN_CHECK(!slot.begin());
  slot.reset();
  IWN_CHECK(slot.state() == FrameSlot::kIdle);
}

IWN_TEST(Handoff, ConcludeTellsTheFourOutcomesApart) {
  FrameSlot slot;
  // JS never began: cancelled here, idle again
  IWN_CHECK(slot.post());
  IWN_CHECK(slot.conclude() == FrameSlot::Outcome::kCancelled);
  IWN_CHECK(slot.state() == FrameSlot::kIdle);
  // JS finished: done, left for the caller to collect
  IWN_CHECK(slot.post());
  IWN_CHECK(slot.begin());
  slot.finish();
  IWN_CHECK(slot.conclude() == FrameSlot::Outcome::kDone);
  IWN_CHECK(slot.state() == FrameSlot::kDone);
  slot.reset();
  // JS still in it: running, stays in flight until it finishes
  IWN_CHECK(slot.post());
  IWN_CHECK(slot.begin());
  IWN_CHECK(slot.conclude() == FrameSlot::Outcome::kRunning);
  IWN_CHECK(slot.state() == FrameSlot::kRunning);
  IWN_CHECK(!slot.withdraw());  // a frame JS runs is never withdrawn
  slot.finish();
  slot.reset();
  // withdrawn by a command while the XR thread waited: idle, nothing in flight
  IWN_CHECK(slot.post());
  IWN_CHECK(slot.withdraw());
  IWN_CHECK(!slot.begin());  // JS can no longer take it
  IWN_CHECK(slot.conclude() == FrameSlot::Outcome::kWithdrawn);
  IWN_CHECK(slot.state() == FrameSlot::kIdle);
  IWN_CHECK(slot.post());  // and the next frame can be posted
}

// Regression, at the protocol level: the page ends its session (a command the XR thread serves
// inside wait_done) while the frame it posted has not been begun by JS. The command withdraws the frame; the wait
// stops at once and the frame loop learns "withdrawn" (an earlier build read the idle slot as "still in JS" and never posted
// another frame in that process).
IWN_TEST(Handoff, AFrameWithdrawnByACommandWhileWaitingIsNotInFlight) {
  FrameSlot slot;
  CommandQueue q;
  q.set_slot(&slot);
  IWN_CHECK(slot.post());
  std::thread js([&] { IWN_CHECK(q.push([&] { slot.withdraw(); })); });  // natives.endSession() from a timer task
  const auto t0 = std::chrono::steady_clock::now();
  const FrameSlot::State st = slot.wait_done(t0 + std::chrono::seconds(5), &q);
  js.join();
  const auto waited = std::chrono::steady_clock::now() - t0;
  IWN_CHECK(st == FrameSlot::kIdle);
  IWN_CHECK(waited < std::chrono::seconds(4));  // no wait for the deadline once nothing is left to wait for
  IWN_CHECK(slot.conclude() == FrameSlot::Outcome::kWithdrawn);
  IWN_CHECK(slot.post());
}

namespace {

// Replays the XR thread's JS-frame protocol as runtime/xr/src/android/xr_system.cc runs it (run_frame: collect a
// finished frame, run commands, post when idle, wait_done, conclude; destroy_swapchain: withdraw a posted frame, defer
// while one is in JS) against a JS thread, with real threads and a short display period.
struct FrameLoopReplay {
  FrameSlot slot;
  CommandQueue commands;
  std::atomic<bool> pending{false};
  bool webxr_active = false;  // XR thread only
  bool swapchain = false;
  bool destroy_pending = false;
  int collected = 0, cancelled = 0, withdrawn = 0, late = 0;
  std::chrono::microseconds period{2000};
  std::chrono::steady_clock::time_point next = std::chrono::steady_clock::now();

  FrameLoopReplay() { commands.set_slot(&slot); }

  void collect() {
    slot.reset();
    ++collected;
    if (destroy_pending) destroy_swapchain();
  }
  void destroy_swapchain() {
    slot.withdraw();
    if (slot.state() == FrameSlot::kRunning || slot.state() == FrameSlot::kDone) {
      destroy_pending = true;
      return;
    }
    swapchain = false;
    destroy_pending = false;
  }
  void end_webxr() {
    if (!webxr_active) return;
    webxr_active = false;
    destroy_swapchain();
  }
  void frame() {
    next += period;
    std::this_thread::sleep_until(next);  // xrWaitFrame
    if (slot.state() == FrameSlot::kDone) collect();
    commands.run_pending();
    if (!webxr_active || slot.state() != FrameSlot::kIdle) return;
    IWN_CHECK(slot.post());
    pending = true;
    slot.wait_done(std::chrono::steady_clock::now() + period, &commands);
    switch (slot.conclude()) {
      case FrameSlot::Outcome::kDone: collect(); break;
      case FrameSlot::Outcome::kCancelled: ++cancelled; break;
      case FrameSlot::Outcome::kWithdrawn: ++withdrawn; break;
      case FrameSlot::Outcome::kRunning: ++late; break;
    }
  }
};

}  // namespace

IWN_TEST(Handoff, EndFromATaskThenANewSessionKeepsFramesComing) {
  // Session 1 runs; a task that is busy when the next frame is posted ends it; session 2 starts at once (an IWSDK
  // re-offer, XR-LIFE-5) and must get frames. Several rounds, so the end lands at varying points of a frame.
  for (int round = 0; round < 5; ++round) {
    FrameLoopReplay x;
    std::atomic<bool> quit{false};
    std::thread xr([&] {
      while (!quit) x.frame();
    });
    std::atomic<int> js_frames{0};
    auto serve = [&](std::chrono::milliseconds ms) {
      const auto until = std::chrono::steady_clock::now() + ms;
      while (std::chrono::steady_clock::now() < until) {
        if (x.pending.exchange(false) && x.slot.begin()) {
          std::this_thread::sleep_for(std::chrono::microseconds(300));  // the app's frame
          ++js_frames;
          x.slot.finish();
        }
        std::this_thread::sleep_for(std::chrono::microseconds(50));
      }
    };
    IWN_CHECK(x.commands.call([&] { x.webxr_active = true; }, std::chrono::seconds(2)));  // sessionStarted
    IWN_CHECK(x.commands.call([&] { x.swapchain = true; }, std::chrono::seconds(2)));     // beginSwapchain
    serve(std::chrono::milliseconds(30));
    // a timer task runs while the XR thread posts the next frame; the task ends the session
    const auto give_up = std::chrono::steady_clock::now() + std::chrono::seconds(2);
    while (x.slot.state() != FrameSlot::kPosted && std::chrono::steady_clock::now() < give_up) {
      std::this_thread::yield();
    }
    IWN_CHECK(x.commands.push([&] { x.end_webxr(); }));  // natives.endSession()
    std::this_thread::sleep_for(std::chrono::microseconds(500 + 400 * round));  // the rest of the task
    serve(std::chrono::milliseconds(10));
    // session 2: sessionStarted, then beginSwapchain (which destroys a swapchain left over, as create_swapchain does)
    IWN_CHECK(x.commands.call([&] { x.webxr_active = true; }, std::chrono::seconds(2)));
    bool created = false;
    IWN_CHECK(x.commands.call([&] {
      if (x.swapchain && x.slot.state() == FrameSlot::kDone) x.collect();
      if (x.swapchain) x.destroy_swapchain();
      if (!x.swapchain) created = x.swapchain = true;  // else: "the previous swapchain is still in use by a frame"
    }, std::chrono::seconds(2)));
    IWN_CHECK(created);
    const int before = js_frames.load();
    serve(std::chrono::milliseconds(100));  // ~50 frames at a 2 ms period
    quit = true;
    xr.join();
    IWN_CHECK(js_frames.load() - before > 20);
    IWN_CHECK(x.swapchain);
    IWN_CHECK(x.slot.state() != FrameSlot::kPosted);
  }
}

IWN_TEST(Handoff, CallTimesOutAndCloseRefuses) {
  CommandQueue q;
  IWN_CHECK(!q.call([] {}, std::chrono::milliseconds(20)));  // nobody runs the queue
  IWN_CHECK_EQ(q.run_pending(), 1);
  q.close();
  IWN_CHECK(!q.push([] {}));
  IWN_CHECK(!q.call([] {}, std::chrono::milliseconds(1000)));
}

// --- loading screen (XR-IDLE-1) ----------------------------------------------------------------------------------------

IWN_TEST(Loading, ConfigDefaults) {
  LoadingConfig c = parse_loading_config(*iwn::Json::parse("{}"), nullptr);
  IWN_CHECK(c.enabled);
  IWN_CHECK_EQ(c.image, std::string("vr_splash.png"));
  IWN_CHECK(is_black(c.background));
  IWN_CHECK(c.contextual);  // black, unless the app can show passthrough and the user comes from it
  IWN_CHECK_EQ(c.distance_m, 6.0);
  IWN_CHECK_EQ(c.height_deg, 20.0);
  IWN_CHECK_EQ(c.max_width_deg, 80.0);
  IWN_CHECK(c.spinner);
  IWN_CHECK_EQ(c.fade_ms, 250.0);
  // The whole xr section has it, and it is not an unknown xr key.
  std::vector<std::string> w;
  XrConfig x = parse_xr_config(*iwn::Json::parse(R"({"xr": {"loading": {"enabled": false}}})"), &w);
  IWN_CHECK(!x.loading.enabled);
  IWN_CHECK_EQ(w.size(), 0u);
}

IWN_TEST(Loading, ConfigFromThePacker) {
  std::vector<std::string> w;
  auto json = iwn::Json::parse(R"({"xr": {"loading": {"enabled": true, "image": "vr_splash.png",
                                   "background": "#102030", "fadeMs": 400, "followDeg": 20}}})");
  IWN_CHECK(json.has_value());
  LoadingConfig c = parse_loading_config(*json, &w);
  IWN_CHECK_EQ(w.size(), 0u);
  IWN_CHECK(c.enabled);
  IWN_CHECK(near(c.background[0], 0x10 / 255.0, 1e-6));
  IWN_CHECK(near(c.background[1], 0x20 / 255.0, 1e-6));
  IWN_CHECK(near(c.background[2], 0x30 / 255.0, 1e-6));
  IWN_CHECK(!is_black(c.background));
  IWN_CHECK(!c.contextual);  // a colour is always that colour
  IWN_CHECK_EQ(c.fade_ms, 400.0);
  IWN_CHECK_EQ(c.follow_deg, 20.0);
  // "loading": false, "image": null, bad values (warned, defaults kept)
  IWN_CHECK(!parse_loading_config(*iwn::Json::parse(R"({"xr": {"loading": false}})"), nullptr).enabled);
  LoadingConfig none = parse_loading_config(*iwn::Json::parse(R"({"xr": {"loading": {"image": null}}})"), nullptr);
  IWN_CHECK(none.image.empty());
  w.clear();
  LoadingConfig bad = parse_loading_config(
      *iwn::Json::parse(R"({"xr": {"loading": {"background": "purple", "distance": -2, "fadeMs": "x", "spin": 1}}})"),
      &w);
  IWN_CHECK_EQ(w.size(), 4u);
  IWN_CHECK(is_black(bad.background));
  IWN_CHECK(bad.contextual);
  IWN_CHECK_EQ(bad.distance_m, 6.0);
  IWN_CHECK_EQ(bad.fade_ms, 250.0);
}

namespace {
LoadingOrigin at_launch(int recommended) {
  LoadingOrigin o;
  o.recommended = recommended;
  return o;
}
LoadingOrigin after_content(bool showed_passthrough) {
  LoadingOrigin o;
  o.after_content = true;
  o.content_passthrough = showed_passthrough;
  o.recommended = 1;  // ignored after content: the user comes from the app's own session
  return o;
}
}  // namespace

IWN_TEST(Loading, BackgroundIsContextualBlackOrAColour) {
  auto parse = [](const char* bg, std::vector<std::string>* w) {
    return parse_loading_config(
        *iwn::Json::parse(std::string(R"({"xr": {"loading": {"background": )") + bg + "}}}"), w);
  };
  std::vector<std::string> w;
  // "contextual": passthrough only when the app can show it (XR_FB_passthrough) and the user comes from passthrough:
  // at launch the system's recommendation (unknown -> opaque black).
  const LoadingConfig ctx = parse("\"contextual\"", &w);
  IWN_CHECK(ctx.contextual);
  IWN_CHECK(is_black(ctx.background));
  IWN_CHECK(loading_background(ctx, at_launch(1), true) == LoadingBackground::kPassthrough);
  IWN_CHECK(loading_background(ctx, at_launch(0), true) == LoadingBackground::kColour);
  IWN_CHECK(loading_background(ctx, at_launch(-1), true) == LoadingBackground::kColour);
  // An app without passthrough (no com.oculus.feature.PASSTHROUGH: every VR app) is black from any home. Nothing
  // depends on what the system shows behind a frame.
  IWN_CHECK(loading_background(ctx, at_launch(1), false) == LoadingBackground::kColour);
  // After content (a reload, a session end): what the session showed, not the home. A VR session -> black.
  IWN_CHECK(loading_background(ctx, after_content(false), true) == LoadingBackground::kColour);
  IWN_CHECK(loading_background(ctx, after_content(true), true) == LoadingBackground::kPassthrough);
  IWN_CHECK(loading_background(ctx, after_content(true), false) == LoadingBackground::kColour);
  // The runtime's default (no background key) is contextual: black unless the app can show passthrough.
  const LoadingConfig defaults = parse_loading_config(*iwn::Json::parse("{}"), nullptr);
  IWN_CHECK(loading_background(defaults, at_launch(1), true) == LoadingBackground::kPassthrough);
  IWN_CHECK(loading_background(defaults, at_launch(1), false) == LoadingBackground::kColour);
  IWN_CHECK(loading_background(defaults, at_launch(0), true) == LoadingBackground::kColour);
  // "black" and colours never show passthrough, whatever the system recommends or the session showed.
  const LoadingConfig black = parse("\"black\"", &w);
  IWN_CHECK(!black.contextual);
  IWN_CHECK(is_black(black.background));
  IWN_CHECK(loading_background(black, at_launch(1), true) == LoadingBackground::kColour);
  IWN_CHECK(loading_background(black, after_content(true), true) == LoadingBackground::kColour);
  const LoadingConfig hex_black = parse("\"#000\"", &w);
  IWN_CHECK(!hex_black.contextual);
  IWN_CHECK(loading_background(hex_black, at_launch(1), true) == LoadingBackground::kColour);
  const LoadingConfig blue = parse("\"#1d65c1\"", &w);
  IWN_CHECK(!blue.contextual);
  IWN_CHECK(near(blue.background[2], 0xc1 / 255.0, 1e-6));
  IWN_CHECK(loading_background(blue, at_launch(1), true) == LoadingBackground::kColour);
  IWN_CHECK_EQ(w.size(), 0u);
  // Wrong values warn and keep the default (contextual).
  const LoadingConfig num = parse("3", &w);
  const LoadingConfig word = parse("\"Contextual\"", &w);
  IWN_CHECK_EQ(w.size(), 2u);
  IWN_CHECK(num.contextual && word.contextual);
  IWN_CHECK_EQ(std::string(loading_background_name(LoadingBackground::kColour)), std::string("colour"));
  IWN_CHECK_EQ(std::string(loading_background_name(LoadingBackground::kPassthrough)), std::string("passthrough"));
}

namespace {
// The XR thread's per-frame inputs for a VR app (no passthrough), the loading screen created.
FrameLayerInput vr_frame() {
  FrameLayerInput in;
  in.render = true;
  in.loading_ready = true;
  in.cover_ready = true;
  return in;
}
LoadingPolicy::Frame loading_frame(float alpha = 1) {
  LoadingPolicy::Frame f;
  f.loading = true;
  f.loading_alpha = alpha;
  return f;
}
LoadingPolicy::Frame handover_frame(float s) {
  LoadingPolicy::Frame f;
  f.loading = true;
  f.loading_alpha = 1 - s;
  f.app_scale = s;
  return f;
}
int layer_count(const FrameLayerPlan& p) {
  return (p.passthrough ? 1 : 0) + (p.cover ? 1 : 0) + (p.projection ? 1 : 0) + (p.quads ? 1 : 0);
}
}  // namespace

IWN_TEST(Loading, AVrAppsLoadingScreenAlwaysHasTheOpaqueBackground) {
  // Seen on a headset: from a virtual home the loading screen showed the room. A frame with only the quads leaves the
  // rest of the view to the system; the plan always puts the opaque background behind them.
  FrameLayerInput in = vr_frame();
  FrameLayerPlan p = plan_frame_layers(in, loading_frame());
  IWN_CHECK(p.cover && p.quads && !p.passthrough && !p.projection);
  IWN_CHECK_EQ(p.quad_alpha, 1.0f);
  // A session granted, its first frame still rendering: still the loading screen on the opaque background.
  in.webxr_active = true;
  p = plan_frame_layers(in, loading_frame());
  IWN_CHECK(p.cover && p.quads && !p.projection);
  // A passthrough background the app cannot show (no passthrough layer) falls back to the opaque background.
  in.background = LoadingBackground::kPassthrough;
  p = plan_frame_layers(in, loading_frame());
  IWN_CHECK(p.cover && !p.passthrough);
  // The app's first frame: the hand-over. The app's layer is under the quads, so no cover; the app comes in from the
  // background colour the user saw.
  in.background = LoadingBackground::kColour;
  in.app_frame = true;
  p = plan_frame_layers(in, handover_frame(0.25f));
  IWN_CHECK(p.projection && p.quads && !p.cover && !p.passthrough);
  IWN_CHECK(p.app_fade == AppFade::kFromColour);
  IWN_CHECK(near(p.app_scale, 0.25, 1e-6) && near(p.app_bias, 0.75, 1e-6));
  IWN_CHECK(near(p.quad_alpha, 0.75, 1e-6));
  // Without an opaque layer (it could not be created) the user saw black: no colour bias.
  in.cover_ready = false;
  IWN_CHECK_EQ(plan_frame_layers(in, handover_frame(0.25f)).app_bias, 0.0f);
  in.cover_ready = true;
  // After the hand-over: the app's layer alone, at full strength.
  p = plan_frame_layers(in, LoadingPolicy::Frame{});
  IWN_CHECK(p.projection && layer_count(p) == 1);
  IWN_CHECK(p.app_fade == AppFade::kNone && p.app_scale == 1.0f);
  // shouldRender false: nothing.
  in.render = false;
  IWN_CHECK_EQ(layer_count(plan_frame_layers(in, loading_frame())), 0);
}

IWN_TEST(Loading, AResumedVrSessionIsNeverAnEmptyFrame) {
  // After a pause the session's frames have no app frame until the page's next one is rendered (pause_frames()
  // drops the old image) and the loading screen stays away (PausesDoNotBringItBackButLostContentDoes). Those frames
  // carry the opaque background instead of nothing.
  FrameLayerInput in = vr_frame();
  in.webxr_active = true;
  in.app_frame = false;
  FrameLayerPlan p = plan_frame_layers(in, LoadingPolicy::Frame{});
  IWN_CHECK(p.cover && !p.quads && !p.projection && !p.passthrough);
  // The next app frame replaces it.
  in.app_frame = true;
  p = plan_frame_layers(in, LoadingPolicy::Frame{});
  IWN_CHECK(p.projection && !p.cover);
  // No session and no loading screen (loading disabled): nothing to cover with.
  FrameLayerInput off;
  off.render = true;
  IWN_CHECK_EQ(layer_count(plan_frame_layers(off, LoadingPolicy::Frame{})), 0);
}

IWN_TEST(Loading, APassthroughBackgroundIsALayerTheRuntimeSubmits) {
  // An app that declares passthrough, launched from a passthrough home: the room behind the card is the runtime's own
  // passthrough layer, never a frame left to the system.
  FrameLayerInput in = vr_frame();
  in.background = LoadingBackground::kPassthrough;
  in.passthrough_ready = true;
  FrameLayerPlan p = plan_frame_layers(in, loading_frame());
  IWN_CHECK(p.passthrough && p.quads && !p.cover && !p.projection);
  // A VR session's first frame replaces the room at once (no dip through black) while the quads fade out over it;
  // the passthrough is no longer submitted under the opaque app layer.
  in.webxr_active = true;
  in.app_frame = true;
  p = plan_frame_layers(in, handover_frame(0.1f));
  IWN_CHECK(p.projection && p.quads && !p.passthrough && !p.cover);
  IWN_CHECK(p.app_fade == AppFade::kNone && p.app_scale == 1.0f && p.app_bias == 0.0f);
  IWN_CHECK(near(p.quad_alpha, 0.9, 1e-6));
  // Passthrough not running (could not be started, or hidden): the opaque background instead.
  in.app_frame = false;
  in.passthrough_ready = false;
  p = plan_frame_layers(in, loading_frame());
  IWN_CHECK(p.cover && !p.passthrough);
}

IWN_TEST(Loading, ImmersiveArKeepsItsPassthroughUnderTheLoadingScreenAndTheApp) {
  FrameLayerInput in = vr_frame();
  in.webxr_active = true;
  in.session_ar = true;
  in.passthrough_ready = true;
  // From a passthrough home (passthrough background): the room behind the card, then the AR frames blend in over it.
  in.background = LoadingBackground::kPassthrough;
  FrameLayerPlan p = plan_frame_layers(in, loading_frame());
  IWN_CHECK(p.passthrough && p.quads && !p.cover);
  in.app_frame = true;
  p = plan_frame_layers(in, handover_frame(0.5f));
  IWN_CHECK(p.passthrough && p.projection && p.quads && !p.cover);
  IWN_CHECK(p.app_fade == AppFade::kAlpha && near(p.app_scale, 0.5, 1e-6));
  // From a virtual home (colour background): black behind the card even though the session's passthrough runs.
  in.background = LoadingBackground::kColour;
  in.app_frame = false;
  p = plan_frame_layers(in, loading_frame());
  IWN_CHECK(p.cover && p.quads && !p.passthrough);
  // The app phase: passthrough under the app's frames; a frame without an app frame shows passthrough, not black.
  in.app_frame = true;
  p = plan_frame_layers(in, LoadingPolicy::Frame{});
  IWN_CHECK(p.passthrough && p.projection && !p.cover);
  in.app_frame = false;
  p = plan_frame_layers(in, LoadingPolicy::Frame{});
  IWN_CHECK(p.passthrough && !p.cover && !p.projection);
  // The page hid its passthrough: such a frame gets the opaque background.
  in.passthrough_ready = false;
  p = plan_frame_layers(in, LoadingPolicy::Frame{});
  IWN_CHECK(p.cover && !p.passthrough);
  IWN_CHECK_EQ(std::string(app_fade_name(AppFade::kAlpha)), std::string("alpha"));
}

IWN_TEST(Loading, HexColours) {
  float c[3];
  IWN_CHECK(parse_hex_color("#fff", c));
  IWN_CHECK(near(c[0], 1.0) && near(c[1], 1.0) && near(c[2], 1.0));
  IWN_CHECK(parse_hex_color("#0B0C0e", c));
  IWN_CHECK(near(c[0], 11 / 255.0, 1e-6) && near(c[1], 12 / 255.0, 1e-6) && near(c[2], 14 / 255.0, 1e-6));
  IWN_CHECK(!parse_hex_color("000000", c));
  IWN_CHECK(!parse_hex_color("#00000", c));
  IWN_CHECK(!parse_hex_color("#gg0000", c));
  IWN_CHECK(!parse_hex_color("", c));
  // The background's linear value (the hand-over fades the app in from it).
  IWN_CHECK_EQ(srgb_to_linear(0.0f), 0.0f);
  IWN_CHECK(near(srgb_to_linear(1.0f), 1.0, 1e-6));
  IWN_CHECK(near(srgb_to_linear(0.5f), 0.2140, 1e-3));
  IWN_CHECK(near(srgb_to_linear(0.04f), 0.04 / 12.92, 1e-6));
}

IWN_TEST(Loading, ShownUntilTheAppsFirstFrameThenCrossFaded) {
  LoadingPolicy p(true, 250);
  IWN_CHECK(p.phase() == LoadingPhase::kLoading);
  // Boot: frames before the app's first projection layer (OpenXR running, the bundle loading, the WebXR session
  // granted but its first frame still compiling) all show the loading screen, fully opaque.
  LoadingPolicy::Frame f = p.frame(1000, false);
  IWN_CHECK(f.loading && f.first_loading && !f.handover);
  IWN_CHECK_EQ(f.loading_alpha, 1.0f);
  for (int i = 1; i < 300; ++i) {
    f = p.frame(1000 + i * 13.9, false);
    IWN_CHECK(f.loading && !f.first_loading);
    IWN_CHECK_EQ(f.loading_alpha, 1.0f);
  }
  // The app's first frame: the hand-over starts. That frame still shows the loading screen opaque over the app's
  // layer at colour scale 0, so no frame ever shows nothing or a half-faded state without the loading screen.
  f = p.frame(5000, true);
  IWN_CHECK(f.handover && f.loading);
  IWN_CHECK_EQ(f.loading_alpha, 1.0f);
  IWN_CHECK_EQ(f.app_scale, 0.0f);
  IWN_CHECK(p.phase() == LoadingPhase::kHandover);
  IWN_CHECK_EQ(p.last_loading_duration_ms(), 4000.0);
  IWN_CHECK_EQ(p.handovers(), 1u);
  // Half way: complementary.
  f = p.frame(5125, true);
  IWN_CHECK(f.loading && !f.handover);
  IWN_CHECK(near(f.loading_alpha, 0.5, 1e-6));
  IWN_CHECK(near(f.loading_alpha + f.app_scale, 1.0, 1e-6));
  // Monotonic over the fade.
  float last_alpha = f.loading_alpha;
  for (double t = 5130; t < 5250; t += 10) {
    f = p.frame(t, true);
    IWN_CHECK(f.loading);
    IWN_CHECK(f.loading_alpha <= last_alpha);
    last_alpha = f.loading_alpha;
  }
  // Done: the app's layers only, at full scale.
  f = p.frame(5250, true);
  IWN_CHECK(!f.loading && f.handover_done);
  IWN_CHECK_EQ(f.app_scale, 1.0f);
  IWN_CHECK(p.phase() == LoadingPhase::kApp);
  f = p.frame(5264, true);
  IWN_CHECK(!f.loading && !f.handover_done);
}

IWN_TEST(Loading, WithoutFadesTheHandOverIsOneFrame) {
  LoadingPolicy p(true, 250);
  p.set_fade_ms(0);  // no XR_KHR_composition_layer_color_scale_bias
  IWN_CHECK(p.frame(0, false).loading);
  LoadingPolicy::Frame f = p.frame(14, true);
  IWN_CHECK(f.handover && f.handover_done && !f.loading);
  IWN_CHECK_EQ(f.app_scale, 1.0f);
  IWN_CHECK(p.phase() == LoadingPhase::kApp);
}

IWN_TEST(Loading, PausesDoNotBringItBackButLostContentDoes) {
  LoadingPolicy p(true, 100);
  p.frame(0, false);
  p.frame(10, true);
  p.frame(200, true);
  IWN_CHECK(p.phase() == LoadingPhase::kApp);
  // Resume after sleep: the session's first frames have no projection layer yet. No loading flash.
  for (int i = 0; i < 5; ++i) IWN_CHECK(!p.frame(300 + i * 14, false).loading);
  // A late frame JS has not finished: the last image is re-submitted (the app layer stays). Nothing changes.
  IWN_CHECK(!p.frame(400, true).loading);
  // The page reloads (or ends its session): the loading screen is back until the new page's first frame.
  p.content_lost(1000);
  IWN_CHECK(p.phase() == LoadingPhase::kLoading);
  LoadingPolicy::Frame f = p.frame(1014, false);
  IWN_CHECK(f.loading && !f.first_loading);  // "first" is the boot's only
  IWN_CHECK_EQ(f.loading_alpha, 1.0f);
  f = p.frame(6000, true);
  IWN_CHECK(f.handover);
  IWN_CHECK_EQ(p.last_loading_duration_ms(), 5000.0);
  IWN_CHECK_EQ(p.handovers(), 2u);
  // Content lost mid-hand-over (the app's session ended right away): straight back to loading, opaque.
  p.content_lost(6050);
  f = p.frame(6060, false);
  IWN_CHECK(f.loading);
  IWN_CHECK_EQ(f.loading_alpha, 1.0f);
}

IWN_TEST(Loading, AShortLoadingPeriodHandsOverInOneFrame) {
  LoadingPolicy p(true, 250);
  p.frame(0, false);
  p.frame(5000, true);  // the boot's hand-over: a full cross-fade
  for (double t = 5014; t < 5300; t += 14) p.frame(t, true);
  IWN_CHECK(p.phase() == LoadingPhase::kApp);
  // The page ends its session and IWSDK enters the next one at once: the loading screen is up for 23 ms. The app's
  // next frame comes back at full brightness instead of fading in from black over 250 ms.
  p.content_lost(6000);
  IWN_CHECK(p.frame(6009, false).loading);
  LoadingPolicy::Frame f = p.frame(6023, true);
  IWN_CHECK(f.handover && f.handover_done && !f.loading);
  IWN_CHECK_EQ(f.app_scale, 1.0f);
  IWN_CHECK(p.phase() == LoadingPhase::kApp);
  IWN_CHECK_EQ(p.last_loading_duration_ms(), 23.0);
  IWN_CHECK_EQ(p.handovers(), 2u);
  // A loading period as long as the fade or longer (a reload) cross-fades as at launch.
  p.content_lost(7000);
  p.frame(7014, false);
  f = p.frame(7250, true);
  IWN_CHECK(f.handover && f.loading && !f.handover_done);
  IWN_CHECK_EQ(f.loading_alpha, 1.0f);
  IWN_CHECK_EQ(f.app_scale, 0.0f);
  f = p.frame(7375, true);
  IWN_CHECK(f.loading && near(f.loading_alpha, 0.5, 1e-6));
}

IWN_TEST(Loading, DisabledNeverShows) {
  LoadingPolicy p(false, 250);
  IWN_CHECK(p.phase() == LoadingPhase::kOff);
  IWN_CHECK(!p.frame(0, false).loading);
  IWN_CHECK(!p.frame(10, true).loading);
  p.content_lost(20);
  IWN_CHECK(p.phase() == LoadingPhase::kOff);
  IWN_CHECK(!p.frame(30, false).loading);
  IWN_CHECK_EQ(p.frame(40, true).app_scale, 1.0f);
}

namespace {
// A head turned by yaw (about +Y), then pitched (about its own +X: positive looks up), then rolled (about its own +Z:
// positive tilts the top of the head to the left).
XrPosef head_at(double yaw_deg, double pitch_deg = 0, float x = 0, float y = 1.6f, float z = 0, double roll_deg = 0) {
  const double yr = yaw_deg * M_PI / 180, pr = pitch_deg * M_PI / 180, rr = roll_deg * M_PI / 180;
  XrQuaternionf qy = yaw_quat(yr);
  XrQuaternionf qx{static_cast<float>(std::sin(pr / 2)), 0, 0, static_cast<float>(std::cos(pr / 2))};
  XrQuaternionf qz{0, 0, static_cast<float>(std::sin(rr / 2)), static_cast<float>(std::cos(rr / 2))};
  return {mul(mul(qy, qx), qz), {x, y, z}};
}
double deg_of(double rad) { return rad * 180 / M_PI; }
XrVector3f gaze_of(const XrQuaternionf& q) { return rotate(q, {0, 0, -1}); }
// The angle between the gaze and the direction from the eye to the card's centre (the anchor turns -Z there).
double card_off_gaze_deg(const XrPosef& head, const XrQuaternionf& anchor) {
  return deg_of(angle_between(gaze_of(head.orientation), gaze_of(anchor)));
}
}  // namespace

IWN_TEST(Loading, PoseHelpers) {
  XrVector3f f = rotate(yaw_quat(M_PI / 2), {0, 0, -1});  // turned left by 90 degrees: forward is -X
  IWN_CHECK(near(f.x, -1, 1e-6) && near(f.y, 0, 1e-6) && near(f.z, 0, 1e-6));
  bool ok = false;
  IWN_CHECK(near(deg_of(yaw_of(head_at(30, 20).orientation, &ok)), 30, 1e-4) && ok);
  yaw_of(head_at(10, -85).orientation, &ok);  // looking at the floor: the gaze has no heading
  IWN_CHECK(!ok);
  XrPosef c = compose(head_at(90, 0, 1, 1.6f, 2), {{0, 0, 0, 1}, {0, 0, -6}});
  IWN_CHECK(near(c.position.x, 1 - 6, 1e-5) && near(c.position.y, 1.6, 1e-6) && near(c.position.z, 2, 1e-5));
  // pitch_of: the gaze above the horizon; roll does not change it.
  IWN_CHECK(near(deg_of(pitch_of(head_at(40, 25).orientation)), 25, 1e-3));
  IWN_CHECK(near(deg_of(pitch_of(head_at(-120, -60, 0, 1.6f, 0, 15).orientation)), -60, 1e-3));
  // heading_of: the gaze's heading for an unrolled head at any pitch, straight up and down included, where the gaze
  // alone has none: there it follows the top of the head (looking down) or the back of it (looking up).
  for (double pitch : {-90.0, -88.0, -60.0, 0.0, 45.0, 81.0, 90.0}) {
    for (double yaw : {-170.0, -30.0, 0.0, 60.0, 150.0}) {
      IWN_CHECK(near(deg_of(heading_of(head_at(yaw, pitch).orientation)), yaw, 1e-3));
    }
  }
  IWN_CHECK(near(deg_of(heading_of(head_at(20, 0, 0, 1.6f, 0, 30).orientation)), 20, 1e-3));  // rolled, level
  // angle_between: vectors, and the rotation between two orientations (either quaternion sign).
  IWN_CHECK(near(deg_of(angle_between(XrVector3f{0, 0, -1}, XrVector3f{1, 0, 0})), 90, 1e-9));
  IWN_CHECK(near(deg_of(angle_between(gaze_of(head_at(0).orientation), gaze_of(head_at(0, 0.5).orientation))), 0.5,
                 1e-4));
  const XrQuaternionf q30 = head_at(30, 0).orientation;
  IWN_CHECK(near(deg_of(angle_between(head_at(0).orientation, q30)), 30, 1e-4));
  IWN_CHECK(near(deg_of(angle_between(head_at(0).orientation, XrQuaternionf{-q30.x, -q30.y, -q30.z, -q30.w})), 30,
                 1e-4));
  IWN_CHECK(near(deg_of(angle_between(head_at(10, 20, 0, 0, 0, 5).orientation,
                                      head_at(10, 20, 0, 0, 0, 5).orientation)), 0, 1e-6));
  // The spinner turns clockwise seen from the front: the roll angle about +Z decreases with time.
  auto roll = [](double t) {
    XrQuaternionf q = spinner_roll(t, 1000);
    return 2 * std::atan2(q.z, q.w);
  };
  IWN_CHECK(roll(100) < 0 && roll(100) > -M_PI);
  IWN_CHECK(near(roll(250), -M_PI / 2, 1e-5));
  IWN_CHECK(near(roll(1250), roll(250), 1e-5));  // one turn per period
}

IWN_TEST(Loading, WorldLockedUntilTheHeadTurnsAwayThenGlidesBack) {
  LoadingPlacement p(35);
  XrPosef a = p.update(head_at(10), 0);
  IWN_CHECK(near(deg_of(p.yaw()), 10, 1e-4));
  IWN_CHECK(p.on_horizon() && near(deg_of(p.pitch()), 0, 1e-4));
  IWN_CHECK(near(a.position.y, 1.6, 1e-6));
  // Turning within the dead zone (the whole angle between the gaze and the card: here 32 degrees), looking up or
  // down, or leaning: the card stays (world-locked); the position follows the head (body-locked, as Horizon OS's
  // splash).
  a = p.update(head_at(30, 25, 0.3f, 1.5f, -0.2f), 14);
  IWN_CHECK(near(deg_of(p.yaw()), 10, 1e-4));
  IWN_CHECK(!p.gliding());
  IWN_CHECK(near(a.position.x, 0.3, 1e-6) && near(a.position.z, -0.2, 1e-6));
  a = p.update(head_at(-20), 28);
  IWN_CHECK(near(deg_of(p.yaw()), 10, 1e-4));
  a = p.update(head_at(10, -33), 35);  // looking at the floor in front: 33 degrees away, inside the dead zone
  IWN_CHECK(!p.gliding() && p.on_horizon() && near(deg_of(p.pitch()), 0, 1e-4));
  // Past the dead zone: it glides back in front, without overshoot, upright, and settles within a second.
  double t = 42;
  p.update(head_at(80), t);
  IWN_CHECK(p.gliding());
  double prev = deg_of(p.yaw());
  for (int i = 0; i < 72; ++i) {
    t += 13.9;
    a = p.update(head_at(80), t);
    const double y = deg_of(p.yaw());
    IWN_CHECK(y >= prev - 1e-9 && y <= 80 + 1e-9);
    IWN_CHECK(near(rotate(a.orientation, {1, 0, 0}).y, 0, 1e-6) && near(deg_of(p.pitch()), 0, 1e-4));
    prev = y;
  }
  IWN_CHECK(!p.gliding());
  IWN_CHECK(std::fabs(deg_of(p.yaw()) - 80) < 1.0);
  // Across the +-180 degree seam it takes the short way.
  LoadingPlacement q(35);
  q.update(head_at(170), 0);
  q.update(head_at(-150), 14);  // 40 degrees further, through 180
  for (int i = 0; i < 100; ++i) q.update(head_at(-150), 28 + i * 14);
  IWN_CHECK(std::fabs(deg_of(q.yaw()) + 150) < 1.0);
  // reset() re-centres on the next update.
  LoadingPlacement r(35);
  r.update(head_at(-100), 0);
  r.reset();
  IWN_CHECK(!r.placed());
  r.update(head_at(60), 14);
  IWN_CHECK(r.placed());
  IWN_CHECK(near(deg_of(r.yaw()), 60, 1e-4));
}

IWN_TEST(Loading, APitchedHeadGetsTheCardInFrontOfItsEyes) {
  // Horizon OS's splash sits on the horizon: out of view for a head pitched more than ~40 degrees (a user lying down
  // or looking at the floor at launch, a headset lying face up). There the card goes where the head looks, as
  // the head is turned (centred, upright for the viewer); up to kLoadingHorizonPitchDeg it stays on the horizon
  // ahead (where the system splash is), upright.
  struct Case {
    double yaw, pitch, roll;
    bool horizon;
  };
  const Case cases[] = {{0, 81, 0, false},    {30, -60, 0, false}, {-140, 90, 0, false}, {75, -90, 0, false},
                        {10, 31, 0, false},    {200, 45, 12, false}, {0, 81.3, -6, false}, {-30, 50, 90, false},
                        {20, 29.5, 0, true},   {-45, -25, 0, true}, {5, 3, -6, true},      {60, 0, 90, true}};
  for (const Case& c : cases) {
    LoadingPlacement p(35);
    const XrPosef head = head_at(c.yaw, c.pitch, 0.1f, 1.2f, 0.3f, c.roll);
    const XrPosef a = p.update(head, 0);
    IWN_CHECK_EQ(p.on_horizon(), c.horizon);
    IWN_CHECK(near(a.position.x, 0.1, 1e-6) && near(a.position.y, 1.2, 1e-6) && near(a.position.z, 0.3, 1e-6));
    const XrVector3f card_right = rotate(a.orientation, {1, 0, 0}), card_up = rotate(a.orientation, {0, 1, 0});
    if (c.horizon) {
      // On the horizon at the gaze's heading, upright in the world: the gaze's pitch away from the card.
      IWN_CHECK(near(card_off_gaze_deg(head, a.orientation), std::fabs(c.pitch), 1e-3));
      IWN_CHECK(near(card_right.y, 0, 1e-6) && near(card_up.y, 1, 1e-6));
    } else {
      // In front of the eyes and upright for the viewer: the card's axes are the head's.
      IWN_CHECK(card_off_gaze_deg(head, a.orientation) < 0.01);
      const XrVector3f head_up = rotate(head.orientation, {0, 1, 0});
      IWN_CHECK(deg_of(angle_between(card_up, head_up)) < 0.01);
    }
    IWN_CHECK(card_off_gaze_deg(head, a.orientation) < 35.0);  // within the dead zone, so in view
    // Placed once: holding the head still never moves it.
    for (int i = 1; i <= 20; ++i) p.update(head, i * 13.9);
    IWN_CHECK(!p.gliding());
  }
  // A Quest 3S lying face up (forward 0.99 up, measured on the device): the card is in front of its lenses.
  {
    const XrVector3f fwd{-0.002f, 0.988f, -0.151f};
    const double pitch = std::asin(fwd.y), yaw = std::atan2(-fwd.x, -fwd.z);
    LoadingPlacement p(35);
    const XrPosef head = head_at(deg_of(yaw), deg_of(pitch));
    IWN_CHECK(card_off_gaze_deg(head, p.update(head, 0).orientation) < 0.01);
    IWN_CHECK(!p.on_horizon());
  }
}

IWN_TEST(Loading, TheCardFollowsTheGazeUpAndDownAndBackToTheHorizon) {
  LoadingPlacement p(35);
  double t = 0;
  p.update(head_at(0), t);
  // Looking up 50 degrees: the gaze is 50 degrees from the card, past the dead zone; the card glides up, without
  // overshoot, and settles in front of the eyes within a second.
  double prev = 0;
  bool glided = false;
  for (int i = 0; i < 72; ++i) {
    t += 13.9;
    p.update(head_at(0, 50), t);
    glided = glided || p.gliding();
    const double pitch = deg_of(p.pitch());
    IWN_CHECK(pitch >= prev - 1e-9 && pitch <= 50 + 1e-6);
    prev = pitch;
  }
  IWN_CHECK(glided && !p.gliding() && !p.on_horizon());
  IWN_CHECK(std::fabs(deg_of(p.pitch()) - 50) < 1.0);
  // Level again: 50 degrees away, so it glides back down to the horizon (where it would have started).
  for (int i = 0; i < 72; ++i) p.update(head_at(0), t += 13.9);
  IWN_CHECK(!p.gliding() && p.on_horizon());
  IWN_CHECK(std::fabs(deg_of(p.pitch())) < 1.0);
  // Looking 25 degrees down and 20 to the side: 32 degrees from the card, it stays put.
  p.update(head_at(20, -25), t += 13.9);
  IWN_CHECK(!p.gliding());
  // Turning round while looking at the floor: the card follows into view.
  for (int i = 0; i < 100; ++i) p.update(head_at(160, -70), t += 13.9);
  IWN_CHECK(!p.gliding());
  IWN_CHECK(card_off_gaze_deg(head_at(160, -70), p.orientation()) < 1.0);
  // A small dead zone never makes the card chase a target it is already at (the horizon is 20 degrees below a gaze
  // pitched 20 degrees up, more than this 10 degree dead zone).
  LoadingPlacement s(10);
  s.update(head_at(0, 20), 0);
  for (int i = 1; i < 10; ++i) {
    s.update(head_at(0, 20), i * 13.9);
    IWN_CHECK(!s.gliding());
  }
}

IWN_TEST(Loading, LayoutFollowsHorizonSplashSizing) {
  LoadingConfig c;  // 6 m, fitted to 80 x 20 degrees
  const double h20 = 2 * 6 * std::tan(10 * M_PI / 180);  // 2.116 m
  LoadingLayout l = loading_layout(c, 1024, 512);
  IWN_CHECK(l.card);
  IWN_CHECK(near(l.card_h, h20, 1e-4));
  IWN_CHECK(near(l.card_w, 2 * h20, 1e-4));
  IWN_CHECK(near(l.card_center.z, -6, 1e-6) && near(l.card_center.y, 0, 1e-6));
  // The spinner sits below the card, at the same distance.
  IWN_CHECK(l.spinner_size > 0);
  IWN_CHECK(l.spinner_center.y + l.spinner_size / 2 < -l.card_h / 2);
  IWN_CHECK(near(l.spinner_center.z, -6, 1e-6));
  // A square image: 20 x 20 degrees. A very wide one: limited by the 80 degree width.
  l = loading_layout(c, 640, 640);
  IWN_CHECK(near(l.card_w, h20, 1e-4) && near(l.card_h, h20, 1e-4));
  l = loading_layout(c, 4000, 500);
  IWN_CHECK(near(l.card_w, 2 * 6 * std::tan(40 * M_PI / 180), 1e-3));
  IWN_CHECK(near(l.card_h, l.card_w / 8, 1e-4));
  // No image: the spinner alone, straight ahead.
  l = loading_layout(c, 0, 0);
  IWN_CHECK(!l.card);
  IWN_CHECK(near(l.spinner_center.y, 0, 1e-6));
  c.spinner = false;
  IWN_CHECK_EQ(loading_layout(c, 0, 0).spinner_size, 0.0f);
}

IWN_TEST(Loading, SpinnerImageIsAPremultipliedArcWithAHeadAndATail) {
  const int n = 256;
  std::vector<uint8_t> px = spinner_image(n);
  IWN_CHECK_EQ(px.size(), static_cast<size_t>(n * n * 4));
  auto at = [&](double angle_deg, double radius_frac) {
    const double a = angle_deg * M_PI / 180, r = radius_frac * n;
    const int x = static_cast<int>(n / 2.0 + r * std::cos(a)), y = static_cast<int>(n / 2.0 - r * std::sin(a));
    return &px[(static_cast<size_t>(y) * n + x) * 4];
  };
  IWN_CHECK(at(90, 0.41)[3] > 240);   // the head, at the top
  IWN_CHECK(at(150, 0.41)[3] > 150);  // just behind it (counter-clockwise: it turns clockwise)
  IWN_CHECK(at(300, 0.41)[3] < 80);   // the end of the tail fades out
  IWN_CHECK(at(60, 0.41)[3] < 10);    // ahead of the head: empty
  IWN_CHECK(at(200, 0.2)[3] == 0);    // inside the ring
  IWN_CHECK(at(200, 0.495)[3] == 0);  // outside it
  for (size_t i = 0; i < px.size(); i += 4) {
    if (px[i] != px[i + 3] || px[i + 1] != px[i + 3] || px[i + 2] != px[i + 3]) {
      IWN_CHECK(false);  // premultiplied white: every colour channel equals alpha
      break;
    }
  }
}

IWN_TEST(Loading, Premultiply) {
  uint8_t px[8] = {255, 128, 0, 128, 10, 20, 30, 255};
  premultiply_rgba(px, 2);
  IWN_CHECK_EQ(int(px[0]), 128);
  IWN_CHECK_EQ(int(px[1]), 64);
  IWN_CHECK_EQ(int(px[2]), 0);
  IWN_CHECK_EQ(int(px[3]), 128);
  IWN_CHECK_EQ(int(px[4]), 10);  // opaque: unchanged
  IWN_CHECK_EQ(int(px[7]), 255);
}

// --- composition layers (XR-LAYER-1) ------------------------------------------------------------------------------

namespace {

void fresh_layer_buffer(uint32_t* words) {
  std::memset(words, 0, layers::kWords * sizeof(uint32_t));
  words[layers::kVersionAt] = layers::kVersion;
  words[layers::kCountAt] = layers::kNoList;
}

}  // namespace

IWN_TEST(Layers, BufferLayoutFitsAndNoListMeansProjectionOnly) {
  static_assert(layers::kEntriesAt == layers::kNamesAt + layers::kMaxSwapchains);
  static_assert(layers::kC < layers::kEntryWords);
  uint32_t words[layers::kWords];
  fresh_layer_buffer(words);
  layers::Entry out[layers::kMaxEntries];
  IWN_CHECK_EQ(layers::read_entries(words, out), -1);  // kNoList
  words[layers::kCountAt] = 0;
  IWN_CHECK_EQ(layers::read_entries(words, out), 0);  // an empty list: nothing shown
  words[layers::kVersionAt] = layers::kVersion + 1;
  IWN_CHECK_EQ(layers::read_entries(words, out), -1);  // another version is never read
}

IWN_TEST(Layers, EntriesRoundTripInOrderAndBadOnesAreDropped) {
  uint32_t words[layers::kWords];
  fresh_layer_buffer(words);
  layers::Entry proj;
  proj.kind = layers::kProjection;
  proj.flags = layers::kListed;
  layers::Entry quad;
  quad.kind = layers::kQuad;
  quad.id = 3;
  quad.flags = layers::kListed | layers::kRedrawn | layers::kBlendAlpha | layers::kLocated;
  quad.layout = layers::kStereoTopBottom;
  const float p[7] = {0.3f, 1.5f, -1.2f, 0, 0.7071068f, 0, 0.7071068f};
  std::memcpy(quad.pose, p, sizeof p);
  quad.a = 0.8f;
  quad.b = 0.4f;
  layers::Entry bad = quad;
  bad.kind = static_cast<layers::Kind>(9);
  layers::write_entry(words, 0, quad);
  layers::write_entry(words, 1, bad);
  layers::write_entry(words, 2, proj);
  words[layers::kCountAt] = 3;
  layers::Entry out[layers::kMaxEntries];
  IWN_CHECK_EQ(layers::read_entries(words, out), 2);
  IWN_CHECK_EQ(out[0].kind, layers::kQuad);
  IWN_CHECK_EQ(out[0].id, 3u);
  IWN_CHECK_EQ(out[0].flags, quad.flags);
  IWN_CHECK_EQ(out[0].layout, layers::kStereoTopBottom);
  for (int k = 0; k < 7; ++k) IWN_CHECK_EQ(out[0].pose[k], p[k]);
  IWN_CHECK_EQ(out[0].a, 0.8f);
  IWN_CHECK_EQ(out[1].kind, layers::kProjection);
  // more entries than the buffer holds: the first kMaxEntries
  words[layers::kCountAt] = 1000;
  IWN_CHECK(layers::read_entries(words, out) <= static_cast<int>(layers::kMaxEntries));
}

IWN_TEST(Layers, ViewsPerLayoutUseGlBottomLeftRows) {
  layers::EntryView v[2];
  IWN_CHECK_EQ(layers::entry_views(layers::kMono, 512, 256, v), 1u);
  IWN_CHECK_EQ(v[0].eye, 0);
  IWN_CHECK_EQ(v[0].w, 512);
  IWN_CHECK_EQ(layers::entry_views(layers::kStereoLeftRight, 1024, 256, v), 2u);
  IWN_CHECK(v[0].eye == 1 && v[0].x == 0 && v[0].w == 512);
  IWN_CHECK(v[1].eye == 2 && v[1].x == 512 && v[1].w == 512);
  // top-bottom: the left eye is the top half, the upper rows with GL's origin (IWER's viewport y = h)
  IWN_CHECK_EQ(layers::entry_views(layers::kStereoTopBottom, 512, 512, v), 2u);
  IWN_CHECK(v[0].eye == 1 && v[0].y == 256 && v[0].h == 256);
  IWN_CHECK(v[1].eye == 2 && v[1].y == 0 && v[1].h == 256);
  IWN_CHECK_EQ(layers::entry_views(layers::kStereoArray, 512, 256, v), 2u);
  IWN_CHECK(v[0].array_index == 0 && v[1].array_index == 1 && v[1].w == 512 && v[1].h == 256);
  uint32_t w, h, a;
  layers::image_size(layers::kStereoLeftRight, 300, 100, &w, &h, &a);
  IWN_CHECK(w == 600 && h == 100 && a == 1);
  layers::image_size(layers::kStereoArray, 300, 100, &w, &h, &a);
  IWN_CHECK(w == 300 && h == 100 && a == 2);
}

IWN_TEST(Layers, PosesAndShapesOpenXrAccepts) {
  const float ok[7] = {0, 1, -2, 0, 0, 0, 1};
  IWN_CHECK(layers::valid_pose(ok));
  const float nan[7] = {0, NAN, -2, 0, 0, 0, 1};
  IWN_CHECK(!layers::valid_pose(nan));
  const float zero_q[7] = {0, 1, -2, 0, 0, 0, 0};
  IWN_CHECK(!layers::valid_pose(zero_q));
  layers::Entry q;
  q.kind = layers::kQuad;
  q.a = 1;
  q.b = 0.5f;
  IWN_CHECK(layers::valid_shape(q));
  q.b = 0;
  IWN_CHECK(!layers::valid_shape(q));
  layers::Entry c;
  c.kind = layers::kCylinder;
  c.a = 2;
  c.b = 0.785f;
  c.c = 2;
  IWN_CHECK(layers::valid_shape(c));
  c.b = 7;  // more than a full turn
  IWN_CHECK(!layers::valid_shape(c));
  c.b = 1;
  c.c = INFINITY;
  IWN_CHECK(!layers::valid_shape(c));
}

namespace {

layers::Entry plan_entry(layers::Kind kind, uint32_t id, uint32_t flags) {
  layers::Entry e;
  e.kind = kind;
  e.id = id;
  e.flags = flags | layers::kLocated;
  e.a = kind == layers::kCylinder ? 2.0f : 1.0f;
  e.b = kind == layers::kCylinder ? 1.0f : 0.5f;
  e.c = 2;
  return e;
}

layers::SlotState slot(layers::Kind kind, bool held, bool is_static = false) {
  layers::SlotState s;
  s.live = true;
  s.kind = kind;
  s.held = held;
  s.is_static = is_static;
  return s;
}

}  // namespace

IWN_TEST(Layers, CollectReleasesRedrawnImagesAndPlansWhatCanBeShown) {
  layers::SlotState slots[layers::kMaxSwapchains];
  slots[0] = slot(layers::kQuad, true);
  slots[1] = slot(layers::kCylinder, true, true);  // static
  slots[2] = slot(layers::kQuad, true);            // listed, never drawn: no content yet
  slots[3] = slot(layers::kQuad, true);
  slots[3].live = false;                           // destroyed by the page (goes at flush())
  slots[3].released_once = true;
  slots[4] = slot(layers::kQuad, true);            // drawn without being listed
  const uint32_t L = layers::kListed, R = layers::kRedrawn;
  const layers::Entry list[] = {
      plan_entry(layers::kProjection, 0, L), plan_entry(layers::kQuad, 1, L | R),
      plan_entry(layers::kCylinder, 2, L | R), plan_entry(layers::kQuad, 3, L),
      plan_entry(layers::kQuad, 4, L | R),     plan_entry(layers::kQuad, 5, R),
  };
  layers::Entry plan[layers::kMaxEntries];
  uint32_t release = 0;
  int n = layers::collect(list, 6, slots, &release, plan);
  IWN_CHECK_EQ(release, 0b10011u);  // slots 0, 1 and 4: the redrawn live layers holding an image
  IWN_CHECK_EQ(n, 3);
  IWN_CHECK(plan[0].kind == layers::kProjection && plan[1].id == 1u && plan[2].id == 2u);
  IWN_CHECK(!slots[0].held && slots[0].released_once && !slots[0].static_done);
  IWN_CHECK(slots[1].static_done);
  IWN_CHECK(slots[2].held && !slots[2].released_once);
  IWN_CHECK(slots[4].released_once);  // its content becomes current although it is not shown

  // The next frame: layer 1 has no image yet (a redraw cannot release one); a kind that does not match the slot
  // (layer 2 is a cylinder), an unlocated pose (layer 3, given content now) and a shape OpenXR refuses (layer 5) are
  // left out of the plan.
  layers::Entry next[] = {plan_entry(layers::kQuad, 1, L | R), plan_entry(layers::kQuad, 2, L),
                          plan_entry(layers::kQuad, 3, L), plan_entry(layers::kQuad, 5, L)};
  next[2].flags &= ~layers::kLocated;
  next[3].a = -1;
  slots[2].released_once = true;
  n = layers::collect(next, 4, slots, &release, plan);
  IWN_CHECK_EQ(release, 0u);
  IWN_CHECK_EQ(n, 1);
  IWN_CHECK_EQ(plan[0].id, 1u);
  IWN_CHECK_EQ(layers::collect(next, -1, slots, &release, plan), 0);  // no list: nothing to show
}

IWN_TEST(Layers, ContentOnlyPlansAndContentUnderTheProjectionLayer) {
  const layers::Entry proj = plan_entry(layers::kProjection, 0, layers::kListed);
  const layers::Entry quad = plan_entry(layers::kQuad, 1, layers::kListed);
  const layers::Entry under[] = {quad, proj};
  const layers::Entry over[] = {proj, quad};
  const layers::Entry only[] = {quad};
  IWN_CHECK(layers::plan_has_content(under, 2) && layers::content_under_projection(under, 2));
  IWN_CHECK(layers::plan_has_content(over, 2) && !layers::content_under_projection(over, 2));
  IWN_CHECK(!layers::plan_has_content(&proj, 1) && !layers::content_under_projection(&proj, 1));
  // a session that shows only quad or cylinder layers presents, with no projection layer to blend
  IWN_CHECK(layers::plan_has_content(only, 1) && !layers::content_under_projection(only, 1));
}
