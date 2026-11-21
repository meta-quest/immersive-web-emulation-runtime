// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
//
// Render-side audio graph: AudioParam (timeline + audio-rate inputs) and AudioNode with the spec's
// input mixing ("computedNumberOfChannels"), plus every node type the runtime implements.
// All processing happens on the render thread; node objects are constructed on the main thread
// and handed over in a control batch, so the render thread never allocates for them.
#pragma once

#include <complex>
#include <cstdint>
#include <memory>
#include <vector>

#include "core.h"
#include "param.h"
#include "protocol.h"

namespace iwn::audio {

class Graph;
class Node;
class RealFFT;

// Engine-wide cap on channels flowing between nodes. AudioBuffers may hold up to kMaxChannels;
// a source playing a buffer with more channels outputs the first kBusChannels.
constexpr int kBusChannels = 8;

struct OutputRef {
  Node* node;
  int output;
};

// Base of everything the render thread hands back to the main thread for deletion.
struct Disposable {
  virtual ~Disposable() = default;
};

class Param {
 public:
  Param(float def, float mn, float mx, bool aRate, bool rateFixed = false)
      : tl(def, mn, mx), aRate(aRate), rateFixed(rateFixed) {}
  // The mono bus that sums audio-rate inputs; allocated on the main thread when the first
  // connection to this param is prepared (most params never get one). Returns the previous bus.
  AudioBus* installInputBus(AudioBus* b) {
    AudioBus* old = inputBus_.release();
    inputBus_.reset(b);
    return old;
  }
  bool hasInputBus() const { return inputBus_ != nullptr; }
  // Computes values for the graph's current quantum (timeline + inputs, clamped to the nominal
  // range) and publishes the first value to the shared slot. Returns values (128 entries).
  const float* process(Graph& g);
  // For an owner whose output is silent this quantum: only the value at the quantum's start is
  // computed (published for AudioParam.value, timeline pruned), not 128 samples; isConstant()
  // is true and only values[0] is valid. Full process() when the param has audio-rate inputs.
  // Never for params shared between nodes (the listener's): they need the full array.
  const float* processIdle(Graph& g);
  bool isConstant() const { return constant; }
  float first() const { return values[0]; }

  ParamTimeline tl;
  bool aRate;
  bool rateFixed;
  int slot = -1;
  Node* owner = nullptr;  // the node this param belongs to (null for AudioListener params)
  std::vector<OutputRef> inputs;
  GrowHint inputsHint;
  float values[kQuantum] = {};
  bool constant = true;
  uint64_t computedQuantum = ~0ull;

 private:
  std::unique_ptr<AudioBus> inputBus_;
};

class Node : public Disposable {
 public:
  // Bus capacities are fixed at construction (main thread); nodes whose channel count the spec
  // bounds (panners, convolver, merger inputs) get small buses to keep per-node memory low.
  Node(proto::NodeType type, int numInputs, int numOutputs, int outCapacity = kBusChannels,
       int inCapacity = kBusChannels);
  ~Node() override;

  proto::NodeType type() const { return type_; }
  int numInputs() const { return static_cast<int>(inputs.size()); }
  int numOutputs() const { return static_cast<int>(outputs.size()); }

  // Ensures this node's outputs hold the current quantum's audio.
  void pull(Graph& g);
  // Pulls every input and mixes it into inputBuses (spec input mixing).
  void mixInputs(Graph& g);
  // DelayNode in a cycle (spec: "DelayNode in a cycle" is split into a reader and a writer): the
  // output is produced from the delay line first (delay clamped to >= one quantum) and the input
  // is written after the rest of the graph rendered (Graph::render).
  virtual bool isDelay() const { return false; }
  virtual void produceFromLine(Graph&) {}
  virtual void writeLine(Graph&) {}
  // Silences every output (a node in a cycle without a DelayNode, spec: muted).
  void muteOutputs();
  virtual void setProp(int prop, double v);
  virtual bool isScheduledSource() const { return false; }
  // A scheduled source that played to its end and delivered `ended`: start() is once-only, so its
  // output is silent for good (spec: no longer actively processing).
  virtual bool isFinished() const { return false; }
  // True when a released node can be removed (no further audible effect).
  virtual bool canBeCollected() const;
  // Render-thread side of start/stop for scheduled sources.
  virtual void start(double /*when*/, double /*offset*/, double /*duration*/) {}
  virtual void stop(double /*when*/) {}
  // Replaces an attached resource (buffer / kernel / wave); returns the previous one, or null.
  virtual BufferData* setBuffer(BufferData* b) { return b; }
  virtual Disposable* setKernel(Disposable* k) { return k; }

