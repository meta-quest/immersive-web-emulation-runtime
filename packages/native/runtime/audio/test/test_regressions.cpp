// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
//
// Regression tests: control-batch attachments, bounded automation
// timelines, render-thread allocation, cycles, silence, panner corner cases, event delivery,
// paused output (AUD-2), decoder limits.
#include <algorithm>
#include <chrono>
#include <cstring>
#include <random>
#include <thread>

#include "context.h"
#include "decode.h"
#include "iwn/audio.h"
#include "test.h"

using namespace iwn::audio;
using namespace iwn::audio::proto;
using iwntest::Rig;

namespace {
ParamEvent mk(ParamEvent::Type t, double time, float v, double tcOrDur = 0, double ins = 0) {
  ParamEvent e;
  e.type = t;
  e.time = time;
  e.value = v;
  if (t == ParamEvent::SetTarget) e.timeConstant = tcOrDur;
  if (t == ParamEvent::SetCurve) e.duration = tcOrDur;
  e.insertTime = ins;
  return e;
}
uint64_t rtAllocs() { return rtAllocationCounter().load(); }
}  // namespace

// ---- attachments -------------------------------------------------------------------------------

TEST(connect_param_buses_are_not_stolen_across_commands) {
  // Task 1: lfo1 -> gA.gain. Task 2: lfo2 -> gA.gain (gA already has a bus) and lfo1 -> gB.gain
  // (needs a new bus). Each param must end up with its own bus.
  Rig r;
  uint32_t lfo1 = r.create(kConstantSource), lfo2 = r.create(kConstantSource);
  uint32_t gA = r.create(kGain), gB = r.create(kGain);
  r.setValue(r.slot(gB, 0), 0, 0);
  r.start(lfo1);
  r.start(lfo2);
  r.connectParam(lfo1, r.slot(gA, 0));
  r.render(1);
  r.connectParam(lfo2, r.slot(gA, 0));
  r.connectParam(lfo1, r.slot(gB, 0));
  r.render(2);
  CHECK_NEAR(r.paramValue(r.slot(gA, 0)), 3.0, 1e-6);  // 1 + lfo1 + lfo2
  CHECK_NEAR(r.paramValue(r.slot(gB, 0)), 1.0, 1e-6);  // 0 + lfo1
}

TEST(set_buffer_keeps_its_bus_next_to_a_first_param_connection) {
  // One batch: a stereo buffer on an existing source (no larger bus needed) followed by the first
  // connection into a param (which carries a bus). The source must stay stereo.
  Rig r;
  uint32_t src = r.create(kBufferSource);
  uint32_t lfo = r.create(kConstantSource);
  uint32_t g = r.create(kGain);
  r.render(1);
  uint32_t buf = r.makeBuffer({std::vector<float>(4096, 0.5f), std::vector<float>(4096, -0.25f)});
  r.buffer(src, buf);
  r.connectParam(lfo, r.slot(g, 0));
  r.connect(src, 1);
  r.start(src);
  auto out = r.render(2);
  CHECK_NEAR(out[0][200], 0.5, 1e-6);
  CHECK_NEAR(out[1][200], -0.25, 1e-6);
}

// ---- automation timelines --------------------------------------------------------------------------

TEST(timeline_insert_order_does_not_change_values) {
  // recomputeLocal() must recompute everything an insert affects: build the same event set in a
  // random order and in time order and compare the curves sample by sample.
  std::mt19937 rng(7);
  for (int trial = 0; trial < 40; ++trial) {
    std::vector<ParamEvent> evs;
    std::uniform_real_distribution<double> ut(0.0, 1.0);
    std::uniform_real_distribution<float> uv(0.1f, 2.0f);
    std::uniform_int_distribution<int> uk(0, 3);
    for (int i = 0; i < 24; ++i) {
      int k = uk(rng);
      double t = ut(rng);
      if (k == 3) evs.push_back(mk(ParamEvent::SetTarget, t, uv(rng), 0.05));
      else evs.push_back(mk(static_cast<ParamEvent::Type>(k), t, uv(rng)));
    }
    ParamTimeline a(1, -100, 100), b(1, -100, 100);
    for (auto& e : evs) a.insert(e, nullptr);
    auto sorted = evs;
    std::sort(sorted.begin(), sorted.end(), [](auto& x, auto& y) { return x.time < y.time; });
    for (auto& e : sorted) b.insert(e, nullptr);
    double worst = 0;
    for (int i = 0; i <= 1100; ++i) {
      double t = i / 1000.0;
      worst = std::max(worst, double(std::fabs(a.valueAt(t) - b.valueAt(t))));
    }
    CHECK(worst == 0);
  }
}

