/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// PortHub: see port_hub.h. HTML §9.4 (message ports) and §10.2 (worker implicit ports).
#include "iwn/workers/port_hub.h"

#include "iwn/core/clock.h"

namespace iwn::workers {

PortHub& PortHub::shared() {
  static PortHub* hub = new PortHub();  // never destroyed: worker threads may outlive static destructors
  return *hub;
}

std::pair<PortId, PortId> PortHub::create_pair(std::shared_ptr<PortOwner> owner_a,
                                               std::shared_ptr<PortOwner> owner_b) {
  std::lock_guard<std::mutex> lock(mu_);
  PortId a = next_id_++;
  PortId b = next_id_++;
  Port& pa = ports_[a];
  pa.peer = b;
  pa.owner = std::move(owner_a);
  Port& pb = ports_[b];
  pb.peer = a;
  pb.owner = std::move(owner_b);
  return {a, b};
}

std::shared_ptr<PortOwner> PortHub::schedule_locked(PortId, Port& port) {
  if (port.scheduled || !port.started || !port.owner || port.queue.empty()) return nullptr;
  port.scheduled = true;
  return port.owner;
}

void PortHub::notify(PortId id, const std::shared_ptr<PortOwner>& owner) {
  if (!owner) return;
  if (owner->schedule_delivery(id)) return;
  // The owner cannot run tasks any more (teardown in progress): let a later adopt/start try again.
  std::lock_guard<std::mutex> lock(mu_);
  auto it = ports_.find(id);
  if (it != ports_.end() && it->second.owner == owner) it->second.scheduled = false;
}

std::string PortHub::label_locked(PortId id) const {
  auto it = ports_.find(id);
  if (it != ports_.end() && !it->second.label.empty()) return it->second.label;
  return "port " + std::to_string(id);
}

PortHub::PostResult PortHub::post(PortId from, std::unique_ptr<Payload> payload) {
  std::shared_ptr<PortOwner> to_notify;
  PortId target = 0;
  PostResult result = PostResult::kQueued;
  {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = ports_.find(from);
    if (it == ports_.end()) {
      result = PostResult::kUnknownPort;
    } else {
      auto peer = it->second.peer ? ports_.find(it->second.peer) : ports_.end();
      if (peer == ports_.end()) {
        result = PostResult::kNoPeer;
      } else {
        size_t bytes = payload ? payload->byte_size() : 0;
        stats_.posted++;
        stats_.bytes_posted += bytes;
        if (log_capacity_ > 0) {
          if (log_.size() >= log_capacity_) log_.pop_front();
          log_.push_back({now_ms(), label_locked(from), label_locked(peer->first), bytes});
        }
        peer->second.queue.push_back(std::move(payload));
        target = peer->first;
        to_notify = schedule_locked(target, peer->second);
      }
    }
    if (result != PostResult::kQueued) stats_.dropped++;
  }
  // A dropped payload (still in `payload`) is destroyed here, outside the lock.
  payload.reset();
  notify(target, to_notify);
  return result;
}

void PortHub::start(PortId port) {
  std::shared_ptr<PortOwner> to_notify;
  {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = ports_.find(port);
    if (it == ports_.end()) return;
    it->second.started = true;
    to_notify = schedule_locked(port, it->second);
  }
  notify(port, to_notify);
}

void PortHub::close(PortId port) {
  std::deque<std::unique_ptr<Payload>> dropped;
  std::shared_ptr<PortOwner> owner;
  {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = ports_.find(port);
    if (it == ports_.end()) return;
    if (it->second.peer) {
      auto peer = ports_.find(it->second.peer);
      if (peer != ports_.end()) peer->second.peer = 0;  // disentangled; its queue (messages we sent) stays
    }
    dropped.swap(it->second.queue);
    stats_.dropped += dropped.size();
    owner = std::move(it->second.owner);
    ports_.erase(it);
  }
  dropped.clear();  // payload destructors may close the ports they carried (re-entrant, lock released)
  owner.reset();
}

bool PortHub::detach_for_transfer(PortId port, const PortOwner* expected_owner) {
  std::shared_ptr<PortOwner> old;
  {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = ports_.find(port);
    if (it == ports_.end() || it->second.owner.get() != expected_owner) return false;
    old = std::move(it->second.owner);
    it->second.owner.reset();
    it->second.started = false;
    it->second.scheduled = false;
  }
  return true;
}

bool PortHub::adopt(PortId port, std::shared_ptr<PortOwner> owner) {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = ports_.find(port);
  if (it == ports_.end() || it->second.owner) return false;
  it->second.owner = std::move(owner);
  it->second.started = false;
  it->second.scheduled = false;
  return true;
}

std::unique_ptr<Payload> PortHub::pop(PortId port, const PortOwner* owner) {
  std::unique_ptr<Payload> out;
  std::shared_ptr<PortOwner> to_notify;
  {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = ports_.find(port);
    if (it == ports_.end()) return nullptr;
    Port& p = it->second;
    if (p.owner.get() != owner || !p.started) {
      if (p.owner.get() == owner) p.scheduled = false;
      return nullptr;
    }
    p.scheduled = false;
    if (p.queue.empty()) return nullptr;
    out = std::move(p.queue.front());
    p.queue.pop_front();
    stats_.delivered++;
    to_notify = schedule_locked(port, p);
  }
  notify(port, to_notify);
  return out;
}

size_t PortHub::close_owned_by(const PortOwner* owner) {
  std::vector<PortId> ids;
  {
    std::lock_guard<std::mutex> lock(mu_);
    for (auto& [id, p] : ports_) {
      if (p.owner.get() == owner) ids.push_back(id);
    }
  }
  for (PortId id : ids) close(id);
  return ids.size();
}

void PortHub::set_label(PortId port, std::string label) {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = ports_.find(port);
  if (it != ports_.end()) it->second.label = std::move(label);
}

bool PortHub::exists(PortId port) const {
  std::lock_guard<std::mutex> lock(mu_);
  return ports_.count(port) != 0;
}

bool PortHub::entangled(PortId port) const {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = ports_.find(port);
  return it != ports_.end() && it->second.peer != 0;
}

bool PortHub::started(PortId port) const {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = ports_.find(port);
  return it != ports_.end() && it->second.started;
}

size_t PortHub::queued(PortId port) const {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = ports_.find(port);
  return it == ports_.end() ? 0 : it->second.queue.size();
}

PortHubStats PortHub::stats() const {
  std::lock_guard<std::mutex> lock(mu_);
  PortHubStats s = stats_;
  s.live_ports = ports_.size();
  s.queued_messages = 0;
  for (auto& [id, p] : ports_) s.queued_messages += p.queue.size();
  return s;
}

void PortHub::set_log_capacity(size_t capacity) {
  std::lock_guard<std::mutex> lock(mu_);
  log_capacity_ = capacity;
  while (log_.size() > log_capacity_) log_.pop_front();
}

std::vector<MessageLogEntry> PortHub::log_snapshot() const {
  std::lock_guard<std::mutex> lock(mu_);
  return {log_.begin(), log_.end()};
}

}  // namespace iwn::workers
