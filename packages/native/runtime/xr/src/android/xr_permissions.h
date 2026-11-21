/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Android runtime permissions (XR-PERM-1): the ones Horizon OS grants only after its system dialog (USE_SCENE for the
// Scene API, CAMERA + HEADSET_CAMERA for the passthrough cameras). Activity.requestPermissions shows the dialog;
// NativeActivity drops onRequestPermissionsResult, so a worker thread polls Context.checkSelfPermission and judges
// the answer with PermissionWait (iwn/xr/permission_wait.h). Android drops a request made while another is in flight,
// so one worker keeps one in flight and merges what is asked for meanwhile into the next (PermissionQueue,
// iwn/xr/permission_queue.h). Sources: Android SDK reference (Activity, ContextWrapper, PackageManager
// .PERMISSION_GRANTED / GET_PERMISSIONS, PackageInfo.requestedPermissions), JNI specification.
#pragma once

#include <jni.h>

#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include "iwn/core/monotonic_cv.h"
#include "iwn/xr/permission_queue.h"

namespace iwn::xr {

class PermissionBroker {
 public:
  static PermissionBroker& get();

  // Any thread (attaches to the VM for the call): checkSelfPermission for each name, no dialog.
  std::vector<bool> check(const std::vector<std::string>& names);

  // The permissions the app's manifest declares (PackageInfo.requestedPermissions), read once; null when they
  // cannot be read (then every name counts as declared). Any thread.
  std::shared_ptr<const std::set<std::string>> declared();

  // Asks for `names`: the ones not held, declared and not asked for before in this process go to
  // Activity.requestPermissions (one dialog, after any request in flight), then the worker polls until all are held
  // or the dialog is answered (`focused`: whether the app has the input focus, any thread). `done` runs on the
  // worker with the final state of each name. Without an Activity nothing is asked. False (nothing queued, `done`
  // not called) between stop() and the next start().
  bool request(std::vector<std::string> names, std::function<bool()> focused,
               std::function<void(std::vector<bool>)> done);

  // Registration of a page's runtime (the first one, or an activity relaunched in this process): requests are taken.
  void start();
  // Shutdown hook (PROC-7): ends the wait in progress (its `done` runs with the state then), joins the worker and
  // answers every request still queued as denied (no dialog); from now until start() requests are refused.
  void stop();

 private:
  PermissionBroker() = default;
  void work();
  // One batch on the worker: checks, asks for what PermissionQueue::to_ask leaves, waits for the answer. The final
  // state of each name.
  std::vector<bool> run_batch(JNIEnv* env, const std::vector<std::string>& names, const std::function<bool()>& focused);

  struct Callbacks {
    std::function<bool()> focused;
    std::function<void(std::vector<bool>)> done;
  };
  std::mutex mu_;
  MonotonicCondVar cv_;
  bool quit_ = false;
  bool stopped_ = false;
  PermissionQueue queue_;
  std::map<uint64_t, Callbacks> callbacks_;
  std::thread worker_;
  std::mutex declared_mu_;
  bool declared_read_ = false;
  std::shared_ptr<const std::set<std::string>> declared_;
};

}  // namespace iwn::xr