TEST(suspended_context_timeline_stays_bounded) {
  // Three.js on a suspended context: currentTime frozen, 9 listener ramps per frame with
  // jittered end times. The list is capped and every apply stays cheap.
  Rig r;
  r.render(1);
  uint64_t merged0 = paramMergeCounter().load();
  std::mt19937 rng(3);
  std::uniform_real_distribution<double> jitter(0.010, 0.020);
  double t0 = r.graph().time();
  auto start = std::chrono::steady_clock::now();
  double firstWindow = 0;
  for (int frame = 0; frame < 8640; ++frame) {  // 2 minutes at 72 Hz
    for (int p = 0; p < 9; ++p) r.event(p, ParamEvent::LinearRamp, t0 + jitter(rng), 0.1 * p, 0, t0);
    r.commit();
    r.graph().applyPending();  // what Context::render does while suspended: apply, no render
    r.graph().drainGarbage();
    if (frame == 719)
      firstWindow = std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
  }
  double total = std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
  for (int p = 0; p < 9; ++p) CHECK(r.graph().listenerParam(p)->tl.eventCount() <= ParamTimeline::kMaxEvents);
  CHECK(paramMergeCounter().load() > merged0);
  // Linear, not quadratic: the last 10 minutes-worth of frames cost about what the first did.
  std::printf("    suspended 8640 frames: %.1f ms total (first 720: %.1f ms)\n", total * 1e3, firstWindow * 1e3);
  CHECK(total < firstWindow * 12 * 3 + 0.05);
}

TEST(same_time_set_target_replaces_the_previous_one) {
  ParamTimeline a(1, -10, 10), ref(1, -10, 10);
  for (int i = 0; i < 100; ++i) a.insert(mk(ParamEvent::SetTarget, 0.5, 0.01f * i, 0.1), nullptr);
  ref.insert(mk(ParamEvent::SetTarget, 0.5, 0.99f, 0.1), nullptr);
  CHECK(a.eventCount() == 1);
  for (double t : {0.4, 0.5, 0.6, 1.0}) CHECK_NEAR(a.valueAt(t), ref.valueAt(t), 1e-7);
}

TEST(set_target_settles_to_constant) {
  ParamTimeline tl(1, -10, 10);
  tl.insert(mk(ParamEvent::SetTarget, 0, 0.25f, 0.01), nullptr);
  float buf[kQuantum];
  CHECK(!tl.compute(0.001, 1.0 / 48000, kQuantum, buf));
  CHECK(tl.compute(1.0, 1.0 / 48000, kQuantum, buf));  // 100 time constants later
  CHECK(buf[0] == 0.25f);
}

TEST(cancel_scheduled_values_keeps_the_intrinsic_value) {
  Rig r;
  uint32_t c = r.create(kConstantSource);
  r.start(c);
  r.render(1);
  r.setValue(r.slot(c, 0), 0.3, r.graph().time(), r.graph().time());
  r.raw({double(kParamCancel), double(r.slot(c, 0)), 0, 0});
  r.render(2);
  CHECK_NEAR(r.paramValue(r.slot(c, 0)), 0.3, 1e-7);
}

// ---- render-thread allocation (AUD-10) -------------------------------------------------------------

TEST(render_thread_does_not_allocate_for_ramps_connections_or_hrtf) {
  Rig r;
  uint32_t src = r.create(kConstantSource);
  uint32_t pan = r.create(kPanner);
  r.prop(pan, kPropPanningModel, 1);
  uint32_t g = r.create(kGain);
  r.connect(src, pan);
  r.connect(pan, g);
  r.connect(g, 1);
  r.start(src);
  r.render(2);
  uint64_t before = rtAllocs();
  // 50 frames of three.js-style ramps on every panner and listener param.
  for (int f = 0; f < 50; ++f) {
    double t = r.graph().time();
    for (int p = 0; p < 6; ++p) r.event(r.slot(pan, p), ParamEvent::LinearRamp, t + 0.014, 0.1 * f, 0, t);
    for (int p = 0; p < 9; ++p) r.event(p, ParamEvent::LinearRamp, t + 0.014, p == 5 ? -1 : 0.01 * f, 0, t);
    r.render(5);
  }
  // An 8-ramp envelope on an existing param in one batch.
  double t = r.graph().time();
  for (int k = 1; k <= 8; ++k) r.event(r.slot(g, 0), ParamEvent::LinearRamp, t + 0.01 * k, 1.0 / k, 0, t);
  r.render(2);
  // Six new sources into one existing input, one batch.
  for (int k = 0; k < 6; ++k) {
    uint32_t s = r.create(kConstantSource);
    r.connect(s, g);
    r.start(s);
  }
  r.render(2);
  // And the same again into the same input over several batches.
  for (int k = 0; k < 20; ++k) {
    uint32_t s = r.create(kConstantSource);
    r.connect(s, g);
    r.start(s);
    r.render(1);
  }
  CHECK(rtAllocs() == before);
}

// ---- cycles -------------------------------------------------------------------------------------

TEST(feedback_delay_echoes_at_the_delay_time) {
  // s -> g -> d(10 ms) -> fb(0.5) -> g; g -> out. Echoes at 0, 480, 960, 1440 (no extra quantum).
  Rig r;
  std::vector<float> imp(128, 0.f);
  imp[0] = 1;
  uint32_t buf = r.makeBuffer({imp});
  uint32_t s = r.create(kBufferSource);
  r.buffer(s, buf);
  uint32_t g = r.create(kGain);
  uint32_t d = r.create(kDelay, 2, 0, 0, 1.0);
  uint32_t fb = r.create(kGain);
  r.setValue(r.slot(d, 0), 0.01, 0);
  r.setValue(r.slot(fb, 0), 0.5, 0);
  r.connect(s, g);
  r.connect(g, d);
  r.connect(d, fb);
  r.connect(fb, g);
  r.connect(g, 1);
  r.start(s);
  auto out = r.render(16);
  CHECK_NEAR(out[0][0], 1.0, 1e-6);
  // delayTime is a float param: 0.01 s is 479.99998 frames, hence the 1e-4 tolerance.
  CHECK_NEAR(out[0][480], 0.5, 1e-4);
  CHECK_NEAR(out[0][960], 0.25, 1e-4);
  CHECK_NEAR(out[0][1440], 0.125, 1e-4);
  CHECK_NEAR(out[0][608], 0.0, 1e-7);
  CHECK_NEAR(out[0][1216], 0.0, 1e-7);
}

