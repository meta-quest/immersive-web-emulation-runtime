// SerialWorker: the bounded background reader used for import() graphs (PROC-2): one thread, jobs in order,
// bounded queue, a refused post leaves the job with the caller, stop() interrupts and joins.
#include <atomic>
#include <chrono>
#include <climits>
#include <memory>
#include <mutex>
#include <set>
#include <thread>
#include <vector>

#include <sys/resource.h>
#include <sys/syscall.h>
#include <unistd.h>

#include "iwn/core/serial_worker.h"
#include "iwn_test.h"

using iwn::SerialWorker;

namespace {
template <typename F>
bool wait_until(F f, int ms = 2000) {
  auto end = std::chrono::steady_clock::now() + std::chrono::milliseconds(ms);
  while (!f()) {
    if (std::chrono::steady_clock::now() > end) return false;
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  return true;
}
}  // namespace

IWN_TEST(SerialWorker, RunsJobsInOrderOnOneThread) {
  SerialWorker w("iwn-test-w", INT_MIN);
  IWN_CHECK(!w.started());
  std::mutex mu;
  std::vector<int> order;
  std::set<std::thread::id> threads;
  for (int i = 0; i < 50; ++i) {
    SerialWorker::Job j = [&, i](const std::atomic<bool>&) {
      std::lock_guard<std::mutex> l(mu);
      order.push_back(i);
      threads.insert(std::this_thread::get_id());
    };
    IWN_CHECK(w.post(j));
  }
  IWN_CHECK(w.started());
  IWN_CHECK(wait_until([&] {
    std::lock_guard<std::mutex> l(mu);
    return order.size() == 50;
  }));
  for (int i = 0; i < 50; ++i) IWN_CHECK_EQ(order[i], i);
  IWN_CHECK_EQ(threads.size(), size_t(1));
  IWN_CHECK(threads.count(std::this_thread::get_id()) == 0);
}

IWN_TEST(SerialWorker, BoundedQueueRefusesAndKeepsTheJob) {
  SerialWorker w("iwn-test-w", INT_MIN, 2);
  std::atomic<bool> release{false};
  std::atomic<bool> blocking{false};
  SerialWorker::Job block = [&](const std::atomic<bool>& stop) {
    blocking = true;
    while (!release && !stop) std::this_thread::sleep_for(std::chrono::milliseconds(1));
  };
  IWN_CHECK(w.post(block));
  IWN_CHECK(wait_until([&] { return blocking.load(); }));
  SerialWorker::Job a = [](const std::atomic<bool>&) {};
  SerialWorker::Job b = [](const std::atomic<bool>&) {};
  IWN_CHECK(w.post(a));
  IWN_CHECK(w.post(b));
  SerialWorker::Job c = [](const std::atomic<bool>&) {};
  IWN_CHECK(!w.post(c));
  IWN_CHECK(static_cast<bool>(c));
  release = true;
  IWN_CHECK(wait_until([&] { return w.pending() == 0; }));
}

IWN_TEST(SerialWorker, StopInterruptsJoinsAndDropsQueuedJobs) {
  auto w = std::make_unique<SerialWorker>("iwn-test-w", INT_MIN);
  std::atomic<bool> running{false};
  std::atomic<bool> saw_stop{false};
  SerialWorker::Job long_job = [&](const std::atomic<bool>& stop) {
    running = true;
    while (!stop) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    saw_stop = true;
  };
  IWN_CHECK(w->post(long_job));
  auto payload = std::make_shared<int>(7);
  std::weak_ptr<int> weak = payload;
  bool queued_ran = false;
  SerialWorker::Job queued = [payload, &queued_ran](const std::atomic<bool>&) { queued_ran = true; };
  payload.reset();
  IWN_CHECK(w->post(queued));
  IWN_CHECK(wait_until([&] { return running.load(); }));
  auto t0 = std::chrono::steady_clock::now();
  w->stop();
  IWN_CHECK(std::chrono::steady_clock::now() - t0 < std::chrono::milliseconds(500));
  IWN_CHECK(saw_stop.load());
  IWN_CHECK(!queued_ran);
  IWN_CHECK(weak.expired());
  SerialWorker::Job late = [](const std::atomic<bool>&) {};
  IWN_CHECK(!w->post(late));
  w.reset();  // destructor after stop() is a no-op
}

IWN_TEST(SerialWorker, SetsTheThreadNiceValue) {
  SerialWorker w("iwn-test-w", 7);
  std::atomic<int> nice_seen{INT_MIN};
  SerialWorker::Job j = [&](const std::atomic<bool>&) {
    errno = 0;
    nice_seen = getpriority(PRIO_PROCESS, static_cast<id_t>(syscall(SYS_gettid)));
  };
  IWN_CHECK(w.post(j));
  IWN_CHECK(wait_until([&] { return nice_seen.load() != INT_MIN; }));
  IWN_CHECK(nice_seen.load() >= 7);  // raising nice is always allowed; it was 7 or the inherited value if higher
}