  uint32_t id = 0;
  int channelCount = 2;
  ChannelCountMode mode = ChannelCountMode::Max;
  ChannelInterpretation interp = ChannelInterpretation::Speakers;
  std::vector<std::vector<OutputRef>> inputs;  // per input: connected outputs
  std::unique_ptr<GrowHint[]> inputHints;      // per input
  struct Downstream {
    Node* node;     // destination node (null for params)
    int output;
    int input;
    Param* param;   // destination param (null for nodes)
  };
  std::vector<Downstream> downstream;  // outgoing connections
  GrowHint downstreamHint;
  std::vector<std::unique_ptr<AudioBus>> outputs;
  std::vector<std::unique_ptr<AudioBus>> inputBuses;
  std::vector<std::unique_ptr<Param>> params;
  bool released = false;
  bool createdInPendingBatch = false;  // main thread: created by the batch being prepared
  size_t activeIndex = 0;              // render thread: position in Graph::active_ (or retired_)
  bool retired = false;                // render thread: finished source parked in Graph::retired_
  bool inCycle = false;                // render thread: DelayNode that is part of a cycle
  uint64_t mutedQuantum = ~0ull;       // render thread: in a delay-free cycle this quantum
  uint64_t dfsMark = 0;                // render thread: cycle analysis

 protected:
  // Called with inputBuses mixed for this quantum. Must fill outputs (setChannels + data/silent).
  virtual void process(Graph& g) = 0;
  int computeInputChannels(int input) const;
  // Convenience: all inputs silent.
  bool inputsSilent() const;

 private:
  proto::NodeType type_;
  uint64_t processedQuantum_ = ~0ull;
  bool visiting_ = false;
};

// ---- node types -----------------------------------------------------------------------------

class DestinationNode final : public Node {
 public:
  explicit DestinationNode(int channels);
  void process(Graph& g) override;
  const AudioBus& mixed() const { return *inputBuses[0]; }
};

class GainNode final : public Node {
 public:
  GainNode();
  void process(Graph& g) override;
};

class ScheduledSource : public Node {
 public:
  ScheduledSource(proto::NodeType t, int outCapacity) : Node(t, 0, 1, outCapacity) {}
  // AudioBufferSourceNode: a buffer with more channels than the output bus holds arrives with a
  // larger bus (prepared on the main thread); returns the previous bus for disposal.
  AudioBus* swapOutputBus(AudioBus* b) {
    AudioBus* old = outputs[0].release();
    outputs[0].reset(b);
    return old;
  }
  bool isScheduledSource() const override { return true; }
  bool isFinished() const override { return started_ && ended_ && !endedPending_; }
  bool canBeCollected() const override;
  void start(double when, double offset, double duration) override;
  void stop(double when) override;

 protected:
  // Computes [begin, end) of the quantum that plays, handles stop/ended. Returns false if silent.
  bool activeRange(Graph& g, int& begin, int& end);
  void finish(Graph& g);
  bool started_ = false;
  bool ended_ = false;
  bool endedPending_ = false;  // `ended` not delivered yet (event queue full): retried each quantum
  bool playing_ = false;
  double startTime_ = 0, stopTime_ = 1e300, offset_ = 0, duration_ = -1;
};

class BufferSourceNode final : public ScheduledSource {
 public:
  BufferSourceNode();
  ~BufferSourceNode() override;
  void process(Graph& g) override;
  void setProp(int prop, double v) override;
  BufferData* setBuffer(BufferData* b) override;
  bool canBeCollected() const override;