TEST(feedback_delay_below_one_quantum_is_clamped_in_a_cycle) {
  // Spec: a DelayNode in a cycle delays by at least one render quantum.
  Rig r;
  std::vector<float> imp(128, 0.f);
  imp[0] = 1;
  uint32_t buf = r.makeBuffer({imp});
  uint32_t s = r.create(kBufferSource);
  r.buffer(s, buf);
  uint32_t g = r.create(kGain);
  uint32_t d = r.create(kDelay, 2, 0, 0, 1.0);
  r.setValue(r.slot(d, 0), 10.0 / 48000, 0);
  uint32_t fb = r.create(kGain);
  r.setValue(r.slot(fb, 0), 0.5, 0);
  r.connect(s, g);
  r.connect(g, d);
  r.connect(d, fb);
  r.connect(fb, g);
  r.connect(g, 1);
  r.start(s);
  auto out = r.render(4);
  CHECK_NEAR(out[0][10], 0.0, 1e-7);
  CHECK_NEAR(out[0][128], 0.5, 1e-6);
  CHECK_NEAR(out[0][256], 0.25, 1e-6);
}

TEST(cycle_without_delay_is_muted) {
  Rig r;
  uint32_t c = r.create(kConstantSource);
  uint32_t g1 = r.create(kGain), g2 = r.create(kGain);
  r.setValue(r.slot(g2, 0), 0.5, 0);
  r.connect(c, g1);
  r.connect(g1, g2);
  r.connect(g2, g1);
  r.connect(g1, 1);
  r.start(c);
  auto out = r.render(6);
  double peak = 0;
  for (float v : out[0]) peak = std::max(peak, double(std::fabs(v)));
  CHECK(peak == 0);
  // Breaking the cycle brings the signal back.
  r.disconnect(g2);
  out = r.render(2);
  CHECK_NEAR(out[0][200], 1.0, 1e-6);
}

// ---- silence ------------------------------------------------------------------------------------

TEST(hrtf_delay_and_convolver_go_silent_after_their_tails) {
  for (int kind = 0; kind < 3; ++kind) {
    Rig r;
    uint32_t c = r.create(kConstantSource);
    r.stop(c, 0.01);
    uint32_t n = 0;
    if (kind == 0) {
      n = r.create(kPanner);
      r.prop(n, kPropPanningModel, 1);
      r.setValue(r.slot(n, 0), 1, 0);
    } else if (kind == 1) {
      n = r.create(kDelay, 2, 0, 0, 0.05);
      r.setValue(r.slot(n, 0), 0.02, 0);
    } else {
      n = r.create(kConvolver);
      std::vector<float> ir(2000, 0.f);
      ir[0] = 1;
      ir[1999] = 0.5f;
      r.prop(n, kPropNormalize, 0);
      r.buffer(n, r.makeBuffer({ir}));
    }
    r.connect(c, n);
    r.connect(n, 1);
    r.start(c);
    auto out = r.render(16);
    double peak = 0;
    for (float v : out[0]) peak = std::max(peak, double(std::fabs(v)));
    CHECK(peak > 0.1);
    r.render(375);  // ~1 s
    CHECK(r.graph().destination()->mixed().silent());
    CHECK(r.graph().nodeForTest(n)->outputs[0]->silent());
  }
}

// ---- panner ---------------------------------------------------------------------------------------

TEST(panner_corner_cases) {
  PannerNode p;
  p.setProp(kPropDistanceModel, 0);
  p.setProp(kPropRefDistance, 5);
  p.setProp(kPropMaxDistance, 5);
  p.setProp(kPropRolloffFactor, 0.25);
  CHECK_NEAR(p.distanceGain(1), 0.75, 1e-12);  // dRef == dMax: 1 - f
  CHECK_NEAR(p.distanceGain(9), 0.75, 1e-12);
  p.setProp(kPropRefDistance, 10);
  p.setProp(kPropMaxDistance, 2);  // swapped: dRef = 2, dMax = 10
  CHECK_NEAR(p.distanceGain(6), 1 - 0.25 * 4 / 8, 1e-12);
  double az = 99, el = 99;
  const float src[3] = {1, 0, 0}, lpos[3] = {0, 0, 0}, fwd[3] = {0, 1, 0}, up[3] = {0, 1, 0};
  PannerNode::azimuthElevation(src, lpos, fwd, up, az, el);
  CHECK(az == 0 && el == 0);
}

