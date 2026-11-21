// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
//
// Golden tests against the Web Audio API formulas (AUD-3..AUD-7 checks; HL-3).
#include <cfloat>
#include <random>

#include "test.h"

using namespace iwn::audio;
using namespace iwn::audio::proto;
using iwntest::Rig;

namespace {
constexpr double kPi = 3.14159265358979323846;
std::vector<float> ramp(size_t n, float scale = 0.001f) {
  std::vector<float> v(n);
  for (size_t i = 0; i < n; ++i) v[i] = float(i) * scale;
  return v;
}
}  // namespace

// ---- channel mixing (AUD-4) ----------------------------------------------------------------------

TEST(mix_mono_to_stereo_and_back) {
  float m[kQuantum], l[kQuantum] = {}, r[kQuantum] = {}, mono[kQuantum] = {};
  for (int i = 0; i < kQuantum; ++i) m[i] = float(i);
  const float* in1[] = {m};
  float* out2[] = {l, r};
  mixChannels(in1, 1, out2, 2, ChannelInterpretation::Speakers);
  CHECK_NEAR(l[5], 5, 0);
  CHECK_NEAR(r[5], 5, 0);
  r[5] = 15;
  const float* in2[] = {l, r};
  float* out1[] = {mono};
  mixChannels(in2, 2, out1, 1, ChannelInterpretation::Speakers);
  CHECK_NEAR(mono[5], 10, 1e-6);  // 0.5 (L + R)
}

TEST(mix_51_to_stereo_and_discrete) {
  float ch[6][kQuantum];
  for (int c = 0; c < 6; ++c)
    for (int i = 0; i < kQuantum; ++i) ch[c][i] = float(c + 1);
  const float* in[] = {ch[0], ch[1], ch[2], ch[3], ch[4], ch[5]};
  float l[kQuantum] = {}, r[kQuantum] = {};
  float* out[] = {l, r};
  mixChannels(in, 6, out, 2, ChannelInterpretation::Speakers);
  const double h = std::sqrt(0.5);
  CHECK_NEAR(l[0], 1 + h * (3 + 5), 1e-5);  // L + sqrt(.5)(C + SL)
  CHECK_NEAR(r[0], 2 + h * (3 + 6), 1e-5);  // R + sqrt(.5)(C + SR)
  float d0[kQuantum] = {}, d1[kQuantum] = {};
  float* outd[] = {d0, d1};
  mixChannels(in, 6, outd, 2, ChannelInterpretation::Discrete);
  CHECK_NEAR(d0[0], 1, 0);
  CHECK_NEAR(d1[0], 2, 0);
  float q[4][kQuantum] = {};
  float* outq[] = {q[0], q[1], q[2], q[3]};
  const float* in1[] = {ch[0]};
  mixChannels(in1, 1, outq, 4, ChannelInterpretation::Speakers);
  CHECK_NEAR(q[0][0], 1, 0);
  CHECK_NEAR(q[1][0], 1, 0);
  CHECK_NEAR(q[2][0], 0, 0);
}

// ---- AudioParam automation (AUD-5) ----------------------------------------------------------------

namespace {
ParamEvent ev(ParamEvent::Type t, double time, float v, double tc = 0, double ins = 0) {
  ParamEvent e;
  e.type = t;
  e.time = time;
  e.value = v;
  e.timeConstant = tc;
  e.insertTime = ins;
  return e;
}
}  // namespace

TEST(param_set_and_linear_ramp) {
  ParamTimeline tl(1, -FLT_MAX, FLT_MAX);
  CHECK_NEAR(tl.valueAt(0.5), 1, 0);
  tl.insert(ev(ParamEvent::SetValue, 0, 0), nullptr);
  tl.insert(ev(ParamEvent::LinearRamp, 1, 1), nullptr);
  CHECK_NEAR(tl.valueAt(0.25), 0.25, 1e-6);
  CHECK_NEAR(tl.valueAt(1), 1, 0);
  CHECK_NEAR(tl.valueAt(5), 1, 0);
  tl.insert(ev(ParamEvent::SetValue, 2, 0.5f), nullptr);
  CHECK_NEAR(tl.valueAt(1.999), 1, 0);
  CHECK_NEAR(tl.valueAt(2), 0.5, 0);
}

