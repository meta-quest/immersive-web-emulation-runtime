/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Host stand-in for src/android/xr_permissions.h (JNI): what src/android/xr_camera.cc asks of the broker, answered
// from the fake camera service's permission state (test/host/fake_camera.h).
#pragma once

#include <string>
#include <vector>

namespace iwn::xr {

class PermissionBroker {
 public:
  static PermissionBroker& get();
  std::vector<bool> check(const std::vector<std::string>& names);
};

}  // namespace iwn::xr