TEST(equalpower_with_automated_geometry_matches_per_sample_formula) {
  // A source sweeping across in front of the listener with a linear ramp (three.js style); the
  // interpolated matrix must stay close to the per-sample spec evaluation.
  struct Case {
    double speed;  // m/s along x, passing 0.5 m in front of the listener
    double tol;
  } cases[] = {{4, 1e-5}, {40, 1e-5}};
  for (const Case& cs : cases) {
    const double dur = 2.0 / cs.speed;  // x: -1 -> 1
    Rig r;
    uint32_t c = r.create(kConstantSource);
    uint32_t pan = r.create(kPanner);
    r.connect(c, pan);
    r.connect(pan, 1);
    r.start(c);
    r.setValue(r.slot(pan, 0), -1, 0);
    r.setValue(r.slot(pan, 2), -0.5, 0);
    r.event(r.slot(pan, 0), ParamEvent::LinearRamp, dur, 1, 0, 0);
    int quanta = int(dur * 48000 / kQuantum) + 2;
    auto out = r.render(quanta);
    double worst = 0;
    int worstAt = 0;
    for (int i = 0; i < quanta * kQuantum; ++i) {
      double t = i / 48000.0;
      float x = static_cast<float>(t >= dur ? 1 : -1 + 2 * (t / dur));
      const float s[3] = {x, 0, -0.5f}, lp[3] = {0, 0, 0}, f[3] = {0, 0, -1}, u[3] = {0, 1, 0};
      double az, el;
      PannerNode::azimuthElevation(s, lp, f, u, az, el);
      PannerNode ref;
      double gain = ref.distanceGain(std::sqrt(double(x) * x + 0.25));
      double a = az < -90 ? -180 - az : (az > 90 ? 180 - az : az);
      double xx = (a + 90) / 180;
      double L = std::cos(xx * 3.14159265358979 / 2) * gain, R = std::sin(xx * 3.14159265358979 / 2) * gain;
      double err = std::max(std::fabs(out[0][size_t(i)] - L), std::fabs(out[1][size_t(i)] - R));
      if (err > worst) { worst = err; worstAt = i; }
    }
    std::printf("    equal-power interpolation, %g m/s at 0.5 m: worst error %.2e at sample %d\n", cs.speed, worst, worstAt);
    CHECK(worst < cs.tol);
  }
}

TEST(start_far_in_the_future_does_not_play) {
  Rig r;
  uint32_t c = r.create(kConstantSource);
  r.connect(c, 1);
  r.start(c, 1e300);
  auto out = r.render(2);
  CHECK(out[0][10] == 0);
  Rig r2;
  uint32_t c2 = r2.create(kConstantSource);
  r2.connect(c2, 1);
  r2.start(c2, 0);
  r2.stop(c2, 1e200);
  out = r2.render(2);
  CHECK(out[0][10] == 1);
}

// ---- resources ------------------------------------------------------------------------------------

TEST(periodic_wave_switch_to_builtin_does_not_leak) {
  // Run under LeakSanitizer (ASan build): the custom table must be owned and freed.
  Rig r;
  uint32_t o = r.create(kOscillator);
  for (int k = 0; k < 3; ++k) {
    r.raw({double(kPeriodicWave), double(o), 0, 3, 0, 0, 0, 0, 1, 0.5});
    r.prop(o, kPropOscType, 0);
    r.render(1);
  }
  r.release(o);
  r.render(2);
  CHECK(r.graph().nodeForTest(o) == nullptr);
}

TEST(long_delay_line_memory_is_lazy_beyond_stereo) {
  if (IWN_TEST_SANITIZED) {
    std::printf("    skipped: sanitizer shadow memory distorts RSS\n");
    return;
  }
  auto residentMb = [] {
    long pages = 0, resident = 0;
    if (FILE* f = std::fopen("/proc/self/statm", "r")) {
      if (std::fscanf(f, "%ld %ld", &pages, &resident) != 2) resident = 0;
      std::fclose(f);
    }
    return resident * 4096.0 / 1048576.0;
  };
  double before = residentMb();
  auto* d = new DelayNode(179, 48000);
  double grewMb = residentMb() - before;
  std::printf("    createDelay(179): max RSS +%.0f MB (2 resident channels = %.0f MB)\n", grewMb,
              2.0 * d->ringBytesForTest() / 1048576.0);
  CHECK(grewMb < 2.0 * d->ringBytesForTest() / 1048576.0 + 20);
  delete d;
}

TEST(wav_with_absurd_sample_rate_is_rejected_quickly) {
  std::vector<uint8_t> f;
  auto u32 = [&](uint32_t v) { for (int i = 0; i < 4; ++i) f.push_back(uint8_t(v >> (8 * i))); };
  auto u16 = [&](uint16_t v) { f.push_back(uint8_t(v)); f.push_back(uint8_t(v >> 8)); };
  f.insert(f.end(), {'R', 'I', 'F', 'F'});
  u32(36 + 2000);
  f.insert(f.end(), {'W', 'A', 'V', 'E', 'f', 'm', 't', ' '});
  u32(16);
  u16(1);
  u16(1);
  u32(1);  // 1 Hz
  u32(2);
  u16(2);
  u16(16);
  f.insert(f.end(), {'d', 'a', 't', 'a'});
  u32(2000);
  f.resize(f.size() + 2000, 0);
  auto t0 = std::chrono::steady_clock::now();
  DecodeOutcome o = decodeAudio(f.data(), f.size(), 48000);
  double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  CHECK(o.buffer == nullptr);
  CHECK(ms < 50);
  if (o.buffer) o.buffer->release();
}

