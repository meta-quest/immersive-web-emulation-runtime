/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "iwn/xr/permission_queue.h"

#include <algorithm>

namespace iwn::xr {

uint64_t PermissionQueue::push(std::vector<std::string> names) {
  queued_.push_back(Request{++next_, std::move(names)});
  return next_;
}

bool PermissionQueue::begin(std::vector<std::string>* names) {
  names->clear();
  if (queued_.empty()) return false;
  batch_.swap(queued_);
  queued_.clear();
  for (const Request& r : batch_) {
    for (const std::string& n : r.names) {
      if (std::find(names->begin(), names->end(), n) == names->end()) names->push_back(n);
    }
  }
  return true;
}

std::vector<std::string> PermissionQueue::to_ask(const std::vector<std::string>& missing,
                                                 const std::function<bool(const std::string&)>& declared) {
  std::vector<std::string> out;
  for (const std::string& n : missing) {
    if (asked_.count(n) != 0 || (declared && !declared(n))) continue;
    asked_.insert(n);
    out.push_back(n);
  }
  return out;
}

std::vector<std::pair<uint64_t, std::vector<bool>>> PermissionQueue::finish(const std::vector<std::string>& names,
                                                                            const std::vector<bool>& held) {
  std::vector<std::pair<uint64_t, std::vector<bool>>> out;
  for (const Request& r : batch_) {
    std::vector<bool> states;
    for (const std::string& n : r.names) {
      const auto it = std::find(names.begin(), names.end(), n);
      const size_t i = static_cast<size_t>(it - names.begin());
      states.push_back(it != names.end() && i < held.size() && held[i]);
    }
    out.emplace_back(r.ticket, std::move(states));
  }
  batch_.clear();
  return out;
}

std::vector<uint64_t> PermissionQueue::drain() {
  std::vector<uint64_t> out;
  for (const Request& r : batch_) out.push_back(r.ticket);
  for (const Request& r : queued_) out.push_back(r.ticket);
  batch_.clear();
  queued_.clear();
  return out;
}

}  // namespace iwn::xr
