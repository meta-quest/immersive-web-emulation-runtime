// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
//
// Context-level checks: realtime path through a capturing output (AUD-1, AUD-2, AUD-10), the
// real-time-paced host output (currentTime ~ wall time), offline rendering (AUD-3), decoding on
// worker threads (PROC-2).
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <fstream>
#include <iterator>
#include <mutex>
#include <thread>

#include "context.h"
#include "decode.h"
#include "iwn/audio.h"
#include "notify.h"
#include "test.h"

using namespace iwn::audio;
using namespace iwn::audio::proto;

namespace {

// Output that renders as fast as asked (driven by the test) with odd burst sizes, capturing audio.
class CaptureOutput final : public AudioOutput {
 public:
  bool open(int channels, float, int, RenderCallback* cb) override {
    ch_ = channels;
    cb_ = cb;
    return true;
  }
  float sampleRate() const override { return 48000; }
  double baseLatency() const override { return 0.004; }
  double outputLatency() const override { return 0.012; }
  bool start() override { running = true; return true; }
  void pause() override { running = false; }
  void close() override { running = false; }
  uint64_t xruns() const override { return 0; }
  bool timestamp(int64_t&, int64_t&) const override { return false; }
  // Pulls `frames` frames in bursts of `burst` (like a device whose burst is not 128).
  void pump(int frames, int burst = 96) {
    std::vector<float> buf(size_t(burst * ch_));
    for (int done = 0; done < frames; done += burst) {
      if (!running) return;
      cb_->render(buf.data(), ch_, burst);
      captured.insert(captured.end(), buf.begin(), buf.end());
    }
  }
  std::vector<float> captured;
  std::atomic<bool> running{false};

 private:
  int ch_ = 2;
  RenderCallback* cb_ = nullptr;
};

std::vector<OutEvent> drain() {
  std::vector<OutEvent> ev;
  collectAllEvents(ev);
  return ev;
}

double frameOf(Context* c) { return Graph::loadShared(&c->block()->shared[kSharedFrame]); }

}  // namespace

TEST(realtime_state_machine_and_current_time) {
  auto* out = new CaptureOutput();
  std::string err;
  Context* c = Context::createRealtime(0, 0, &err, std::unique_ptr<AudioOutput>(out));
  CHECK(c != nullptr);
  if (!c) return;
  auto ev = drain();
  bool running = false;
  for (auto& e : ev) running |= e.type == kEvState && e.ctx == c->id() && e.a == 1;
  CHECK(running);  // AUD-1 decision: starts running, reported by a state event
  out->pump(48000);
  CHECK_NEAR(frameOf(c) / 48000.0, 1.0, 0.01);  // currentTime follows rendered frames
  double s[] = {kContextState, 0, 7};  // suspend, request 7
  CHECK(c->submit(s, 3) > 0);
  out->pump(960);
  double f1 = frameOf(c);
  out->pump(4800);
  CHECK(frameOf(c) == f1);  // suspended: time does not advance
  ev = drain();
  bool ack = false;
  for (auto& e : ev) ack |= e.type == kEvState && e.a == 0 && e.b == 7;
  CHECK(ack);
  double r[] = {kContextState, 1, 8};
  c->submit(r, 3);
  out->pump(4800);
  CHECK(frameOf(c) > f1);
  double cl[] = {kContextState, 2, 9};
  c->submit(cl, 3);
  out->pump(480);
  ev = drain();
  bool closed = false;
  for (auto& e : ev) closed |= e.type == kEvState && e.a == 2 && e.b == 9;
  CHECK(closed);
  destroyContext(c->id());
}

