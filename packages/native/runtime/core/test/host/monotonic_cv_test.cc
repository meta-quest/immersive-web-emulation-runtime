// MonotonicCondVar: timed waits on CLOCK_MONOTONIC (a backwards wall-clock step cannot stretch them).
#include <atomic>
#include <chrono>
#include <thread>

#include "iwn/core/monotonic_cv.h"
#include "iwn_test.h"

using namespace iwn;
using Clock = std::chrono::steady_clock;

namespace {
long long ms_since(Clock::time_point t) {
  return std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - t).count();
}
}  // namespace

IWN_TEST(MonotonicCondVar, TimesOutOnTime) {
  std::mutex mu;
  MonotonicCondVar cv;
  std::unique_lock<std::mutex> lock(mu);
  auto t0 = Clock::now();
  bool r = cv.wait_for(lock, std::chrono::milliseconds(60), [] { return false; });
  long long ms = ms_since(t0);
  IWN_CHECK(!r);
  IWN_CHECK(ms >= 59);
  IWN_CHECK(ms < 1000);
  IWN_CHECK(!cv.wait_once_for(lock, std::chrono::nanoseconds(0)));
}

IWN_TEST(MonotonicCondVar, NotifyWakesBeforeTheDeadline) {
  std::mutex mu;
  MonotonicCondVar cv;
  bool flag = false;
  std::thread t([&] {
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    std::lock_guard<std::mutex> l(mu);
    flag = true;
    cv.notify_all();
  });
  auto t0 = Clock::now();
  {
    std::unique_lock<std::mutex> lock(mu);
    IWN_CHECK(cv.wait_for(lock, std::chrono::seconds(5), [&] { return flag; }));
  }
  IWN_CHECK(ms_since(t0) < 2000);
  t.join();
}

IWN_TEST(MonotonicCondVar, WaitUntilSteadyDeadlineAndLongTimeouts) {
  std::mutex mu;
  MonotonicCondVar cv;
  std::unique_lock<std::mutex> lock(mu);
  auto t0 = Clock::now();
  IWN_CHECK(!cv.wait_until(lock, t0 + std::chrono::milliseconds(30), [] { return false; }));
  IWN_CHECK(ms_since(t0) >= 29);
  // Nanosecond carry: a 1.999999999 s timeout must not overflow tv_nsec (pthread would return EINVAL at once).
  std::atomic<bool> done{false};
  std::thread t([&] {
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    std::lock_guard<std::mutex> l(mu);
    done = true;
    cv.notify_all();
  });
  auto t1 = Clock::now();
  IWN_CHECK(cv.wait_for(lock, std::chrono::nanoseconds(1999999999), [&] { return done.load(); }));
  IWN_CHECK(ms_since(t1) >= 40);
  t.join();
}