TEST(param_exponential_ramp_and_hold_rules) {
  ParamTimeline a(1, -FLT_MAX, FLT_MAX);
  a.insert(ev(ParamEvent::SetValue, 0, 1), nullptr);
  a.insert(ev(ParamEvent::ExpRamp, 1, 100), nullptr);
  CHECK_NEAR(a.valueAt(0.5), 10, 1e-4);  // V0 (V1/V0)^0.5
  ParamTimeline b(1, -FLT_MAX, FLT_MAX);
  b.insert(ev(ParamEvent::SetValue, 0, 0), nullptr);
  b.insert(ev(ParamEvent::ExpRamp, 1, 1), nullptr);
  CHECK_NEAR(b.valueAt(0.5), 0, 0);  // V0 == 0: hold until the end time
  CHECK_NEAR(b.valueAt(1), 1, 0);
  ParamTimeline c(1, -FLT_MAX, FLT_MAX);
  c.insert(ev(ParamEvent::SetValue, 0, -1), nullptr);
  c.insert(ev(ParamEvent::ExpRamp, 1, 1), nullptr);
  CHECK_NEAR(c.valueAt(0.5), -1, 0);  // opposite signs: hold
}

TEST(param_set_target) {
  ParamTimeline tl(1, -FLT_MAX, FLT_MAX);
  tl.insert(ev(ParamEvent::SetValue, 0, 1), nullptr);
  tl.insert(ev(ParamEvent::SetTarget, 0.5, 0, 0.1), nullptr);
  CHECK_NEAR(tl.valueAt(0.4), 1, 0);
  CHECK_NEAR(tl.valueAt(0.6), std::exp(-1.0), 1e-6);
  CHECK_NEAR(tl.valueAt(1.5), std::exp(-10.0), 1e-7);
  // A ramp inserted later replaces the setTarget from its insertion time (spec rule).
  tl.insert(ev(ParamEvent::LinearRamp, 2, 1, 0, 1.0), nullptr);
  double v0 = std::exp(-5.0);
  CHECK_NEAR(tl.valueAt(1.0), v0, 1e-6);
  CHECK_NEAR(tl.valueAt(1.5), v0 + (1 - v0) * 0.5, 1e-6);
}

TEST(param_value_curve) {
  ParamTimeline tl(0, -FLT_MAX, FLT_MAX);
  ParamEvent e = ev(ParamEvent::SetCurve, 0, 0);
  e.duration = 2;
  e.curve = BufferData::create(1, 3, 48000);
  e.curve->channel(0)[0] = 0;
  e.curve->channel(0)[1] = 1;
  e.curve->channel(0)[2] = 0;
  tl.insert(e, nullptr);
  CHECK_NEAR(tl.valueAt(0.5), 0.5, 1e-6);
  CHECK_NEAR(tl.valueAt(1.0), 1, 1e-6);
  CHECK_NEAR(tl.valueAt(1.5), 0.5, 1e-6);
  CHECK_NEAR(tl.valueAt(3.0), 0, 0);
  // A ramp after the curve starts from the curve's last value at its end time.
  tl.insert(ev(ParamEvent::LinearRamp, 4, 2), nullptr);
  CHECK_NEAR(tl.valueAt(3.0), 1, 1e-6);
}

