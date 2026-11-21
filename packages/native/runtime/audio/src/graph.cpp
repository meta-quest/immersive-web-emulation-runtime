// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
#include "graph.h"

#include <algorithm>
#include <cfloat>
#include <cmath>

namespace iwn::audio {

using namespace proto;

namespace {
constexpr float kMaxDetune = 153600.f;  // 1200 * log2(FLT_MAX), rounded
constexpr float kMaxBiquadGain = 1541.f;  // 40 * log10(FLT_MAX), rounded
constexpr uint32_t kDestinationId = 1;

inline int I(double v) { return static_cast<int>(v); }

// Walks a word stream; calls f(op, args, extraCount) for every command. Returns false if
// malformed.
template <typename F>
bool walk(const std::vector<double>& w, F&& f) {
  size_t i = 0, n = w.size();
  while (i < n) {
    int op = I(w[i]);
    int argc = argCount(op);
    if (argc < 0 || i + 1 + static_cast<size_t>(argc) > n) return false;
    const double* a = &w[i + 1];
    size_t extra = 0;
    if (op == kParamEvent) {
      double cnt = a[6];
      if (!(cnt >= 0) || cnt > 1e7) return false;
      extra = static_cast<size_t>(cnt);
    } else if (op == kPeriodicWave) {
      double cnt = a[2];
      if (!(cnt >= 0) || cnt > 1e6) return false;
      extra = 2 * static_cast<size_t>(cnt);
    }
    if (i + 1 + static_cast<size_t>(argc) + extra > n) return false;
    if (!f(op, a, extra)) return false;
    i += 1 + static_cast<size_t>(argc) + extra;
  }
  return true;
}
}  // namespace

// Connection lists hold each (node, output) pair once and their order does not matter: remove by
// swapping with the last element (O(1) per removal; a panner with thousands of finished voices
// must not make collection quadratic).
template <typename V, typename P>
void swapRemoveFirst(V& v, P pred) {
  for (size_t i = 0; i < v.size(); ++i) {
    if (pred(v[i])) {
      if (i + 1 != v.size()) v[i] = v.back();
      v.pop_back();
      return;
    }
  }
}

// ---- BufferRegistry -------------------------------------------------------------------------

BufferRegistry& BufferRegistry::get() {
  static BufferRegistry r;
  return r;
}

uint32_t BufferRegistry::add(BufferData* b) {
  uint32_t id = next_++;
  if (next_ == 0) next_ = 1;
  map_[id] = b;
  return id;
}

BufferData* BufferRegistry::find(uint32_t id) const {
  auto it = map_.find(id);
  return it == map_.end() ? nullptr : it->second;
}

void BufferRegistry::remove(uint32_t id) {
  auto it = map_.find(id);
  if (it == map_.end()) return;
  it->second->release();
  map_.erase(it);
}

void BufferRegistry::clear() {
  for (auto& kv : map_) kv.second->release();
  map_.clear();
}

// ---- node factory ---------------------------------------------------------------------------

namespace {
Node* makeNodeRaw(int type, float sampleRate, const double* opts) {
  float nyq = sampleRate / 2;
  switch (type) {
    case kGain: return new GainNode();
    case kBufferSource: {
      auto* n = new BufferSourceNode();
      n->params[1]->tl.setRange(-kMaxDetune, kMaxDetune);
      return n;
    }
    case kOscillator: {
      auto* n = new OscillatorNode();
      n->params[0]->tl.setRange(-nyq, nyq);
      n->params[1]->tl.setRange(-kMaxDetune, kMaxDetune);
      return n;
    }
    case kConstantSource: return new ConstantSourceNode();
    case kStereoPanner: return new StereoPannerNode();
    case kPanner: return new PannerNode();
    case kBiquad: {
      auto* n = new BiquadFilterNode();
      n->params[0]->tl.setRange(0, nyq);
      n->params[1]->tl.setRange(-kMaxDetune, kMaxDetune);
      n->params[3]->tl.setRange(-FLT_MAX, kMaxBiquadGain);
      return n;
    }
    case kDelay: {
      double maxDelay = opts[0] > 0 ? opts[0] : 1.0;
      return new DelayNode(std::min(maxDelay, 180.0), sampleRate);
    }
    case kAnalyser: return new AnalyserNode();
    case kConvolver: return new ConvolverNode();
    case kSplitter: return new ChannelSplitterNode(std::max(1, std::min(I(opts[0]), kMaxChannels)));
    case kMerger: return new ChannelMergerNode(std::max(1, std::min(I(opts[0]), kMaxChannels)));
    default: return nullptr;
  }
}
}  // namespace

Node* makeNode(int type, float sampleRate, const double* opts) {
  Node* n = makeNodeRaw(type, sampleRate, opts);
  if (n)
    for (auto& p : n->params) p->owner = n;
  return n;
}

void deleteBatch(Batch* b) {
  for (auto& a : b->attachments) {
    if (!a.ptr) continue;
    if (a.kind == Attachment::kNode || a.kind == Attachment::kObject) delete static_cast<Disposable*>(a.ptr);
    else if (a.kind == Attachment::kBuffer) static_cast<BufferData*>(a.ptr)->release();
    else if (a.kind == Attachment::kBus) delete static_cast<AudioBus*>(a.ptr);
  }
  for (GrowPack* g : b->grows) delete g;
  delete b;
}

// ---- Graph ----------------------------------------------------------------------------------

Graph::Graph(float sampleRate, int destinationChannels, double* shared, float* paramValues,
             int paramCapacity, int nodeCapacity)
    : sampleRate_(sampleRate),
      shared_(shared),
      paramValues_(paramValues),
      paramCapacity_(paramCapacity) {
  nodes_.assign(static_cast<size_t>(nodeCapacity), nullptr);
  mainNodes_.assign(static_cast<size_t>(nodeCapacity), nullptr);
  mainParams_.assign(static_cast<size_t>(paramCapacity), nullptr);
  params_.assign(static_cast<size_t>(paramCapacity), nullptr);
  active_.reserve(static_cast<size_t>(nodeCapacity));
  retired_.reserve(static_cast<size_t>(nodeCapacity));
  garbageOverflow_.reserve(4096);
  pullStack_.assign(static_cast<size_t>(nodeCapacity) + 1, nullptr);
  deferred_.assign(static_cast<size_t>(nodeCapacity) + 1, nullptr);
  dfsStack_.reserve(static_cast<size_t>(nodeCapacity) + 1);
  touched_.reserve(256);
  destination_ = new DestinationNode(destinationChannels);
  destination_->id = kDestinationId;
  nodes_[kDestinationId] = destination_;
  destination_->activeIndex = 0;
  active_.push_back(destination_);
  mainNodes_[kDestinationId] = destination_;
  // AudioListener: position (0,0,0), forward (0,0,-1), up (0,1,0); a-rate.
  const float defaults[kListenerSlots] = {0, 0, 0, 0, 0, -1, 0, 1, 0};
  for (int i = 0; i < kListenerSlots; ++i) {
    listener_[i].reset(new Param(defaults[i], -FLT_MAX, FLT_MAX, true));
    listener_[i]->slot = i;
    params_[static_cast<size_t>(i)] = listener_[i].get();
    mainParams_[static_cast<size_t>(i)] = listener_[i].get();
    publishParam(i, defaults[i]);
  }
}

Graph::~Graph() {
  // Owner guarantees the render thread has stopped.
  Batch* b;
  while (batches_.pop(b)) deleteBatch(b);
  drainGarbage();
  for (GarbageItem& it : garbageOverflow_) {
    if (it.kind == GarbageItem::kBuffer) static_cast<BufferData*>(it.ptr)->destroy();
    else if (it.kind == GarbageItem::kObject) delete static_cast<Disposable*>(it.ptr);
    else if (it.kind == GarbageItem::kBus) delete static_cast<AudioBus*>(it.ptr);
    else delete static_cast<Batch*>(it.ptr);
  }
  for (Node* n : active_) delete n;
  for (Node* n : retired_) delete n;
}

Node* Graph::mainNode(uint32_t id) const { return id < mainNodes_.size() ? mainNodes_[id] : nullptr; }

bool Graph::prepare(Batch& b) {
  // Pass 1: validate the stream. __iwn.audio.submit is reachable from app JS, so the words are
  // untrusted: a CreateNode must name a free id and free param slots (reusing a live one would
  // leave stale Param pointers behind), and a PeriodicWave must target a live oscillator.
  std::unordered_map<uint32_t, int> createdTypes;  // id -> type, created earlier in this batch
  std::unordered_set<int> claimedSlots;
  auto liveType = [&](double id) -> int {
    if (!(id >= 0) || id >= static_cast<double>(mainNodes_.size())) return -1;
    uint32_t i = static_cast<uint32_t>(id);
    auto it = createdTypes.find(i);
    if (it != createdTypes.end()) return it->second;
    return mainNodes_[i] ? mainNodes_[i]->type() : -1;
  };
  bool ok = walk(b.words, [&](int op, const double* a, size_t) {
    if (op == kCreateNode) {
      double id = a[0];
      if (!(id >= 2) || id >= static_cast<double>(nodes_.size())) return false;
      int type = I(a[1]);
      if (type <= kDestination || type >= kNodeTypeCount) return false;
      int slotBase = I(a[2]), np = paramCount(type);
      if (np > 0 && (slotBase < kListenerSlots || slotBase + np > paramCapacity_)) return false;
      if (liveType(id) >= 0) return false;
      for (int s = slotBase; s < slotBase + np; ++s) {
        if (mainParams_[static_cast<size_t>(s)] || !claimedSlots.insert(s).second) return false;
      }
      createdTypes[static_cast<uint32_t>(id)] = type;
    } else if (op == kPeriodicWave) {
      if (liveType(a[0]) != kOscillator) return false;
    }
    return true;
  });
  if (!ok) return false;
  // Pass 2: build attachments in stream order.
  b.attachments.reserve(b.words.size() / 16 + 4);
  std::vector<Node*> created;
  walk(b.words, [&](int op, const double* a, size_t extra) {
    switch (op) {
      case kCreateNode: {
        Node* n = makeNode(I(a[1]), sampleRate_, a + 6);
        n->id = static_cast<uint32_t>(a[0]);
        n->setProp(kPropChannelCount, a[3]);
        n->setProp(kPropChannelCountMode, a[4]);
        n->setProp(kPropChannelInterpretation, a[5]);
        int slot = I(a[2]);
        for (auto& p : n->params) {
          mainParams_[static_cast<size_t>(slot)] = p.get();
          p->slot = slot++;
        }
        mainNodes_[n->id] = n;
        n->createdInPendingBatch = true;
        created.push_back(n);
        b.attachments.push_back({Attachment::kNode, n});
        break;
      }
      case kReleaseNode:
        if (a[0] >= 0 && a[0] < static_cast<double>(mainNodes_.size())) {
          Node*& slotRef = mainNodes_[static_cast<size_t>(a[0])];
          if (slotRef) {
            for (auto& p : slotRef->params) {
              paramsWithBus_.erase(p.get());
              if (p->slot >= 0 && mainParams_[static_cast<size_t>(p->slot)] == p.get()) mainParams_[static_cast<size_t>(p->slot)] = nullptr;
            }
          }
          slotRef = nullptr;
        }
        convolverNormalize_.erase(static_cast<uint32_t>(a[0]));
        break;
      case kConnect: {
        Node* s = mainNode(static_cast<uint32_t>(std::max(0.0, a[0])));
        Node* d = mainNode(static_cast<uint32_t>(std::max(0.0, a[2])));
        int in = I(a[3]);
        if (s && d && in >= 0 && in < d->numInputs()) {
          countGrow(GrowPack::kDownstream, s, 0, &s->downstreamHint);
          countGrow(GrowPack::kNodeInputs, d, in, &d->inputHints[static_cast<size_t>(in)]);
        }
        break;
      }
      case kConnectParam: {
        // The param's input bus is allocated here (main thread), the first time it gets an input.
        // The command always carries one attachment (null when the param has a bus already).
        double slot = a[2];
        Param* p = (slot >= 0 && slot < static_cast<double>(mainParams_.size())) ? mainParams_[static_cast<size_t>(slot)] : nullptr;
        AudioBus* bus = nullptr;
        if (p && !mainParamHasBus(p)) {
          markParamHasBus(p);
          bus = new AudioBus(1);
        }
        b.attachments.push_back({Attachment::kBus, bus});
        Node* s = mainNode(static_cast<uint32_t>(std::max(0.0, a[0])));
        if (s && p) {
          countGrow(GrowPack::kDownstream, s, 0, &s->downstreamHint);
          countGrow(GrowPack::kParamInputs, p, 0, &p->inputsHint);
        }
        break;
      }
      case kSetProp:
        if (I(a[1]) == kPropNormalize) convolverNormalize_[static_cast<uint32_t>(a[0])] = a[2] != 0;
        break;
      case kSetBuffer: {
        uint32_t nodeId = static_cast<uint32_t>(a[0]);
        Node* n = mainNode(nodeId);
        BufferData* buf = BufferRegistry::get().find(static_cast<uint32_t>(a[1]));
        if (n && n->type() == kConvolver) {
          Disposable* k = nullptr;
          if (buf) {
            auto it = convolverNormalize_.find(nodeId);
            bool norm = it == convolverNormalize_.end() ? true : it->second;
            k = ConvolverKernel::build(buf, norm, sampleRate_);
          }
          b.attachments.push_back({Attachment::kObject, k});
        } else {
          if (buf) buf->ref();
          b.attachments.push_back({Attachment::kBuffer, buf});
          // A buffer with more channels than the source's output bus: hand over a larger bus. The
          // command always carries this second attachment (null when no bus is handed over).
          AudioBus* bigger = nullptr;
          if (n && buf && n->type() == kBufferSource && buf->channels() > n->outputs[0]->capacity()) {
            auto* bus = new AudioBus(std::min(buf->channels(), kBusChannels));
            if (n->createdInPendingBatch) {
              delete static_cast<ScheduledSource*>(n)->swapOutputBus(bus);  // not visible to render yet
            } else {
              bigger = bus;
            }
          }
          b.attachments.push_back({Attachment::kBus, bigger});
        }
        break;
      }
      case kParamEvent: {
        double slot = a[0];
        Param* p = (slot >= 0 && slot < static_cast<double>(mainParams_.size())) ? mainParams_[static_cast<size_t>(slot)] : nullptr;
        if (p) countGrow(GrowPack::kEvents, p, 0, &p->tl.hint);
        if (I(a[1]) == ParamEvent::SetCurve) {
          BufferData* c = BufferData::create(1, extra, sampleRate_);
          for (size_t i = 0; i < extra; ++i) c->channel(0)[i] = static_cast<float>(a[7 + i]);
          b.attachments.push_back({Attachment::kBuffer, c});
        }
        break;
      }
      case kPeriodicWave: {
        int n = I(a[2]);
        std::vector<float> re(static_cast<size_t>(n)), im(static_cast<size_t>(n));
        for (int i = 0; i < n; ++i) {
          re[static_cast<size_t>(i)] = static_cast<float>(a[3 + i]);
          im[static_cast<size_t>(i)] = static_cast<float>(a[3 + n + i]);
        }
        b.attachments.push_back({Attachment::kObject, WaveTable::build(re.data(), im.data(), n, a[1] == 0)});
        break;
      }
      default:
        break;
    }
    return true;
  });
  // Storage for the render-side vectors this batch grows (AUD-10: the render thread does not
  // allocate). Nodes created by this batch are not visible to the render thread yet: reserve
  // directly. Live ones get larger storage that apply() swaps in.
  constexpr uint32_t kSlack = 4;
  for (const Touched& t : touched_) {
    uint32_t add = t.hint->mainPending;
    t.hint->mainPending = 0;
    bool events = t.kind == GrowPack::kEvents;
    bool paramTarget = events || t.kind == GrowPack::kParamInputs;
    Param* p = paramTarget ? static_cast<Param*>(t.target) : nullptr;
    Node* n = paramTarget ? (p->owner) : static_cast<Node*>(t.target);
    uint32_t limit = events ? static_cast<uint32_t>(ParamTimeline::kMaxEvents) : 0xffffffffu;
    if (n && n->createdInPendingBatch) {
      size_t want = std::min(add + kSlack, limit);
      switch (t.kind) {
        case GrowPack::kEvents: p->tl.reserve(want); break;
        case GrowPack::kParamInputs: p->inputs.reserve(want); p->inputsHint.publish(p->inputs); break;
        case GrowPack::kNodeInputs: {
          auto& v = n->inputs[static_cast<size_t>(t.index)];
          v.reserve(want);
          n->inputHints[static_cast<size_t>(t.index)].publish(v);
          break;
        }
        case GrowPack::kDownstream: n->downstream.reserve(want); n->downstreamHint.publish(n->downstream); break;
      }
      continue;
    }
    uint32_t size = t.hint->size.load(std::memory_order_relaxed);
    uint32_t cap = std::max(t.hint->cap.load(std::memory_order_relaxed), t.hint->mainGranted);
    uint32_t need = std::min(size + add + kSlack, limit);
    if (need <= cap) continue;
    uint32_t newCap = std::min(std::max(need * 2, 8u), limit);
    if (newCap <= cap) continue;
    auto* g = new GrowPack();
    g->kind = t.kind;
    g->target = t.target;
    g->index = t.index;
    switch (t.kind) {
      case GrowPack::kEvents: g->events.reserve(newCap); break;
      case GrowPack::kParamInputs:
      case GrowPack::kNodeInputs: g->refs.reserve(newCap); break;
      case GrowPack::kDownstream: g->down.reserve(newCap); break;
    }
    t.hint->mainGranted = newCap;
    b.grows.push_back(g);
  }
  touched_.clear();
  for (Node* n : created) n->createdInPendingBatch = false;
  return true;
}

void Graph::countGrow(GrowPack::Kind kind, void* target, int index, GrowHint* h) {
  if (h->mainPending++ == 0) touched_.push_back({kind, target, index, h});
}

void Graph::applyGrow(GrowPack& g) {
  auto swapIn = [](auto& v, auto& storage, GrowHint& h) {
    if (storage.capacity() <= v.capacity() || storage.capacity() < v.size()) return;
    storage.assign(v.begin(), v.end());  // fits: no allocation
    v.swap(storage);
    h.publish(v);
  };
  switch (g.kind) {
    case GrowPack::kEvents: static_cast<Param*>(g.target)->tl.adoptStorage(g.events); break;
    case GrowPack::kParamInputs: {
      auto* p = static_cast<Param*>(g.target);
      swapIn(p->inputs, g.refs, p->inputsHint);
      break;
    }
    case GrowPack::kNodeInputs: {
      auto* n = static_cast<Node*>(g.target);
      if (g.index >= 0 && g.index < n->numInputs())
        swapIn(n->inputs[static_cast<size_t>(g.index)], g.refs, n->inputHints[static_cast<size_t>(g.index)]);
      break;
    }
    case GrowPack::kDownstream: {
      auto* n = static_cast<Node*>(g.target);
      swapIn(n->downstream, g.down, n->downstreamHint);
      break;
    }
  }
}

void Graph::applyPending() {
  Batch* b;
  while (batches_.pop(b)) {
    apply(*b);
    storeShared(&shared_[kSharedAppliedSeq], static_cast<double>(b->seq));
    pushGarbage({GarbageItem::kBatch, b});
  }
}

void Graph::apply(Batch& b) {
  // Grown storage first (the targets are alive: see prepare()), then the commands.
  for (GrowPack* g : b.grows) {
    applyGrow(*g);
    disposeObject(g);
  }
  b.grows.clear();
  size_t att = 0;
  auto take = [&]() -> Attachment {
    return att < b.attachments.size() ? b.attachments[att++] : Attachment{};
  };
  auto node = [&](double id) -> Node* {
    if (!(id >= 0) || id >= static_cast<double>(nodes_.size())) return nullptr;
    return nodes_[static_cast<size_t>(id)];
  };
  auto param = [&](double slot) -> Param* {
    if (!(slot >= 0) || slot >= static_cast<double>(params_.size())) return nullptr;
    return params_[static_cast<size_t>(slot)];
  };
  walk(b.words, [&](int op, const double* a, size_t extra) {
    switch (op) {
      case kCreateNode: {
        Attachment at = take();
        Node* n = static_cast<Node*>(at.ptr);
        if (!n) break;
        if (nodes_[n->id]) removeNode(nodes_[n->id]);  // id reuse after release (defensive)
        nodes_[n->id] = n;
        n->activeIndex = active_.size();
        for (auto& p : n->params)
          if (p->slot >= 0 && p->slot < paramCapacity_) {
            params_[static_cast<size_t>(p->slot)] = p.get();
            publishParam(p->slot, p->tl.defaultValue());
          }
        active_.push_back(n);
        break;
      }
      case kConnect: {
        Node* s = node(a[0]);
        Node* d = node(a[2]);
        int out = I(a[1]), in = I(a[3]);
        if (!s || !d || out < 0 || out >= s->numOutputs() || in < 0 || in >= d->numInputs()) break;
        if (s->retired) break;  // a finished source outputs silence for good
        auto& list = d->inputs[static_cast<size_t>(in)];
        bool exists = std::any_of(list.begin(), list.end(),
                                  [&](const OutputRef& r) { return r.node == s && r.output == out; });
        if (exists) break;
        rtPush(list, OutputRef{s, out}, d->inputHints[static_cast<size_t>(in)]);
        rtPush(s->downstream, Node::Downstream{d, out, in, nullptr}, s->downstreamHint);
        topologyDirty_ = true;
        break;
      }
      case kConnectParam: {
        if (auto* bus = static_cast<AudioBus*>(take().ptr)) {
          Param* bp = param(a[2]);
          if (bp && !bp->hasInputBus()) bus = bp->installInputBus(bus);
          if (bus) pushGarbage({GarbageItem::kBus, bus});
        }
        Node* s = node(a[0]);
        Param* p = param(a[2]);
        int out = I(a[1]);
        if (!s || !p || out < 0 || out >= s->numOutputs()) break;
        if (s->retired) break;
        bool exists = std::any_of(p->inputs.begin(), p->inputs.end(),
                                  [&](const OutputRef& r) { return r.node == s && r.output == out; });
        if (exists) break;
        rtPush(p->inputs, OutputRef{s, out}, p->inputsHint);
        rtPush(s->downstream, Node::Downstream{nullptr, out, 0, p}, s->downstreamHint);
        topologyDirty_ = true;
        break;
      }
      case kDisconnect: {
        Node* s = node(a[0]);
        if (!s) break;
        Node* d = a[2] >= 0 ? node(a[2]) : nullptr;
        if (a[2] >= 0 && !d) break;
        disconnect(s, I(a[1]), d, I(a[3]), a[2] >= 0);
        topologyDirty_ = true;
        break;
      }
      case kDisconnectParam: {
        Node* s = node(a[0]);
        Param* p = param(a[2]);
        if (s && p) disconnectParam(s, I(a[1]), p);
        topologyDirty_ = true;
        break;
      }
      case kReleaseNode: {
        Node* n = node(a[0]);
        if (n && n != destination_) {
          n->released = true;
          if (n->retired) scanRetired_ = true;
        }
        break;
      }
      case kParamEvent: {
        Param* p = param(a[0]);
        int kind = I(a[1]);
        BufferData* curve = nullptr;
        if (kind == ParamEvent::SetCurve) curve = static_cast<BufferData*>(take().ptr);
        if (!p) {
          if (curve && curve->release_rt()) dispose(curve);
          break;
        }
        ParamEvent e;
        e.type = static_cast<ParamEvent::Type>(kind);
        e.time = a[2];
        e.value = static_cast<float>(a[3]);
        if (kind == ParamEvent::SetTarget) e.timeConstant = a[4];
        if (kind == ParamEvent::SetCurve) {
          e.duration = a[4];
          e.curve = curve;
        }
        e.insertTime = a[5];
        p->tl.insert(e, this);
        (void)extra;
        break;
      }
      case kParamCancel: {
        Param* p = param(a[0]);
        if (!p) break;
        if (a[2] != 0) p->tl.cancelAndHoldAtTime(a[1], this);
        else p->tl.cancelScheduledValues(a[1], this, time());
        break;
      }
      case kParamRate: {
        Param* p = param(a[0]);
        if (p && !p->rateFixed) p->aRate = a[1] != 0;
        break;
      }
      case kSetProp: {
        Node* n = node(a[0]);
        if (n) n->setProp(I(a[1]), a[2]);
        break;
      }
      case kSetBuffer: {
        Attachment at = take();
        Node* n = node(a[0]);
        if (at.kind == Attachment::kObject) {
          Disposable* k = static_cast<Disposable*>(at.ptr);
          Disposable* old = n && n->type() == kConvolver ? n->setKernel(k) : k;
          if (old) disposeObject(old);
        } else {
          BufferData* buf = static_cast<BufferData*>(at.ptr);
          BufferData* old = n ? n->setBuffer(buf) : buf;
          if (old && old->release_rt()) dispose(old);
          if (auto* bus = static_cast<AudioBus*>(take().ptr)) {
            if (n && n->type() == kBufferSource) bus = static_cast<ScheduledSource*>(n)->swapOutputBus(bus);
            pushGarbage({GarbageItem::kBus, bus});
          }
        }
        break;
      }
      case kStart: {
        Node* n = node(a[0]);
        if (n) n->start(a[1], a[2], a[3]);
        break;
      }
      case kStop: {
        Node* n = node(a[0]);
        if (n) n->stop(a[1]);
        break;
      }
      case kPeriodicWave: {
        Attachment at = take();
        Node* n = node(a[0]);
        Disposable* k = static_cast<Disposable*>(at.ptr);
        Disposable* old = n && n->type() == kOscillator ? n->setKernel(k) : k;
        if (old) disposeObject(old);
        break;
      }
      case kContextState: {
        int desired = I(a[0]);
        if (stateRequestCount_ - stateRequestRead_ < kStateRequestSlots) {
          stateRequests_[stateRequestCount_ % kStateRequestSlots] = {desired, a[1]};
          ++stateRequestCount_;
        } else {
          // Full (many resume()/suspend() calls before the owner handled any): fold this request
          // into the newest one. Acknowledgements are cumulative (an ack for request id N settles
          // every earlier request too, see Context::handleStateRequests), and the result is the
          // same: the later request wins, except that a close is final.
          StateRequest& last = stateRequests_[(stateRequestCount_ - 1) % kStateRequestSlots];
          last.desired = (last.desired == 2 || desired == 2) ? 2 : desired;
          last.requestId = a[1];
        }
        break;
      }
      default:
        break;
    }
    return true;
  });
}

bool Graph::popStateRequest(StateRequest& r) {
  if (stateRequestRead_ == stateRequestCount_) return false;
  r = stateRequests_[stateRequestRead_ % kStateRequestSlots];
  ++stateRequestRead_;
  return true;
}

void Graph::disconnect(Node* s, int output, Node* d, int input, bool nodesOnly) {
  for (size_t i = 0; i < s->downstream.size();) {
    Node::Downstream& ds = s->downstream[i];
    bool match = (output < 0 || ds.output == output);
    if (nodesOnly) match = match && ds.node && ds.node == d && (input < 0 || ds.input == input);
    if (!match) {
      ++i;
      continue;
    }
    int out = ds.output;
    if (ds.node) {
      auto& v = ds.node->inputs[static_cast<size_t>(ds.input)];
      swapRemoveFirst(v, [&](const OutputRef& r) { return r.node == s && r.output == out; });
      ds.node->inputHints[static_cast<size_t>(ds.input)].publish(v);
    } else if (ds.param) {
      swapRemoveFirst(ds.param->inputs, [&](const OutputRef& r) { return r.node == s && r.output == out; });
      ds.param->inputsHint.publish(ds.param->inputs);
    }
    if (i + 1 != s->downstream.size()) s->downstream[i] = s->downstream.back();
    s->downstream.pop_back();
  }
  s->downstreamHint.publish(s->downstream);
}

void Graph::disconnectParam(Node* s, int output, Param* p) {
  for (size_t i = 0; i < s->downstream.size();) {
    Node::Downstream& ds = s->downstream[i];
    if (ds.param == p && (output < 0 || ds.output == output)) {
      int out = ds.output;
      swapRemoveFirst(p->inputs, [&](const OutputRef& r) { return r.node == s && r.output == out; });
      if (i + 1 != s->downstream.size()) s->downstream[i] = s->downstream.back();
      s->downstream.pop_back();
    } else {
      ++i;
    }
  }
  p->inputsHint.publish(p->inputs);
  s->downstreamHint.publish(s->downstream);
}

void Graph::removeNode(Node* n) {
  topologyDirty_ = true;
  // Upstream connections into n.
  for (size_t in = 0; in < n->inputs.size(); ++in) {
    for (const OutputRef& r : n->inputs[in]) {
      swapRemoveFirst(r.node->downstream, [&](const Node::Downstream& d) {
        return d.node == n && d.input == static_cast<int>(in) && d.output == r.output;
      });
      r.node->downstreamHint.publish(r.node->downstream);
    }
    n->inputs[in].clear();
  }
  for (auto& p : n->params) {
    for (const OutputRef& r : p->inputs) {
      Param* pp = p.get();
      swapRemoveFirst(r.node->downstream, [&](const Node::Downstream& d) { return d.param == pp && d.output == r.output; });
      r.node->downstreamHint.publish(r.node->downstream);
    }
    p->inputs.clear();
    if (p->slot >= 0 && p->slot < paramCapacity_ && params_[static_cast<size_t>(p->slot)] == p.get())
      params_[static_cast<size_t>(p->slot)] = nullptr;
  }
  // Downstream connections out of n.
  disconnect(n, -1, nullptr, -1, false);
  if (n->id < nodes_.size() && nodes_[n->id] == n) {
    nodes_[n->id] = nullptr;
    events.push({kEvNodeFreed, static_cast<double>(n->id), 0});
  }
  std::vector<Node*>& list = n->retired ? retired_ : active_;
  size_t ai = n->activeIndex;
  if (ai < list.size() && list[ai] == n) {
    list[ai] = list.back();
    list[ai]->activeIndex = ai;
    list.pop_back();
  }
  disposeObject(n);
}

void Graph::retire(Node* n) {
  disconnect(n, -1, nullptr, -1, false);
  topologyDirty_ = true;
  size_t ai = n->activeIndex;
  if (ai < active_.size() && active_[ai] == n) {
    active_[ai] = active_.back();
    active_[ai]->activeIndex = ai;
    active_.pop_back();
  }
  n->activeIndex = retired_.size();
  retired_.push_back(n);  // reserved for the node capacity: no allocation
  n->retired = true;
}

void Graph::render() {
  if (topologyDirty_) {
    analyzeCycles();
    topologyDirty_ = false;
  }
  // Listener params publish their values even without a panner.
  for (auto& l : listener_) l->process(*this);
  deferredCount_ = 0;
  pullDepth_ = 0;
  for (size_t i = 0; i < active_.size(); ++i) active_[i]->pull(*this);
  // Writer halves of DelayNodes in cycles, now that every node rendered this quantum.
  for (size_t i = 0; i < deferredCount_; ++i) deferred_[i]->writeLine(*this);
  // Collect released nodes that can no longer be heard. Each removal posts NodeFreed: when the
  // event queue is full, collection waits for the main thread to drain it (an id whose
  // NodeFreed was lost would never be reused).
  // Finished sources still referenced from JS are parked (retire) instead.
  for (size_t i = 0; i < active_.size();) {
    Node* n = active_[i];
    if (n->released && n->canBeCollected()) {
      if (events.freeSlots() == 0) break;
      removeNode(n);  // swaps the last node into slot i
    } else if (n->isFinished()) {
      retire(n);  // swaps the last node into slot i
    } else {
      ++i;
    }
  }
  if (scanRetired_) {
    scanRetired_ = false;
    for (size_t i = 0; i < retired_.size();) {
      Node* n = retired_[i];
      if (!n->released) {
        ++i;
      } else if (events.freeSlots() == 0) {
        scanRetired_ = true;  // retry next quantum
        break;
      } else {
        removeNode(n);  // swaps the last retired node into slot i
      }
    }
  }
  frame_ += kQuantum;
  ++quantum_;
  storeShared(&shared_[kSharedFrame], static_cast<double>(frame_));
  // Retry garbage that did not fit earlier.
  while (!garbageOverflow_.empty() && garbage_.push(garbageOverflow_.back())) garbageOverflow_.pop_back();
}

bool Graph::postEnded(uint32_t id) { return events.push({kEvEnded, static_cast<double>(id), 0}); }

void Graph::muteCycle(Node* n) {
  size_t depth = std::min(pullDepth_, pullStack_.size());
  for (size_t i = depth; i-- > 0;) {
    Node* m = pullStack_[i];
    m->mutedQuantum = quantum_;
    if (m == n) break;
  }
}

void Graph::analyzeCycles() {
  // A DelayNode is in a cycle when it can reach itself through node and AudioParam connections.
  // Runs on the render thread after topology changes; marks avoid revisiting, so each search is
  // linear in what the delay reaches (usually a few nodes) and the stack never exceeds the node
  // count it was reserved for.
  for (Node* d : active_) {
    if (!d->isDelay()) continue;
    ++dfsEpoch_;
    bool cyc = false;
    dfsStack_.clear();
    auto visit = [&](const Node::Downstream& ds) {
      Node* m = ds.node ? ds.node : (ds.param ? ds.param->owner : nullptr);
      if (!m) return;
      if (m == d) {
        cyc = true;
        return;
      }
      if (m->dfsMark == dfsEpoch_) return;
      m->dfsMark = dfsEpoch_;
      dfsStack_.push_back(m);
    };
    for (const auto& ds : d->downstream) visit(ds);
    while (!cyc && !dfsStack_.empty()) {
      Node* m = dfsStack_.back();
      dfsStack_.pop_back();
      for (const auto& ds : m->downstream) {
        visit(ds);
        if (cyc) break;
      }
    }
    d->inCycle = cyc;
  }
}

void Graph::pushGarbage(GarbageItem it) {
  if (!garbage_.push(it)) {
    if (garbageOverflow_.size() < garbageOverflow_.capacity()) garbageOverflow_.push_back(it);
    // else: leaked rather than freed on the render thread (bounded by the overflow capacity).
  }
}

void Graph::dispose(BufferData* b) { pushGarbage({GarbageItem::kBuffer, b}); }

void Graph::disposeObject(Disposable* d) { pushGarbage({GarbageItem::kObject, d}); }

void Graph::drainGarbage() {
  GarbageItem it;
  while (garbage_.pop(it)) {
    switch (it.kind) {
      case GarbageItem::kBuffer: static_cast<BufferData*>(it.ptr)->destroy(); break;
      case GarbageItem::kObject: delete static_cast<Disposable*>(it.ptr); break;
      case GarbageItem::kBatch: delete static_cast<Batch*>(it.ptr); break;
      case GarbageItem::kBus: delete static_cast<AudioBus*>(it.ptr); break;
    }
  }
}

}  // namespace iwn::audio
