// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
//
// The render-side graph of one (Offline)AudioContext and the control-batch machinery.
//
// Threading: a Batch is prepared on the main thread (prepare(): constructs node objects, copies
// curves, builds wavetables and convolver kernels, resolves buffer ids) and applied whole on the
// render thread at a quantum boundary (apply()). Objects the render thread drops are returned to
// the main thread through `garbage` and freed there (drainGarbage()).
#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "nodes.h"
#include "spsc.h"

namespace iwn::audio {

struct Attachment {
  enum Kind : uint8_t { kNone, kNode, kBuffer, kObject, kBus };
  Kind kind = kNone;
  void* ptr = nullptr;
};

// Larger storage for a render-owned vector, prepared on the main thread (GrowHint) and swapped in
// by the render thread when the batch is applied; the old storage comes back as garbage.
struct GrowPack final : public Disposable {
  enum Kind : uint8_t { kEvents, kParamInputs, kNodeInputs, kDownstream };
  Kind kind = kEvents;
  void* target = nullptr;  // Param* (kEvents, kParamInputs) or Node*
  int index = 0;           // input index (kNodeInputs)
  std::vector<ParamEvent> events;
  std::vector<OutputRef> refs;
  std::vector<Node::Downstream> down;
};

struct Batch {
  std::vector<double> words;
  // One entry per command that carries an object, in stream order. Commands that may carry one
  // (ConnectParam: input bus; SetBuffer: buffer + output bus) always take their entries, null
  // when nothing is handed over, so apply() never has to guess which command owns an entry.
  std::vector<Attachment> attachments;
  std::vector<GrowPack*> grows;  // applied before the words
  uint64_t seq = 0;
};
void deleteBatch(Batch* b);  // frees a batch that was never applied (owns its attachments)

struct GraphEvent {
  int type = 0;
  double a = 0;
  double b = 0;
};

struct GarbageItem {
  enum Kind : uint8_t { kBuffer, kObject, kBatch, kBus };
  Kind kind;
  void* ptr;
};

// Main-thread registry of AudioBuffer storage handed to JS (ids are process-wide).
class BufferRegistry {
 public:
  static BufferRegistry& get();
  uint32_t add(BufferData* b);  // takes one reference
  BufferData* find(uint32_t id) const;
  void remove(uint32_t id);     // drops the registry's reference
  void clear();                 // drops every reference (new page, PROC-8)
  size_t size() const { return map_.size(); }

 private:
  std::unordered_map<uint32_t, BufferData*> map_;
  uint32_t next_ = 1;
};

class Graph final : public Garbage {
 public:
  // shared: proto::kSharedCount doubles; paramValues: paramCapacity floats. Both stay owned by
  // the caller and outlive the graph.
  Graph(float sampleRate, int destinationChannels, double* shared, float* paramValues,
        int paramCapacity, int nodeCapacity);
  ~Graph() override;

  float sampleRate() const { return sampleRate_; }
  uint64_t frame() const { return frame_; }
  uint64_t quantum() const { return quantum_; }
  double time() const { return static_cast<double>(frame_) / sampleRate_; }
  DestinationNode* destination() { return destination_; }
  Param* listenerParam(int i) { return listener_[i].get(); }
  Node* nodeForTest(uint32_t id) const { return id < nodes_.size() ? nodes_[id] : nullptr; }
  size_t activeNodeCount() const { return active_.size() + retired_.size(); }

  // ---- main thread ----
  // Validates and prepares a batch. Returns false (and leaves nothing allocated) on a malformed
  // word stream.
  bool prepare(Batch& b);
  // Main-thread lookup of a live node (analyser reads). Null after the node was released.
  Node* mainNode(uint32_t id) const;
  void drainGarbage();
  bool pushBatch(Batch* b) { return batches_.push(b); }

