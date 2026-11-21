/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// PROC-6/7 event mapping: pause/resume -> visibilitychange, focus loss -> blur, destroy -> pagehide.
#include "iwn/core/lifecycle.h"
#include "iwn_test.h"

using namespace iwn;

namespace {
std::string names(const std::vector<PageEvent>& ev) {
  std::string s;
  for (auto& e : ev) {
    if (!s.empty()) s += ",";
    s += (e.target == PageEvent::Target::kWindow ? "w:" : "d:") + e.type;
  }
  return s;
}
}  // namespace

IWN_TEST(Lifecycle, StartsVisibleAndFocused) {
  Lifecycle l;
  IWN_CHECK(l.visible());
  IWN_CHECK(l.focused());
  IWN_CHECK_EQ(names(l.apply(LifecycleInput::kStart)), std::string(""));
  IWN_CHECK_EQ(names(l.apply(LifecycleInput::kResume)), std::string(""));
}

IWN_TEST(Lifecycle, PauseResume) {
  Lifecycle l;
  IWN_CHECK_EQ(names(l.apply(LifecycleInput::kPause)), std::string("w:blur,d:visibilitychange"));
  IWN_CHECK_EQ(std::string(l.visibility_state()), std::string("hidden"));
  IWN_CHECK_EQ(names(l.apply(LifecycleInput::kStop)), std::string(""));
  IWN_CHECK_EQ(names(l.apply(LifecycleInput::kResume)), std::string("d:visibilitychange,w:focus"));
  IWN_CHECK_EQ(std::string(l.visibility_state()), std::string("visible"));
}

IWN_TEST(Lifecycle, FocusLossKeepsVisible) {
  Lifecycle l;
  IWN_CHECK_EQ(names(l.apply(LifecycleInput::kFocusLost)), std::string("w:blur"));
  IWN_CHECK(l.visible());
  IWN_CHECK_EQ(names(l.apply(LifecycleInput::kFocusGained)), std::string("w:focus"));
}

IWN_TEST(Lifecycle, ExternalHidden) {
  Lifecycle l;
  IWN_CHECK_EQ(names(l.apply(LifecycleInput::kExternalHidden)), std::string("w:blur,d:visibilitychange"));
  IWN_CHECK_EQ(names(l.apply(LifecycleInput::kResume)), std::string(""));
  IWN_CHECK_EQ(names(l.apply(LifecycleInput::kExternalVisible)), std::string("d:visibilitychange,w:focus"));
}

IWN_TEST(Lifecycle, DestroyFiresPagehideOnce) {
  Lifecycle l;
  IWN_CHECK_EQ(names(l.apply(LifecycleInput::kDestroy)), std::string("w:blur,d:visibilitychange,w:pagehide"));
  IWN_CHECK_EQ(names(l.apply(LifecycleInput::kDestroy)), std::string(""));
  IWN_CHECK_EQ(names(l.apply(LifecycleInput::kResume)), std::string(""));
}

IWN_TEST(Lifecycle, DestroyWhileHidden) {
  Lifecycle l;
  l.apply(LifecycleInput::kPause);
  IWN_CHECK_EQ(names(l.apply(LifecycleInput::kDestroy)), std::string("w:pagehide"));
}