TEST(param_cancel_scheduled_and_hold) {
  ParamTimeline a(0, -FLT_MAX, FLT_MAX);
  a.insert(ev(ParamEvent::SetValue, 0, 1), nullptr);
  a.insert(ev(ParamEvent::LinearRamp, 1, 2), nullptr);
  a.cancelScheduledValues(0.5, nullptr);
  CHECK_NEAR(a.valueAt(0.75), 1, 0);
  ParamTimeline b(0, -FLT_MAX, FLT_MAX);
  b.insert(ev(ParamEvent::SetValue, 0, 0), nullptr);
  b.insert(ev(ParamEvent::LinearRamp, 1, 1), nullptr);
  b.cancelAndHoldAtTime(0.5, nullptr);
  CHECK_NEAR(b.valueAt(0.25), 0.25, 1e-6);
  CHECK_NEAR(b.valueAt(0.5), 0.5, 1e-6);
  CHECK_NEAR(b.valueAt(0.75), 0.5, 1e-6);
  CHECK_NEAR(b.valueAt(9), 0.5, 1e-6);
  ParamTimeline c(1, -FLT_MAX, FLT_MAX);
  c.insert(ev(ParamEvent::SetTarget, 0, 0, 1), nullptr);
  c.cancelAndHoldAtTime(1, nullptr);
  CHECK_NEAR(c.valueAt(2), std::exp(-1.0), 1e-6);
}

TEST(param_compute_matches_value_at_and_prunes) {
  ParamTimeline tl(0, -FLT_MAX, FLT_MAX);
  tl.insert(ev(ParamEvent::SetValue, 0, 0), nullptr);
  tl.insert(ev(ParamEvent::LinearRamp, 0.01, 1), nullptr);
  tl.insert(ev(ParamEvent::ExpRamp, 0.02, 0.01f), nullptr);
  float out[kQuantum];
  double dt = 1.0 / 48000;
  for (int q = 0; q < 10; ++q) {
    double t0 = q * kQuantum * dt;
    tl.compute(t0, dt, kQuantum, out);
    for (int i = 0; i < kQuantum; i += 17) {
      ParamTimeline ref(0, -FLT_MAX, FLT_MAX);
      ref.insert(ev(ParamEvent::SetValue, 0, 0), nullptr);
      ref.insert(ev(ParamEvent::LinearRamp, 0.01, 1), nullptr);
      ref.insert(ev(ParamEvent::ExpRamp, 0.02, 0.01f), nullptr);
      CHECK_NEAR(out[i], ref.valueAt(t0 + i * dt), 1e-5);
    }
    tl.prune(t0, nullptr);
  }
  CHECK(tl.eventCount() <= 2);
}

// ---- nodes (AUD-6, AUD-7) ---------------------------------------------------------------------------

TEST(gain_and_constant_source_upmix) {
  Rig r;
  uint32_t src = r.create(kConstantSource);
  uint32_t g = r.create(kGain);
  r.setValue(r.slot(src, 0), 0.5, 0);
  r.setValue(r.slot(g, 0), 2, 0);
  r.connect(src, g);
  r.connect(g, 1);
  r.start(src);
  auto out = r.render(2);
  CHECK_NEAR(out[0][10], 1.0, 1e-6);
  CHECK_NEAR(out[1][200], 1.0, 1e-6);
  CHECK_NEAR(r.paramValue(r.slot(g, 0)), 2, 0);
}

TEST(buffer_source_plays_offsets_and_ends) {
  Rig r;
  uint32_t buf = r.makeBuffer({ramp(1000)});
  uint32_t s = r.create(kBufferSource);
  r.buffer(s, buf);
  r.connect(s, 1);
  r.start(s, 200.0 / 48000, 100.0 / 48000);  // start at frame 200, offset 100 frames
  auto out = r.render(10);
  CHECK_NEAR(out[0][199], 0, 0);
  CHECK_NEAR(out[0][200], 0.100, 1e-6);
  CHECK_NEAR(out[0][300], 0.200, 1e-6);
  CHECK_NEAR(out[0][200 + 899], 0.999, 1e-6);
  CHECK_NEAR(out[0][200 + 900], 0, 0);
  CHECK(r.events.size() == 1 && r.events[0].type == kEvEnded && r.events[0].a == s);
}

