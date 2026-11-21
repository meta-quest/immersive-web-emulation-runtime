// PortHub (WRK-5, WRK-6, WRK-8): entangled pairs, queued-until-started delivery in order, one message per delivery
// task, transfer (detach/adopt) with the queue kept, close/disentangle, owner teardown, payloads destroyed exactly
// once and outside the lock (re-entrant destructors), and a bounded multi-threaded run.
#include <atomic>
#include <chrono>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

#include "iwn/workers/port_hub.h"
#include "iwn_test.h"

using namespace iwn::workers;

namespace {

std::atomic<int> g_live_payloads{0};

struct TestPayload : Payload {
  explicit TestPayload(int v, std::function<void()> on_destroy = {}) : value(v), on_destroy(std::move(on_destroy)) {
    g_live_payloads++;
  }
  ~TestPayload() override {
    g_live_payloads--;
    if (on_destroy) on_destroy();
  }
  size_t byte_size() const override { return 8; }
  int value;
  std::function<void()> on_destroy;
};

// An owner whose "event loop" is a queue drained by the test (single-threaded) or by a thread.
struct TestOwner : PortOwner {
  bool schedule_delivery(PortId port) override {
    std::lock_guard<std::mutex> lock(mu);
    if (dead) return false;
    tasks.push_back(port);
    return true;
  }
  // Runs queued delivery tasks; returns the values delivered.
  std::vector<int> drain(PortHub& hub) {
    std::vector<int> got;
    while (true) {
      PortId port;
      {
        std::lock_guard<std::mutex> lock(mu);
        if (tasks.empty()) break;
        port = tasks.front();
        tasks.pop_front();
      }
      auto p = hub.pop(port, this);
      if (p) got.push_back(static_cast<TestPayload*>(p.get())->value);
    }
    return got;
  }
  size_t pending() {
    std::lock_guard<std::mutex> lock(mu);
    return tasks.size();
  }
  std::mutex mu;
  std::deque<PortId> tasks;
  bool dead = false;
};

std::unique_ptr<Payload> msg(int v) { return std::make_unique<TestPayload>(v); }

}  // namespace

IWN_TEST(PortHub, QueuedUntilStartedThenInOrder) {
  PortHub hub;
  auto a = std::make_shared<TestOwner>();
  auto b = std::make_shared<TestOwner>();
  auto [pa, pb] = hub.create_pair(a, b);
  for (int i = 0; i < 5; ++i) IWN_CHECK(hub.post(pa, msg(i)) == PortHub::PostResult::kQueued);
  IWN_CHECK_EQ(b->pending(), 0u);  // not started: nothing scheduled
  IWN_CHECK_EQ(hub.queued(pb), 5u);
  hub.start(pb);
  IWN_CHECK_EQ(b->pending(), 1u);  // one task at a time
  auto got = b->drain(hub);
  IWN_CHECK_EQ(got.size(), 5u);
  for (int i = 0; i < 5; ++i) IWN_CHECK_EQ(got[i], i);
  IWN_CHECK_EQ(hub.queued(pb), 0u);
  hub.close(pa);
  hub.close(pb);
  IWN_CHECK_EQ(g_live_payloads.load(), 0);
}

IWN_TEST(PortHub, OneDeliveryTaskPerMessage) {
  PortHub hub;
  auto a = std::make_shared<TestOwner>();
  auto [pa, pb] = hub.create_pair(a, a);
  hub.start(pb);
  hub.post(pa, msg(1));
  hub.post(pa, msg(2));
  IWN_CHECK_EQ(a->pending(), 1u);
  // Run exactly one task: one message comes out and the next task is scheduled.
  PortId port = a->tasks.front();
  a->tasks.pop_front();
  auto p = hub.pop(port, a.get());
  IWN_CHECK(p != nullptr);
  IWN_CHECK_EQ(static_cast<TestPayload*>(p.get())->value, 1);
  IWN_CHECK_EQ(a->pending(), 1u);
  p.reset();
  IWN_CHECK_EQ(a->drain(hub).size(), 1u);
  hub.close(pa);
}

