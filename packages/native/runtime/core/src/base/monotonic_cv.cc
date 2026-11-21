// See iwn/core/monotonic_cv.h. POSIX pthread_condattr_setclock / pthread_cond_timedwait (bionic and glibc).
#include "iwn/core/monotonic_cv.h"

#include <errno.h>
#include <time.h>

namespace iwn {

MonotonicCondVar::MonotonicCondVar() {
  pthread_condattr_t attr;
  pthread_condattr_init(&attr);
  pthread_condattr_setclock(&attr, CLOCK_MONOTONIC);
  pthread_cond_init(&cond_, &attr);
  pthread_condattr_destroy(&attr);
}

MonotonicCondVar::~MonotonicCondVar() { pthread_cond_destroy(&cond_); }

void MonotonicCondVar::notify_one() { pthread_cond_signal(&cond_); }

void MonotonicCondVar::notify_all() { pthread_cond_broadcast(&cond_); }

void MonotonicCondVar::wait(std::unique_lock<std::mutex>& lock) { pthread_cond_wait(&cond_, lock.mutex()->native_handle()); }

bool MonotonicCondVar::wait_once_for(std::unique_lock<std::mutex>& lock, std::chrono::nanoseconds timeout) {
  if (timeout <= std::chrono::nanoseconds::zero()) return false;
  timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  const long long kNs = 1000000000LL;
  long long total = static_cast<long long>(ts.tv_nsec) + timeout.count() % kNs;
  ts.tv_sec += static_cast<time_t>(timeout.count() / kNs + total / kNs);
  ts.tv_nsec = static_cast<long>(total % kNs);
  return pthread_cond_timedwait(&cond_, lock.mutex()->native_handle(), &ts) != ETIMEDOUT;
}

}  // namespace iwn