TEST(buffer_source_duration_stop_and_ended_once) {
  Rig r;
  uint32_t buf = r.makeBuffer({std::vector<float>(48000, 1.f)});
  uint32_t a = r.create(kBufferSource);
  r.buffer(a, buf);
  r.connect(a, 1);
  r.start(a, 0, 0, 300.0 / 48000);
  uint32_t b = r.create(kBufferSource);
  r.buffer(b, buf);
  r.start(b, 0);
  r.stop(b, 500.0 / 48000);
  uint32_t g = r.create(kGain);
  r.connect(b, g);
  auto out = r.render(8);
  CHECK_NEAR(out[0][299], 1, 0);
  CHECK_NEAR(out[0][300], 0, 0);
  int endedA = 0, endedB = 0;
  for (auto& e : r.events) {
    endedA += e.type == kEvEnded && e.a == a;
    endedB += e.type == kEvEnded && e.a == b;
  }
  CHECK(endedA == 1);
  CHECK(endedB == 1);
}

TEST(buffer_source_loop_and_rate) {
  Rig r;
  uint32_t buf = r.makeBuffer({ramp(100, 0.01f)});
  uint32_t s = r.create(kBufferSource);
  r.buffer(s, buf);
  r.prop(s, kPropLoop, 1);
  r.connect(s, 1);
  r.start(s);
  auto out = r.render(3);
  CHECK_NEAR(out[0][0], 0, 0);
  CHECK_NEAR(out[0][150], 0.5, 1e-6);  // wrapped
  CHECK_NEAR(out[0][383], 0.83, 1e-6);
  Rig r2;
  uint32_t b2 = r2.makeBuffer({ramp(1000)});
  uint32_t s2 = r2.create(kBufferSource);
  r2.buffer(s2, b2);
  r2.setValue(r2.slot(s2, 0), 0.5, 0);  // playbackRate
  r2.connect(s2, 1);
  r2.start(s2);
  auto o2 = r2.render(2);
  CHECK_NEAR(o2[0][11], 0.0055, 1e-6);  // buffer[5.5], linear interpolation
  // detune +1200 cents doubles the rate.
  Rig r3;
  uint32_t b3 = r3.makeBuffer({ramp(1000)});
  uint32_t s3 = r3.create(kBufferSource);
  r3.buffer(s3, b3);
  r3.setValue(r3.slot(s3, 1), 1200, 0);
  r3.connect(s3, 1);
  r3.start(s3);
  auto o3 = r3.render(1);
  CHECK_NEAR(o3[0][10], 0.020, 1e-6);
}

TEST(buffer_source_resamples_other_rates) {
  Rig r;
  uint32_t buf = r.makeBuffer({ramp(1000)}, 24000);
  uint32_t s = r.create(kBufferSource);
  r.buffer(s, buf);
  r.connect(s, 1);
  r.start(s);
  auto out = r.render(1);
  CHECK_NEAR(out[0][21], 0.0105, 1e-6);  // half speed in buffer frames
}

TEST(stereo_panner_formula) {
  Rig r;
  uint32_t src = r.create(kConstantSource);
  uint32_t p = r.create(kStereoPanner, 2, 1);
  r.setValue(r.slot(p, 0), 0.5, 0);
  r.connect(src, p);
  r.connect(p, 1);
  r.start(src);
  auto out = r.render(1);
  double x = (0.5 + 1) / 2;
  CHECK_NEAR(out[0][3], std::cos(x * kPi / 2), 1e-6);
  CHECK_NEAR(out[1][3], std::sin(x * kPi / 2), 1e-6);
}

