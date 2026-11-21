#include "iwn/core/timer_queue.h"

#include <climits>

namespace iwn {

int TimerQueue::allocate_id() {
  for (;;) {
    int id = next_id_;
    next_id_ = (next_id_ == INT_MAX) ? 1 : next_id_ + 1;
    if (!by_id_.count(id) && !(running_ && current_.id == id)) return id;
  }
}

void TimerQueue::insert(int id, double timeout, bool repeat, int nesting, double now) {
  Entry e{now + timeout, next_seq_++, nesting, repeat, timeout};
  by_id_[id] = e;
  order_.emplace(e.due, e.seq, id);
}

int TimerQueue::add(double timeout_ms, bool repeat, double now_ms) {
  if (!(timeout_ms > 0)) timeout_ms = 0;  // also NaN
  int level = running_ ? current_.nesting : 0;
  if (level > kNestingThreshold && timeout_ms < kMinNestedTimeoutMs) timeout_ms = kMinNestedTimeoutMs;
  int id = allocate_id();
  insert(id, timeout_ms, repeat, level + 1, now_ms);
  return id;
}

bool TimerQueue::clear(int id) {
  bool found = false;
  auto it = by_id_.find(id);
  if (it != by_id_.end()) {
    order_.erase({it->second.due, it->second.seq, id});
    by_id_.erase(it);
    found = true;
  }
  if (running_ && current_.id == id) {
    current_cleared_ = true;
    found = true;
  }
  return found;
}

bool TimerQueue::contains(int id) const { return by_id_.count(id) != 0; }

std::optional<double> TimerQueue::next_due() const {
  if (order_.empty()) return std::nullopt;
  return std::get<0>(*order_.begin());
}

std::optional<TimerQueue::Fired> TimerQueue::pop_due(double now_ms) {
  if (order_.empty()) return std::nullopt;
  auto first = order_.begin();
  if (std::get<0>(*first) > now_ms) return std::nullopt;
  int id = std::get<2>(*first);
  order_.erase(first);
  auto it = by_id_.find(id);
  Fired f{id, it->second.nesting, it->second.repeat, it->second.timeout};
  by_id_.erase(it);
  return f;
}

void TimerQueue::begin_callback(const Fired& fired) {
  running_ = true;
  current_ = fired;
  current_cleared_ = false;
}

void TimerQueue::end_callback(double now_ms) {
  if (!running_) return;
  Fired f = current_;
  bool cleared = current_cleared_;
  running_ = false;
  current_cleared_ = false;
  if (f.repeat && !cleared) {
    // HTML re-runs the timer initialization steps from inside the timer's task: nesting level = this task's level.
    double timeout = f.timeout_ms;
    if (f.nesting > kNestingThreshold && timeout < kMinNestedTimeoutMs) timeout = kMinNestedTimeoutMs;
    insert(f.id, timeout, true, f.nesting + 1, now_ms);
  }
}

void TimerQueue::reset() {
  by_id_.clear();
  order_.clear();
  running_ = false;
  current_cleared_ = false;
}

}  // namespace iwn