// ---- events -----------------------------------------------------------------------------------------

TEST(ended_and_node_freed_survive_a_full_event_queue) {
  // 3000 released one-shots (6000 events) ending in the same quantum, while the main thread does not drain.
  Rig r;
  std::vector<float> one(64, 0.1f);
  uint32_t buf = r.makeBuffer({one});
  const int n = 3000;
  for (int i = 0; i < n; ++i) {
    uint32_t s = r.create(kBufferSource);
    r.buffer(s, buf);
    r.connect(s, 1);
    r.start(s);
    r.release(s);
  }
  r.commit();
  int ended = 0, freed = 0;
  for (int q = 0; q < 6; ++q) {  // no draining: the 4096-slot queue fills
    r.graph().applyPending();
    r.graph().render();
  }
  for (int q = 0; q < 40; ++q) {
    GraphEvent e;
    while (r.graph().events.pop(e)) {
      ended += e.type == kEvEnded;
      freed += e.type == kEvNodeFreed;
    }
    r.graph().applyPending();
    r.graph().render();
    r.graph().drainGarbage();
  }
  GraphEvent e;
  while (r.graph().events.pop(e)) {
    ended += e.type == kEvEnded;
    freed += e.type == kEvNodeFreed;
  }
  CHECK(ended == n);
  CHECK(freed == n);
}

// ---- paused output (AUD-2) --------------------------------------------------------------------

namespace {
class StillOutput final : public AudioOutput {
 public:
  bool open(int, float, int, RenderCallback*) override { return true; }
  float sampleRate() const override { return 48000; }
  double baseLatency() const override { return 0.004; }
  double outputLatency() const override { return 0.012; }
  bool start() override { return true; }
  void pause() override {}
  void close() override {}
  uint64_t xruns() const override { return 0; }
  bool timestamp(int64_t&, int64_t&) const override { return false; }
};
}  // namespace

TEST(paused_output_still_answers_state_requests_and_bounds_the_queue) {
  // No render callback runs while paused: batches are applied on the main thread instead, so
  // close() resolves, queues do not grow, and currentTime stays put.
  setOutputPaused(kPauseHost, true);
  std::string err;
  Context* c = Context::createRealtime(0, 0, &err, std::unique_ptr<AudioOutput>(new StillOutput()));
  CHECK(c != nullptr);
  if (!c) {
    setOutputPaused(kPauseHost, false);
    return;
  }
  std::vector<OutEvent> ev;
  collectAllEvents(ev);
  for (int i = 0; i < 3000; ++i) {
    double w[] = {kParamEvent, 0, 1, 0.01 * (i % 7), 1, 0, 0, 0};
    c->submit(w, 8);
  }
  ev.clear();
  collectAllEvents(ev);
  CHECK(!c->hasPendingWork());  // nothing left queued natively
  double cl[] = {kContextState, 2, 42};
  c->submit(cl, 3);
  ev.clear();
  collectAllEvents(ev);
  bool closed = false;
  for (auto& e : ev) closed |= e.type == kEvState && e.ctx == c->id() && e.a == 2 && e.b == 42;
  CHECK(closed);
  CHECK(Graph::loadShared(&c->block()->shared[kSharedFrame]) == 0);
  CHECK(c->graph().listenerParam(0)->tl.eventCount() <= ParamTimeline::kMaxEvents);
  setOutputPaused(kPauseHost, false);
  destroyContext(c->id());
}

TEST(decodes_from_a_previous_page_are_dropped) {
  std::vector<uint8_t> wav;
  auto u32 = [&](uint32_t v) { for (int i = 0; i < 4; ++i) wav.push_back(uint8_t(v >> (8 * i))); };
  auto u16 = [&](uint16_t v) { wav.push_back(uint8_t(v)); wav.push_back(uint8_t(v >> 8)); };
  wav.insert(wav.end(), {'R', 'I', 'F', 'F'});
  u32(36 + 200);
  wav.insert(wav.end(), {'W', 'A', 'V', 'E', 'f', 'm', 't', ' '});
  u32(16);
  u16(1);
  u16(1);
  u32(48000);
  u32(96000);
  u16(2);
  u16(16);
  wav.insert(wav.end(), {'d', 'a', 't', 'a'});
  u32(200);
  wav.resize(wav.size() + 200, 1);
  auto bytes = std::make_shared<std::vector<uint8_t>>(wav);
  DecodeJob job;
  job.ctx = 999;
  job.requestId = 1;
  job.targetRate = 48000;
  job.data = bytes->data();
  job.size = bytes->size();
  job.keepAlive = bytes;
  submitDecode(job);
  beginDecodeGeneration();  // the page reloads before the decode is delivered
  std::vector<DecodeDone> done;
  for (int i = 0; i < 200 && pendingDecodes() > 0; ++i) {
    collectDecodes(done);
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
  }
  collectDecodes(done);
  CHECK(done.empty());
  CHECK(pendingDecodes() == 0);
}

