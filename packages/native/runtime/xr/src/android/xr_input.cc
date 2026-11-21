#include "android/xr_input.h"

#include <cstring>

#include "iwn/core/log.h"

namespace iwn::xr {

namespace {

XrPath path(XrInstance instance, const std::string& s) {
  XrPath p = XR_NULL_PATH;
  if (XR_FAILED(xrStringToPath(instance, s.c_str(), &p))) return XR_NULL_PATH;
  return p;
}

const char* const kProfilePaths[5] = {
    "/interaction_profiles/oculus/touch_controller",
    "/interaction_profiles/meta/touch_controller_plus",
    "/interaction_profiles/facebook/touch_controller_pro",
    "/interaction_profiles/khr/simple_controller",
    "/interaction_profiles/ext/hand_interaction_ext",
};
const InputProfile kProfileIds[5] = {InputProfile::kOculusTouch, InputProfile::kTouchPlus, InputProfile::kTouchPro,
                                     InputProfile::kSimple, InputProfile::kHandInteraction};

// XR_META_hand_tracking_microgestures component paths (HandGesture order) and their action names.
const char* const kGesturePaths[kHandGestureCount] = {
    "/input/swipe_left_meta/click", "/input/swipe_right_meta/click", "/input/swipe_forward_meta/click",
    "/input/swipe_backward_meta/click", "/input/tap_thumb_meta/click",
};
const char* const kGestureActions[kHandGestureCount] = {"swipe_left", "swipe_right", "swipe_forward",
                                                        "swipe_backward", "tap_thumb"};

}  // namespace

XrAction XrInput::make_action(const char* name, XrActionType type, bool both_hands) {
  XrActionCreateInfo info{XR_TYPE_ACTION_CREATE_INFO};
  std::strncpy(info.actionName, name, XR_MAX_ACTION_NAME_SIZE - 1);
  std::strncpy(info.localizedActionName, name, XR_MAX_LOCALIZED_ACTION_NAME_SIZE - 1);
  info.actionType = type;
  info.countSubactionPaths = both_hands ? 2 : 1;
  info.subactionPaths = hand_path_;
  XrAction a = XR_NULL_HANDLE;
  XrResult r = xrCreateAction(set_, &info, &a);
  if (XR_FAILED(r)) log(LogLevel::kWarn, "xr: xrCreateAction(%s) failed: %d", name, r);
  return a;
}

XrResult XrInput::suggest(const char* profile, const std::vector<std::pair<XrAction, std::string>>& bindings,
                          bool quiet) {
  std::vector<XrActionSuggestedBinding> list;
  list.reserve(bindings.size());
  for (const auto& [action, p] : bindings) {
    if (action == XR_NULL_HANDLE) continue;
    XrPath bp = path(instance_, p);
    if (bp != XR_NULL_PATH) list.push_back({action, bp});
  }
  XrInteractionProfileSuggestedBinding s{XR_TYPE_INTERACTION_PROFILE_SUGGESTED_BINDING};
  s.interactionProfile = path(instance_, profile);
  s.countSuggestedBindings = static_cast<uint32_t>(list.size());
  s.suggestedBindings = list.data();
  XrResult r = xrSuggestInteractionProfileBindings(instance_, &s);
  if (XR_FAILED(r) && !quiet) log(LogLevel::kWarn, "xr: bindings for %s refused: %d", profile, r);
  return r;
}

// Hands: /interaction_profiles/ext/hand_interaction_ext with the aim and grip poses (so the runtime reports this
// profile, not khr/simple_controller, while a hand is used) and, with XR_META_hand_tracking_microgestures, the five
// microgesture clicks (Quest Browser binds the same paths). A call is all or nothing, and OpenXR refuses the paths
// of an extension the instance did not enable, so the full set goes first, then the poses alone.
void XrInput::suggest_hand_profile() {
  const char* profile = kProfilePaths[4];
  auto bindings = [&](bool gestures) {
    std::vector<std::pair<XrAction, std::string>> b;
    for (int h = 0; h < 2; ++h) {
      const std::string u = h == 0 ? "/user/hand/left" : "/user/hand/right";
      b.push_back({aim_, u + "/input/aim/pose"});
      b.push_back({grip_, u + "/input/grip/pose"});
      if (gestures) {
        for (int g = 0; g < kHandGestureCount; ++g) b.push_back({gesture_[g], u + kGesturePaths[g]});
      }
    }
    return b;
  };
  const XrResult full = suggest(profile, bindings(true), true);
  XrResult poses = XR_SUCCESS;
  if (XR_SUCCEEDED(full)) {
    hand_bindings_ = HandProfileBindings::kPosesAndMicrogestures;
  } else {
    poses = suggest(profile, bindings(false), true);
    hand_bindings_ = XR_SUCCEEDED(poses) ? HandProfileBindings::kPoses : HandProfileBindings::kNone;
  }
  switch (hand_bindings_) {
    case HandProfileBindings::kPosesAndMicrogestures:
      log(LogLevel::kInfo, "xr: hands: %s bound (aim, grip, microgestures -> hand buttons 5-9)", profile);
      break;
    case HandProfileBindings::kPoses:
      log(LogLevel::kInfo, "xr: hands: %s bound (aim, grip); microgestures unavailable (%d)", profile, full);
      break;
    case HandProfileBindings::kNone:
      log(LogLevel::kInfo, "xr: hands: %s unavailable (%d, XR_EXT_hand_interaction not enabled); tracked hands come "
          "with no interaction profile", profile, poses);
      break;
  }
}

bool XrInput::init(XrInstance instance, XrSession session, const InputExtensions& ext, bool system_hand_tracking) {
  instance_ = instance;
  session_ = session;
  ext_ = ext;
  hand_bindings_ = HandProfileBindings::kNone;
  source_[0] = source_[1] = Source::kNone;
  source_logs_ = 0;
  hand_path_[0] = path(instance, "/user/hand/left");
  hand_path_[1] = path(instance, "/user/hand/right");
  for (int i = 0; i < 5; ++i) profile_path_[i] = path(instance, kProfilePaths[i]);

  XrActionSetCreateInfo si{XR_TYPE_ACTION_SET_CREATE_INFO};
  std::strcpy(si.actionSetName, "webxr");
  std::strcpy(si.localizedActionSetName, "WebXR");
  si.priority = 0;
  XrResult r = xrCreateActionSet(instance, &si, &set_);
  if (XR_FAILED(r)) {
    log(LogLevel::kError, "xr: xrCreateActionSet failed: %d", r);
    return false;
  }
  aim_ = make_action("aim_pose", XR_ACTION_TYPE_POSE_INPUT);
  grip_ = make_action("grip_pose", XR_ACTION_TYPE_POSE_INPUT);
  trigger_value_ = make_action("trigger_value", XR_ACTION_TYPE_FLOAT_INPUT);
  trigger_click_ = make_action("trigger_click", XR_ACTION_TYPE_BOOLEAN_INPUT);
  trigger_touch_ = make_action("trigger_touch", XR_ACTION_TYPE_BOOLEAN_INPUT);
  squeeze_value_ = make_action("squeeze_value", XR_ACTION_TYPE_FLOAT_INPUT);
  squeeze_click_ = make_action("squeeze_click", XR_ACTION_TYPE_BOOLEAN_INPUT);
  stick_ = make_action("thumbstick", XR_ACTION_TYPE_VECTOR2F_INPUT);
  stick_click_ = make_action("thumbstick_click", XR_ACTION_TYPE_BOOLEAN_INPUT);
  stick_touch_ = make_action("thumbstick_touch", XR_ACTION_TYPE_BOOLEAN_INPUT);
  primary_click_ = make_action("primary_click", XR_ACTION_TYPE_BOOLEAN_INPUT);
  primary_touch_ = make_action("primary_touch", XR_ACTION_TYPE_BOOLEAN_INPUT);
  secondary_click_ = make_action("secondary_click", XR_ACTION_TYPE_BOOLEAN_INPUT);
  secondary_touch_ = make_action("secondary_touch", XR_ACTION_TYPE_BOOLEAN_INPUT);
  thumbrest_touch_ = make_action("thumbrest_touch", XR_ACTION_TYPE_BOOLEAN_INPUT);
  menu_click_ = make_action("menu_click", XR_ACTION_TYPE_BOOLEAN_INPUT);
  haptic_ = make_action("haptic", XR_ACTION_TYPE_VIBRATION_OUTPUT);
  for (int g = 0; g < kHandGestureCount; ++g) {
    gesture_[g] = make_action(kGestureActions[g], XR_ACTION_TYPE_BOOLEAN_INPUT);
  }

  auto touch = [&](const char* profile) {
    std::vector<std::pair<XrAction, std::string>> b;
    for (int h = 0; h < 2; ++h) {
      const std::string u = h == 0 ? "/user/hand/left" : "/user/hand/right";
      b.push_back({aim_, u + "/input/aim/pose"});
      b.push_back({grip_, u + "/input/grip/pose"});
      b.push_back({trigger_value_, u + "/input/trigger/value"});
      b.push_back({trigger_click_, u + "/input/trigger/value"});
      b.push_back({trigger_touch_, u + "/input/trigger/touch"});
      b.push_back({squeeze_value_, u + "/input/squeeze/value"});
      b.push_back({squeeze_click_, u + "/input/squeeze/value"});
      b.push_back({stick_, u + "/input/thumbstick"});
      b.push_back({stick_click_, u + "/input/thumbstick/click"});
      b.push_back({stick_touch_, u + "/input/thumbstick/touch"});
      b.push_back({primary_click_, u + (h == 0 ? "/input/x/click" : "/input/a/click")});
      b.push_back({primary_touch_, u + (h == 0 ? "/input/x/touch" : "/input/a/touch")});
      b.push_back({secondary_click_, u + (h == 0 ? "/input/y/click" : "/input/b/click")});
      b.push_back({secondary_touch_, u + (h == 0 ? "/input/y/touch" : "/input/b/touch")});
      b.push_back({thumbrest_touch_, u + "/input/thumbrest/touch"});
      if (h == 0) b.push_back({menu_click_, u + "/input/menu/click"});
      b.push_back({haptic_, u + "/output/haptic"});
    }
    suggest(profile, b);
  };
  touch(kProfilePaths[0]);
  if (ext.touch_controller_plus) touch(kProfilePaths[1]);
  if (ext.touch_controller_pro) touch(kProfilePaths[2]);
  // No khr/simple_controller bindings: Horizon OS binds only tracked hands to it (input_map.h), which made hands
  // show up as controllers. Quest Browser does not suggest it either.
  suggest_hand_profile();

  for (int h = 0; h < 2; ++h) {
    XrActionSpaceCreateInfo ai{XR_TYPE_ACTION_SPACE_CREATE_INFO};
    ai.subactionPath = hand_path_[h];
    ai.poseInActionSpace.orientation.w = 1;
    ai.action = aim_;
    xrCreateActionSpace(session, &ai, &aim_space_[h]);
    ai.action = grip_;
    xrCreateActionSpace(session, &ai, &grip_space_[h]);
  }
  XrSessionActionSetsAttachInfo attach{XR_TYPE_SESSION_ACTION_SETS_ATTACH_INFO};
  attach.countActionSets = 1;
  attach.actionSets = &set_;
  r = xrAttachSessionActionSets(session, &attach);
  if (XR_FAILED(r)) {
    log(LogLevel::kError, "xr: xrAttachSessionActionSets failed: %d", r);
    return false;
  }

  if (ext.hand_tracking && system_hand_tracking) {
    xrGetInstanceProcAddr(instance, "xrCreateHandTrackerEXT",
                          reinterpret_cast<PFN_xrVoidFunction*>(&create_hand_tracker_));
    xrGetInstanceProcAddr(instance, "xrDestroyHandTrackerEXT",
                          reinterpret_cast<PFN_xrVoidFunction*>(&destroy_hand_tracker_));
    xrGetInstanceProcAddr(instance, "xrLocateHandJointsEXT",
                          reinterpret_cast<PFN_xrVoidFunction*>(&locate_hand_joints_));
    if (create_hand_tracker_ && locate_hand_joints_) {
      for (int h = 0; h < 2; ++h) {
        XrHandTrackerCreateInfoEXT ci{XR_TYPE_HAND_TRACKER_CREATE_INFO_EXT};
        ci.hand = h == 0 ? XR_HAND_LEFT_EXT : XR_HAND_RIGHT_EXT;
        ci.handJointSet = XR_HAND_JOINT_SET_DEFAULT_EXT;
        r = create_hand_tracker_(session, &ci, &hand_tracker_[h]);
        if (XR_FAILED(r)) {
          log(LogLevel::kWarn, "xr: xrCreateHandTrackerEXT failed: %d (hands disabled)", r);
          hand_tracker_[0] = hand_tracker_[1] = XR_NULL_HANDLE;
          break;
        }
      }
    }
  }
  refresh_profiles();
  return true;
}

void XrInput::destroy() {
  stop_haptics();
  for (int h = 0; h < 2; ++h) {
    if (hand_tracker_[h] != XR_NULL_HANDLE && destroy_hand_tracker_) destroy_hand_tracker_(hand_tracker_[h]);
    hand_tracker_[h] = XR_NULL_HANDLE;
    if (aim_space_[h] != XR_NULL_HANDLE) xrDestroySpace(aim_space_[h]);
    if (grip_space_[h] != XR_NULL_HANDLE) xrDestroySpace(grip_space_[h]);
    aim_space_[h] = grip_space_[h] = XR_NULL_HANDLE;
  }
  if (set_ != XR_NULL_HANDLE) xrDestroyActionSet(set_);  // destroys its actions
  set_ = XR_NULL_HANDLE;
  for (XrAction& a : gesture_) a = XR_NULL_HANDLE;
  hand_bindings_ = HandProfileBindings::kNone;
  session_ = XR_NULL_HANDLE;
}

void XrInput::refresh_profiles() {
  for (int h = 0; h < 2; ++h) {
    XrInteractionProfileState st{XR_TYPE_INTERACTION_PROFILE_STATE};
    InputProfile p = InputProfile::kNone;
    if (XR_SUCCEEDED(xrGetCurrentInteractionProfile(session_, hand_path_[h], &st))) {
      for (int i = 0; i < 5; ++i) {
        if (st.interactionProfile != XR_NULL_PATH && st.interactionProfile == profile_path_[i]) p = kProfileIds[i];
      }
    }
    if (p != profile_[h]) {
      log(LogLevel::kInfo, "xr: %s hand interaction profile: %s", h == 0 ? "left" : "right",
          p == InputProfile::kNone ? "none" : kProfilePaths[static_cast<int>(p) - 1]);
    }
    profile_[h] = p;
  }
}

const char* XrInput::profile_name(int hand) const {
  const int p = static_cast<int>(profile_[hand]);
  return p == 0 ? "none" : kProfilePaths[p - 1];
}

bool XrInput::sample_bool(XrAction a, int hand, bool*) {
  if (a == XR_NULL_HANDLE) return false;
  XrActionStateGetInfo gi{XR_TYPE_ACTION_STATE_GET_INFO};
  gi.action = a;
  gi.subactionPath = hand_path_[hand];
  XrActionStateBoolean st{XR_TYPE_ACTION_STATE_BOOLEAN};
  if (XR_FAILED(xrGetActionStateBoolean(session_, &gi, &st)) || !st.isActive) return false;
  return st.currentState == XR_TRUE;
}

float XrInput::sample_float(XrAction a, int hand) {
  if (a == XR_NULL_HANDLE) return 0;
  XrActionStateGetInfo gi{XR_TYPE_ACTION_STATE_GET_INFO};
  gi.action = a;
  gi.subactionPath = hand_path_[hand];
  XrActionStateFloat st{XR_TYPE_ACTION_STATE_FLOAT};
  if (XR_FAILED(xrGetActionStateFloat(session_, &gi, &st)) || !st.isActive) return 0;
  return st.currentState;
}

PoseSample XrInput::locate(XrSpace space, XrSpace base, XrTime time) {
  PoseSample out;
  if (space == XR_NULL_HANDLE) return out;
  XrSpaceLocation loc{XR_TYPE_SPACE_LOCATION};
  if (XR_FAILED(xrLocateSpace(space, base, time, &loc))) return out;
  out.valid = location_valid(loc.locationFlags);
  if (out.valid) out.pose = loc.pose;
  return out;
}

void XrInput::sample(XrTime time, XrSpace base, bool hand_tracking_enabled, bool focused, HandInput out[2]) {
  ++samples_;
  if (focused && set_ != XR_NULL_HANDLE) {
    XrActiveActionSet active{set_, XR_NULL_PATH};
    XrActionsSyncInfo sync{XR_TYPE_ACTIONS_SYNC_INFO};
    sync.countActiveActionSets = 1;
    sync.activeActionSets = &active;
    xrSyncActions(session_, &sync);
  }
  for (int h = 0; h < 2; ++h) {
    HandInput& in = out[h];
    ControllerSample& c = in.controller;
    c = ControllerSample{};
    in.hand.tracked = false;
    in.hand.aim = PoseSample{};
    for (bool& g : in.hand.gestures) g = false;
    in.profile = profile_[h];
    if (focused) {
      XrActionStateGetInfo gi{XR_TYPE_ACTION_STATE_GET_INFO};
      gi.action = grip_;
      gi.subactionPath = hand_path_[h];
      XrActionStatePose ps{XR_TYPE_ACTION_STATE_POSE};
      c.active = XR_SUCCEEDED(xrGetActionStatePose(session_, &gi, &ps)) && ps.isActive;
      if (c.active && is_controller_profile(profile_[h])) {
        c.aim = locate(aim_space_[h], base, time);
        c.grip = locate(grip_space_[h], base, time);
        c.trigger = sample_float(trigger_value_, h);
        c.trigger_pressed = sample_bool(trigger_click_, h);
        c.trigger_touched = sample_bool(trigger_touch_, h);
        c.squeeze = sample_float(squeeze_value_, h);
        c.squeeze_pressed = sample_bool(squeeze_click_, h);
        XrActionStateGetInfo vi{XR_TYPE_ACTION_STATE_GET_INFO};
        vi.action = stick_;
        vi.subactionPath = hand_path_[h];
        XrActionStateVector2f vs{XR_TYPE_ACTION_STATE_VECTOR2F};
        if (XR_SUCCEEDED(xrGetActionStateVector2f(session_, &vi, &vs)) && vs.isActive) {
          c.stick_x = vs.currentState.x;
          c.stick_y = vs.currentState.y;
        }
        c.stick_click = sample_bool(stick_click_, h);
        c.stick_touch = sample_bool(stick_touch_, h);
        c.primary_click = sample_bool(primary_click_, h);
        c.primary_touch = sample_bool(primary_touch_, h);
        c.secondary_click = sample_bool(secondary_click_, h);
        c.secondary_touch = sample_bool(secondary_touch_, h);
        c.thumbrest_touch = sample_bool(thumbrest_touch_, h);
        if (h == 0) c.menu_click = sample_bool(menu_click_, h);
      }
    }
    // Hands: located unless a controller is held in this hand. A session without hand tracking still gets a pointer
    // from a tracked hand (resolve_input); its joints stay out of the record then (write_hand_input, controller mode).
    const bool held = c.active && is_controller_profile(profile_[h]);
    if (hand_tracker_[h] != XR_NULL_HANDLE && !held) {
      HandSample& hs = in.hand;
      XrHandJointsLocateInfoEXT li{XR_TYPE_HAND_JOINTS_LOCATE_INFO_EXT};
      li.baseSpace = base;
      li.time = time;
      XrHandJointLocationsEXT locs{XR_TYPE_HAND_JOINT_LOCATIONS_EXT};
      locs.jointCount = kOpenXrJoints;
      locs.jointLocations = hs.joints;
      XrHandTrackingAimStateFB aim{XR_TYPE_HAND_TRACKING_AIM_STATE_FB};
      if (ext_.hand_tracking_aim) locs.next = &aim;
      if (XR_SUCCEEDED(locate_hand_joints_(hand_tracker_[h], &li, &locs)) && hand_tracked(locs.isActive, hs.joints)) {
        hs.tracked = true;
        if (ext_.hand_tracking_aim) {
          hs.has_aim_state = true;
          hs.aim.valid = (aim.status & XR_HAND_TRACKING_AIM_VALID_BIT_FB) != 0;
          hs.aim.pose = aim.aimPose;
          hs.pinching = (aim.status & XR_HAND_TRACKING_AIM_INDEX_PINCHING_BIT_FB) != 0;
          hs.pinch_index = aim.pinchStrengthIndex;
          hs.menu_pressed = (aim.status & XR_HAND_TRACKING_AIM_MENU_PRESSED_BIT_FB) != 0;
        } else {
          hs.has_aim_state = false;
          hs.aim = derive_aim(hs.joints);
          const XrHandJointLocationEXT& t = hs.joints[XR_HAND_JOINT_THUMB_TIP_EXT];
          const XrHandJointLocationEXT& i = hs.joints[XR_HAND_JOINT_INDEX_TIP_EXT];
          if (location_valid(t.locationFlags) && location_valid(i.locationFlags)) {
            hs.pinching = pinch_[h].update(t.pose.position, i.pose.position);
            hs.pinch_index = pinch_[h].value();
          }
          hs.menu_pressed = false;
        }
        // Microgestures: each click reads true for the frames the runtime reports the gesture (the hand profile's
        // actions are only active while the runtime reports that profile for this hand).
        if (focused && hand_bindings_ == HandProfileBindings::kPosesAndMicrogestures) {
          for (int g = 0; g < kHandGestureCount; ++g) hs.gestures[g] = sample_bool(gesture_[g], h);
        }
      } else {
        pinch_[h].reset();
      }
    }
    resolve_input(in, hand_tracking_enabled, focused);
    note_source(h, in);
  }
}

// One log line per change of what a hand shows (controller, hand, a hand's pointer, nothing), capped per session:
// on a device this is the record of which source the app saw, with the interaction profile behind it.
void XrInput::note_source(int hand, const HandInput& in) {
  Source s = Source::kNone;
  if (in.mode == InputMode::kHand) {
    s = Source::kHand;
  } else if (in.mode == InputMode::kController) {
    s = is_controller_profile(in.profile) ? Source::kController : Source::kHandPointer;
  }
  if (s == source_[hand]) return;
  static const char* const kNames[] = {"none", "controller", "hand",
                                       "hand pointer (the session did not enable hand-tracking)"};
  constexpr int kMaxLogs = 200;
  if (source_logs_ < kMaxLogs) {
    log(LogLevel::kInfo, "xr: %s input: %s -> %s (profile %s)", hand == 0 ? "left" : "right",
        kNames[static_cast<int>(source_[hand])], kNames[static_cast<int>(s)], profile_name(hand));
  } else if (source_logs_ == kMaxLogs) {
    log(LogLevel::kInfo, "xr: further input source changes are not logged this session");
  }
  if (source_logs_ <= kMaxLogs) ++source_logs_;
  source_[hand] = s;
}

void XrInput::haptic(int hand, float amplitude, int64_t duration_ns, float frequency) {
  if (haptic_ == XR_NULL_HANDLE || hand < 0 || hand > 1) return;
  XrHapticActionInfo hi{XR_TYPE_HAPTIC_ACTION_INFO};
  hi.action = haptic_;
  hi.subactionPath = hand_path_[hand];
  XrHapticVibration v{XR_TYPE_HAPTIC_VIBRATION};
  v.amplitude = amplitude < 0 ? 0 : (amplitude > 1 ? 1 : amplitude);
  v.duration = duration_ns > 0 ? duration_ns : XR_MIN_HAPTIC_DURATION;
  v.frequency = frequency > 0 ? frequency : XR_FREQUENCY_UNSPECIFIED;
  xrApplyHapticFeedback(session_, &hi, reinterpret_cast<const XrHapticBaseHeader*>(&v));
}

void XrInput::stop_haptics() {
  if (haptic_ == XR_NULL_HANDLE || session_ == XR_NULL_HANDLE) return;
  for (int h = 0; h < 2; ++h) {
    XrHapticActionInfo hi{XR_TYPE_HAPTIC_ACTION_INFO};
    hi.action = haptic_;
    hi.subactionPath = hand_path_[h];
    xrStopHapticFeedback(session_, &hi);
  }
}

}  // namespace iwn::xr