  // ---- render thread ----
  // Applies every batch queued so far.
  void applyPending();
  void apply(Batch& b);
  // Renders one quantum: afterwards destination()->mixed() holds the output.
  void render();
  // False when the event queue is full (the caller retries next quantum).
  bool postEnded(uint32_t id);
  // Pull bookkeeping (render thread, see Node::pull).
  void pushPull(Node* n) {
    if (pullDepth_ < pullStack_.size()) pullStack_[pullDepth_] = n;
    ++pullDepth_;
  }
  void popPull() { --pullDepth_; }
  // `n` was re-entered while visiting: mutes every node of the cycle (stack top down to n).
  void muteCycle(Node* n);
  void deferLineWrite(Node* n) {
    if (deferredCount_ < deferred_.size()) deferred_[deferredCount_++] = n;
  }
  void publishParam(int slot, float v) {
    if (slot >= 0 && slot < paramCapacity_) paramValues_[slot] = v;
  }
  void dispose(BufferData* b) override;
  void disposeObject(Disposable* d);
  // Context state requests found in applied batches (owner consumes them).
  struct StateRequest {
    int desired;
    double requestId;
  };
  bool popStateRequest(StateRequest& r);

  // Render thread -> main thread.
  Spsc<GraphEvent> events{4096};

  static void storeShared(double* slot, double v) {
    __atomic_store(slot, &v, __ATOMIC_RELEASE);
  }
  static double loadShared(const double* slot) {
    double v;
    __atomic_load(slot, &v, __ATOMIC_ACQUIRE);
    return v;
  }
  double* shared() { return shared_; }

 private:
  Node* createNode(const double* w);
  // Main thread, prepare(): counts an addition to a growable render-side vector.
  void countGrow(GrowPack::Kind kind, void* target, int index, GrowHint* h);
  void applyGrow(GrowPack& g);
  void analyzeCycles();
  void removeNode(Node* n);
  // Parks a finished source: cuts its outgoing connections and moves it from active_ to retired_,
  // so a finished one-shot that JS still references costs no render time until it is released.
  void retire(Node* n);
  void disconnect(Node* s, int output, Node* d, int input, bool nodesOnly);
  void disconnectParam(Node* s, int output, Param* p);
  void pushGarbage(GarbageItem it);
  // Main thread: which params already received an input bus (keyed by Param*, cleared on release).
  bool mainParamHasBus(Param* p) const { return paramsWithBus_.count(p) != 0; }
  void markParamHasBus(Param* p) { paramsWithBus_.insert(p); }
  std::unordered_set<Param*> paramsWithBus_;
  struct Touched {
    GrowPack::Kind kind;
    void* target;
    int index;
    GrowHint* hint;
  };
  std::vector<Touched> touched_;  // main side, per prepare()
  // Render side.
  std::vector<Node*> pullStack_;
  size_t pullDepth_ = 0;
  std::vector<Node*> deferred_;
  size_t deferredCount_ = 0;
  std::vector<Node*> dfsStack_;
  uint64_t dfsEpoch_ = 0;
  bool topologyDirty_ = false;

  float sampleRate_;
  double* shared_;
  float* paramValues_;
  int paramCapacity_;
  uint64_t frame_ = 0;
  uint64_t quantum_ = 0;
  std::vector<Node*> nodes_;     // render side, by id
  std::vector<Param*> params_;   // render side, by slot
  std::vector<Node*> active_;    // render side, every live node except retired ones
  std::vector<Node*> retired_;   // render side, finished sources waiting for their release
  bool scanRetired_ = false;     // render side: a release arrived since retired_ was last scanned
  std::vector<Node*> mainNodes_;  // main side, by id
  std::vector<Param*> mainParams_;  // main side, by slot (listener + live nodes)
  std::unordered_map<uint32_t, bool> convolverNormalize_;  // main side
  DestinationNode* destination_;
  std::unique_ptr<Param> listener_[proto::kListenerSlots];
  Spsc<Batch*> batches_{1024};
  Spsc<GarbageItem> garbage_{16384};
  std::vector<GarbageItem> garbageOverflow_;  // render side (reserved)
  static constexpr int kStateRequestSlots = 16;
  StateRequest stateRequests_[kStateRequestSlots];
  int stateRequestCount_ = 0;
  int stateRequestRead_ = 0;
};

// Builds a node object for `type` (main thread). Exposed for tests.
Node* makeNode(int type, float sampleRate, const double* opts);

}  // namespace iwn::audio