TEST(realtime_batches_apply_at_quantum_boundaries) {
  // AUD-10 with a device burst of 96 frames (not a multiple of 128).
  auto* out = new CaptureOutput();
  std::string err;
  Context* c = Context::createRealtime(0, 0, &err, std::unique_ptr<AudioOutput>(out));
  drain();
  int slot = kListenerSlots;
  std::vector<double> w = {
      kCreateNode, 2, kConstantSource, double(slot), 2, 0, 0, 0, 0, 0, 0,
      kCreateNode, 3, kGain, double(slot + 1), 2, 0, 0, 0, 0, 0, 0,
      kCreateNode, 4, kGain, double(slot + 2), 2, 0, 0, 0, 0, 0, 0,
      kCreateNode, 5, kMerger, 0, 1, 2, 0, 2, 0, 0, 0,
      kConnect, 2, 0, 3, 0, kConnect, 2, 0, 4, 0,
      kConnect, 3, 0, 5, 0, kConnect, 4, 0, 5, 1, kConnect, 5, 0, 1, 0,
      kStart, 2, 0, 0, -1};
  CHECK(c->submit(w.data(), w.size()) > 0);
  std::thread pumpThread([&] { out->pump(48000 * 2, 96); });
  for (int k = 0; k < 400; ++k) {
    double v = (k % 10) * 0.1;
    double t = 0;  // "now": setValueAtTime(v, 0) applies at the next quantum boundary
    std::vector<double> b = {kParamEvent, double(slot + 1), 0, t, v, 0, 0, 0,
                             kParamEvent, double(slot + 2), 0, t, v, 0, 0, 0};
    c->submit(b.data(), b.size());
    std::this_thread::sleep_for(std::chrono::microseconds(50));
  }
  pumpThread.join();
  size_t mismatches = 0;
  for (size_t i = 0; i + 1 < out->captured.size(); i += 2) mismatches += out->captured[i] != out->captured[i + 1];
  CHECK(mismatches == 0);
  double sum = 0;
  for (float v : out->captured) sum += v;
  CHECK(sum > 0);
  destroyContext(c->id());
  drain();
}

TEST(realtime_host_output_tracks_wall_time) {
  std::string err;
  Context* c = Context::createRealtime(0, 0, &err);
  CHECK(c != nullptr);
  if (!c) return;
  std::this_thread::sleep_for(std::chrono::milliseconds(100));
  double f0 = frameOf(c);
  auto t0 = std::chrono::steady_clock::now();
  std::this_thread::sleep_for(std::chrono::milliseconds(500));
  double f1 = frameOf(c);
  double wall = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  CHECK_NEAR((f1 - f0) / c->sampleRate(), wall, 0.05);
  // AUD-2: output paused by lifecycle -> time stops, no state event; resumes after.
  drain();
  setOutputPaused(kPauseLifecycle, true);
  std::this_thread::sleep_for(std::chrono::milliseconds(30));
  double p0 = frameOf(c);
  std::this_thread::sleep_for(std::chrono::milliseconds(200));
  CHECK(frameOf(c) - p0 <= 192 * 2);
  setOutputPaused(kPauseXrHidden, true);
  setOutputPaused(kPauseLifecycle, false);  // still hidden: stays paused
  std::this_thread::sleep_for(std::chrono::milliseconds(100));
  CHECK(frameOf(c) - p0 <= 192 * 2);
  setOutputPaused(kPauseXrHidden, false);
  std::this_thread::sleep_for(std::chrono::milliseconds(200));
  CHECK(frameOf(c) - p0 > 4800);
  auto ev = drain();
  for (auto& e : ev) CHECK(e.type != kEvState);
  CHECK(Graph::loadShared(&c->block()->shared[kSharedState]) == 1);
  destroyContext(c->id());
}

