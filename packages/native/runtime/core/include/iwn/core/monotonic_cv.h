// A condition variable whose timed waits run on CLOCK_MONOTONIC.
//
// Why: the runtime is built for API 29, and libc++ uses pthread_cond_clockwait(CLOCK_MONOTONIC) only from API 30
// (_LIBCPP_HAS_COND_CLOCKWAIT). Below that, std::condition_variable::wait_for/wait_until turn every timeout into
// an absolute system_clock (CLOCK_REALTIME) deadline, so a backwards wall-clock step (NTP, a manual or automatic
// time change) makes a sleeping thread oversleep by the size of the step: timers, the window rAF fallback,
// delayed platform tasks, the quit watchdog and the UI thread's join(80) (PROC-3) would all stall.
// This wraps a pthread condvar created with pthread_condattr_setclock(CLOCK_MONOTONIC) and works with
// std::unique_lock<std::mutex> (libc++/libstdc++ std::mutex is a pthread mutex).
#pragma once

#include <pthread.h>

#include <chrono>
#include <mutex>

namespace iwn {

class MonotonicCondVar {
 public:
  MonotonicCondVar();
  ~MonotonicCondVar();
  MonotonicCondVar(const MonotonicCondVar&) = delete;
  MonotonicCondVar& operator=(const MonotonicCondVar&) = delete;

  void notify_one();
  void notify_all();
  void wait(std::unique_lock<std::mutex>& lock);
  // One wait of at most `timeout` (spurious wakeups possible). Returns false if it timed out.
  bool wait_once_for(std::unique_lock<std::mutex>& lock, std::chrono::nanoseconds timeout);

  template <typename Rep, typename Period, typename Pred>
  bool wait_for(std::unique_lock<std::mutex>& lock, std::chrono::duration<Rep, Period> timeout, Pred pred) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::duration_cast<std::chrono::nanoseconds>(timeout);
    return wait_until(lock, deadline, pred);
  }
  template <typename Pred>
  bool wait_until(std::unique_lock<std::mutex>& lock, std::chrono::steady_clock::time_point deadline, Pred pred) {
    while (!pred()) {
      auto left = deadline - std::chrono::steady_clock::now();
      if (left <= std::chrono::nanoseconds::zero()) return pred();
      wait_once_for(lock, std::chrono::duration_cast<std::chrono::nanoseconds>(left));
    }
    return true;
  }

 private:
  pthread_cond_t cond_;
};

}  // namespace iwn