TEST(panner_azimuth_distance_cone) {
  double az, el;
  float lpos[3] = {0, 0, 0}, fwd[3] = {0, 0, -1}, up[3] = {0, 1, 0};
  float right[3] = {1, 0, 0}, left[3] = {-1, 0, 0}, behind[3] = {0, 0, 1}, above[3] = {0, 1, -1};
  PannerNode::azimuthElevation(right, lpos, fwd, up, az, el);
  CHECK_NEAR(az, 90, 1e-9);
  PannerNode::azimuthElevation(left, lpos, fwd, up, az, el);
  CHECK_NEAR(az, -90, 1e-9);
  PannerNode::azimuthElevation(behind, lpos, fwd, up, az, el);
  CHECK_NEAR(std::fabs(az), 180, 1e-9);
  PannerNode::azimuthElevation(above, lpos, fwd, up, az, el);
  CHECK_NEAR(el, 45, 1e-6);
  PannerNode n;
  n.setProp(kPropDistanceModel, 0);
  n.setProp(kPropMaxDistance, 10);
  CHECK_NEAR(n.distanceGain(5.5), 0.5, 1e-12);
  n.setProp(kPropDistanceModel, 2);
  CHECK_NEAR(n.distanceGain(4), 0.25, 1e-12);
  n.setProp(kPropDistanceModel, 1);
  CHECK_NEAR(n.distanceGain(2), 0.5, 1e-12);
  CHECK_NEAR(n.distanceGain(0.5), 1, 1e-12);
  n.setProp(kPropConeInnerAngle, 60);
  n.setProp(kPropConeOuterAngle, 120);
  n.setProp(kPropConeOuterGain, 0.25);
  float src[3] = {0, 0, 0}, ori[3] = {0, 0, -1};
  float inside[3] = {0, 0, -1}, edge[3] = {1, 0, -1}, outside[3] = {1, 0, 0};
  CHECK_NEAR(n.coneGain(src, ori, inside), 1, 1e-12);
  CHECK_NEAR(n.coneGain(src, ori, outside), 0.25, 1e-12);
  // 45 degrees: halfway between 30 and 60 -> (1-x) + 0.25 x, x = 0.5.
  CHECK_NEAR(n.coneGain(src, ori, edge), 0.625, 1e-9);
}

TEST(panner_equalpower_render) {
  Rig r;
  uint32_t src = r.create(kConstantSource);
  uint32_t p = r.create(kPanner, 2, 1);
  r.setValue(r.slot(p, 2), -2, 0);  // positionZ = -2 (in front, distance 2)
  r.connect(src, p);
  r.connect(p, 1);
  r.start(src);
  auto out = r.render(1);
  double g = std::cos(kPi / 4) * 0.5;  // centre, inverse distance 1 / (1 + (2 - 1))
  CHECK_NEAR(out[0][7], g, 1e-6);
  CHECK_NEAR(out[1][7], g, 1e-6);
  Rig r2;
  uint32_t s2 = r2.create(kConstantSource);
  uint32_t p2 = r2.create(kPanner, 2, 1);
  r2.setValue(r2.slot(p2, 0), 1, 0);  // to the right, distance 1
  r2.connect(s2, p2);
  r2.connect(p2, 1);
  r2.start(s2);
  auto o2 = r2.render(1);
  CHECK_NEAR(o2[0][7], 0, 1e-6);
  CHECK_NEAR(o2[1][7], 1, 1e-6);
}

TEST(panner_hrtf_lateralises) {
  Rig r;
  uint32_t buf = r.makeBuffer({std::vector<float>(4800, 0.f)});
  (void)buf;
  uint32_t osc = r.create(kOscillator);
  r.setValue(r.slot(osc, 0), 2000, 0);
  uint32_t p = r.create(kPanner, 2, 1);
  r.prop(p, kPropPanningModel, 1);
  r.setValue(r.slot(p, 0), 1, 0);  // right
  r.connect(osc, p);
  r.connect(p, 1);
  r.start(osc);
  auto out = r.render(40);
  double el = 0, er = 0;
  for (size_t i = 1280; i < out[0].size(); ++i) {
    el += out[0][i] * out[0][i];
    er += out[1][i] * out[1][i];
  }
  CHECK(er > el * 2);  // head shadow attenuates the far (left) ear at 2 kHz
  CHECK(er > 0);
}