TEST(offline_context_renders_on_background_thread) {
  std::string err;
  Context* c = Context::createOffline(2, 48000, 44100, &err);
  CHECK(c != nullptr);
  std::vector<double> w = {
      kCreateNode, 2, kOscillator, double(kListenerSlots), 2, 0, 0, 0, 0, 0, 0,
      kParamEvent, double(kListenerSlots), 0, 0, 441, 0, 0, 0,
      kConnect, 2, 0, 1, 0, kStart, 2, 0, 0, -1, kStop, 2, 0.5, };
  CHECK(c->submit(w.data(), w.size()) > 0);
  CHECK(c->startRendering());
  CHECK(!c->startRendering());
  uint32_t bufferId = 0;
  bool ended = false;
  for (int i = 0; i < 400 && !bufferId; ++i) {
    for (auto& e : drain()) {
      if (e.type == kEvRenderDone && e.ctx == c->id()) bufferId = uint32_t(e.a);
      if (e.type == kEvEnded && e.a == 2) ended = true;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  CHECK(bufferId != 0);
  CHECK(ended);
  BufferData* b = BufferRegistry::get().find(bufferId);
  CHECK(b && b->length() == 48000 && b->channels() == 2);
  if (b) {
    const double kPi = 3.14159265358979323846;
    CHECK_NEAR(b->channel(1)[100], std::sin(2 * kPi * 441 * 100 / 44100.0), 1e-4);
    CHECK_NEAR(b->channel(0)[30000], 0, 0);  // stopped at 0.5 s
  }
  BufferRegistry::get().remove(bufferId);
  destroyContext(c->id());
}

TEST(background_decode_completes_as_event) {
  std::string path = std::string(IWN_AUDIO_FIXTURES) + "/mp3-22050-mono-vbr.mp3";
  std::ifstream f(path, std::ios::binary);
  auto bytes = std::make_shared<std::vector<uint8_t>>((std::istreambuf_iterator<char>(f)),
                                                      std::istreambuf_iterator<char>());
  DecodeJob j;
  j.ctx = 77;
  j.requestId = 5;
  j.targetRate = 48000;
  j.data = bytes->data();
  j.size = bytes->size();
  j.keepAlive = bytes;
  submitDecode(j);
  DecodeJob bad = j;
  bad.requestId = 6;
  static const uint8_t junk[] = "not audio at all";
  bad.data = junk;
  bad.size = sizeof junk;
  submitDecode(bad);
  bool ok = false, failed = false;
  for (int i = 0; i < 400 && !(ok && failed); ++i) {
    for (auto& e : drain()) {
      if (e.type == kEvDecodeDone && e.b > 0 && e.a == 5) {
        ok = true;
        BufferData* b = BufferRegistry::get().find(uint32_t(e.b));
        CHECK(b && b->sampleRate() == 48000);
        BufferRegistry::get().remove(uint32_t(e.b));
      }
      if (e.type == kEvDecodeError && e.a == 6) failed = !e.message.empty();
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  CHECK(ok);
  CHECK(failed);
  CHECK(pendingDecodes() == 0);
}

TEST(host_hooks_wake_main_thread) {
  // Leaked on purpose: the notifier thread is never joined in this binary and may still be inside
  // the hook while static destructors run at exit.
  static std::mutex& mu = *new std::mutex();
  static std::condition_variable& cv = *new std::condition_variable();
  static int posted = 0;
  HostHooks h;
  h.postToMain = [](void*, void (*fn)(void*), void* arg) {
    fn(arg);  // test: run inline on the notifier thread
    std::lock_guard<std::mutex> l(mu);
    ++posted;
    cv.notify_all();
    return true;
  };
  setHostHooks(h);
  std::string err;
  Context* c = Context::createOffline(1, 1280, 48000, &err);
  c->startRendering();
  std::unique_lock<std::mutex> l(mu);
  cv.wait_for(l, std::chrono::seconds(2), [] { return posted > 0; });
  CHECK(posted > 0);
  l.unlock();
  for (int i = 0; i < 100; ++i) {
    bool done = false;
    for (auto& e : drain()) {
      if (e.type == kEvRenderDone) {
        done = true;
        BufferRegistry::get().remove(uint32_t(e.a));
      }
    }
    if (done) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  destroyContext(c->id());
  setHostHooks(HostHooks{});
}

// ---- event notifier, state requests, module restart -----------------------------------------------

namespace {
std::atomic<int>& drainCount() {
  static auto* n = new std::atomic<int>(0);
  return *n;
}
void countDrain(void*) { drainCount().fetch_add(1); }
std::atomic<int>& dropNextPost() {
  static auto* n = new std::atomic<int>(0);
  return *n;
}
// Runs posted tasks inline on the notifier thread, except one it is told to drop (as the core's
// post_task drops a task whose page reloaded before it ran).
bool inlinePost(void*, void (*fn)(void*), void* arg) {
  if (dropNextPost().exchange(0)) return true;
  fn(arg);
  return true;
}
double maxAck(const std::vector<OutEvent>& ev, uint32_t ctx) {
  double m = 0;
  for (auto& e : ev)
    if (e.type == kEvState && e.ctx == ctx) m = std::max(m, e.b);
  return m;
}
}  // namespace

TEST(notifier_recovers_when_the_host_drops_a_posted_task) {
  HostHooks h;
  h.postToMain = inlinePost;
  setHostHooks(h);
  drainCount() = 0;
  dropNextPost() = 1;
  Notifier::get().setDrain(countDrain, nullptr);  // posts once (results check): dropped
  std::this_thread::sleep_for(std::chrono::milliseconds(50));
  Notifier::get().signal();  // coalesced behind the dropped task
  std::this_thread::sleep_for(std::chrono::milliseconds(50));
  CHECK(drainCount() == 0);
  // A new page installs its drain function: the lost task is forgotten and results are delivered.
  Notifier::get().setDrain(countDrain, nullptr);
  std::this_thread::sleep_for(std::chrono::milliseconds(50));
  CHECK(drainCount() >= 1);
  // Without a new page: a task that has not run within a second is posted again.
  drainCount() = 0;
  dropNextPost() = 1;
  Notifier::get().signal();
  std::this_thread::sleep_for(std::chrono::milliseconds(100));
  CHECK(drainCount() == 0);
  Notifier::get().signal();
  for (int i = 0; i < 40 && drainCount() == 0; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(50));
  CHECK(drainCount() >= 1);
  Notifier::get().setDrain(nullptr, nullptr);
  setHostHooks(HostHooks{});
}

TEST(more_state_requests_than_slots_all_settle) {
  for (int scenario = 0; scenario < 2; ++scenario) {
    auto* out = new CaptureOutput();
    std::string err;
    Context* c = Context::createRealtime(0, 0, &err, std::unique_ptr<AudioOutput>(out));
    drain();
    // 40 alternating suspend/resume requests in one batch (scenario 1: request 20 is a close).
    std::vector<double> w;
    for (int k = 1; k <= 40; ++k) {
      double desired = (scenario == 1 && k == 20) ? 2 : (k % 2 ? 0 : 1);
      w.insert(w.end(), {double(kContextState), desired, double(k)});
    }
    CHECK(c->submit(w.data(), w.size()) > 0);
    out->pump(960);
    auto ev = drain();
    CHECK(maxAck(ev, c->id()) == 40);  // the last ack settles every request (cumulative)
    double state = Graph::loadShared(&c->block()->shared[kSharedState]);
    CHECK(state == (scenario == 0 ? 1 : 2));  // the last request wins; a close is final
    destroyContext(c->id());
  }
}

TEST(state_ack_survives_a_full_event_queue) {
  auto* out = new CaptureOutput();
  std::string err;
  Context* c = Context::createRealtime(0, 0, &err, std::unique_ptr<AudioOutput>(out));
  drain();
  // This thread plays the render thread (pump), so it may fill the render -> main queue.
  while (c->graph().events.push({kEvEnded, 999, 0})) {
  }
  double s[] = {kContextState, 0, 5, kContextState, 1, 6};
  c->submit(s, 6);
  out->pump(480);  // acks do not fit
  std::vector<OutEvent> ev;
  GraphEvent ge;
  while (c->graph().events.pop(ge)) {
  }  // main side drains the queue (dropping the filler)
  out->pump(480);  // retried at the next quantum
  ev = drain();
  CHECK(maxAck(ev, c->id()) == 6);
  destroyContext(c->id());
}

TEST(module_rearms_after_shutdown_for_a_new_runtime) {
  // PROC-7 then a relaunch into the cached process: the runtime's shutdown hook ran
  // iwn::audio::shutdown(), then a new runtime registers the module again.
  HostHooks h;
  h.postToMain = inlinePost;
  setHostHooks(h);
  std::string err;
  Context* c = Context::createRealtime(0, 0, &err);
  CHECK(c != nullptr);
  uint32_t oldId = c ? c->id() : 0;
  setOutputPaused(kPauseLifecycle, true);  // the old activity was paused when it went away
  shutdown();
  CHECK(findContext(oldId) == nullptr);  // freed, not just stopped
  CHECK(!Notifier::get().hasHooks());    // nothing points at the old runtime
  err.clear();
  CHECK(Context::createRealtime(0, 0, &err) == nullptr);
  CHECK(err.find("shut down") != std::string::npos);

  rearmAfterShutdown();  // what iwn_register_audio does for the new runtime
  CHECK(outputPausedReasons() == 0);
  setHostHooks(h);
  drainCount() = 0;
  Notifier::get().setDrain(countDrain, nullptr);
  Context* c2 = Context::createRealtime(0, 0, &err);
  CHECK(c2 != nullptr);
  if (c2) {
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    CHECK(frameOf(c2) > 0);  // not paused by the old activity's reason
  }
  // Decoder threads run again and the notifier thread posts again.
  std::string path = std::string(IWN_AUDIO_FIXTURES) + "/wav-22050-mono-s16.wav";
  std::ifstream f(path, std::ios::binary);
  auto bytes = std::make_shared<std::vector<uint8_t>>((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
  DecodeJob j;
  j.ctx = c2 ? c2->id() : 0;
  j.requestId = 1;
  j.targetRate = 48000;
  j.data = bytes->data();
  j.size = bytes->size();
  j.keepAlive = bytes;
  int before = drainCount();
  submitDecode(j);
  bool ok = false;
  for (int i = 0; i < 400 && !ok; ++i) {
    for (auto& e : drain()) {
      if (e.type == kEvDecodeDone && e.a == 1) {
        ok = true;
        BufferRegistry::get().remove(uint32_t(e.b));
      }
    }
    if (!ok) std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  CHECK(ok);
  CHECK(drainCount() > before);
  if (c2) destroyContext(c2->id());
  Notifier::get().setDrain(nullptr, nullptr);
  setHostHooks(HostHooks{});
}

TEST(stream_down_is_serviced_without_rendering) {
  // AUD-12: between a disconnect and the reopen no render callback runs; the output's reopener
  // thread services the graph instead (here: this thread).
  auto* out = new CaptureOutput();
  std::string err;
  Context* c = Context::createRealtime(0, 0, &err, std::unique_ptr<AudioOutput>(out));
  drain();
  out->pump(960);
  double f0 = frameOf(c);
  out->running = false;  // the stream is gone
  std::vector<double> w = {kCreateNode, 2, kGain, double(kListenerSlots), 2, 0, 0, 0, 0, 0, 0, kContextState, 0, 3};
  CHECK(c->submit(w.data(), w.size()) > 0);
  for (int k = 0; k < 3000; ++k) {  // more batches than the queue holds (1024)
    double b[] = {kParamEvent, double(kListenerSlots), 0, 0, double(k % 7), 0, 0, 0};
    c->submit(b, 8);
    if (k % 100 == 0) c->serviceWithoutDevice();
  }
  double cl[] = {kContextState, 2, 4};
  c->submit(cl, 3);
  c->serviceWithoutDevice();
  auto ev = drain();  // also moves batches that did not fit into the queue
  c->serviceWithoutDevice();
  auto ev2 = drain();
  ev.insert(ev.end(), ev2.begin(), ev2.end());
  CHECK(maxAck(ev, c->id()) == 4);  // suspend and close answered
  CHECK(frameOf(c) == f0);          // nothing rendered
  CHECK(!c->hasPendingWork());      // nothing piled up
  destroyContext(c->id());
}