 private:
  BufferData* buffer_ = nullptr;
  bool loop_ = false;
  double loopStart_ = 0, loopEnd_ = 0;
  double playhead_ = 0;      // in buffer frames
  double bufferTimePlayed_ = 0;
  double startFrame_ = 0;    // the (clamped) start offset, in buffer frames
  bool positioned_ = false;
  bool enteredLoop_ = false; // spec playback algorithm: enteredLoop
};

class ConstantSourceNode final : public ScheduledSource {
 public:
  ConstantSourceNode();
  void process(Graph& g) override;
};

// Band-limited wavetables for one periodic waveform (built on the main thread).
struct WaveTable final : public Disposable {
  static constexpr int kSize = 4096;
  static constexpr int kRanges = 12;  // partial limits 1, 2, 4, ... 2048
  std::vector<float> tables[kRanges];
  static WaveTable* build(const float* real, const float* imag, int n, bool normalize);
  static WaveTable* builtin(int type);  // 0 sine, 1 square, 2 sawtooth, 3 triangle
};

class OscillatorNode final : public ScheduledSource {
 public:
  OscillatorNode();
  ~OscillatorNode() override;
  void process(Graph& g) override;
  void setProp(int prop, double v) override;
  Disposable* setKernel(Disposable* k) override;  // WaveTable

 private:
  WaveTable* wave_ = nullptr;
  WaveTable* custom_ = nullptr;  // owned; kept while a built-in type plays
  WaveTable* builtins_[4] = {};
  double phase_ = 0;  // [0, 1)
};

class StereoPannerNode final : public Node {
 public:
  StereoPannerNode();
  void process(Graph& g) override;
};

class PannerNode final : public Node {
 public:
  PannerNode();
  void process(Graph& g) override;
  void setProp(int prop, double v) override;

  // Spec formulas, public for tests.
  static void azimuthElevation(const float src[3], const float lpos[3], const float lfwd[3],
                               const float lup[3], double& azimuth, double& elevation);
  double distanceGain(double d) const;
  double coneGain(const float src[3], const float orient[3], const float lpos[3]) const;

 private:
  void processHrtf(Graph& g, const float* in, int frames, double az, double el, float gain);
  int panningModel_ = 0;
  int distanceModel_ = 1;
  double refDistance_ = 1, maxDistance_ = 10000, rolloff_ = 1;
  double coneInner_ = 360, coneOuter_ = 360, coneOuterGain_ = 0;
  // HRTF (spherical-head model) state per ear.
  struct Ear {
    float b0 = 1, b1 = 0, a1 = 0;  // one-pole/one-zero head-shadow filter
    float x1 = 0, y1 = 0;
    double delay = 0;  // samples
  } ears_[2];
  // Spherical-head model constants: the longest interaural delay is (a/c)(1 + pi/2).

 public:
  static constexpr double hrtfMaxDelaySecForTest() { return kHrtfMaxDelaySec; }

 private:
  static constexpr double kHrtfMaxDelaySec = 0.0875 / 343.0 * (1 + 3.14159265358979323846 / 2);
  static constexpr int kHrtfHist = 1024;  // > kHrtfMaxDelaySec * 768 kHz + 2, power of two
  std::vector<float> hist_;  // mono input history for the ITD delay line (allocated at construction)
  int histPos_ = 0;
  bool hrtfActive_ = false;  // HRTF state may hold a tail (else silent input renders nothing)
  int hrtfSilentQuanta_ = 0;
};

struct BiquadCoeffs {
  double b0, b1, b2, a1, a2;  // normalised by a0
};
BiquadCoeffs biquadCoefficients(int type, double sampleRate, double frequency, double detune,
                                double q, double gain);

class BiquadFilterNode final : public Node {
 public:
  BiquadFilterNode();
  void process(Graph& g) override;
  void setProp(int prop, double v) override;
  // getFrequencyResponse (main thread, current parameter values).
  static void frequencyResponse(int type, double sampleRate, double frequency, double detune,
                                double q, double gain, const float* freqs, float* mag,
                                float* phase, int n);

 private:
  int type_ = 0;
  struct State {
    double x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  } st_[kBusChannels];
};

class DelayNode final : public Node {
 public:
  explicit DelayNode(double maxDelaySeconds, float sampleRate);
  ~DelayNode() override;
  void process(Graph& g) override;
  bool isDelay() const override { return true; }
  void produceFromLine(Graph& g) override;
  void writeLine(Graph& g) override;
  size_t ringBytesForTest() const { return static_cast<size_t>(size_) * sizeof(float); }