IWN_TEST(PortHub, BothDirections) {
  PortHub hub;
  auto a = std::make_shared<TestOwner>();
  auto b = std::make_shared<TestOwner>();
  auto [pa, pb] = hub.create_pair(a, b);
  hub.start(pa);
  hub.start(pb);
  hub.post(pa, msg(10));
  hub.post(pb, msg(20));
  IWN_CHECK_EQ(b->drain(hub)[0], 10);
  IWN_CHECK_EQ(a->drain(hub)[0], 20);
  hub.close(pa);
}

IWN_TEST(PortHub, CloseDisentanglesAndDropsOwnQueue) {
  PortHub hub;
  auto a = std::make_shared<TestOwner>();
  auto b = std::make_shared<TestOwner>();
  auto [pa, pb] = hub.create_pair(a, b);
  hub.post(pb, msg(1));  // queued at pa (not started)
  hub.post(pa, msg(2));  // queued at pb
  hub.close(pa);
  IWN_CHECK(!hub.exists(pa));
  IWN_CHECK(!hub.entangled(pb));
  IWN_CHECK_EQ(g_live_payloads.load(), 1);  // pa's queue dropped; pb keeps what pa sent before closing
  IWN_CHECK(hub.post(pb, msg(3)) == PortHub::PostResult::kNoPeer);
  IWN_CHECK(hub.post(pa, msg(4)) == PortHub::PostResult::kUnknownPort);
  IWN_CHECK_EQ(g_live_payloads.load(), 1);
  hub.start(pb);
  auto got = b->drain(hub);
  IWN_CHECK_EQ(got.size(), 1u);
  IWN_CHECK_EQ(got[0], 2);
  hub.close(pb);
  IWN_CHECK_EQ(g_live_payloads.load(), 0);
}

IWN_TEST(PortHub, TransferKeepsQueueAndOrder) {
  PortHub hub;
  auto a = std::make_shared<TestOwner>();
  auto b = std::make_shared<TestOwner>();
  auto c = std::make_shared<TestOwner>();
  auto [pa, pb] = hub.create_pair(a, a);
  hub.start(pb);
  hub.post(pa, msg(1));
  IWN_CHECK_EQ(a->pending(), 1u);
  // pb travels to b; a's pending delivery task finds it gone.
  IWN_CHECK(!hub.detach_for_transfer(pb, b.get()));  // not b's
  IWN_CHECK(hub.detach_for_transfer(pb, a.get()));
  IWN_CHECK(a->drain(hub).empty());
  hub.post(pa, msg(2));  // arrives while in transit
  IWN_CHECK_EQ(hub.queued(pb), 2u);
  IWN_CHECK(!hub.detach_for_transfer(pb, a.get()));  // a no longer owns it
  // adopt only once
  hub.detach_for_transfer(pb, nullptr);  // no-op: owner already null, expected null matches
  IWN_CHECK(hub.adopt(pb, b));
  IWN_CHECK(!hub.adopt(pb, c));
  IWN_CHECK_EQ(b->pending(), 0u);  // adopted ports start disabled
  hub.start(pb);
  auto got = b->drain(hub);
  IWN_CHECK_EQ(got.size(), 2u);
  IWN_CHECK_EQ(got[0], 1);
  IWN_CHECK_EQ(got[1], 2);
  hub.close(pa);
  hub.close(pb);
}

IWN_TEST(PortHub, OwnerTeardownClosesItsPorts) {
  PortHub hub;
  auto a = std::make_shared<TestOwner>();
  auto b = std::make_shared<TestOwner>();
  auto [pa, pb] = hub.create_pair(a, b);
  auto [pc, pd] = hub.create_pair(b, b);
  hub.post(pa, msg(1));
  hub.post(pc, msg(2));
  IWN_CHECK_EQ(hub.close_owned_by(b.get()), 3u);
  IWN_CHECK(hub.exists(pa));
  IWN_CHECK(!hub.entangled(pa));
  IWN_CHECK(!hub.exists(pb) && !hub.exists(pc) && !hub.exists(pd));
  IWN_CHECK_EQ(g_live_payloads.load(), 0);
  hub.close(pa);
}

