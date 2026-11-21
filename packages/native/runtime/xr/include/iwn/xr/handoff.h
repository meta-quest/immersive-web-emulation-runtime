// Thread handoff between the XR thread (owns OpenXR and the frame loop) and the main JS thread (owns V8 and the
// WebGL contexts), V8-free and OpenXR-free so the protocol is tested on the host with real threads.
//
// FrameSlot: the one JS frame in flight. The XR thread writes the frame record, post()s, and waits for the JS thread
// to begin() and finish() it, up to a deadline; when the JS thread is busy (a long task, a debugger pause) the XR
// thread cancel()s a frame JS has not begun, or leaves a running one in flight and submits its image in a later
// OpenXR frame. Exactly one of begin() and cancel() wins for a posted frame, so the record is never written while JS
// reads it. A command the XR thread runs while it waits (the page ending its session, a new swapchain) may withdraw()
// the posted frame; conclude() tells the waiting frame loop which of these happened, so a withdrawn frame is never
// mistaken for one still running in JS.
//
// CommandQueue: JS-thread requests (swapchain creation, frame rate, foveation, haptics, ...) that must run on the
// XR thread. call() blocks the caller until the command ran or a timeout passed; the XR thread runs commands
// between OpenXR calls and while it waits for a JS frame, so a JS frame that issues a blocking command cannot
// deadlock with the XR thread waiting for that frame.
#pragma once

#include <atomic>
#include <chrono>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>

#include "iwn/core/monotonic_cv.h"

namespace iwn::xr {

class CommandQueue;

class FrameSlot {
 public:
  enum State : int { kIdle = 0, kPosted = 1, kRunning = 2, kDone = 3, kCancelled = 4 };

  // XR thread: kIdle -> kPosted. False (and nothing changes) when the slot is not idle.
  bool post();
  // JS thread: kPosted -> kRunning. False when nothing is posted or the XR thread cancelled it.
  bool begin();
  // JS thread: kRunning -> kDone, and wakes the XR thread.
  void finish();
  // XR thread: kPosted -> kCancelled. False when JS already began (or nothing was posted).
  bool cancel();
  // XR thread: kDone or kCancelled -> kIdle.
  void reset();
  // XR thread: drops a posted frame JS has not begun (kPosted -> kIdle). False when nothing was posted or JS began
  // it first.
  bool withdraw();
  State state() const { return static_cast<State>(state_.load(std::memory_order_acquire)); }

  // XR thread: waits until the slot is kDone or `deadline` passes, running `commands` whenever commands arrive; stops
  // early when a command left no frame to wait for (withdrawn: the slot is idle). Returns the state when it stopped.
  State wait_done(std::chrono::steady_clock::time_point deadline, CommandQueue* commands);

  // XR thread, after wait_done(): what became of the frame it posted (or of the frame in flight).
  //   kDone       JS finished it: collect it now (the slot stays kDone until reset()).
  //   kCancelled  JS never began it: cancelled here, the slot is idle again.
  //   kWithdrawn  a command run while waiting withdrew it (withdraw()): the slot is idle and nothing is in flight.
  //   kRunning    JS is still in it: collect it once it is done.
  enum class Outcome { kDone, kCancelled, kWithdrawn, kRunning };
  Outcome conclude();

  // Any thread: wakes wait_done (used by CommandQueue::push).
  void kick();

  // Back to kIdle with no wake pending, for a new run after the XR thread was joined (same-process relaunch). No
  // other thread may use the slot meanwhile.
  void force_idle();

 private:
  friend class CommandQueue;
  std::atomic<int> state_{kIdle};
  std::mutex mu_;
  MonotonicCondVar cv_;
  bool kicked_ = false;
};

class CommandQueue {
 public:
  using Command = std::function<void()>;

  // Wake target while the XR thread waits for a JS frame (may be null).
  void set_slot(FrameSlot* slot) { slot_ = slot; }

  // Any thread: queue a command for the XR thread. False (command dropped) after close().
  bool push(Command command);
  // Any thread except the XR thread: queue and wait until it ran (true) or `timeout` passed (false; the command
  // still runs later, so it must only touch state that outlives the caller, e.g. through a shared_ptr).
  bool call(Command command, std::chrono::milliseconds timeout);
  // XR thread: run everything queued so far. Returns how many ran.
  int run_pending();
  // XR thread: wait until a command arrives or the timeout passes.
  void wait(std::chrono::milliseconds timeout);
  bool empty() const;
  // XR thread at exit: run what is queued, then refuse new commands (push drops them, call returns false at once).
  void close();
  // Accept commands again (empty queue), for a new XR thread after the previous one was joined.
  void reopen();

 private:
  mutable std::mutex mu_;
  MonotonicCondVar cv_;
  std::deque<Command> queue_;
  bool closed_ = false;
  FrameSlot* slot_ = nullptr;
};

}  // namespace iwn::xr