TEST(panner_render_cost_with_three_style_automation) {
  // Host numbers only (PERF-AUDIO-1 is measured on device): 24 looping voices, every panner and
  // listener param ramped each 72 Hz frame, equal-power vs HRTF, constant vs ramping.
  for (int model = 0; model < 2; ++model) {
    for (int ramping = 0; ramping < 2; ++ramping) {
      Rig r;
      std::vector<float> noise(48000);
      std::mt19937 rng(1);
      std::uniform_real_distribution<float> u(-0.5f, 0.5f);
      for (auto& v : noise) v = u(rng);
      uint32_t buf = r.makeBuffer({noise});
      std::vector<uint32_t> pans;
      for (int v = 0; v < 24; ++v) {
        uint32_t s = r.create(kBufferSource);
        r.buffer(s, buf);
        r.prop(s, kPropLoop, 1);
        uint32_t p = r.create(kPanner);
        r.prop(p, kPropPanningModel, model);
        uint32_t g = r.create(kGain);
        r.connect(s, g);
        r.connect(g, p);
        r.connect(p, 1);
        r.start(s);
        r.setValue(r.slot(p, 0), float(v % 5) - 2, 0);
        r.setValue(r.slot(p, 2), -1.f - v * 0.1f, 0);
        pans.push_back(p);
      }
      r.render(4);
      double secs = 0;
      int quanta = 0;
      for (int f = 0; f < 72; ++f) {
        if (ramping) {
          double t = r.graph().time(), end = t + 1.0 / 72;
          for (size_t v = 0; v < pans.size(); ++v) {
            r.event(r.slot(pans[v], 0), ParamEvent::LinearRamp, end, std::sin(f * 0.1 + v), 0, t);
            r.event(r.slot(pans[v], 1), ParamEvent::LinearRamp, end, 0.1 * std::cos(f * 0.1), 0, t);
            r.event(r.slot(pans[v], 2), ParamEvent::LinearRamp, end, -1.0 - v * 0.1, 0, t);
            for (int k = 3; k < 6; ++k) r.event(r.slot(pans[v], k), ParamEvent::LinearRamp, end, k == 3 ? 1 : 0, 0, t);
          }
          for (int k = 0; k < 9; ++k)
            r.event(k, ParamEvent::LinearRamp, end, k == 5 ? -1 : (k == 7 ? 1 : 0.01 * std::sin(f * 0.05 + k)), 0, t);
        }
        r.commit();
        auto t0 = std::chrono::steady_clock::now();
        for (int q = 0; q < 5; ++q) {
          r.graph().applyPending();
          r.graph().render();
        }
        secs += std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
        quanta += 5;
        GraphEvent e;
        while (r.graph().events.pop(e)) {
        }
        r.graph().drainGarbage();
      }
      std::printf("    24 voices %s %s: %.0f us per quantum (host)\n", model ? "HRTF" : "equal-power",
                  ramping ? "ramping" : "constant", secs / quanta * 1e6);
    }
  }
}

// ---- HRTF delay, convolver levels and cost, finished one-shots -------------------------------------

TEST(hrtf_interaural_delay_is_right_at_768_khz) {
  // Source hard left: the right ear's delay is (a/c)(1 + pi/2) = 0.656 ms = 504 samples at 768 kHz
  // (the delay line used to be 256 samples and wrapped).
  const float sr = 768000;
  Rig r(sr);
  std::vector<float> imp(256, 0.f);
  imp[0] = 1.f;
  uint32_t buf = r.makeBuffer({imp});
  uint32_t src = r.create(kBufferSource);
  r.buffer(src, buf);
  uint32_t p = r.create(kPanner, 2, 1);
  r.prop(p, kPropPanningModel, 1);
  r.setValue(r.slot(p, 0), -1, 0);  // positionX = -1: left
  r.connect(src, p);
  r.connect(p, 1);
  const int startFrame = 4 * kQuantum;  // after the delay smoothing of the first quantum
  r.start(src, startFrame / double(sr));
  auto out = r.render(16);
  auto peak = [&](const std::vector<float>& ch) {
    size_t best = 0;
    for (size_t i = 0; i < ch.size(); ++i)
      if (std::fabs(ch[i]) > std::fabs(ch[best])) best = i;
    return double(best) - startFrame;
  };
  double expected = PannerNode::hrtfMaxDelaySecForTest() * sr;
  std::printf("    768 kHz: left-ear peak +%.0f, right-ear peak +%.0f (expected +%.1f)\n", peak(out[0]), peak(out[1]),
              expected);
  CHECK_NEAR(peak(out[0]), 0, 1);
  CHECK_NEAR(peak(out[1]), expected, 2);
}

