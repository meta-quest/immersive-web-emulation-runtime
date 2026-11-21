/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Message ports without V8 (WRK-5, WRK-6, WRK-8, WRK-10): the process-wide table of entangled port pairs that
// carries messages between the main isolate and worker isolates, and between ports inside one isolate.
//
// Written from HTML §9.4 (MessageChannel, MessagePort: entangle, port message queue, "enabled" queues, transfer,
// disentangle) and §10.2 (a worker's implicit port pair). A port is a number; the JS MessagePort / Worker / worker
// global objects are wrappers that the V8 binding keeps per isolate.
//
// Model:
//   * Every port has at most one entangled peer, an owner (the isolate whose JS can use it: a PortOwner), a queue
//     of messages it received, and a started flag (HTML "port message queue enabled").
//   * post(from, payload) appends to the peer's queue. Nothing is delivered until the receiving port is started and
//     owned; then the owner is asked (schedule_delivery) to run one delivery task on its thread, which calls pop().
//     pop() hands out one message and re-schedules while more are queued, so each message is its own task (HTML) and
//     a burst never monopolises the receiver's event loop (LOOP-2).
//   * Transfer: detach_for_transfer() takes a port away from its owner (queue kept, delivery off) while a message
//     carries it; adopt() gives it to the receiving isolate. Messages that arrive in between wait in its queue.
//   * close() removes the port and disentangles its peer; the closed port's queue is dropped, messages it had already
//     sent stay with the peer. Posting through a port whose peer is gone drops the message (HTML).
//   * Payload destructors may call back into the hub (an undelivered message closes the ports it carried), so the hub
//     never destroys payloads, nor calls owners, while holding its lock.
//
// Thread-safety: every method may be called from any thread.
#pragma once

#include <cstddef>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace iwn::workers {

using PortId = uint64_t;

// A message in flight. The V8 binding's subclass holds the serialized bytes and everything transferred with them.
class Payload {
 public:
  virtual ~Payload() = default;
  virtual size_t byte_size() const = 0;
};

// The isolate a port belongs to. Implemented by the V8 binding, one per isolate (page or worker).
class PortOwner {
 public:
  virtual ~PortOwner() = default;
  // Any thread. Asks the owner to run a delivery task for `port` on its JS thread (that task calls PortHub::pop).
  // Returns false when the owner can no longer run tasks (its isolate is going away).
  virtual bool schedule_delivery(PortId port) = 0;
};

struct PortHubStats {
  size_t live_ports = 0;
  size_t queued_messages = 0;
  uint64_t posted = 0;
  uint64_t delivered = 0;
  uint64_t dropped = 0;
  uint64_t bytes_posted = 0;
};

// WRK-10: one exchanged message, for the debug-build message log.
struct MessageLogEntry {
  double time_ms = 0;  // iwn::now_ms() clock
  std::string from;    // label of the sending port ("main", "worker 3 'ktx2'", "port 17", ...)
  std::string to;
  size_t bytes = 0;
};

class PortHub {
 public:
  // The process-wide hub (never destroyed, so worker threads may outlive static destructors).
  static PortHub& shared();

  PortHub() = default;
  PortHub(const PortHub&) = delete;
  PortHub& operator=(const PortHub&) = delete;

  // Two entangled ports. Either owner may be null (not owned yet).
  std::pair<PortId, PortId> create_pair(std::shared_ptr<PortOwner> owner_a, std::shared_ptr<PortOwner> owner_b);

  enum class PostResult { kQueued, kNoPeer, kUnknownPort };
  // Queues `payload` on from's peer. kNoPeer / kUnknownPort: the payload is destroyed (outside the lock).
  PostResult post(PortId from, std::unique_ptr<Payload> payload);

  // HTML "start": enables the port's message queue (delivery begins if the port has an owner).
  void start(PortId port);
  // HTML "close": the port is removed, its queue dropped, its peer disentangled. Unknown ids are ignored.
  void close(PortId port);
  // Takes the port from `expected_owner` for a transfer (queue kept; delivery off until adopt + start).
  // False if the port is unknown or owned by someone else.
  bool detach_for_transfer(PortId port, const PortOwner* expected_owner);
  // Gives a detached port to `owner` (not started). False if the port is unknown or still owned.
  bool adopt(PortId port, std::shared_ptr<PortOwner> owner);

  // The owner's delivery task: the next message of `port`, or null if the port is gone, not started, or no longer
  // owned by `owner`. Re-schedules delivery itself while more messages are queued.
  std::unique_ptr<Payload> pop(PortId port, const PortOwner* owner);

  // Closes every port owned by `owner` (isolate teardown). Returns how many.
  size_t close_owned_by(const PortOwner* owner);

  // Diagnostics.
  void set_label(PortId port, std::string label);
  bool exists(PortId port) const;
  bool entangled(PortId port) const;
  bool started(PortId port) const;
  size_t queued(PortId port) const;
  PortHubStats stats() const;
  // WRK-10: keep the last `capacity` exchanged messages (0 = off, the default).
  void set_log_capacity(size_t capacity);
  std::vector<MessageLogEntry> log_snapshot() const;

 private:
  struct Port {
    PortId peer = 0;
    std::shared_ptr<PortOwner> owner;
    std::deque<std::unique_ptr<Payload>> queue;
    bool started = false;
    bool scheduled = false;  // a delivery task is pending on the owner's thread
    std::string label;
  };
  // Returns the owner to notify (call schedule_delivery outside the lock), or null.
  std::shared_ptr<PortOwner> schedule_locked(PortId id, Port& port);
  void notify(PortId id, const std::shared_ptr<PortOwner>& owner);
  std::string label_locked(PortId id) const;

  mutable std::mutex mu_;
  std::unordered_map<PortId, Port> ports_;
  PortId next_id_ = 1;
  PortHubStats stats_;
  size_t log_capacity_ = 0;
  std::deque<MessageLogEntry> log_;
};

}  // namespace iwn::workers