 private:
  void noteInput(const AudioBus& in);
  // Channels 0-1 are allocated and touched at construction; channels 2-7 are calloc'ed lazily
  // (zero pages: memory only becomes resident if a >2-channel input ever uses them).
  float* ring_[kBusChannels] = {};
  int size_;
  int writePos_ = 0;
  int lastChannels_ = 1;
  int64_t silentRun_ = 0;  // consecutive silent input frames written (>= size_: line is all zeros)
};

class AnalyserNode final : public Node {
 public:
  AnalyserNode();
  ~AnalyserNode() override;
  void process(Graph& g) override;
  void setProp(int prop, double v) override;
  // Main-thread reads (lock-free snapshot of the most recent samples). The analysis parameters
  // (fftSize, smoothingTimeConstant) are owned by the JS object and passed in.
  void timeDomain(float* out, int n) const;
  // getFloatFrequencyData: Blackman window, FFT, smoothing over time, dB. Recomputed at most once
  // per render quantum (`frameNow` = current frame); `bins` <= fftSize / 2.
  void frequency(float* outDb, int bins, int fftSize, double smoothing, uint64_t frameNow);

  static constexpr int kRing = 32768;

 private:
  std::vector<float> ring_;
  std::atomic<uint32_t> writeIdx_{0};
  // Main-thread analysis state.
  std::unique_ptr<RealFFT> fft_;
  std::vector<float> smoothed_, window_, scratch_;
  std::vector<std::complex<float>> spectrum_;
  uint64_t lastFrame_ = ~0ull;
};

// Frequency-domain partitions of an impulse response (built on the main thread), in levels of
// growing block size (non-uniformly partitioned convolution):
//
//   level 0: 128-frame blocks for IR [0, 2048), computed in the current quantum (no latency);
//   level 1: 1024-frame blocks for IR [2048, 8192);
//   level 2: 4096-frame blocks for IR [8192, end) (kConvLevelBlocks in nodes.cpp).
//
// A level with block N starts at IR offset S = 2N. Its block k of input is complete at the end of
// block k; the result is due at kN + S = the start of block k + 2. The work for block k (forward
// FFT, the partition multiply-adds, inverse FFT) is therefore spread over the quanta of block k + 1,
// at most one FFT of a level per quantum, so per-quantum cost stays nearly flat and grows with IR length / N instead of
// IR length / 128. Uniform 128-frame partitions cost 21.8 % of a core for a 4 s stereo IR (an
// earlier version); levels bring that down by an order of magnitude. Deterministic (no helper thread), so
// OfflineAudioContext renders stay bit-reproducible.
struct ConvolverKernel final : public Disposable {
  static ConvolverKernel* build(const BufferData* ir, bool normalize, float contextRate);
  ~ConvolverKernel() override;
  struct Level {
    int N = 0;  // block size (frames)
    int M = 1;  // quanta per block
    int S = 0;  // IR offset of partition 0
    int P = 0;  // partitions
    RealFFT* fft = nullptr;  // size 2N
    // [irChannel * P + p] -> N + 1 bins of the zero-padded partition (scaled by 1 / 2N).
    std::vector<std::vector<std::complex<float>>> parts;
    // Render state (allocated here so the render thread never allocates).
    std::vector<std::vector<std::complex<float>>> fdl[2];  // per input channel, P spectra
    int fdlPos = 0;                                          // slot of the newest spectrum
    std::vector<std::complex<float>> acc[2];                // per output channel, N + 1 bins
    std::vector<float> prev[2], cur[2];                     // per input channel, N frames
    std::vector<float> block[2];                             // 2N FFT input / output, per channel
    std::vector<float> ring[2];                              // per output channel, 2N (two results)
  };
  int channels = 0;  // 1, 2 or 4
  size_t irLength = 0;
  std::vector<Level> levels;
  uint64_t quanta = 0;  // quanta processed since the kernel was set (block clock of every level)
  int tailQuanta = 0;   // silent quanta after which every buffer of every level is zero
  size_t partitionCountForTest() const;
};

class ConvolverNode final : public Node {
 public:
  ConvolverNode();
  ~ConvolverNode() override;
  void process(Graph& g) override;
  void setProp(int prop, double v) override;
  Disposable* setKernel(Disposable* k) override;

 private:
  ConvolverKernel* kernel_ = nullptr;
  int silentQuanta_ = 0;  // > kernel_->tailQuanta: the state is all zeros and silent input renders nothing
};

class ChannelSplitterNode final : public Node {
 public:
  explicit ChannelSplitterNode(int outputs);
  void process(Graph& g) override;
};

class ChannelMergerNode final : public Node {
 public:
  explicit ChannelMergerNode(int inputs);
  void process(Graph& g) override;
};

}  // namespace iwn::audio