TEST(convolver_long_ir_matches_direct_convolution_across_levels) {
  // 40000-frame stereo IR: all three partition levels (128 / 1024 / 8192). Stereo input, so both
  // output channels and both delay lines are exercised; the reference is direct convolution.
  std::mt19937 rng(7);
  std::uniform_real_distribution<float> u(-1, 1);
  const size_t irLen = 40000, xLen = 30000, n = 60000;
  std::vector<float> irL(irLen), irR(irLen), x(xLen);
  for (size_t i = 0; i < irLen; ++i) {
    float env = std::exp(-float(i) / 15000.f);
    irL[i] = u(rng) * 0.02f * env;
    irR[i] = u(rng) * 0.02f * env;
  }
  for (auto& v : x) v = u(rng);
  Rig r;
  uint32_t irb = r.makeBuffer({irL, irR});
  uint32_t xb = r.makeBuffer({x});
  uint32_t s = r.create(kBufferSource);
  r.buffer(s, xb);
  uint32_t c = r.create(kConvolver, 2, 1);
  r.prop(c, kPropNormalize, 0);
  r.buffer(c, irb);
  r.connect(s, c);
  r.connect(c, 1);
  r.start(s);
  auto out = r.render(int(n / kQuantum) + 1);
  double maxErr = 0, peak = 0;
  for (size_t k = 0; k < n; k += 7) {  // every 7th sample (direct convolution is O(n * irLen))
    double refL = 0, refR = 0;
    size_t lo = k >= xLen ? k - xLen + 1 : 0;
    for (size_t j = lo; j <= k && j < irLen; ++j) {
      refL += double(irL[j]) * x[k - j];
      refR += double(irR[j]) * x[k - j];
    }
    peak = std::max(peak, std::fabs(refL));
    maxErr = std::max(maxErr, std::fabs(refL - out[0][k]));
    maxErr = std::max(maxErr, std::fabs(refR - out[1][k]));
  }
  std::printf("    40000-frame IR: max error %.2g (peak %.2f)\n", maxErr, peak);
  CHECK(maxErr < 1e-4);
}

TEST(convolver_cost_grows_slowly_with_ir_length) {
  // Per-quantum cost for 1, 2 and 4 s stereo IRs with stereo input (measured: 149 / 299 / 582 us per
  // quantum with uniform 128-frame partitions on the Linux build host).
  double us[3] = {0, 0, 0};
  for (int k = 0; k < 3; ++k) {
    size_t irLen = size_t(48000) << k;
    std::vector<float> irL(irLen), irR(irLen);
    std::mt19937 rng(3);
    std::uniform_real_distribution<float> u(-1, 1);
    for (size_t i = 0; i < irLen; ++i) {
      irL[i] = u(rng) * 0.01f;
      irR[i] = u(rng) * 0.01f;
    }
    Rig r;
    uint32_t irb = r.makeBuffer({irL, irR});
    uint32_t osc = r.create(kOscillator);
    uint32_t c = r.create(kConvolver, 2, 1);
    r.prop(c, kPropNormalize, 0);
    r.buffer(c, irb);
    r.connect(osc, c);
    r.connect(c, 1);
    r.start(osc);
    r.render(64);  // warm up
    const int quanta = 2048;
    double worst = 0, total = 0;
    for (int qn = 0; qn < quanta; ++qn) {
      auto t0 = std::chrono::steady_clock::now();
      r.render(1);
      double d = std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - t0).count();
      total += d;
      worst = std::max(worst, d);
    }
    us[k] = total / quanta;
    std::printf("    %d s stereo IR: %.0f us per quantum, worst %.0f us (host, incl. oscillator and test rig)\n", 1 << k,
                us[k], worst);
  }
  if (!IWN_TEST_SANITIZED) {
    CHECK(us[2] < 120);
    CHECK(us[2] < 2.5 * us[0]);
  }
}

TEST(finished_one_shots_still_referenced_cost_nothing) {
  // Device probe finding: 4,200 one-shots (start + stop 10 ms later) connected to one panner,
  // ended but not yet collected by JS GC, were still pulled and mixed every quantum and doubled
  // the render load until the next GC. Finished sources can never play again (start() is
  // once-only), so they must not cost render time while their JS objects are alive.
  Rig r;
  std::vector<float> tone(4800);
  for (size_t i = 0; i < tone.size(); ++i) tone[i] = 0.1f * std::sin(i * 0.05f);
  uint32_t buf = r.makeBuffer({tone});
  uint32_t p = r.create(kPanner);
  r.connect(p, 1);
  auto measure = [&](int quanta) {
    auto t0 = std::chrono::steady_clock::now();
    r.render(quanta);
    return std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - t0).count() / quanta;
  };
  r.render(8);
  double base = measure(256);
  std::vector<uint32_t> shots;
  for (int k = 0; k < 3500; ++k) {  // the Rig holds 4096 nodes
    uint32_t s = r.create(kBufferSource);
    r.buffer(s, buf);
    r.connect(s, p);
    r.start(s, r.graph().time());
    r.stop(s, r.graph().time() + 0.01);
    shots.push_back(s);
    if (k % 100 == 99) r.render(1);  // the app's frames: 100 one-shots each
  }
  r.render(16);  // all ended
  size_t ended = 0;
  for (const auto& e : r.events)
    if (e.type == kEvEnded) ++ended;
  CHECK(ended == shots.size());
  double withFinished = measure(256);
  std::printf("    panner alone %.1f us per quantum; with 3500 finished, referenced one-shots %.1f us\n", base,
              withFinished);
  if (!IWN_TEST_SANITIZED) CHECK(withFinished < base + 15);
  // Disconnecting / releasing them later is still fine.
  for (size_t k = 0; k < shots.size(); ++k) {
    r.disconnect(shots[k]);
    r.release(shots[k]);
    if (k % 100 == 99) r.render(1);
  }
  r.render(4);
  size_t freed = 0;
  for (const auto& e : r.events)
    if (e.type == kEvNodeFreed) ++freed;
  CHECK(freed == shots.size());
}

// ---- hostile batches, loop offsets, buffer allocation cap ------------------------------------------

