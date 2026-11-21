/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "iwn/core/lifecycle.h"

namespace iwn {

void Lifecycle::recompute(std::vector<PageEvent>& out) {
  bool visible = !destroyed_ && resumed_ && !external_hidden_;
  bool focused = visible && window_focus_;
  // Order as browsers do when a tab goes to the background: blur, then visibilitychange; the reverse on return.
  if (focused_ && !focused) {
    focused_ = false;
    out.push_back({PageEvent::Target::kWindow, "blur"});
  }
  if (visible != visible_) {
    visible_ = visible;
    out.push_back({PageEvent::Target::kDocument, "visibilitychange"});
  }
  if (!focused_ && focused) {
    focused_ = true;
    out.push_back({PageEvent::Target::kWindow, "focus"});
  }
}

std::vector<PageEvent> Lifecycle::apply(LifecycleInput input) {
  std::vector<PageEvent> out;
  if (destroyed_) return out;
  switch (input) {
    case LifecycleInput::kStart:
      break;
    case LifecycleInput::kResume:
      resumed_ = true;
      break;
    case LifecycleInput::kPause:
    case LifecycleInput::kStop:
      resumed_ = false;
      break;
    case LifecycleInput::kFocusGained:
      window_focus_ = true;
      break;
    case LifecycleInput::kFocusLost:
      window_focus_ = false;
      break;
    case LifecycleInput::kExternalHidden:
      external_hidden_ = true;
      break;
    case LifecycleInput::kExternalVisible:
      external_hidden_ = false;
      break;
    case LifecycleInput::kDestroy:
      // HTML "unload a document": the page becomes hidden (visibilitychange) then pagehide (persisted false).
      destroyed_ = true;
      recompute(out);
      out.push_back({PageEvent::Target::kWindow, "pagehide"});
      return out;
  }
  recompute(out);
  return out;
}

}  // namespace iwn