IWN_TEST(PortHub, DeadOwnerDoesNotLoseLaterAdoption) {
  PortHub hub;
  auto a = std::make_shared<TestOwner>();
  a->dead = true;
  auto [pa, pb] = hub.create_pair(a, a);
  hub.start(pb);
  hub.post(pa, msg(1));  // schedule refused: the port is left unscheduled
  IWN_CHECK_EQ(a->pending(), 0u);
  a->dead = false;
  hub.post(pa, msg(2));
  IWN_CHECK_EQ(a->pending(), 1u);
  IWN_CHECK_EQ(a->drain(hub).size(), 2u);
  hub.close(pa);
  hub.close(pb);
}

IWN_TEST(PortHub, ReentrantPayloadDestructorClosesCarriedPort) {
  // A message carrying a transferred port is dropped: its destructor closes that port through the hub, which must
  // not deadlock (the hub destroys payloads after releasing its lock).
  PortHub hub;
  auto a = std::make_shared<TestOwner>();
  auto [carried1, carried2] = hub.create_pair(a, a);
  hub.detach_for_transfer(carried1, a.get());
  auto [pa, pb] = hub.create_pair(a, a);
  hub.post(pa, std::make_unique<TestPayload>(1, [&hub, carried1 = carried1] { hub.close(carried1); }));
  hub.close(pb);  // drops the queued message -> closes carried1
  IWN_CHECK(!hub.exists(carried1));
  IWN_CHECK(!hub.entangled(carried2));
  // And the kNoPeer path:
  hub.post(pa, std::make_unique<TestPayload>(2, [&hub, carried2 = carried2] { hub.close(carried2); }));
  IWN_CHECK(!hub.exists(carried2));
  hub.close(pa);
  IWN_CHECK_EQ(g_live_payloads.load(), 0);
}

IWN_TEST(PortHub, MessageLogBounded) {
  PortHub hub;
  auto a = std::make_shared<TestOwner>();
  auto [pa, pb] = hub.create_pair(a, a);
  hub.set_label(pa, "main");
  hub.set_label(pb, "worker 1 'w'");
  hub.post(pa, msg(1));
  IWN_CHECK(hub.log_snapshot().empty());  // off by default
  hub.set_log_capacity(3);
  for (int i = 0; i < 5; ++i) hub.post(pa, msg(i));
  auto log = hub.log_snapshot();
  IWN_CHECK_EQ(log.size(), 3u);
  IWN_CHECK_EQ(log[0].from, std::string("main"));
  IWN_CHECK_EQ(log[0].to, std::string("worker 1 'w'"));
  IWN_CHECK_EQ(log[0].bytes, 8u);
  auto s = hub.stats();
  IWN_CHECK_EQ(s.posted, 6u);
  IWN_CHECK_EQ(s.queued_messages, 6u);
  hub.close(pa);
  hub.close(pb);
}

IWN_TEST(PortHub, ThreadedPingPongBounded) {
  // Two threads, each draining its own owner, bounce 20,000 messages; order per direction is kept and every payload
  // is destroyed exactly once. Bounded: fixed iteration count and a 20 s deadline.
  PortHub hub;
  auto a = std::make_shared<TestOwner>();
  auto b = std::make_shared<TestOwner>();
  auto [pa, pb] = hub.create_pair(a, b);
  hub.start(pa);
  hub.start(pb);
  constexpr int kN = 20000;
  std::atomic<bool> fail{false};
  auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(20);
  std::thread tb([&] {
    int expect = 0;
    while (expect < kN && std::chrono::steady_clock::now() < deadline) {
      for (int v : b->drain(hub)) {
        if (v != expect) fail = true;
        expect++;
        hub.post(pb, msg(v));
      }
      std::this_thread::yield();
    }
  });
  for (int i = 0; i < kN; ++i) hub.post(pa, msg(i));
  int back = 0;
  while (back < kN && std::chrono::steady_clock::now() < deadline) {
    for (int v : a->drain(hub)) {
      if (v != back) fail = true;
      back++;
    }
    std::this_thread::yield();
  }
  tb.join();
  IWN_CHECK(!fail.load());
  IWN_CHECK_EQ(back, kN);
  hub.close(pa);
  hub.close(pb);
  IWN_CHECK_EQ(g_live_payloads.load(), 0);
}
