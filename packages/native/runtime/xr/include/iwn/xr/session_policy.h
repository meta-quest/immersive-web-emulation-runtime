/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// OpenXR session state -> WebXR visibility, and the session-lifetime timers (docs/spec/08 XR-LIFE-3/4/5/7,
// XR-IDLE-*), V8-free so they are unit-tested on the host.
#pragma once

#include <cstdint>

#include "iwn/xr/openxr_headers.h"

namespace iwn::xr {

struct Visibility {
  bool visible = false;
  bool focused = false;
  bool operator==(const Visibility& o) const { return visible == o.visible && focused == o.focused; }
  bool operator!=(const Visibility& o) const { return !(*this == o); }
};

// XR-LIFE-4: FOCUSED -> visible, VISIBLE -> visible-blurred, everything else -> hidden.
Visibility visibility_for(XrSessionState state);
// "visible" | "visible-blurred" | "hidden" (XRVisibilityState).
const char* web_visibility(Visibility v);
const char* session_state_name(XrSessionState state);
// The OpenXR frame loop runs (xrBeginSession done, not yet ended) in these states.
bool frame_loop_state(XrSessionState state);

struct LifePolicyConfig {
  double end_grace_ms = 2000;              // XR-LIFE-5; < 0 disables the exit
  double never_offered_error_ms = 10000;   // XR-LIFE-7 error line; < 0 disables
  double never_offered_exit_ms = 30000;    // XR-LIFE-7 exit; < 0 disables
  bool debug_endpoint = false;             // inspector or debug endpoint served: XR-LIFE-7 never exits
};

// Decides when the runtime logs XR-LIFE-7's error and when it asks OpenXR to exit (XR-LIFE-5/7). The XR thread
// feeds it events and calls tick() once per loop iteration. Everything except the OpenXR visibility is about the
// current page: on_page_started() forgets it.
class LifePolicy {
 public:
  explicit LifePolicy(const LifePolicyConfig& config = {}) : config_(config) {}

  // A new page context replaced the old one (location.reload(), DevTools Page.reload; PROC-8). The old page's
  // session ended with it; the new page is judged on its own: XR-LIFE-7 from its own entry evaluation (debug builds
  // never exit there), not XR-LIFE-5's grace period, which would close an app that takes longer than the grace
  // period to boot and offer again.
  void on_page_started(double now);
  void on_entry_evaluated(double now);   // the page's entry module finished evaluating (window load)
  // offerSession() or requestSession() was called. After the page's session ended, a request (or a held offer in
  // explicit-grant mode) stops XR-LIFE-5's clock until a session starts or every pending request is rejected.
  void on_offered(double now);
  // Every offerSession()/requestSession() still pending was rejected and no session exists (for example a required
  // feature this runtime does not grant): until a later offer, XR-LIFE-7 applies again, counted from the entry
  // evaluation, so the user is not left in the idle presentation for good. Once the page had a session, XR-LIFE-5's
  // grace period applies again instead, counted from the rejection.
  void on_offer_rejected(double now);
  void on_session_started(double now);   // a WebXR session exists
  void on_session_ended(double now);     // it ended (app or system); the idle presentation follows
  void on_xr_visible(bool visible, double now);  // OpenXR VISIBLE/FOCUSED vs not

  enum class Action { kNone, kLogNeverOffered, kRequestExit };
  struct Result {
    Action action = Action::kNone;
    const char* reason = "";
  };
  // At most one action per call; each XR-LIFE-7 action happens once.
  Result tick(double now);

  bool session_active() const { return session_active_; }
  bool ever_offered() const { return offered_; }
  // XR-LIFE-7 applies because the app's requests were rejected (not because it never made one).
  bool offers_rejected() const { return offers_rejected_; }
  uint32_t never_offered_errors() const { return never_offered_logged_ ? 1 : 0; }

 private:
  LifePolicyConfig config_;
  double entry_ms_ = -1;
  bool offered_ = false;
  bool offers_rejected_ = false;
  bool session_active_ = false;
  bool had_session_ = false;
  bool rerequested_ = false;  // the page's session ended and it asked for a new one (pending): XR-LIFE-5 waits
  double ended_ms_ = -1;
  bool visible_ = false;
  double visible_since_ms_ = -1;
  bool never_offered_logged_ = false;
  bool exit_requested_ = false;
};

}  // namespace iwn::xr