TEST(biquad_frequency_response_matches_spec) {
  float f[3] = {1000, 100, 30000};
  float mag[3], ph[3];
  BiquadFilterNode::frequencyResponse(kLowpass, 48000, 1000, 0, 0, 0, f, mag, ph, 3);
  CHECK_NEAR(mag[0], 1.0, 1e-4);  // |H(f0)| = 10^(Q/20) with Q in dB
  CHECK_NEAR(mag[1], 1.0, 0.02);
  CHECK(std::isnan(mag[2]));      // above Nyquist
  BiquadFilterNode::frequencyResponse(kPeaking, 48000, 1000, 0, 1, 6, f, mag, ph, 1);
  CHECK_NEAR(mag[0], std::pow(10.0, 6.0 / 20), 1e-4);
  BiquadFilterNode::frequencyResponse(kNotch, 48000, 1000, 0, 1, 0, f, mag, ph, 1);
  CHECK_NEAR(mag[0], 0, 1e-4);
  BiquadFilterNode::frequencyResponse(kLowpass, 48000, 500, 1200, 0, 0, f, mag, ph, 1);  // detune
  CHECK_NEAR(mag[0], 1.0, 1e-4);
}

TEST(biquad_filters_signal_like_its_response) {
  Rig r;
  uint32_t osc = r.create(kOscillator);
  r.setValue(r.slot(osc, 0), 3000, 0);
  uint32_t bq = r.create(kBiquad);
  r.setValue(r.slot(bq, 0), 1000, 0);
  r.connect(osc, bq);
  r.connect(bq, 1);
  r.start(osc);
  auto out = r.render(200);
  double peak = 0;
  for (size_t i = out[0].size() / 2; i < out[0].size(); ++i) peak = std::max(peak, double(std::fabs(out[0][i])));
  float f = 3000, mag, ph;
  BiquadFilterNode::frequencyResponse(kLowpass, 48000, 1000, 0, 1, 0, &f, &mag, &ph, 1);
  CHECK_NEAR(peak, mag, 0.01);
}

TEST(delay_node_delays) {
  Rig r;
  std::vector<float> imp(256, 0.f);
  imp[0] = 1;
  uint32_t buf = r.makeBuffer({imp});
  uint32_t s = r.create(kBufferSource);
  r.buffer(s, buf);
  uint32_t d = r.create(kDelay, 2, 0, 0, 1.0);
  r.setValue(r.slot(d, 0), 10.0 / 48000, 0);
  r.connect(s, d);
  r.connect(d, 1);
  r.start(s);
  auto out = r.render(2);
  CHECK_NEAR(out[0][9], 0, 1e-7);
  CHECK_NEAR(out[0][10], 1, 1e-6);
  CHECK_NEAR(out[0][11], 0, 1e-6);
}

TEST(delay_feedback_cycle_renders) {
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
  auto out = r.render(40);
  double later = 0;
  for (size_t i = 960; i < out[0].size(); ++i) later += std::fabs(out[0][i]);
  CHECK(later > 0.1);  // echoes keep coming
}

TEST(convolver_matches_direct_convolution) {
  std::mt19937 rng(42);
  std::uniform_real_distribution<float> u(-1, 1);
  std::vector<float> ir(1000), x(2000);
  for (auto& v : ir) v = u(rng) * 0.05f;
  for (auto& v : x) v = u(rng);
  Rig r;
  uint32_t irb = r.makeBuffer({ir});
  uint32_t xb = r.makeBuffer({x});
  uint32_t s = r.create(kBufferSource);
  r.buffer(s, xb);
  uint32_t c = r.create(kConvolver, 2, 1);
  r.prop(c, kPropNormalize, 0);
  r.buffer(c, irb);
  r.connect(s, c);
  r.connect(c, 1);
  r.start(s);
  auto out = r.render(30);
  double maxErr = 0;
  for (size_t n = 0; n < 3000; ++n) {
    double ref = 0;
    for (size_t k = 0; k < ir.size() && k <= n; ++k)
      if (n - k < x.size()) ref += double(ir[k]) * x[n - k];
    maxErr = std::max(maxErr, std::fabs(ref - out[0][n]));
    maxErr = std::max(maxErr, std::fabs(ref - out[1][n]));
  }
  CHECK(maxErr < 1e-4);
}

