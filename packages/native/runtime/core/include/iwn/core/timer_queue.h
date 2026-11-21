// HTML timers (HTML §8.6, "timer initialization steps") without V8: ids, the nesting clamp, ordering of equal
// delays, repeat re-arming. TMR-1, TMR-2. The JS side keeps the callbacks keyed by id.
#pragma once

#include <cstdint>
#include <optional>
#include <set>
#include <tuple>
#include <unordered_map>

namespace iwn {

class TimerQueue {
 public:
  struct Fired {
    int id = 0;
    int nesting = 0;  // the timer task's nesting level
    bool repeat = false;
    double timeout_ms = 0;  // as requested (after clamping), used to re-arm intervals
  };

  // HTML: "If nesting level is greater than 5, and timeout is less than 4, then set timeout to 4."
  static constexpr int kNestingThreshold = 5;
  static constexpr double kMinNestedTimeoutMs = 4.0;

  // Creates a timer due at now + timeout. timeout_ms is the WebIDL-converted value (negative treated as 0).
  int add(double timeout_ms, bool repeat, double now_ms);
  // Removes a timer. Clearing the timer that is currently firing stops it from being re-armed. Unknown ids: no-op.
  bool clear(int id);
  bool contains(int id) const;
  size_t size() const { return by_id_.size(); }
  std::optional<double> next_due() const;

  // Pops the earliest timer with due <= now (ties in creation order). A non-repeating timer is gone afterwards; a
  // repeating one is re-armed by end_callback() unless cleared meanwhile.
  std::optional<Fired> pop_due(double now_ms);
  // Bracket the callback (and its microtask checkpoint) of a fired timer: timers created inside get nesting + 1.
  void begin_callback(const Fired& fired);
  void end_callback(double now_ms);
  bool in_callback() const { return running_; }

  // Drops everything (reload). Ids keep increasing so stale ids from the old realm never alias.
  void reset();

 private:
  struct Entry {
    double due;
    uint64_t seq;
    int nesting;
    bool repeat;
    double timeout;
  };
  int allocate_id();
  void insert(int id, double timeout, bool repeat, int nesting, double now);

  std::unordered_map<int, Entry> by_id_;
  std::set<std::tuple<double, uint64_t, int>> order_;
  uint64_t next_seq_ = 1;
  int next_id_ = 1;
  bool running_ = false;
  Fired current_{};
  bool current_cleared_ = false;
};

}  // namespace iwn
