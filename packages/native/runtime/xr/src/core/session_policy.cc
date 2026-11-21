/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "iwn/xr/session_policy.h"

#include <algorithm>

namespace iwn::xr {

Visibility visibility_for(XrSessionState state) {
  switch (state) {
    case XR_SESSION_STATE_FOCUSED: return {true, true};
    case XR_SESSION_STATE_VISIBLE: return {true, false};
    default: return {false, false};
  }
}

const char* web_visibility(Visibility v) {
  if (!v.visible) return "hidden";
  return v.focused ? "visible" : "visible-blurred";
}

const char* session_state_name(XrSessionState state) {
  switch (state) {
    case XR_SESSION_STATE_UNKNOWN: return "UNKNOWN";
    case XR_SESSION_STATE_IDLE: return "IDLE";
    case XR_SESSION_STATE_READY: return "READY";
    case XR_SESSION_STATE_SYNCHRONIZED: return "SYNCHRONIZED";
    case XR_SESSION_STATE_VISIBLE: return "VISIBLE";
    case XR_SESSION_STATE_FOCUSED: return "FOCUSED";
    case XR_SESSION_STATE_STOPPING: return "STOPPING";
    case XR_SESSION_STATE_LOSS_PENDING: return "LOSS_PENDING";
    case XR_SESSION_STATE_EXITING: return "EXITING";
    default: return "?";
  }
}

bool frame_loop_state(XrSessionState state) {
  return state == XR_SESSION_STATE_SYNCHRONIZED || state == XR_SESSION_STATE_VISIBLE ||
         state == XR_SESSION_STATE_FOCUSED;
}

void LifePolicy::on_page_started(double now) {
  (void)now;
  entry_ms_ = -1;  // re-armed by the new page's load
  offered_ = false;
  offers_rejected_ = false;
  session_active_ = false;
  had_session_ = false;
  rerequested_ = false;
  ended_ms_ = -1;
  never_offered_logged_ = false;  // the new page gets its own error line
}

void LifePolicy::on_entry_evaluated(double now) {
  if (entry_ms_ < 0) entry_ms_ = now;
}

void LifePolicy::on_offered(double now) {
  (void)now;
  offered_ = true;
  // A request made while a session is active is rejected at once (InvalidStateError), so only one made after the
  // end waits for anything.
  if (had_session_ && !session_active_) rerequested_ = true;
}

void LifePolicy::on_offer_rejected(double now) {
  if (session_active_) return;
  if (had_session_) {
    rerequested_ = false;
    ended_ms_ = std::max(ended_ms_, now);
    return;
  }
  offered_ = false;
  offers_rejected_ = true;
}

void LifePolicy::on_session_started(double now) {
  (void)now;
  offered_ = true;
  session_active_ = true;
  had_session_ = true;
  rerequested_ = false;
  ended_ms_ = -1;
}

void LifePolicy::on_session_ended(double now) {
  if (!session_active_) return;
  session_active_ = false;
  ended_ms_ = now;
}

void LifePolicy::on_xr_visible(bool visible, double now) {
  if (visible == visible_) return;
  visible_ = visible;
  visible_since_ms_ = visible ? now : -1;
}

LifePolicy::Result LifePolicy::tick(double now) {
  if (exit_requested_) return {};
  // XR-LIFE-5: the page had a session, none is active now, none was requested since, and none came back within the
  // grace period while the user could see the (empty) idle presentation. The clock runs from the end (or the
  // rejection of the page's new request), or from becoming visible again after a system-initiated end while the app
  // was in the background.
  if (had_session_ && !session_active_ && !rerequested_ && config_.end_grace_ms >= 0 && visible_) {
    const double since = std::max(ended_ms_, visible_since_ms_);
    if (since >= 0 && now - since >= config_.end_grace_ms) {
      exit_requested_ = true;
      return {Action::kRequestExit, "the WebXR session ended and no new one started within the grace period"};
    }
  }
  // XR-LIFE-7: never offered or requested, or every request was rejected (a held offer counts as offered).
  if (!offered_ && entry_ms_ >= 0) {
    const double since = now - entry_ms_;
    if (!never_offered_logged_ && config_.never_offered_error_ms >= 0 && since >= config_.never_offered_error_ms) {
      never_offered_logged_ = true;
      return {Action::kLogNeverOffered,
              offers_rejected_ ? "every offerSession/requestSession was rejected" : "no offerSession/requestSession"};
    }
    if (!config_.debug_endpoint && config_.never_offered_exit_ms >= 0 && since >= config_.never_offered_exit_ms) {
      exit_requested_ = true;
      return {Action::kRequestExit, offers_rejected_
                                        ? "every immersive session the app requested was rejected"
                                        : "the app never offered or requested an immersive session"};
    }
  }
  return {};
}

}  // namespace iwn::xr
