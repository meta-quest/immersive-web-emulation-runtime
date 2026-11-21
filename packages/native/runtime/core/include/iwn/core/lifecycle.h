// Page lifecycle from Android activity callbacks (PROC-6, PROC-7), V8-free. Turns activity state changes into the
// page events the bundle sees: document `visibilitychange` (with document.visibilityState), window `focus`/`blur`,
// window `pagehide` on exit. An external "hidden" input lets the XR module fold in the OpenXR session state later
// (VISIBLE/FOCUSED) without changing the activity rules.
#pragma once

#include <string>
#include <vector>

namespace iwn {

enum class LifecycleInput {
  kStart,
  kResume,
  kPause,
  kStop,
  kFocusGained,
  kFocusLost,
  kDestroy,
  kExternalHidden,   // e.g. OpenXR session not VISIBLE
  kExternalVisible,
};

struct PageEvent {
  enum class Target { kWindow, kDocument } target;
  std::string type;  // "visibilitychange", "focus", "blur", "pagehide"
};

class Lifecycle {
 public:
  // Applies an input; returns the events to dispatch, in order.
  std::vector<PageEvent> apply(LifecycleInput input);

  bool visible() const { return visible_; }
  bool focused() const { return focused_; }
  bool resumed() const { return resumed_; }
  bool destroyed() const { return destroyed_; }
  const char* visibility_state() const { return visible_ ? "visible" : "hidden"; }

 private:
  void recompute(std::vector<PageEvent>& out);
  // The page starts visible and focused: the activity is being launched to the front (an app that checks
  // document.hidden at boot must not stall); the first onPause makes it hidden.
  bool resumed_ = true;
  bool window_focus_ = true;
  bool external_hidden_ = false;
  bool destroyed_ = false;
  bool visible_ = true;
  bool focused_ = true;
};

}  // namespace iwn
