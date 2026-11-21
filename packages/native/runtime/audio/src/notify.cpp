// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
#include "notify.h"

#include <pthread.h>

#include <cerrno>
#include <ctime>

#include "output.h"

namespace iwn::audio {

Notifier& Notifier::get() {
  static Notifier* n = new Notifier();  // intentionally leaked: outlives static destructors
  return *n;
}

Notifier::Notifier() { sem_init(&sem_, 0, 0); }

void Notifier::signal() {
  if (quit_.load(std::memory_order_relaxed)) return;
  sem_post(&sem_);
}

void Notifier::setHooks(const HostHooks& h) {
  std::lock_guard<std::mutex> l(mu_);
  hooks_ = h;
  if (h.postToMain && !thread_.joinable() && !quit_) thread_ = std::thread([this] { run(); });
}

bool Notifier::hasHooks() const {
  std::lock_guard<std::mutex> l(mu_);
  return hooks_.postToMain != nullptr;
}

void Notifier::setDrain(void (*fn)(void*), void* arg) {
  {
    std::lock_guard<std::mutex> l(mu_);
    drain_ = fn;
    drainArg_ = arg;
  }
  // A drain task posted for the previous page may have been dropped by the host without running
  // (Runtime::post_task drops tasks across a reload): forget it, or no task would ever be posted
  // again. Then look for results that arrived meanwhile.
  posted_.store(false);
  if (fn) signal();
}

void Notifier::thunk(void* self) {
  auto* n = static_cast<Notifier*>(self);
  n->posted_.store(false);
  void (*fn)(void*);
  void* arg;
  {
    std::lock_guard<std::mutex> l(n->mu_);
    fn = n->drain_;
    arg = n->drainArg_;
  }
  if (fn) fn(arg);
}

void Notifier::post() {
  HostHooks h;
  {
    std::lock_guard<std::mutex> l(mu_);
    h = hooks_;
  }
  postedAt_.store(monotonicNanos());
  posts_.fetch_add(1);
  if (!h.postToMain || !h.postToMain(h.user, &Notifier::thunk, this)) posted_.store(false);
}

void Notifier::run() {
  pthread_setname_np(pthread_self(), "iwn-audio-notify");
  for (;;) {
    if (posted_.load()) {
      // A task is in flight: wait with a timeout so a task the host dropped is noticed.
      timespec ts;
      clock_gettime(CLOCK_REALTIME, &ts);
      ts.tv_nsec += 250000000;
      if (ts.tv_nsec >= 1000000000) {
        ts.tv_sec += 1;
        ts.tv_nsec -= 1000000000;
      }
      if (sem_timedwait(&sem_, &ts) != 0) {
        if (quit_.load()) return;
        if (errno == ETIMEDOUT && posted_.load() && monotonicNanos() - postedAt_.load() >= kRepostAfterNs) post();
        continue;
      }
    } else {
      while (sem_wait(&sem_) != 0) {
      }
    }
    if (quit_.load()) return;
    // Coalesce: drop extra signals while a task is already queued.
    while (sem_trywait(&sem_) == 0) {
    }
    if (posted_.exchange(true)) {
      if (monotonicNanos() - postedAt_.load() >= kRepostAfterNs) post();
      continue;
    }
    post();
  }
}

void Notifier::shutdown() {
  quit_.store(true);
  sem_post(&sem_);
  if (thread_.joinable()) thread_.join();
  std::lock_guard<std::mutex> l(mu_);
  hooks_ = HostHooks{};  // its `user` (the runtime) is about to go away
  drain_ = nullptr;
  drainArg_ = nullptr;
}

void Notifier::restart() {
  while (sem_trywait(&sem_) == 0) {
  }
  posted_.store(false);
  quit_.store(false);
}

}  // namespace iwn::audio