TEST(convolver_normalization_scale) {
  // Spec calculateNormalizationScale for a single unit impulse: power = sqrt(1 / len).
  Rig r;
  std::vector<float> ir(100, 0.f);
  ir[0] = 1;
  uint32_t irb = r.makeBuffer({ir});
  std::vector<float> imp(128, 0.f);
  imp[0] = 1;
  uint32_t xb = r.makeBuffer({imp});
  uint32_t s = r.create(kBufferSource);
  r.buffer(s, xb);
  uint32_t c = r.create(kConvolver, 2, 1);
  r.buffer(c, irb);
  r.connect(s, c);
  r.connect(c, 1);
  r.start(s);
  auto out = r.render(2);
  double power = std::sqrt(1.0 / 100);
  double scale = 1 / power * 0.00125 * 44100.0 / 48000.0;
  CHECK_NEAR(out[0][0], scale, 1e-5);
}

TEST(oscillator_sine_matches_formula) {
  Rig r;
  uint32_t o = r.create(kOscillator);
  r.setValue(r.slot(o, 0), 1000, 0);
  r.connect(o, 1);
  r.start(o);
  auto out = r.render(4);
  double maxErr = 0;
  for (size_t i = 0; i < out[0].size(); ++i)
    maxErr = std::max(maxErr, std::fabs(out[0][i] - std::sin(2 * kPi * 1000 * i / 48000.0)));
  CHECK(maxErr < 1e-4);
}

TEST(oscillator_square_is_bandlimited_and_normalised) {
  Rig r;
  uint32_t o = r.create(kOscillator);
  r.prop(o, kPropOscType, 1);
  r.setValue(r.slot(o, 0), 440, 0);
  r.connect(o, 1);
  r.start(o);
  auto out = r.render(20);
  double peak = 0;
  for (float v : out[0]) peak = std::max(peak, double(std::fabs(v)));
  std::printf("    square peak %.5f\n", peak);
  CHECK(peak <= 1.0001 && peak > 0.9);
}

TEST(analyser_time_and_frequency) {
  Rig r;
  uint32_t o = r.create(kOscillator);
  double bin = 64;
  r.setValue(r.slot(o, 0), bin * 48000 / 2048, 0);
  uint32_t a = r.create(kAnalyser);
  r.connect(o, a);
  r.start(o);
  r.render(20);
  auto* an = static_cast<AnalyserNode*>(r.graph().mainNode(a));
  CHECK(an != nullptr);
  std::vector<float> db(1024);
  an->frequency(db.data(), 1024, 2048, 0, 1);
  int best = 0;
  for (int k = 1; k < 1024; ++k)
    if (db[size_t(k)] > db[size_t(best)]) best = k;
  CHECK(best == 64);
  std::vector<float> td(2048);
  an->timeDomain(td.data(), 2048);
  double peak = 0;
  for (float v : td) peak = std::max(peak, double(std::fabs(v)));
  CHECK_NEAR(peak, 1, 1e-3);
}

TEST(splitter_merger_swap_channels) {
  Rig r;
  uint32_t buf = r.makeBuffer({std::vector<float>(256, 0.25f), std::vector<float>(256, 0.75f)});
  uint32_t s = r.create(kBufferSource);
  r.buffer(s, buf);
  uint32_t sp = r.create(kSplitter, 2, 2, 1, 2);
  uint32_t mg = r.create(kMerger, 1, 2, 0, 2);
  r.connect(s, sp);
  r.connect(sp, mg, 0, 1);
  r.connect(sp, mg, 1, 0);
  r.connect(mg, 1);
  r.start(s);
  auto out = r.render(1);
  CHECK_NEAR(out[0][5], 0.75, 1e-7);
  CHECK_NEAR(out[1][5], 0.25, 1e-7);
}

