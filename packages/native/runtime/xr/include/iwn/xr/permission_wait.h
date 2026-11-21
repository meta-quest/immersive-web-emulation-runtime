// When to stop waiting for the answer to an Android runtime-permission request (XR-PERM-1), V8- and JNI-free so it
// is unit-tested on the host (xr_permissions.cc drives it).
//
// NativeActivity does not forward onRequestPermissionsResult, so the runtime polls checkSelfPermission after
// Activity.requestPermissions. A grant shows up there; a denial does not. The dialog is a system panel that takes the
// input focus from the app (OpenXR FOCUSED -> VISIBLE while it shows, FOCUSED again once answered), so the answer is
// in when the session got its focus back. When nothing is held yet and the focus never goes, the system answered
// without a dialog (the user had chosen "don't ask again", or a policy denies it). The dialog pauses the app on
// Quest 3 (the OpenXR session goes to IDLE until it is answered), so an app that asks before its session is FOCUSED
// (at boot) may only get the focus once the dialog is answered: the first focus then starts the "no dialog" clock
// afresh, and a denial takes appear_ms longer to be known. There is no time limit while the dialog is up (or before
// the app had the focus at all): an answer given after any delay is the answer, and a verdict while the dialog still
// shows would deny what the user may still allow. A grant, too, counts only once the app has the focus again: the
// dialog's result reaches the activity when it resumes, and Android drops a request made before that ("Can request
// only one set of permissions at a time"), which the next request in the broker's queue would otherwise be.
#pragma once

namespace iwn::xr {

struct PermissionWaitConfig {
  double appear_ms = 5000;  // no focus loss this long after the request: no dialog came, the answer is in
  double settle_ms = 300;   // after the focus came back, for the permission state to catch up
};

class PermissionWait {
 public:
  // `focused_at_start`: the app had the input focus when it asked.
  PermissionWait(double now, bool focused_at_start, const PermissionWaitConfig& config = {})
      : config_(config), appear_from_(now), focused_(focused_at_start) {}

  enum class State { kWaiting, kGranted, kAnswered, kNoDialog };
  // One poll: whether every permission asked for is held now, and whether the app has the focus.
  State poll(double now, bool all_held, bool focused) {
    if (all_held && focused) return State::kGranted;
    if (!focused_) {
      // not focused yet when it asked: the first focus is the baseline (the session just got going, or the dialog
      // was answered before the app ever had the focus)
      if (!focused) return State::kWaiting;
      focused_ = true;
      appear_from_ = now;
      return State::kWaiting;
    }
    if (!focused) {
      // the dialog is up: wait for its answer however long the user takes
      lost_ = true;
      back_at_ = -1;
      return State::kWaiting;
    }
    if (lost_) {
      if (back_at_ < 0) back_at_ = now;
      return now - back_at_ >= config_.settle_ms ? State::kAnswered : State::kWaiting;
    }
    return now - appear_from_ >= config_.appear_ms ? State::kNoDialog : State::kWaiting;
  }
  bool dialog_seen() const { return lost_; }

 private:
  PermissionWaitConfig config_;
  double appear_from_;
  bool focused_;  // had the focus at the start or since
  bool lost_ = false;
  double back_at_ = -1;
};

}  // namespace iwn::xr
