// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.
//
// One process-wide deadline thread for the network cores. It bounds the
// blocking steps whose transport cannot time out by itself (connect + proxy
// tunnel + TLS handshake as one step, writes on the JNI transport), so a
// request always ends within its timeout (NET-6) whatever the connector does.

#ifndef IWN_NET_WATCHDOG_H_
#define IWN_NET_WATCHDOG_H_

#include <condition_variable>
#include <cstdint>
#include <functional>
#include <map>
#include <mutex>

namespace iwn::net {

class Watchdog {
 public:
  using Id = uint64_t;
  // The process-wide instance (never destroyed; its thread starts on first use).
  static Watchdog& Shared();

  // Runs `fire` on the watchdog thread once `timeout_ms` have passed, unless
  // disarmed first. `fire` runs under the watchdog's lock, so it must be
  // short and must not call Arm/Disarm (closing a socket is fine).
  Id Arm(int timeout_ms, std::function<void()> fire);
  // After Disarm returns, `fire` is not running and will not run. Returns
  // true if it had already run.
  bool Disarm(Id id);

 private:
  Watchdog() = default;
  void Run();
  std::mutex mu_;
  std::condition_variable cv_;
  // deadline (steady ms) -> (id, fire); multimap keeps equal deadlines.
  std::multimap<int64_t, std::pair<Id, std::function<void()>>> timers_;
  std::map<Id, int64_t> index_;
  Id next_id_ = 1;
  bool started_ = false;
};

// Disarms on scope exit.
class WatchdogScope {
 public:
  WatchdogScope(int timeout_ms, std::function<void()> fire) : id_(Watchdog::Shared().Arm(timeout_ms, std::move(fire))) {}
  ~WatchdogScope() { Disarm(); }
  // True if the deadline passed (the fire function ran).
  bool Disarm() {
    if (id_) {
      fired_ = Watchdog::Shared().Disarm(id_);
      id_ = 0;
    }
    return fired_;
  }
  WatchdogScope(const WatchdogScope&) = delete;
  WatchdogScope& operator=(const WatchdogScope&) = delete;

 private:
  Watchdog::Id id_;
  bool fired_ = false;
};

}  // namespace iwn::net

#endif  // IWN_NET_WATCHDOG_H_