TEST(param_audio_rate_input) {
  Rig r;
  uint32_t src = r.create(kConstantSource);
  uint32_t mod = r.create(kConstantSource);
  uint32_t g = r.create(kGain);
  r.setValue(r.slot(g, 0), 0, 0);
  r.setValue(r.slot(mod, 0), 0.25, 0);
  r.connect(src, g);
  r.connectParam(mod, r.slot(g, 0));
  r.connect(g, 1);
  r.start(src);
  r.start(mod);
  auto out = r.render(1);
  CHECK_NEAR(out[0][50], 0.25, 1e-7);
}

TEST(disconnect_forms) {
  Rig r;
  uint32_t src = r.create(kConstantSource);
  uint32_t g1 = r.create(kGain);
  uint32_t g2 = r.create(kGain);
  r.connect(src, g1);
  r.connect(src, g2);
  r.connect(g1, 1);
  r.connect(g2, 1);
  r.start(src);
  auto a = r.render(1);
  CHECK_NEAR(a[0][0], 2, 1e-7);  // fan-in sums
  r.disconnect(src, -1, int(g2), -1);
  auto b = r.render(1);
  CHECK_NEAR(b[0][0], 1, 1e-7);
  r.disconnect(src);
  auto c = r.render(1);
  CHECK_NEAR(c[0][0], 0, 0);
}

TEST(released_nodes_are_collected) {
  Rig r;
  uint32_t buf = r.makeBuffer({std::vector<float>(64, 1.f)});
  size_t base = r.graph().activeNodeCount();
  for (int i = 0; i < 50; ++i) {
    uint32_t s = r.create(kBufferSource);
    uint32_t g = r.create(kGain);
    r.buffer(s, buf);
    r.connect(s, g);
    r.connect(g, 1);
    r.start(s);
    r.release(s);
    r.release(g);
  }
  r.render(1);
  r.render(2);
  CHECK(r.graph().activeNodeCount() == base);
}

TEST(two_gain_changes_in_one_batch_land_together) {
  // AUD-10: both changes become audible in the same quantum.
  Rig r;
  uint32_t src = r.create(kConstantSource);
  uint32_t gl = r.create(kGain);
  uint32_t gr = r.create(kGain);
  uint32_t mg = r.create(kMerger, 1, 2, 0, 2);
  r.connect(src, gl);
  r.connect(src, gr);
  r.connect(gl, mg, 0, 0);
  r.connect(gr, mg, 0, 1);
  r.connect(mg, 1);
  r.start(src);
  r.render(1);
  for (int k = 0; k < 20; ++k) {
    double v = 0.1 * k;
    r.setValue(r.slot(gl, 0), v, r.graph().time());
    r.setValue(r.slot(gr, 0), v, r.graph().time());
    auto out = r.render(1);
    for (int i = 0; i < kQuantum; ++i) CHECK(out[0][size_t(i)] == out[1][size_t(i)]);
  }
}

TEST(malformed_batches_are_rejected) {
  Rig r;
  Batch b;
  b.words = {double(kConnect), 1, 2};  // truncated
  CHECK(!r.graph().prepare(b));
  Batch c;
  c.words = {double(kCreateNode), 0, double(kGain), 9, 2, 0, 0, 0, 0, 0, 0};  // id 0 reserved
  CHECK(!r.graph().prepare(c));
  Batch d;
  d.words = {999};
  CHECK(!r.graph().prepare(d));
}

TEST(buffer_source_grows_bus_for_multichannel_buffers) {
  // 5.1 buffer with only the centre channel set: speakers down-mix gives L = R = sqrt(0.5).
  std::vector<std::vector<float>> ch(6, std::vector<float>(256, 0.f));
  ch[2].assign(256, 1.f);
  for (int later = 0; later < 2; ++later) {
    Rig r;
    uint32_t buf = r.makeBuffer(ch);
    uint32_t s = r.create(kBufferSource);
    r.connect(s, 1);
    if (later) r.render(1);  // the node is live on the render side before the buffer arrives
    r.buffer(s, buf);
    r.start(s, r.graph().time());
    auto out = r.render(1);
    CHECK_NEAR(out[0][5], std::sqrt(0.5), 1e-6);
    CHECK_NEAR(out[1][5], std::sqrt(0.5), 1e-6);
  }
}
