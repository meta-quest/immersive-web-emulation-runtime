// OpenXR input for the XR thread (docs/spec/10 IN-1..7): one action set with WebXR's controller controls bound for
// the Touch, Touch Plus and Touch Pro profiles, the hand interaction profile (XR_EXT_hand_interaction: aim and grip
// poses, plus the XR_META_hand_tracking_microgestures swipes and tap when the runtime has them), XR_EXT_hand_tracking
// joints with XR_FB_hand_tracking_aim, and haptics. Samples into iwn::xr::HandInput (input_map.h), which the frame
// record writer maps to HOST-INPUT's layout.
//
// Hands or controllers follow the interaction profile the runtime reports per hand, as in Quest Browser (which
// enables the same two hand extensions and binds the same microgesture paths to hand gamepad buttons 5-9): the hand
// interaction profile while the hand is used, a Touch profile while a controller is held. khr/simple_controller is
// not suggested: Horizon OS binds tracked hands to it when no hand profile is suggested, so hands showed up as
// controllers (input_map.h). Quest Browser does not suggest it either.
//
// `pressed` for the trigger and squeeze comes from boolean actions bound to their /value inputs, so OpenXR's own
// threshold-with-hysteresis decides (OpenXR 1.1 §11.4), the conversion a Chromium-based browser on the same runtime
// gets too (IN-3). Sources: OpenXR 1.1 (§11 input, interaction profile paths), XR_EXT_hand_tracking,
// XR_FB_hand_tracking_aim, XR_EXT_hand_interaction, XR_META_hand_tracking_microgestures,
// XR_META_touch_controller_plus, XR_FB_touch_controller_pro.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "iwn/xr/input_map.h"
#include "iwn/xr/openxr_headers.h"

namespace iwn::xr {

struct InputExtensions {
  bool hand_tracking = false;
  bool hand_tracking_aim = false;
  bool touch_controller_plus = false;
  bool touch_controller_pro = false;
};

// What the runtime accepted for /interaction_profiles/ext/hand_interaction_ext. Decided by the bindings call
// itself: OpenXR refuses a profile or component path of an extension the instance did not enable
// (XR_ERROR_PATH_UNSUPPORTED), so the full set (poses + microgestures) is tried first, then the poses alone.
enum class HandProfileBindings { kNone, kPoses, kPosesAndMicrogestures };

class XrInput {
 public:
  // Creates the action set, actions, suggested bindings and action spaces, attaches the set, creates hand trackers
  // when the extension and the system support them. False when the action set could not be attached.
  bool init(XrInstance instance, XrSession session, const InputExtensions& ext, bool system_hand_tracking);
  void destroy();
  HandProfileBindings hand_profile_bindings() const { return hand_bindings_; }

  // XR thread, per frame handed to JS. `hand_tracking_enabled`: the WebXR session enabled hand-tracking.
  // `focused`: the session is FOCUSED (actions only update then). Writes both hands' samples into `out`.
  void sample(XrTime time, XrSpace base, bool hand_tracking_enabled, bool focused, HandInput out[2]);

  // XR_TYPE_EVENT_DATA_INTERACTION_PROFILE_CHANGED (and once after attach).
  void refresh_profiles();
  InputProfile profile(int hand) const { return profile_[hand]; }
  const char* profile_name(int hand) const;

  // IN-7: amplitude 0..1, duration ns, frequency Hz (0 = XR_FREQUENCY_UNSPECIFIED). A new pulse replaces the
  // running one.
  void haptic(int hand, float amplitude, int64_t duration_ns, float frequency);
  void stop_haptics();

  bool hand_tracking_available() const { return hand_tracker_[0] != XR_NULL_HANDLE; }
  uint64_t samples() const { return samples_; }

 private:
  XrAction make_action(const char* name, XrActionType type, bool both_hands = true);
  // `quiet`: a refusal is expected (probing an extension's paths) and logged by the caller.
  XrResult suggest(const char* profile, const std::vector<std::pair<XrAction, std::string>>& bindings,
                   bool quiet = false);
  void suggest_hand_profile();
  void note_source(int hand, const HandInput& in);
  bool sample_bool(XrAction a, int hand, bool* changed = nullptr);
  float sample_float(XrAction a, int hand);
  PoseSample locate(XrSpace space, XrSpace base, XrTime time);

  XrInstance instance_ = XR_NULL_HANDLE;
  XrSession session_ = XR_NULL_HANDLE;
  InputExtensions ext_;
  XrActionSet set_ = XR_NULL_HANDLE;
  XrPath hand_path_[2] = {XR_NULL_PATH, XR_NULL_PATH};
  XrAction aim_ = XR_NULL_HANDLE, grip_ = XR_NULL_HANDLE;
  XrAction trigger_value_ = XR_NULL_HANDLE, trigger_click_ = XR_NULL_HANDLE, trigger_touch_ = XR_NULL_HANDLE;
  XrAction squeeze_value_ = XR_NULL_HANDLE, squeeze_click_ = XR_NULL_HANDLE;
  XrAction stick_ = XR_NULL_HANDLE, stick_click_ = XR_NULL_HANDLE, stick_touch_ = XR_NULL_HANDLE;
  XrAction primary_click_ = XR_NULL_HANDLE, primary_touch_ = XR_NULL_HANDLE;
  XrAction secondary_click_ = XR_NULL_HANDLE, secondary_touch_ = XR_NULL_HANDLE;
  XrAction thumbrest_touch_ = XR_NULL_HANDLE, menu_click_ = XR_NULL_HANDLE, haptic_ = XR_NULL_HANDLE;
  XrAction gesture_[kHandGestureCount] = {};  // microgesture clicks, HandGesture order
  HandProfileBindings hand_bindings_ = HandProfileBindings::kNone;
  // The source each hand last showed, for the log (a line per change, capped per session).
  enum class Source { kNone, kController, kHand, kHandPointer };
  Source source_[2] = {Source::kNone, Source::kNone};
  int source_logs_ = 0;
  XrSpace aim_space_[2] = {XR_NULL_HANDLE, XR_NULL_HANDLE};
  XrSpace grip_space_[2] = {XR_NULL_HANDLE, XR_NULL_HANDLE};
  InputProfile profile_[2] = {InputProfile::kNone, InputProfile::kNone};
  XrPath profile_path_[5] = {};  // touch, touch plus, touch pro, simple, hand interaction

  XrHandTrackerEXT hand_tracker_[2] = {XR_NULL_HANDLE, XR_NULL_HANDLE};
  PFN_xrCreateHandTrackerEXT create_hand_tracker_ = nullptr;
  PFN_xrDestroyHandTrackerEXT destroy_hand_tracker_ = nullptr;
  PFN_xrLocateHandJointsEXT locate_hand_joints_ = nullptr;
  PinchDetector pinch_[2];
  uint64_t samples_ = 0;
};

}  // namespace iwn::xr
