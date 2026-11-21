// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
//
// AudioNode / AudioParam rendering. Formulas follow the Web Audio API specification sections
// cited at each node.
#include "nodes.h"

#include <algorithm>
#include <cfloat>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <new>

#include "fft.h"
#include "graph.h"

namespace iwn::audio {

namespace {
constexpr double kPi = 3.14159265358979323846;

// Seconds -> frame index, saturating (huge start/stop times must not overflow int64).
inline int64_t toFrame(double seconds, double sr) {
  double f = std::ceil(seconds * sr - 1e-6);
  if (!(f < 9.0e18)) return INT64_MAX;
  if (f < -9.0e18) return INT64_MIN / 2;
  return static_cast<int64_t>(f);
}
}

// ---- Param ----------------------------------------------------------------------------------

const float* Param::process(Graph& g) {
  if (computedQuantum == g.quantum()) return values;
  computedQuantum = g.quantum();
  double t0 = g.time();
  double dt = 1.0 / g.sampleRate();
  if (aRate) {
    constant = tl.compute(t0, dt, kQuantum, values);
  } else {
    float v = tl.valueAt(t0);
    for (float& x : values) x = v;
    constant = true;
  }
  if (!inputs.empty() && inputBus_) {
    AudioBus& bus = *inputBus_;
    bus.setChannels(1);
    bus.zero();
    for (const OutputRef& r : inputs) {
      r.node->pull(g);
      bus.sumFrom(*r.node->outputs[r.output], ChannelInterpretation::Speakers);
    }
    if (!bus.silent()) {
      const float* in = bus.channel(0);
      if (aRate) {
        for (int i = 0; i < kQuantum; ++i) values[i] += in[i];
        constant = false;
      } else {
        float a = in[0];
        for (float& x : values) x += a;
      }
    }
  }
  float mn = tl.minValue(), mx = tl.maxValue();
  if (constant) {
    float v = values[0];
    if (std::isnan(v)) v = tl.defaultValue();
    v = clampf(v, mn, mx);
    for (float& x : values) x = v;
  } else {
    const float d = tl.defaultValue();
    for (int i = 0; i < kQuantum; ++i) {
      float x = values[i];
      x = x != x ? d : x;  // NaN -> default (spec)
      x = x < mn ? mn : x;
      values[i] = x > mx ? mx : x;
    }
  }
  tl.prune(t0, &g);
  g.publishParam(slot, values[0]);
  return values;
}

const float* Param::processIdle(Graph& g) {
  if (!inputs.empty() || computedQuantum == g.quantum()) return process(g);
  computedQuantum = g.quantum();
  double t0 = g.time();
  float v = tl.valueAt(t0);
  if (std::isnan(v)) v = tl.defaultValue();
  v = clampf(v, tl.minValue(), tl.maxValue());
  values[0] = v;
  constant = true;
  tl.prune(t0, &g);
  g.publishParam(slot, v);
  return values;
}

// ---- Node -----------------------------------------------------------------------------------

Node::Node(proto::NodeType type, int numInputs, int numOutputs, int outCapacity, int inCapacity)
    : type_(type) {
  inputs.resize(static_cast<size_t>(numInputs));
  if (numInputs > 0) inputHints.reset(new GrowHint[static_cast<size_t>(numInputs)]);
  for (int i = 0; i < numInputs; ++i) {
    inputs[static_cast<size_t>(i)].reserve(4);
    inputHints[static_cast<size_t>(i)].publish(inputs[static_cast<size_t>(i)]);
  }
  downstream.reserve(4);
  downstreamHint.publish(downstream);
  for (int i = 0; i < numInputs; ++i) inputBuses.emplace_back(new AudioBus(inCapacity));
  for (int i = 0; i < numOutputs; ++i) outputs.emplace_back(new AudioBus(outCapacity));
  params.reserve(proto::paramCount(type));
}

Node::~Node() = default;

void Node::setProp(int prop, double v) {
  switch (prop) {
    case proto::kPropChannelCount:
      channelCount = std::max(1, std::min(static_cast<int>(v), kBusChannels));
      break;
    case proto::kPropChannelCountMode:
      mode = static_cast<ChannelCountMode>(static_cast<int>(v));
      break;
    case proto::kPropChannelInterpretation:
      interp = static_cast<ChannelInterpretation>(static_cast<int>(v));
      break;
    default:
      break;
  }
}

bool Node::canBeCollected() const {
  for (const auto& in : inputs)
    if (!in.empty()) return false;
  return true;
}

int Node::computeInputChannels(int input) const {
  int maxCh = 0;
  for (const OutputRef& r : inputs[static_cast<size_t>(input)])
    maxCh = std::max(maxCh, r.node->outputs[static_cast<size_t>(r.output)]->channels());
  if (maxCh == 0) maxCh = 1;
  int n = maxCh;
  if (mode == ChannelCountMode::ClampedMax) n = std::min(maxCh, channelCount);
  else if (mode == ChannelCountMode::Explicit) n = channelCount;
  return std::max(1, std::min(n, inputBuses[static_cast<size_t>(input)]->capacity()));
}

bool Node::inputsSilent() const {
  for (const auto& b : inputBuses)
    if (!b->silent()) return false;
  return true;
}

void Node::mixInputs(Graph& g) {
  for (size_t i = 0; i < inputs.size(); ++i) {
    for (const OutputRef& r : inputs[i]) r.node->pull(g);
    AudioBus& bus = *inputBuses[i];
    bus.setChannels(computeInputChannels(static_cast<int>(i)));
    bus.zero();
    for (const OutputRef& r : inputs[i]) bus.sumFrom(*r.node->outputs[static_cast<size_t>(r.output)], interp);
  }
}

void Node::muteOutputs() {
  for (auto& o : outputs) o->zero();
}

void Node::pull(Graph& g) {
  const uint64_t q = g.quantum();
  if (processedQuantum_ == q) return;
  if (visiting_) {
    // Re-entered while its inputs are being pulled: a cycle with no DelayNode in it (cycles
    // through a DelayNode never re-enter, see below). Spec: such cycles are muted.
    g.muteCycle(this);
    return;
  }
  if (inCycle) {
    // DelayNode in a cycle: its output depends only on the delay line, so it is ready before its
    // inputs are; the input is written once the whole graph rendered (Graph::render).
    processedQuantum_ = q;
    produceFromLine(g);
    g.deferLineWrite(this);
    return;
  }
  visiting_ = true;
  g.pushPull(this);
  mixInputs(g);
  process(g);
  g.popPull();
  visiting_ = false;
  processedQuantum_ = q;
  if (mutedQuantum == q) muteOutputs();
}

// ---- Destination ----------------------------------------------------------------------------

DestinationNode::DestinationNode(int channels) : Node(proto::kDestination, 1, 0, 1, channels) {
  channelCount = channels;
  mode = ChannelCountMode::Explicit;
}

void DestinationNode::process(Graph&) {}

// ---- Gain (spec: GainNode) --------------------------------------------------------------------

GainNode::GainNode() : Node(proto::kGain, 1, 1) {
  params.emplace_back(new Param(1.f, -FLT_MAX, FLT_MAX, true));
}

void GainNode::process(Graph& g) {
  const AudioBus& in = *inputBuses[0];
  AudioBus& out = *outputs[0];
  const float* gain = params[0]->process(g);
  out.setChannels(in.channels());
  out.zero();
  if (in.silent()) return;
  bool k = params[0]->isConstant();
  if (k && gain[0] == 0.f) return;
  for (int c = 0; c < in.channels(); ++c) {
    const float* s = in.channel(c);
    float* d = out.channel(c);
    if (k) {
      float gv = gain[0];
      for (int i = 0; i < kQuantum; ++i) d[i] = s[i] * gv;
    } else {
      for (int i = 0; i < kQuantum; ++i) d[i] = s[i] * gain[i];
    }
  }
  out.setSilent(false);
}

// ---- Scheduled sources (spec: AudioScheduledSourceNode) ----------------------------------------

void ScheduledSource::start(double when, double offset, double duration) {
  started_ = true;
  startTime_ = when;
  offset_ = offset;
  duration_ = duration;
}

void ScheduledSource::stop(double when) { stopTime_ = when; }

bool ScheduledSource::canBeCollected() const { return (!started_ || ended_) && !endedPending_; }

void ScheduledSource::finish(Graph& g) {
  if (ended_) return;
  ended_ = true;
  playing_ = false;
  endedPending_ = !g.postEnded(id);
}

bool ScheduledSource::activeRange(Graph& g, int& begin, int& end) {
  if (!started_ || ended_) return false;
  double sr = g.sampleRate();
  int64_t qs = static_cast<int64_t>(g.frame());
  int64_t qe = qs + kQuantum;
  int64_t sF = toFrame(startTime_, sr);
  int64_t eF = toFrame(stopTime_, sr);
  if (eF <= qs || eF <= sF) {
    if (eF <= qe) {
      finish(g);
      return false;
    }
  }
  if (sF >= qe) return false;
  int64_t b = std::max(sF, qs), e = std::min(eF, qe);
  if (e <= b) {
    finish(g);
    return false;
  }
  begin = static_cast<int>(b - qs);
  end = static_cast<int>(e - qs);
  playing_ = true;
  return true;
}

// ---- AudioBufferSourceNode (spec: "Playback of AudioBuffer Contents") ---------------------------

BufferSourceNode::BufferSourceNode() : ScheduledSource(proto::kBufferSource, 2) {
  // playbackRate and detune are k-rate and the rate cannot be changed.
  params.emplace_back(new Param(1.f, -FLT_MAX, FLT_MAX, false, true));
  params.emplace_back(new Param(0.f, -FLT_MAX, FLT_MAX, false, true));
}

BufferSourceNode::~BufferSourceNode() {
  if (buffer_) buffer_->release();
}

BufferData* BufferSourceNode::setBuffer(BufferData* b) {
  BufferData* old = buffer_;
  buffer_ = b;
  return old;
}

bool BufferSourceNode::canBeCollected() const {
  return ScheduledSource::canBeCollected() || (started_ && !buffer_ && released);
}

void BufferSourceNode::setProp(int prop, double v) {
  switch (prop) {
    case proto::kPropLoop: loop_ = v != 0; break;
    case proto::kPropLoopStart: loopStart_ = v; break;
    case proto::kPropLoopEnd: loopEnd_ = v; break;
    default: Node::setProp(prop, v);
  }
}

void BufferSourceNode::process(Graph& g) {
  AudioBus& out = *outputs[0];
  if (ended_) {  // finished sources cost nothing until they are collected
    if (endedPending_) endedPending_ = !g.postEnded(id);
    out.zero();
    out.setChannels(1);
    return;
  }
  const float* rate = params[0]->process(g);
  const float* det = params[1]->process(g);
  int nch = buffer_ ? std::min(buffer_->channels(), out.capacity()) : 1;
  out.setChannels(nch);
  out.zero();
  int b = 0, e = 0;
  if (!activeRange(g, b, e)) {
    if (ended_) out.setChannels(1);
    return;
  }
  double sr = g.sampleRate();
  int64_t qe = static_cast<int64_t>(g.frame()) + kQuantum;
  bool stopsHere = toFrame(stopTime_, sr) <= qe;
  if (!buffer_) {
    if (stopsHere) finish(g);
    return;
  }
  const double bsr = buffer_->sampleRate();
  const double len = static_cast<double>(buffer_->length());
  const double computedRate = static_cast<double>(rate[0]) * std::pow(2.0, det[0] / 1200.0);
  const double step = computedRate * bsr / sr;
  // Loop region (spec: actualLoopStart/End).
  bool looping = loop_;
  double ls = 0, le = len;
  if (looping && loopStart_ >= 0 && loopEnd_ > 0 && loopStart_ < loopEnd_) {
    ls = loopStart_ * bsr;
    le = std::min(loopEnd_ * bsr, len);
    if (ls >= le) { ls = 0; le = len; }
  }
  if (!positioned_) {
    double off = std::max(0.0, offset_) * bsr;
    if (off > len) off = len;
    // Spec playback algorithm: forwards from an offset at or past loopEnd, playback starts at
    // loopEnd and the loop is never entered (it plays to the end of the buffer).
    if (looping && step >= 0 && off >= le) off = le;
    playhead_ = off;
    startFrame_ = off;
    if (step < 0 && off == 0) playhead_ = len - 1;  // backwards playback from the end
    enteredLoop_ = step < 0 || (off < le && off >= ls);
    positioned_ = true;
  }
  const double durFrames = duration_ >= 0 ? duration_ * bsr : -1;
  const int64_t lenI = static_cast<int64_t>(buffer_->length());
  bool done = false;
  for (int i = b; i < e; ++i) {
    if (durFrames >= 0 && bufferTimePlayed_ >= durFrames) { done = true; break; }
    if (looping && !enteredLoop_) {
      if (startFrame_ < le ? playhead_ >= ls : playhead_ < le) enteredLoop_ = true;
    }
    const bool inLoop = looping && enteredLoop_;
    if (inLoop && le > ls) {  // wrap before reading, as the spec's algorithm does
      double span = le - ls;
      if (step >= 0 && playhead_ >= le) playhead_ = ls + std::fmod(playhead_ - ls, span);
      else if (step < 0 && playhead_ < ls) playhead_ = le - std::fmod(ls - playhead_, span);
    }
    if (!inLoop && (playhead_ >= len || playhead_ < 0)) { done = true; break; }
    double ph = playhead_;
    int64_t k = static_cast<int64_t>(std::floor(ph));
    double frac = ph - static_cast<double>(k);
    int64_t k1 = k + 1;
    if (inLoop && static_cast<double>(k1) >= le) k1 = static_cast<int64_t>(ls);
    for (int c = 0; c < nch; ++c) {
      const float* src = buffer_->channel(c);
      float s0 = (k >= 0 && k < lenI) ? src[k] : 0.f;
      float s1 = (k1 >= 0 && k1 < lenI) ? src[k1] : 0.f;
      out.channel(c)[i] = static_cast<float>(s0 + (s1 - s0) * frac);
    }
    playhead_ += step;
    bufferTimePlayed_ += std::fabs(step);
  }
  out.setSilent(false);
  if (done || stopsHere) finish(g);
}

// ---- ConstantSourceNode -------------------------------------------------------------------------

ConstantSourceNode::ConstantSourceNode() : ScheduledSource(proto::kConstantSource, 1) {
  params.emplace_back(new Param(1.f, -FLT_MAX, FLT_MAX, true));
}

void ConstantSourceNode::process(Graph& g) {
  AudioBus& out = *outputs[0];
  if (ended_) {
    if (endedPending_) endedPending_ = !g.postEnded(id);
    out.zero();
    out.setChannels(1);
    return;
  }
  const float* off = params[0]->process(g);
  out.setChannels(1);
  out.zero();
  int b, e;
  if (!activeRange(g, b, e)) return;
  float* d = out.channel(0);
  for (int i = b; i < e; ++i) d[i] = off[i];
  out.setSilent(false);
  double sr = g.sampleRate();
  if (toFrame(stopTime_, sr) <= static_cast<int64_t>(g.frame()) + kQuantum) finish(g);
}

// ---- OscillatorNode / PeriodicWave (spec: "PeriodicWave", "Waveform Generation") -------------------

WaveTable* WaveTable::build(const float* real, const float* imag, int n, bool normalize) {
  auto* w = new WaveTable();
  RealFFT fft(kSize);
  std::vector<std::complex<float>> spec(kSize / 2 + 1);
  double peak = 0;
  for (int r = kRanges - 1; r >= 0; --r) {
    int limit = std::min({1 << r, n - 1, kSize / 2 - 1});
    std::fill(spec.begin(), spec.end(), std::complex<float>(0, 0));
    for (int k = 1; k <= limit; ++k) {
      float a = real ? real[k] : 0.f;
      float b = imag ? imag[k] : 0.f;
      // a cos + b sin = Re{(a - jb) e^{j theta}}; the inverse real FFT doubles bins 1..N/2-1.
      spec[static_cast<size_t>(k)] = std::complex<float>(a * 0.5f, -b * 0.5f);
    }
    w->tables[r].resize(kSize + 1);
    fft.inverse(spec.data(), w->tables[r].data());
    w->tables[r][kSize] = w->tables[r][0];  // guard sample for interpolation
    // Normalise by the largest peak of any band-limited version so no range exceeds 1.
    for (int i = 0; i < kSize; ++i) peak = std::max(peak, std::fabs(static_cast<double>(w->tables[r][i])));
  }
  if (normalize && peak > 0) {
    float s = static_cast<float>(1.0 / peak);
    for (auto& t : w->tables)
      for (float& x : t) x *= s;
  }
  return w;
}

WaveTable* WaveTable::builtin(int type) {
  // Built once per process; immutable and never freed.
  static WaveTable* tables[4] = {};
  static std::once_flag once[4];
  if (type < 0 || type > 3) type = 0;
  std::call_once(once[type], [type] {
    constexpr int n = kSize / 2;
    std::vector<float> b(n, 0.f);
    for (int k = 1; k < n; ++k) {
      double kk = k;
      switch (type) {
        case 0: b[static_cast<size_t>(k)] = k == 1 ? 1.f : 0.f; break;
        case 1: b[static_cast<size_t>(k)] = static_cast<float>(2.0 / (kk * kPi) * (1 - ((k & 1) ? -1 : 1))); break;
        case 2: b[static_cast<size_t>(k)] = static_cast<float>(((k & 1) ? 1.0 : -1.0) * 2.0 / (kk * kPi)); break;
        case 3: b[static_cast<size_t>(k)] = static_cast<float>(8.0 * std::sin(kk * kPi / 2) / ((kPi * kk) * (kPi * kk))); break;
      }
    }
    tables[type] = build(nullptr, b.data(), n, true);
  });
  return tables[type];
}

OscillatorNode::OscillatorNode() : ScheduledSource(proto::kOscillator, 1) {
  params.emplace_back(new Param(440.f, -FLT_MAX, FLT_MAX, true));   // frequency (range set by JS)
  params.emplace_back(new Param(0.f, -FLT_MAX, FLT_MAX, true));     // detune
  for (int t = 0; t < 4; ++t) builtins_[t] = WaveTable::builtin(t);
  wave_ = builtins_[0];
}

OscillatorNode::~OscillatorNode() { delete custom_; }

void OscillatorNode::setProp(int prop, double v) {
  if (prop == proto::kPropOscType) {
    int t = static_cast<int>(v);
    if (t >= 0 && t <= 3) wave_ = builtins_[t];
    else if (t == 4 && custom_) wave_ = custom_;  // the custom table itself arrives via setKernel
    return;
  }
  Node::setProp(prop, v);
}

Disposable* OscillatorNode::setKernel(Disposable* k) {
  // The custom table stays owned here when a built-in type is selected later (setProp), so
  // switching custom -> sine -> custom neither leaks nor frees on the render thread.
  WaveTable* old = custom_;
  custom_ = static_cast<WaveTable*>(k);
  wave_ = custom_ ? custom_ : builtins_[0];
  return old;
}

void OscillatorNode::process(Graph& g) {
  AudioBus& out = *outputs[0];
  if (ended_) {
    if (endedPending_) endedPending_ = !g.postEnded(id);
    out.zero();
    out.setChannels(1);
    return;
  }
  const float* freq = params[0]->process(g);
  const float* det = params[1]->process(g);
  out.setChannels(1);
  out.zero();
  int b, e;
  if (!activeRange(g, b, e)) return;
  double sr = g.sampleRate();
  double nyquist = sr / 2;
  float* d = out.channel(0);
  bool k = params[0]->isConstant() && params[1]->isConstant();
  double f = 0;
  int range = 0;
  auto pick = [&](double hz) {
    double ah = std::fabs(hz);
    if (ah < 1e-9) return WaveTable::kRanges - 1;
    double maxPartials = nyquist / ah;
    if (maxPartials < 1) return -1;  // above Nyquist: silence
    int r = static_cast<int>(std::floor(std::log2(maxPartials)));
    return std::min(r, WaveTable::kRanges - 1);
  };
  if (k) {
    f = freq[0] * std::pow(2.0, det[0] / 1200.0);
    range = pick(f);
  }
  for (int i = b; i < e; ++i) {
    if (!k) {
      f = freq[i] * std::pow(2.0, det[i] / 1200.0);
      range = pick(f);
    }
    float v = 0.f;
    if (range >= 0 && std::isfinite(f)) {
      const float* t = wave_->tables[range].data();
      double pos = phase_ * WaveTable::kSize;
      int idx = static_cast<int>(pos);
      double frac = pos - idx;
      v = static_cast<float>(t[idx] + (t[idx + 1] - t[idx]) * frac);
    }
    d[i] = v;
    if (std::isfinite(f)) {
      phase_ += f / sr;
      phase_ -= std::floor(phase_);
    }
  }
  out.setSilent(false);
  if (toFrame(stopTime_, sr) <= static_cast<int64_t>(g.frame()) + kQuantum) finish(g);
}

// ---- StereoPannerNode (spec: "StereoPannerNode" panning algorithm) -------------------------------

StereoPannerNode::StereoPannerNode() : Node(proto::kStereoPanner, 1, 1, 2, 2) {
  channelCount = 2;
  mode = ChannelCountMode::ClampedMax;
  params.emplace_back(new Param(0.f, -1.f, 1.f, true));
}

void StereoPannerNode::process(Graph& g) {
  const AudioBus& in = *inputBuses[0];
  AudioBus& out = *outputs[0];
  const float* pan = params[0]->process(g);
  out.setChannels(2);
  out.zero();
  if (in.silent()) return;
  float* L = out.channel(0);
  float* R = out.channel(1);
  bool mono = in.channels() == 1;
  const float* inL = in.channel(0);
  const float* inR = mono ? inL : in.channel(1);
  for (int i = 0; i < kQuantum; ++i) {
    double p = pan[i];
    if (mono) {
      double x = (p + 1) / 2;
      L[i] = static_cast<float>(inL[i] * std::cos(x * kPi / 2));
      R[i] = static_cast<float>(inL[i] * std::sin(x * kPi / 2));
    } else if (p <= 0) {
      double x = p + 1;
      double gL = std::cos(x * kPi / 2), gR = std::sin(x * kPi / 2);
      L[i] = static_cast<float>(inL[i] + inR[i] * gL);
      R[i] = static_cast<float>(inR[i] * gR);
    } else {
      double x = p;
      double gL = std::cos(x * kPi / 2), gR = std::sin(x * kPi / 2);
      L[i] = static_cast<float>(inL[i] * gL);
      R[i] = static_cast<float>(inR[i] + inL[i] * gR);
    }
  }
  out.setSilent(false);
}

// ---- PannerNode (spec: "Spatialization/Panning", "Distance Effects", "Sound Cones") ---------------

PannerNode::PannerNode() : Node(proto::kPanner, 1, 1, 2, 2) {
  channelCount = 2;
  mode = ChannelCountMode::ClampedMax;
  for (int i = 0; i < 3; ++i) params.emplace_back(new Param(0.f, -FLT_MAX, FLT_MAX, true));
  params.emplace_back(new Param(1.f, -FLT_MAX, FLT_MAX, true));
  params.emplace_back(new Param(0.f, -FLT_MAX, FLT_MAX, true));
  params.emplace_back(new Param(0.f, -FLT_MAX, FLT_MAX, true));
  // HRTF delay line (kHrtfHist): allocated here, never on the render thread. Sized for the largest
  // interaural delay at the highest allowed sample rate: (a/c)(1 + pi/2) = 0.66 ms = 504 samples at
  // 768 kHz.
  hist_.assign(kHrtfHist, 0.f);
}

void PannerNode::setProp(int prop, double v) {
  switch (prop) {
    case proto::kPropPanningModel: panningModel_ = static_cast<int>(v); break;
    case proto::kPropDistanceModel: distanceModel_ = static_cast<int>(v); break;
    case proto::kPropRefDistance: refDistance_ = v; break;
    case proto::kPropMaxDistance: maxDistance_ = v; break;
    case proto::kPropRolloffFactor: rolloff_ = v; break;
    case proto::kPropConeInnerAngle: coneInner_ = v; break;
    case proto::kPropConeOuterAngle: coneOuter_ = v; break;
    case proto::kPropConeOuterGain: coneOuterGain_ = v; break;
    default: Node::setProp(prop, v);
  }
}

namespace {
struct V3 {
  double x, y, z;
};
V3 sub(V3 a, V3 b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
double dot(V3 a, V3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
V3 cross(V3 a, V3 b) { return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x}; }
double len(V3 a) { return std::sqrt(dot(a, a)); }
V3 norm(V3 a) {
  double l = len(a);
  return l > 0 ? V3{a.x / l, a.y / l, a.z / l} : V3{0, 0, 0};
}
V3 scale(V3 a, double s) { return {a.x * s, a.y * s, a.z * s}; }
V3 v3(const float* p) { return {p[0], p[1], p[2]}; }
}  // namespace

void PannerNode::azimuthElevation(const float srcP[3], const float lposP[3], const float lfwdP[3],
                                  const float lupP[3], double& azimuth, double& elevation) {
  V3 src = v3(srcP), lpos = v3(lposP), lfwd = v3(lfwdP), lup = v3(lupP);
  V3 sl = sub(src, lpos);
  if (sl.x == 0 && sl.y == 0 && sl.z == 0) {
    azimuth = 0;
    elevation = 0;
    return;
  }
  sl = norm(sl);
  V3 rawRight = cross(lfwd, lup);
  if (len(rawRight) == 0) {
    // Forward and up are parallel (or zero): no listener basis. Spec: azimuth = elevation = 0.
    azimuth = 0;
    elevation = 0;
    return;
  }
  V3 right = norm(rawRight);
  V3 fwd = norm(lfwd);
  V3 up = cross(right, fwd);
  double upProj = dot(sl, up);
  V3 proj = norm(sub(sl, scale(up, upProj)));
  double az = 180.0 / kPi * std::acos(std::max(-1.0, std::min(1.0, dot(proj, right))));
  double frontBack = dot(proj, fwd);
  if (frontBack < 0) az = 360 - az;
  if (az >= 0 && az <= 270) az = 90 - az;
  else az = 450 - az;
  double el = 90 - 180.0 / kPi * std::acos(std::max(-1.0, std::min(1.0, dot(sl, up))));
  if (el > 90) el = 180 - el;
  else if (el < -90) el = -180 - el;
  azimuth = az;
  elevation = el;
}

double PannerNode::distanceGain(double d) const {
  double ref = refDistance_, mx = maxDistance_, f = rolloff_;
  switch (distanceModel_) {
    case 0: {  // linear (spec: dRef = min(ref, max), dMax = max(ref, max); 1 - f when equal)
      f = std::max(0.0, std::min(1.0, f));
      double dRef = std::min(ref, mx), dMax = std::max(ref, mx);
      if (dMax == dRef) return 1.0 - f;
      double dd = std::max(std::min(d, dMax), dRef);
      return 1.0 - f * (dd - dRef) / (dMax - dRef);
    }
    case 2:  // exponential
      if (ref <= 0) return 0.0;
      return std::pow(std::max(d, ref) / ref, -f);
    default: {  // inverse
      double denom = ref + f * (std::max(d, ref) - ref);
      return denom > 0 ? ref / denom : (ref == 0 ? 0.0 : 1.0);
    }
  }
}

double PannerNode::coneGain(const float srcP[3], const float orientP[3], const float lposP[3]) const {
  V3 orient = v3(orientP);
  if ((orient.x == 0 && orient.y == 0 && orient.z == 0) || (coneInner_ == 360 && coneOuter_ == 360))
    return 1.0;
  V3 toListener = norm(sub(v3(lposP), v3(srcP)));
  V3 o = norm(orient);
  double angle = 180.0 / kPi * std::acos(std::max(-1.0, std::min(1.0, dot(toListener, o))));
  double absAngle = std::fabs(angle);
  double absInner = std::fabs(coneInner_) / 2;
  double absOuter = std::fabs(coneOuter_) / 2;
  if (absAngle <= absInner) return 1.0;
  if (absAngle >= absOuter) return coneOuterGain_;
  double x = (absAngle - absInner) / (absOuter - absInner);
  return (1 - x) + coneOuterGain_ * x;
}

void PannerNode::processHrtf(Graph& g, const float* in, int frames, double az, double el,
                             float gain) {
  // Spherical-head structural model (Brown & Duda 1998): per-ear interaural delay from the
  // angle to the ear axis and a one-pole/one-zero head-shadow filter. Elevation cues are not
  // modelled.
  constexpr double a = 0.0875;   // head radius (m)
  constexpr double c = 343.0;    // speed of sound (m/s)
  constexpr int kHist = kHrtfHist;
  static_assert(kHrtfMaxDelaySec * kMaxSampleRate + 2 < kHrtfHist, "HRTF delay line too short");
  double sr = g.sampleRate();
  double azr = az * kPi / 180.0, elr = el * kPi / 180.0;
  double lateral = std::sin(azr) * std::cos(elr);  // +1 = right
  double w0 = c / a;
  double K = 2 * sr;
  float* outs[2] = {outputs[0]->channel(0), outputs[0]->channel(1)};
  double target[2];
  for (int ear = 0; ear < 2; ++ear) {
    double cosTheta = ear == 1 ? lateral : -lateral;  // angle between source and the ear axis
    double theta = std::acos(std::max(-1.0, std::min(1.0, cosTheta)));
    constexpr double alphaMin = 0.1, thetaMin = 150.0 * kPi / 180.0;
    double alpha = (1 + alphaMin / 2) + (1 - alphaMin / 2) * std::cos(theta / thetaMin * kPi);
    double den = 2 * w0 + K;
    Ear& E = ears_[ear];
    E.b0 = static_cast<float>((2 * w0 + alpha * K) / den);
    E.b1 = static_cast<float>((2 * w0 - alpha * K) / den);
    E.a1 = static_cast<float>((2 * w0 - K) / den);
    double delaySec = theta < kPi / 2 ? (a / c) * (1 - std::cos(theta)) : (a / c) * (1 + theta - kPi / 2);
    target[ear] = delaySec * sr;
  }
  for (int i = 0; i < frames; ++i) {
    hist_[static_cast<size_t>(histPos_)] = in ? in[i] : 0.f;
    for (int ear = 0; ear < 2; ++ear) {
      Ear& E = ears_[ear];
      double d = E.delay + (target[ear] - E.delay) * (i + 1) / frames;  // smooth delay changes
      double rp = histPos_ - d;
      while (rp < 0) rp += kHist;
      int i0 = static_cast<int>(rp);
      double fr = rp - i0;
      float s0 = hist_[static_cast<size_t>(i0 % kHist)];
      float s1 = hist_[static_cast<size_t>((i0 + 1) % kHist)];
      float x = static_cast<float>(s0 + (s1 - s0) * fr);
      float y = E.b0 * x + E.b1 * E.x1 - E.a1 * E.y1;
      E.x1 = x;
      E.y1 = y;
      outs[ear][i] = y * gain;
    }
    histPos_ = (histPos_ + 1) % kHist;
  }
  ears_[0].delay = target[0];
  ears_[1].delay = target[1];
}

void PannerNode::process(Graph& g) {
  const AudioBus& in = *inputBuses[0];
  AudioBus& out = *outputs[0];
  if (in.silent() && (panningModel_ != 1 || !hrtfActive_)) {
    // Nothing to pan (a voice that ended, or a panner waiting for GC): no per-sample geometry.
    // Panners outnumber sounds in three.js scenes, and every PositionalAudio is ramped per frame.
    for (int i = 0; i < 6; ++i) params[static_cast<size_t>(i)]->processIdle(g);
    for (int i = 0; i < 9; ++i) g.listenerParam(i)->process(g);  // shared: full arrays
    out.setChannels(2);
    out.zero();
    return;
  }
  const float* p[6];
  bool constant = true;
  for (int i = 0; i < 6; ++i) {
    p[i] = params[static_cast<size_t>(i)]->process(g);
    constant &= params[static_cast<size_t>(i)]->isConstant();
  }
  const float* l[9];
  for (int i = 0; i < 9; ++i) {
    Param* lp = g.listenerParam(i);
    l[i] = lp->process(g);
    constant &= lp->isConstant();
  }
  out.setChannels(2);
  out.zero();
  bool silent = in.silent();
  if (silent && (panningModel_ != 1 || !hrtfActive_)) return;
  bool mono = in.channels() == 1;
  const float* inL = in.channel(0);
  const float* inR = mono ? inL : in.channel(1);
  float* L = out.channel(0);
  float* R = out.channel(1);
  auto geometry = [&](int i, double& az, double& el, double& gain) {
    float src[3] = {p[0][i], p[1][i], p[2][i]};
    float ori[3] = {p[3][i], p[4][i], p[5][i]};
    float lpos[3] = {l[0][i], l[1][i], l[2][i]};
    float lfwd[3] = {l[3][i], l[4][i], l[5][i]};
    float lup[3] = {l[6][i], l[7][i], l[8][i]};
    azimuthElevation(src, lpos, lfwd, lup, az, el);
    double dist = len(sub(v3(src), v3(lpos)));
    gain = distanceGain(dist) * coneGain(src, ori, lpos);
  };
  if (panningModel_ == 1) {
    double az, el, gain;
    geometry(0, az, el, gain);
    float mixed[kQuantum];
    for (int i = 0; i < kQuantum; ++i) mixed[i] = silent ? 0.f : (mono ? inL[i] : 0.5f * (inL[i] + inR[i]));
    processHrtf(g, mixed, kQuantum, az, el, static_cast<float>(gain));
    out.setSilent(false);
    // Tail: the longest interaural delay (0.66 ms; 32 samples at 48 kHz) plus the head-shadow
    // filter's decay; after that many silent quanta (two at 48 kHz) the panner (and everything
    // downstream) is silent again.
    const int tailQuanta = 2 + static_cast<int>(kHrtfMaxDelaySec * g.sampleRate()) / kQuantum;
    if (!silent) {
      hrtfActive_ = true;
      hrtfSilentQuanta_ = 0;
    } else if (++hrtfSilentQuanta_ >= tailQuanta && std::fabs(ears_[0].y1) < 1e-6f && std::fabs(ears_[1].y1) < 1e-6f) {
      hrtfActive_ = false;
      for (Ear& e : ears_) e.x1 = e.y1 = 0;
      std::fill(hist_.begin(), hist_.end(), 0.f);
    }
    return;
  }
  // Equal-power panning as a 2x2 matrix per sample: [L R] = gain * [[cLL cLR] [cRL cRR]] [inL inR].
  struct Coef {
    float ll, lr, rl, rr;
  };
  auto coefAt = [&](int i) -> Coef {
    double az, el, gain;
    geometry(i, az, el, gain);
    double a = az;
    if (a < -90) a = -180 - a;
    else if (a > 90) a = 180 - a;
    double x = mono ? (a + 90) / 180 : (a <= 0 ? (a + 90) / 90 : a / 90);
    double gL = std::cos(x * kPi / 2), gR = std::sin(x * kPi / 2);
    if (mono) return {float(gL * gain), 0.f, float(gR * gain), 0.f};
    if (a <= 0) return {float(gain), float(gL * gain), 0.f, float(gR * gain)};
    return {float(gL * gain), 0.f, float(gR * gain), float(gain)};
  };
  if (constant) {
    Coef c = coefAt(0);
    for (int i = 0; i < kQuantum; ++i) {
      L[i] = c.ll * inL[i] + c.lr * inR[i];
      R[i] = c.rl * inL[i] + c.rr * inR[i];
    }
  } else {
    // Automated geometry (three.js ramps every listener and panner param each frame): evaluate the
    // spec's per-sample azimuth/distance/cone at every 16th sample and the last one, and
    // interpolate the matrix linearly in between; this cuts the per-voice cost about 6x
    // (PERF-AUDIO-1). The matrix is smooth except at kinks (distance crossing refDistance or
    // maxDistance, cone edges, azimuth folding at +-90): each segment's midpoint is evaluated
    // exactly, and a segment whose midpoint deviates by more than 1e-6 is computed per sample.
    constexpr int kStep = 16;
    constexpr float kTol = 1e-5f;
    auto mix = [&](int i, const Coef& c) {
      L[i] = c.ll * inL[i] + c.lr * inR[i];
      R[i] = c.rl * inL[i] + c.rr * inR[i];
    };
    Coef c0 = coefAt(0);
    for (int i0 = 0; i0 < kQuantum - 1; i0 += kStep) {
      int i1 = std::min(i0 + kStep, kQuantum - 1);
      int last = i1 == kQuantum - 1 ? kQuantum : i1;
      Coef c1 = coefAt(i1);
      int im = (i0 + i1) / 2;
      Coef cm = coefAt(im);
      float tm = static_cast<float>(im - i0) / static_cast<float>(i1 - i0);
      auto off = [&](float a0, float a1, float am) { return std::fabs(a0 + (a1 - a0) * tm - am); };
      bool smooth = off(c0.ll, c1.ll, cm.ll) <= kTol && off(c0.lr, c1.lr, cm.lr) <= kTol &&
                    off(c0.rl, c1.rl, cm.rl) <= kTol && off(c0.rr, c1.rr, cm.rr) <= kTol;
      if (smooth) {
        float inv = 1.f / static_cast<float>(i1 - i0);
        for (int i = i0; i < last; ++i) {
          float t = static_cast<float>(i - i0) * inv;
          Coef c{c0.ll + (c1.ll - c0.ll) * t, c0.lr + (c1.lr - c0.lr) * t, c0.rl + (c1.rl - c0.rl) * t,
                 c0.rr + (c1.rr - c0.rr) * t};
          mix(i, c);
        }
      } else {
        for (int i = i0; i < last; ++i) mix(i, i == i0 ? c0 : (i == im ? cm : (i == i1 ? c1 : coefAt(i))));
      }
      c0 = c1;
    }
  }
  out.setSilent(false);
}

// ---- BiquadFilterNode (spec: "BiquadFilterNode" filter formulas) ---------------------------------

BiquadCoeffs biquadCoefficients(int type, double Fs, double frequency, double detune, double Q,
                                double G) {
  double nyquist = Fs / 2;
  double f0 = frequency * std::pow(2.0, detune / 1200.0);
  f0 = std::max(0.0, std::min(f0, nyquist));
  double A = std::pow(10.0, G / 40.0);
  BiquadCoeffs pass{1, 0, 0, 0, 0}, zero{0, 0, 0, 0, 0}, gainA2{A * A, 0, 0, 0, 0};
  bool atZero = f0 <= 0, atNyq = f0 >= nyquist;
  switch (type) {
    case proto::kLowpass: if (atNyq) return pass; if (atZero) return zero; break;
    case proto::kHighpass: if (atNyq) return zero; if (atZero) return pass; break;
    case proto::kBandpass: if (atZero || atNyq) return zero; if (Q <= 0) return pass; break;
    case proto::kNotch: if (atZero || atNyq) return pass; if (Q <= 0) return zero; break;
    case proto::kAllpass: if (atZero || atNyq) return pass; if (Q <= 0) return {-1, 0, 0, 0, 0}; break;
    case proto::kPeaking: if (atZero || atNyq) return pass; if (Q <= 0) return gainA2; break;
    case proto::kLowshelf: if (atNyq) return gainA2; if (atZero) return pass; break;
    case proto::kHighshelf: if (atNyq) return pass; if (atZero) return gainA2; break;
    default: return pass;
  }
  double w0 = 2 * kPi * f0 / Fs;
  double cw = std::cos(w0), sw = std::sin(w0);
  double alphaQ = sw / (2 * Q);
  double alphaQdB = sw / (2 * std::pow(10.0, Q / 20.0));
  double S = 1;
  double alphaS = sw / 2 * std::sqrt((A + 1 / A) * (1 / S - 1) + 2);
  double sA = std::sqrt(A);
  double b0, b1, b2, a0, a1, a2;
  switch (type) {
    case proto::kLowpass:
      b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
      a0 = 1 + alphaQdB; a1 = -2 * cw; a2 = 1 - alphaQdB;
      break;
    case proto::kHighpass:
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
      a0 = 1 + alphaQdB; a1 = -2 * cw; a2 = 1 - alphaQdB;
      break;
    case proto::kBandpass:
      b0 = alphaQ; b1 = 0; b2 = -alphaQ;
      a0 = 1 + alphaQ; a1 = -2 * cw; a2 = 1 - alphaQ;
      break;
    case proto::kNotch:
      b0 = 1; b1 = -2 * cw; b2 = 1;
      a0 = 1 + alphaQ; a1 = -2 * cw; a2 = 1 - alphaQ;
      break;
    case proto::kAllpass:
      b0 = 1 - alphaQ; b1 = -2 * cw; b2 = 1 + alphaQ;
      a0 = 1 + alphaQ; a1 = -2 * cw; a2 = 1 - alphaQ;
      break;
    case proto::kPeaking:
      b0 = 1 + alphaQ * A; b1 = -2 * cw; b2 = 1 - alphaQ * A;
      a0 = 1 + alphaQ / A; a1 = -2 * cw; a2 = 1 - alphaQ / A;
      break;
    case proto::kLowshelf:
      b0 = A * ((A + 1) - (A - 1) * cw + 2 * alphaS * sA);
      b1 = 2 * A * ((A - 1) - (A + 1) * cw);
      b2 = A * ((A + 1) - (A - 1) * cw - 2 * alphaS * sA);
      a0 = (A + 1) + (A - 1) * cw + 2 * alphaS * sA;
      a1 = -2 * ((A - 1) + (A + 1) * cw);
      a2 = (A + 1) + (A - 1) * cw - 2 * alphaS * sA;
      break;
    case proto::kHighshelf:
    default:
      b0 = A * ((A + 1) + (A - 1) * cw + 2 * alphaS * sA);
      b1 = -2 * A * ((A - 1) + (A + 1) * cw);
      b2 = A * ((A + 1) + (A - 1) * cw - 2 * alphaS * sA);
      a0 = (A + 1) - (A - 1) * cw + 2 * alphaS * sA;
      a1 = 2 * ((A - 1) - (A + 1) * cw);
      a2 = (A + 1) - (A - 1) * cw - 2 * alphaS * sA;
      break;
  }
  return {b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0};
}

BiquadFilterNode::BiquadFilterNode() : Node(proto::kBiquad, 1, 1) {
  params.emplace_back(new Param(350.f, 0.f, FLT_MAX, true));        // frequency (max set by JS)
  params.emplace_back(new Param(0.f, -FLT_MAX, FLT_MAX, true));     // detune
  params.emplace_back(new Param(1.f, -FLT_MAX, FLT_MAX, true));     // Q
  params.emplace_back(new Param(0.f, -FLT_MAX, FLT_MAX, true));     // gain
}

void BiquadFilterNode::setProp(int prop, double v) {
  if (prop == proto::kPropBiquadType) {
    type_ = static_cast<int>(v);
    return;
  }
  Node::setProp(prop, v);
}

void BiquadFilterNode::process(Graph& g) {
  const AudioBus& in = *inputBuses[0];
  AudioBus& out = *outputs[0];
  const float* f = params[0]->process(g);
  const float* d = params[1]->process(g);
  const float* q = params[2]->process(g);
  const float* gn = params[3]->process(g);
  bool constant = params[0]->isConstant() && params[1]->isConstant() && params[2]->isConstant() &&
                  params[3]->isConstant();
  int nch = in.channels();
  out.setChannels(nch);
  out.zero();
  if (in.silent()) {
    bool quiet = true;
    for (int c = 0; c < nch; ++c) {
      const State& s = st_[c];
      if (std::fabs(s.y1) > 1e-12 || std::fabs(s.y2) > 1e-12 || std::fabs(s.x1) > 1e-12 ||
          std::fabs(s.x2) > 1e-12)
        quiet = false;
    }
    if (quiet) return;
  }
  double sr = g.sampleRate();
  BiquadCoeffs k = biquadCoefficients(type_, sr, f[0], d[0], q[0], gn[0]);
  for (int c = 0; c < nch; ++c) {
    const float* x = in.channel(c);
    float* y = out.channel(c);
    State& s = st_[c];
    for (int i = 0; i < kQuantum; ++i) {
      if (!constant && i > 0) k = biquadCoefficients(type_, sr, f[i], d[i], q[i], gn[i]);
      double xi = x[i];
      double yi = k.b0 * xi + k.b1 * s.x1 + k.b2 * s.x2 - k.a1 * s.y1 - k.a2 * s.y2;
      s.x2 = s.x1;
      s.x1 = xi;
      s.y2 = s.y1;
      s.y1 = yi;
      y[i] = static_cast<float>(yi);
    }
    if (!constant) k = biquadCoefficients(type_, sr, f[0], d[0], q[0], gn[0]);
    // Flush denormals.
    if (std::fabs(s.y1) < 1e-30) s.y1 = 0;
    if (std::fabs(s.y2) < 1e-30) s.y2 = 0;
  }
  out.setSilent(false);
}

void BiquadFilterNode::frequencyResponse(int type, double sr, double frequency, double detune,
                                         double q, double gain, const float* freqs, float* mag,
                                         float* phase, int n) {
  BiquadCoeffs k = biquadCoefficients(type, sr, frequency, detune, q, gain);
  double nyquist = sr / 2;
  for (int i = 0; i < n; ++i) {
    double fHz = freqs[i];
    if (!(fHz >= 0 && fHz <= nyquist)) {
      mag[i] = NAN;
      phase[i] = NAN;
      continue;
    }
    double w = kPi * fHz / nyquist;
    std::complex<double> z1 = std::polar(1.0, -w), z2 = std::polar(1.0, -2 * w);
    std::complex<double> num = k.b0 + k.b1 * z1 + k.b2 * z2;
    std::complex<double> den = 1.0 + k.a1 * z1 + k.a2 * z2;
    std::complex<double> h = num / den;
    mag[i] = static_cast<float>(std::abs(h));
    phase[i] = static_cast<float>(std::arg(h));
  }
}

// ---- DelayNode ----------------------------------------------------------------------------------

DelayNode::DelayNode(double maxDelaySeconds, float sampleRate) : Node(proto::kDelay, 1, 1) {
  size_ = static_cast<int>(std::ceil(maxDelaySeconds * sampleRate)) + kQuantum + 4;
  for (int c = 0; c < kBusChannels; ++c) {
    ring_[c] = static_cast<float*>(std::calloc(static_cast<size_t>(size_), sizeof(float)));
    if (!ring_[c]) throw std::bad_alloc();
    if (c < 2) {
      // Stereo (the common case) is made resident now, on the main thread, so the render thread
      // does not take page faults on it. One volatile store per page: a memset after calloc
      // would be optimised away.
      volatile float* v = ring_[c];
      for (int i = 0; i < size_; i += 1024) v[i] = 0.f;
    }
  }
  silentRun_ = size_;
  params.emplace_back(new Param(0.f, 0.f, static_cast<float>(maxDelaySeconds), true));
}

DelayNode::~DelayNode() {
  for (float* r : ring_) std::free(r);
}

void DelayNode::noteInput(const AudioBus& in) {
  if (in.silent()) silentRun_ += kQuantum;
  else silentRun_ = 0;
}

void DelayNode::process(Graph& g) {
  const AudioBus& in = *inputBuses[0];
  AudioBus& out = *outputs[0];
  const float* dt = params[0]->process(g);
  int nch = std::max(in.channels(), in.silent() ? lastChannels_ : in.channels());
  lastChannels_ = nch;
  out.setChannels(nch);
  out.zero();
  // The whole line holds zeros and the input is silent: the output is silent (and stays so).
  if (in.silent() && silentRun_ >= size_) return;
  noteInput(in);
  double sr = g.sampleRate();
  int wp = writePos_;
  for (int i = 0; i < kQuantum; ++i) {
    double ds = std::max(0.0, std::min(static_cast<double>(dt[i]) * sr, static_cast<double>(size_ - 2)));
    double rp = wp - ds;
    if (rp < 0) rp += size_;
    int i0 = static_cast<int>(rp);
    double fr = rp - i0;
    int i1 = (i0 + 1) % size_;
    for (int c = 0; c < nch; ++c) {
      float* r = ring_[c];
      r[wp] = (c < in.channels() && !in.silent()) ? in.channel(c)[i] : 0.f;
      float s0 = r[i0], s1 = r[i1];
      // When the delay is below one sample, s1 is the sample just written.
      out.channel(c)[i] = static_cast<float>(s0 + (s1 - s0) * fr);
    }
    wp = (wp + 1) % size_;
  }
  writePos_ = wp;
  out.setSilent(false);
}

void DelayNode::produceFromLine(Graph& g) {
  // Reader half of a DelayNode in a cycle: the delay is at least one render quantum (spec), so
  // every sample read was written in an earlier quantum.
  AudioBus& out = *outputs[0];
  const float* dt = params[0]->process(g);
  int nch = lastChannels_;
  out.setChannels(nch);
  out.zero();
  if (silentRun_ >= size_) return;
  double sr = g.sampleRate();
  int wp = writePos_;
  for (int i = 0; i < kQuantum; ++i) {
    double ds = std::max(static_cast<double>(kQuantum),
                         std::min(static_cast<double>(dt[i]) * sr, static_cast<double>(size_ - 2)));
    double rp = (wp + i) - ds;
    while (rp < 0) rp += size_;
    int i0 = static_cast<int>(rp) % size_;
    double fr = rp - std::floor(rp);
    int i1 = (i0 + 1) % size_;
    for (int c = 0; c < nch; ++c) {
      const float* r = ring_[c];
      out.channel(c)[i] = static_cast<float>(r[i0] + (r[i1] - r[i0]) * fr);
    }
  }
  out.setSilent(false);
}

void DelayNode::writeLine(Graph& g) {
  // Writer half: the inputs rendered this quantum (the rest of the cycle included).
  mixInputs(g);
  const AudioBus& in = *inputBuses[0];
  if (in.silent() && silentRun_ >= size_) return;
  int nch = std::max(in.channels(), in.silent() ? lastChannels_ : in.channels());
  lastChannels_ = nch;
  noteInput(in);
  int wp = writePos_;
  for (int c = 0; c < nch; ++c) {
    float* r = ring_[c];
    const float* x = (c < in.channels() && !in.silent()) ? in.channel(c) : nullptr;
    int w = wp;
    for (int i = 0; i < kQuantum; ++i) {
      r[w] = x ? x[i] : 0.f;
      if (++w == size_) w = 0;
    }
  }
  writePos_ = (wp + kQuantum) % size_;
}

// ---- AnalyserNode (spec: "AnalyserNode", "FFT Windowing and smoothing over time") ----------------

AnalyserNode::AnalyserNode() : Node(proto::kAnalyser, 1, 1) {
  ring_.assign(kRing, 0.f);
  channelCount = 2;
  mode = ChannelCountMode::Max;
}

AnalyserNode::~AnalyserNode() = default;

void AnalyserNode::setProp(int prop, double v) {
  // fftSize / smoothing / decibel range live on the JS side (passed to the main-thread reads).
  Node::setProp(prop, v);
}

void AnalyserNode::process(Graph&) {
  const AudioBus& in = *inputBuses[0];
  AudioBus& out = *outputs[0];
  out.setChannels(in.channels());
  out.copyFrom(in, ChannelInterpretation::Discrete);
  // Down-mix to mono for analysis.
  float mono[kQuantum] = {};
  if (!in.silent()) {
    const float* ins[kMaxChannels];
    for (int c = 0; c < in.channels(); ++c) ins[c] = in.channel(c);
    float* o[1] = {mono};
    mixChannels(ins, in.channels(), o, 1, ChannelInterpretation::Speakers);
  }
  uint32_t w = writeIdx_.load(std::memory_order_relaxed);
  for (int i = 0; i < kQuantum; ++i) ring_[(w + static_cast<uint32_t>(i)) & (kRing - 1)] = mono[i];
  writeIdx_.store(w + kQuantum, std::memory_order_release);
}

void AnalyserNode::timeDomain(float* out, int n) const {
  if (n > kRing) n = kRing;
  uint32_t w = writeIdx_.load(std::memory_order_acquire);
  uint32_t start = w - static_cast<uint32_t>(n);
  for (int i = 0; i < n; ++i) out[i] = ring_[(start + static_cast<uint32_t>(i)) & (kRing - 1)];
}

void AnalyserNode::frequency(float* outDb, int bins, int fftSize, double smoothing, uint64_t frameNow) {
  int n = fftSize;
  if (n < 32 || n > kRing || !isPow2(static_cast<uint32_t>(n))) return;
  if (!fft_ || fft_->size() != n) {
    fft_.reset(new RealFFT(n));
    smoothed_.assign(static_cast<size_t>(n / 2), 0.f);
    window_.resize(static_cast<size_t>(n));
    for (int i = 0; i < n; ++i) {
      double a0 = 0.42, a1 = 0.5, a2 = 0.08;  // Blackman, alpha = 0.16
      window_[static_cast<size_t>(i)] =
          static_cast<float>(a0 - a1 * std::cos(2 * kPi * i / n) + a2 * std::cos(4 * kPi * i / n));
    }
    scratch_.resize(static_cast<size_t>(n));
    spectrum_.resize(static_cast<size_t>(n / 2 + 1));
    lastFrame_ = ~0ull;
  }
  if (frameNow != lastFrame_) {
    lastFrame_ = frameNow;
    timeDomain(scratch_.data(), n);
    for (int i = 0; i < n; ++i) scratch_[static_cast<size_t>(i)] *= window_[static_cast<size_t>(i)];
    fft_->forward(scratch_.data(), spectrum_.data());
    double tau = smoothing;
    for (int k = 0; k < n / 2; ++k) {
      double m = std::abs(spectrum_[static_cast<size_t>(k)]) / n;
      double s = tau * smoothed_[static_cast<size_t>(k)] + (1 - tau) * m;
      if (!std::isfinite(s)) s = 0;
      smoothed_[static_cast<size_t>(k)] = static_cast<float>(s);
    }
  }
  int m = std::min(bins, n / 2);
  for (int k = 0; k < m; ++k) {
    double s = smoothed_[static_cast<size_t>(k)];
    outDb[k] = s > 0 ? static_cast<float>(20 * std::log10(s)) : -INFINITY;
  }
}

// ---- ConvolverNode (spec: "ConvolverNode"; non-uniformly partitioned overlap-save) ---------------

namespace {
constexpr int kConvLevelBlocks[] = {kQuantum, 1024, 4096};
constexpr int kConvLevels = 3;
}  // namespace

ConvolverKernel::~ConvolverKernel() {
  for (Level& L : levels) delete L.fft;
}

size_t ConvolverKernel::partitionCountForTest() const {
  size_t n = 0;
  for (const Level& L : levels) n += static_cast<size_t>(L.P);
  return n;
}

ConvolverKernel* ConvolverKernel::build(const BufferData* ir, bool normalize, float contextRate) {
  auto* k = new ConvolverKernel();
  int nch = ir->channels();
  k->channels = nch;
  size_t len = ir->length();
  k->irLength = len;
  double scale = 1;
  if (normalize) {
    // Spec: calculateNormalizationScale.
    const double kGainCalibration = 0.00125, kGainCalibrationSampleRate = 44100, kMinPower = 0.000125;
    double power = 0;
    for (int c = 0; c < nch; ++c) {
      const float* d = ir->channel(c);
      for (size_t i = 0; i < len; ++i) power += static_cast<double>(d[i]) * d[i];
    }
    power = std::sqrt(power / (static_cast<double>(nch) * static_cast<double>(len ? len : 1)));
    if (!std::isfinite(power) || power < kMinPower) power = kMinPower;
    scale = 1 / power;
    scale *= kGainCalibration;
    if (ir->sampleRate() > 0) scale *= kGainCalibrationSampleRate / ir->sampleRate();
    if (nch == 4) scale *= 0.5;
  }
  (void)contextRate;
  int tail = 0;
  for (int j = 0; j < kConvLevels; ++j) {
    int N = kConvLevelBlocks[j];
    size_t S = j == 0 ? 0 : 2 * static_cast<size_t>(N);
    size_t end = j + 1 < kConvLevels ? 2 * static_cast<size_t>(kConvLevelBlocks[j + 1]) : len;
    if (j > 0 && S >= len) break;
    end = std::min(end, len);
    Level L;
    L.N = N;
    L.M = N / kQuantum;
    L.S = static_cast<int>(S);
    L.P = end > S ? static_cast<int>((end - S + N - 1) / N) : 1;
    L.fft = new RealFFT(2 * N);
    std::vector<float> block(2 * static_cast<size_t>(N));
    L.parts.resize(static_cast<size_t>(nch) * static_cast<size_t>(L.P));
    for (int c = 0; c < nch; ++c) {
      const float* d = ir->channel(c);
      for (int p = 0; p < L.P; ++p) {
        std::fill(block.begin(), block.end(), 0.f);
        for (int i = 0; i < N; ++i) {
          size_t idx = S + static_cast<size_t>(p) * N + static_cast<size_t>(i);
          if (idx < end) block[static_cast<size_t>(i)] = static_cast<float>(d[idx] * scale / (2.0 * N));
        }
        auto& bins = L.parts[static_cast<size_t>(c * L.P + p)];
        bins.resize(static_cast<size_t>(N) + 1);
        L.fft->forward(block.data(), bins.data());
      }
    }
    for (auto& f : L.fdl) {
      f.resize(static_cast<size_t>(L.P));
      for (auto& sp : f) sp.assign(static_cast<size_t>(N) + 1, std::complex<float>(0, 0));
    }
    L.fdlPos = L.P - 1;
    for (int c = 0; c < 2; ++c) {
      L.prev[c].assign(static_cast<size_t>(N), 0.f);
      if (j > 0) {
        L.cur[c].assign(static_cast<size_t>(N), 0.f);
        L.acc[c].assign(static_cast<size_t>(N) + 1, std::complex<float>(0, 0));
        L.ring[c].assign(2 * static_cast<size_t>(N), 0.f);
      }
    }
    if (j == 0) L.acc[0].assign(kQuantum + 1, std::complex<float>(0, 0));
    for (auto& b : L.block) b.assign(2 * static_cast<size_t>(N), 0.f);
    // Silent input: after P + 4 blocks (two of latency, P through the delay line, the overlap
    // block) everything this level holds is zero.
    tail = std::max(tail, (L.P + 4) * L.M);
    k->levels.push_back(std::move(L));
  }
  k->tailQuanta = tail + 2;
  return k;
}

ConvolverNode::ConvolverNode() : Node(proto::kConvolver, 1, 1, 2, 2) {
  channelCount = 2;
  mode = ChannelCountMode::ClampedMax;
}

ConvolverNode::~ConvolverNode() { delete kernel_; }

void ConvolverNode::setProp(int prop, double v) { Node::setProp(prop, v); }

Disposable* ConvolverNode::setKernel(Disposable* k) {
  ConvolverKernel* old = kernel_;
  kernel_ = static_cast<ConvolverKernel*>(k);
  // A fresh kernel's state is all zeros: silent input renders nothing until input arrives.
  silentQuanta_ = kernel_ ? kernel_->tailQuanta + 1 : 0;
  return old;
}

void ConvolverNode::process(Graph&) {
  const AudioBus& in = *inputBuses[0];
  AudioBus& out = *outputs[0];
  ConvolverKernel* k = kernel_;
  if (!k) {
    out.setChannels(1);
    out.zero();
    return;
  }
  int inCh = std::min(in.channels(), 2);
  int irCh = k->channels;
  int outCh = (inCh == 1 && irCh == 1) ? 1 : 2;
  out.setChannels(outCh);
  out.zero();
  // Tail: once enough silent quanta went in, every buffer is zero and the output is silent until
  // input arrives again. Skipped quanta do not advance the block clock; with all state zero the
  // phase does not matter.
  bool sil = in.silent();
  if (sil) {
    if (silentQuanta_ > k->tailQuanta) return;
    ++silentQuanta_;
  } else {
    silentQuanta_ = 0;
  }
  bool trueStereo = irCh == 4;
  int nIn = (trueStereo || inCh == 2) ? 2 : 1;
  const float* x[2];
  for (int c = 0; c < nIn; ++c) x[c] = sil ? nullptr : in.channel(std::min(c, in.channels() - 1));
  // The (input channel, IR channel) terms summed into output channel o.
  auto terms = [&](int o, int* inC, int* irC) -> int {
    if (trueStereo) {
      inC[0] = 0, irC[0] = o == 0 ? 0 : 1;
      inC[1] = 1, irC[1] = o == 0 ? 2 : 3;
      return 2;
    }
    inC[0] = nIn == 2 ? o : 0;
    irC[0] = irCh == 1 ? 0 : o;
    return 1;
  };
  // Complex multiply-add on interleaved (re, im) floats (std::complex<float> arrays may be
  // accessed so). Written out because std::complex's operator* carries an inf/NaN recovery path
  // (Annex G) that blocks vectorization.
  auto mac = [](std::complex<float>* accC, const std::complex<float>* XC, const std::complex<float>* HC, int bins) {
    float* __restrict acc = reinterpret_cast<float*>(accC);
    const float* __restrict X = reinterpret_cast<const float*>(XC);
    const float* __restrict H = reinterpret_cast<const float*>(HC);
    for (int b = 0; b < 2 * bins; b += 2) {
      float xr = X[b], xi = X[b + 1], hr = H[b], hi = H[b + 1];
      acc[b] += xr * hr - xi * hi;
      acc[b + 1] += xr * hi + xi * hr;
    }
  };

  // Level 0: the current quantum, no latency.
  {
    ConvolverKernel::Level& L = k->levels[0];
    L.fdlPos = (L.fdlPos + 1) % L.P;
    for (int c = 0; c < nIn; ++c) {
      float* blk = L.block[0].data();
      for (int i = 0; i < kQuantum; ++i) {
        blk[i] = L.prev[c][static_cast<size_t>(i)];
        float v = x[c] ? x[c][i] : 0.f;
        blk[kQuantum + i] = v;
        L.prev[c][static_cast<size_t>(i)] = v;
      }
      L.fft->forward(blk, L.fdl[c][static_cast<size_t>(L.fdlPos)].data());
    }
    std::complex<float>* acc = L.acc[0].data();
    for (int o = 0; o < outCh; ++o) {
      std::fill(acc, acc + kQuantum + 1, std::complex<float>(0, 0));
      int inC[2], irC[2];
      int nt = terms(o, inC, irC);
      for (int t = 0; t < nt; ++t)
        for (int p = 0; p < L.P; ++p) {
          int slot = (L.fdlPos - p + L.P) % L.P;
          mac(acc, L.fdl[inC[t]][static_cast<size_t>(slot)].data(), L.parts[static_cast<size_t>(irC[t] * L.P + p)].data(), kQuantum + 1);
        }
      L.fft->inverse(acc, L.block[0].data());
      std::copy(L.block[0].begin() + kQuantum, L.block[0].begin() + 2 * kQuantum, out.channel(o));
    }
  }

  // Deeper levels: block k's work runs during block k + 1, its result plays during block k + 2.
  uint64_t q = k->quanta;
  for (size_t j = 1; j < k->levels.size(); ++j) {
    ConvolverKernel::Level& L = k->levels[j];
    const int N = L.N, M = L.M, bins = N + 1;
    const int i = static_cast<int>(q % static_cast<uint64_t>(M));
    const uint64_t blockNow = q / static_cast<uint64_t>(M);
    // Block blockNow - 1 completed at the end of the previous quantum. Its work, one heavy step
    // per quantum so no quantum pays for more than one FFT of this level:
    //   i = 0, 1      forward FFT of [previous block | that block], input channel 0, 1
    //   i = 2 .. M-3  partition multiply-adds, spread evenly
    //   i = M-2, M-1  inverse FFT into the result ring, output channel 0, 1
    if (i == 0 && q > 0) {
      L.fdlPos = (L.fdlPos + 1) % L.P;
      for (int c = 0; c < nIn; ++c) {
        std::copy(L.prev[c].begin(), L.prev[c].end(), L.block[c].begin());
        std::copy(L.cur[c].begin(), L.cur[c].end(), L.block[c].begin() + N);
        L.prev[c].swap(L.cur[c]);
      }
    }
    for (int c = 0; c < nIn; ++c) {
      float* dst = L.cur[c].data() + static_cast<size_t>(i) * kQuantum;
      if (x[c]) std::copy(x[c], x[c] + kQuantum, dst);
      else std::fill(dst, dst + kQuantum, 0.f);
    }
    if (blockNow >= 1) {
      const int Q = M - 4;
      if (i <= 1) {
        if (i < nIn) L.fft->forward(L.block[i].data(), L.fdl[i][static_cast<size_t>(L.fdlPos)].data());
      } else if (i <= M - 3) {
        int p0 = (i - 2) * L.P / Q, p1 = (i - 1) * L.P / Q;
        for (int o = 0; o < outCh; ++o) {
          int inC[2], irC[2];
          int nt = terms(o, inC, irC);
          for (int t = 0; t < nt; ++t)
            for (int p = p0; p < p1; ++p) {
              int slot = (L.fdlPos - p + L.P) % L.P;
              mac(L.acc[o].data(), L.fdl[inC[t]][static_cast<size_t>(slot)].data(),
                  L.parts[static_cast<size_t>(irC[t] * L.P + p)].data(), bins);
            }
        }
      } else {
        int o = i - (M - 2);
        if (o < outCh) {
          size_t half = static_cast<size_t>((blockNow - 1) % 2) * static_cast<size_t>(N);
          L.fft->inverse(L.acc[o].data(), L.block[o].data());
          std::copy(L.block[o].begin() + N, L.block[o].end(), L.ring[o].begin() + static_cast<std::ptrdiff_t>(half));
          std::fill(L.acc[o].begin(), L.acc[o].end(), std::complex<float>(0, 0));
        }
      }
    }
    // Output: the result of block blockNow - 2 (same ring half), at this quantum's offset.
    size_t at = static_cast<size_t>(blockNow % 2) * static_cast<size_t>(N) + static_cast<size_t>(i) * kQuantum;
    for (int o = 0; o < outCh; ++o) {
      float* y = out.channel(o);
      const float* r = L.ring[o].data() + at;
      for (int s2 = 0; s2 < kQuantum; ++s2) y[s2] += r[s2];
    }
  }
  k->quanta = q + 1;
  out.setSilent(false);
}

// ---- Channel splitter / merger --------------------------------------------------------------

ChannelSplitterNode::ChannelSplitterNode(int n) : Node(proto::kSplitter, 1, n, 1) {
  channelCount = n;
  mode = ChannelCountMode::Explicit;
  interp = ChannelInterpretation::Discrete;
}

void ChannelSplitterNode::process(Graph&) {
  const AudioBus& in = *inputBuses[0];
  for (int o = 0; o < numOutputs(); ++o) {
    AudioBus& out = *outputs[static_cast<size_t>(o)];
    out.setChannels(1);
    out.zero();
    if (!in.silent() && o < in.channels()) {
      std::copy(in.channel(o), in.channel(o) + kQuantum, out.channel(0));
      out.setSilent(false);
    }
  }
}

ChannelMergerNode::ChannelMergerNode(int n) : Node(proto::kMerger, n, 1, std::min(n, kBusChannels), 1) {
  channelCount = 1;
  mode = ChannelCountMode::Explicit;
}

void ChannelMergerNode::process(Graph&) {
  AudioBus& out = *outputs[0];
  int n = std::min(numInputs(), kBusChannels);
  out.setChannels(n);
  out.zero();
  for (int i = 0; i < n; ++i) {
    const AudioBus& in = *inputBuses[static_cast<size_t>(i)];
    if (in.silent()) continue;
    std::copy(in.channel(0), in.channel(0) + kQuantum, out.channel(i));
    out.setSilent(false);
  }
}

}  // namespace iwn::audio