TEST(hostile_batches_cannot_reuse_live_ids_or_slots_or_misroute_kernels) {
  // __iwn.audio.submit is visible to app JS: a CreateNode on a live id (or on live param slots)
  // left stale Param pointers behind (use-after-free on the next ParamEvent), and a PeriodicWave
  // aimed at a convolver was static_cast to a ConvolverKernel. Both batches must be rejected.
  Rig r;
  uint32_t g = r.create(kGain);
  uint32_t conv = r.create(kConvolver);
  r.connect(g, 1);
  r.render(2);
  // CreateNode reusing live id `g` on fresh slots.
  r.raw({double(kCreateNode), double(g), double(kGain), 1000, 2, 0, 0, 0, 0, 0, 0});
  CHECK(!r.tryCommit());
  // CreateNode on a free id but on the live gain's param slot.
  r.raw({double(kCreateNode), 3000, double(kGain), double(r.slot(g, 0)), 2, 0, 0, 0, 0, 0, 0});
  CHECK(!r.tryCommit());
  // Two creates of the same new id in one batch.
  r.raw({double(kCreateNode), 3001, double(kGain), 1100, 2, 0, 0, 0, 0, 0, 0});
  r.raw({double(kCreateNode), 3001, double(kGain), 1200, 2, 0, 0, 0, 0, 0, 0});
  CHECK(!r.tryCommit());
  // PeriodicWave aimed at a convolver, and at a node that does not exist.
  r.raw({double(kPeriodicWave), double(conv), 0, 2, 0, 1, 0, 0});
  CHECK(!r.tryCommit());
  r.raw({double(kPeriodicWave), 3002, 0, 2, 0, 1, 0, 0});
  CHECK(!r.tryCommit());
  // The legitimate patterns still pass: an oscillator created and given a wave in one batch.
  uint32_t osc = r.create(kOscillator);
  r.raw({double(kPeriodicWave), double(osc), 0, 2, 0, 1, 0, 0});
  r.connect(osc, g);
  r.start(osc, 0);
  CHECK(r.tryCommit());
  r.setValue(r.slot(g, 0), 0.5, 0);
  auto out = r.render(4);
  float peak = 0;
  for (float v : out[0]) peak = std::max(peak, std::fabs(v));
  CHECK(peak > 0.1f);
  // Release, then the id and slots are free again once the render side collected the node.
  r.disconnect(osc);
  r.release(osc);
  r.render(4);
}

TEST(loop_with_offset_at_or_past_loop_end_plays_to_the_buffer_end) {
  // Web Audio 1.1 playback algorithm: looping forwards from an offset >= loopEnd starts at
  // loopEnd (the offset is clamped to it) and never enters the loop, so playback runs to the end of the buffer and ends.
  Rig r;
  std::vector<float> ones(800, 1.f);
  uint32_t buf = r.makeBuffer({ones});
  const double sr = r.sampleRate();
  uint32_t s = r.create(kBufferSource, 2);
  r.buffer(s, buf);
  r.prop(s, kPropLoop, 1);
  r.prop(s, kPropLoopStart, 0);
  r.prop(s, kPropLoopEnd, 400 / sr);
  r.connect(s, 1);
  r.start(s, 0, 600 / sr);
  // A normal loop next to it (offset inside the loop) keeps playing.
  std::vector<float> half(800, 0.5f);
  uint32_t buf2 = r.makeBuffer({half});
  uint32_t l = r.create(kBufferSource, 2);
  r.buffer(l, buf2);
  r.prop(l, kPropLoop, 1);
  r.prop(l, kPropLoopStart, 0);
  r.prop(l, kPropLoopEnd, 400 / sr);
  r.connect(l, 1);
  r.start(l, 0, 100 / sr);
  auto out = r.render(40);
  CHECK_NEAR(out[0][0], 1.5, 1e-6);
  CHECK_NEAR(out[0][399], 1.5, 1e-6);   // offset clamped to loopEnd (400): buffer frame 799
  CHECK_NEAR(out[0][400], 0.5, 1e-6);   // the first source ended at the buffer end
  CHECK_NEAR(out[0][5000], 0.5, 1e-6);  // the looping one is still going
  size_t ended = 0;
  for (const auto& e : r.events)
    if (e.type == kEvEnded && e.a == s) ++ended;
  CHECK(ended == 1);
}

TEST(buffer_allocation_is_capped_and_zeroed) {
  // createBuffer allowed 32 channels x 1e9 frames and zero-filled every page: on a headset that is
  // a low-memory kill rather than an exception. Same 1 GiB ceiling as decode and offline render.
  CHECK(BufferData::create(32, 1000000000, 48000) == nullptr);
  CHECK(BufferData::create(1, (BufferData::kMaxBytes / sizeof(float)) + 16, 48000) == nullptr);
  BufferData* b = BufferData::create(3, 1000, 48000);
  CHECK(b != nullptr);
  if (b) {
    for (int c = 0; c < 3; ++c) {
      CHECK(reinterpret_cast<uintptr_t>(b->channel(c)) % 64 == 0);
      bool zero = true;
      for (int i = 0; i < 1000; ++i) zero = zero && b->channel(c)[i] == 0.f;
      CHECK(zero);
    }
    b->release();
  }
}
