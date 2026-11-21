// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
//
// Thin V8 layer over the audio core: installs `natives.audio` (globalThis.__iwn.audio). The
// JS-visible contract is documented in web/audio/src/natives.ts. Written against the V8 15.5
// embedder API; it also compiles against Node 24's V8 (13.6) for the host Node addon, so it
// sticks to API present in both.
#include <v8.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <memory>
#include <vector>

#include "context.h"
#include "decode.h"
#include "iwn/audio.h"
#include "notify.h"

#ifdef IWN_AUDIO_WITH_CORE
#include "iwn/core/json.h"
#include "iwn/core/runtime.h"
#endif

using namespace iwn::audio;
using v8::Array;
using v8::ArrayBuffer;
using v8::BackingStore;
using v8::Float32Array;
using v8::Float64Array;
using v8::Function;
using v8::FunctionCallbackInfo;
using v8::FunctionTemplate;
using v8::Global;
using v8::HandleScope;
using v8::Isolate;
using v8::Local;
using v8::Number;
using v8::Object;
using v8::String;
using v8::Uint8Array;
using v8::Value;

namespace {

struct BindingState {
  Isolate* isolate = nullptr;
  Global<v8::Context> context;
  Global<Function> handler;
};
BindingState* g_state = nullptr;

// Native memory a context keeps alive (graph tables, queues, shared block): reported to V8 so that
// dropping many (Offline)AudioContexts makes the GC collect them (their FinalizationRegistry then
// releases the native side).
constexpr int64_t kContextExternalBytes = int64_t(5) << 19;  // ~2.5 MB

// AdjustAmountOfExternalAllocatedMemory is deprecated in V8 15.5 in favour of
// ExternalMemoryAccounter, which Node 24's V8 (host addon) does not ship; it still works in both.
// The accounter would also have to be emptied per isolate before a relaunch (binding state).
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wdeprecated-declarations"
void accountContexts(Isolate* iso, int count) {
  if (count != 0) iso->AdjustAmountOfExternalAllocatedMemory(count * kContextExternalBytes);
}
#pragma GCC diagnostic pop

Local<String> str(Isolate* iso, const char* s) {
  return String::NewFromUtf8(iso, s).ToLocalChecked();
}

void throwType(Isolate* iso, const char* msg) { iso->ThrowException(v8::Exception::TypeError(str(iso, msg))); }
void throwError(Isolate* iso, const std::string& msg) { iso->ThrowException(v8::Exception::Error(str(iso, msg.c_str()))); }

double num(const FunctionCallbackInfo<Value>& info, int i, double def = 0) {
  if (i >= info.Length() || !info[i]->IsNumber()) return def;
  return info[i].As<Number>()->Value();
}

void set(Isolate* iso, Local<v8::Context> ctx, Local<Object> o, const char* k, Local<Value> v) {
  o->Set(ctx, str(iso, k), v).Check();
}

// Float32Array aliasing one channel of a BufferData (holds a reference).
Local<Float32Array> channelView(Isolate* iso, BufferData* b, int c) {
  b->ref();
  std::unique_ptr<BackingStore> bs = ArrayBuffer::NewBackingStore(
      b->channel(c), b->channelBytes(),
      [](void*, size_t, void* data) { static_cast<BufferData*>(data)->release(); }, b);
  Local<ArrayBuffer> ab = ArrayBuffer::New(iso, std::move(bs));
  return Float32Array::New(ab, 0, b->length());
}

Local<Array> bufferArray(Isolate* iso, Local<v8::Context> ctx, uint32_t id, BufferData* b, bool withInfo) {
  int base = withInfo ? 4 : 1;
  Local<Array> a = Array::New(iso, base + b->channels());
  a->Set(ctx, 0, Number::New(iso, id)).Check();
  if (withInfo) {
    a->Set(ctx, 1, Number::New(iso, b->channels())).Check();
    a->Set(ctx, 2, Number::New(iso, static_cast<double>(b->length()))).Check();
    a->Set(ctx, 3, Number::New(iso, b->sampleRate())).Check();
  }
  for (int c = 0; c < b->channels(); ++c) a->Set(ctx, static_cast<uint32_t>(base + c), channelView(iso, b, c)).Check();
  return a;
}

Context* ctxArg(const FunctionCallbackInfo<Value>& info, int i) {
  Context* c = findContext(static_cast<uint32_t>(num(info, i, 0)));
  if (!c) throwError(info.GetIsolate(), "iwn.audio: unknown context");
  return c;
}

// ---- functions ------------------------------------------------------------------------------

// createContext(kind, sampleRate, channels, length, latencyHint) -> [id, sampleRate, Float64Array, Float32Array]
void CreateContext(const FunctionCallbackInfo<Value>& info) {
  Isolate* iso = info.GetIsolate();
  Local<v8::Context> ctx = iso->GetCurrentContext();
  int kind = static_cast<int>(num(info, 0));
  double rate = num(info, 1);
  std::string err;
  iwn::audio::Context* c = nullptr;
  if (kind == 0) {
    c = iwn::audio::Context::createRealtime(static_cast<float>(rate), static_cast<int>(num(info, 4)), &err);
  } else {
    int channels = static_cast<int>(num(info, 2, 1));
    double length = num(info, 3, 0);
    if (channels < 1 || channels > kMaxChannels || !(length >= 1) || length > 4294967295.0 ||
        rate < kMinSampleRate || rate > kMaxSampleRate) {
      iso->ThrowException(v8::Exception::RangeError(str(iso, "invalid OfflineAudioContext options")));
      return;
    }
    c = iwn::audio::Context::createOffline(channels, static_cast<uint32_t>(length), static_cast<float>(rate), &err);
  }
  if (!c) {
    throwError(iso, "iwn.audio: " + err);
    return;
  }
  accountContexts(iso, 1);
  SharedBlock* blk = c->block();
  auto release = [](void*, size_t, void* data) { static_cast<SharedBlock*>(data)->release(); };
  blk->ref();
  Local<ArrayBuffer> sab = ArrayBuffer::New(
      iso, ArrayBuffer::NewBackingStore(blk->shared, sizeof blk->shared, release, blk));
  blk->ref();
  Local<ArrayBuffer> pab = ArrayBuffer::New(
      iso, ArrayBuffer::NewBackingStore(blk->params, sizeof blk->params, release, blk));
  Local<Array> a = Array::New(iso, 4);
  a->Set(ctx, 0, Number::New(iso, c->id())).Check();
  a->Set(ctx, 1, Number::New(iso, c->sampleRate())).Check();
  a->Set(ctx, 2, Float64Array::New(sab, 0, proto::kSharedCount)).Check();
  a->Set(ctx, 3, Float32Array::New(pab, 0, SharedBlock::kParamCapacity)).Check();
  info.GetReturnValue().Set(a);
}

void ReleaseContext(const FunctionCallbackInfo<Value>& info) {
  uint32_t id = static_cast<uint32_t>(num(info, 0));
  if (!findContext(id)) return;
  destroyContext(id);
  accountContexts(info.GetIsolate(), -1);
}

// submit(ctxId, Float64Array words, count) -> sequence number
void Submit(const FunctionCallbackInfo<Value>& info) {
  Isolate* iso = info.GetIsolate();
  iwn::audio::Context* c = ctxArg(info, 0);
  if (!c) return;
  if (info.Length() < 3 || !info[1]->IsFloat64Array()) {
    throwType(iso, "iwn.audio.submit: expected Float64Array");
    return;
  }
  Local<Float64Array> w = info[1].As<Float64Array>();
  size_t count = static_cast<size_t>(std::max(0.0, num(info, 2)));
  if (count > w->Length()) count = w->Length();
  // Read the words in place (Context::submit copies them into the batch): no temporary per submit.
  const double* words = reinterpret_cast<const double*>(static_cast<const uint8_t*>(w->Buffer()->Data()) + w->ByteOffset());
  uint64_t seq = c->submit(words, count);
  if (!seq) {
    throwType(iso, "iwn.audio.submit: malformed control batch");
    return;
  }
  info.GetReturnValue().Set(Number::New(iso, static_cast<double>(seq)));
}

void StartRendering(const FunctionCallbackInfo<Value>& info) {
  iwn::audio::Context* c = ctxArg(info, 0);
  if (!c) return;
  info.GetReturnValue().Set(c->startRendering());
}

// createBuffer(channels, length, sampleRate) -> [bufferId, ...Float32Array]
void CreateBuffer(const FunctionCallbackInfo<Value>& info) {
  Isolate* iso = info.GetIsolate();
  int ch = static_cast<int>(num(info, 0));
  double len = num(info, 1);
  double rate = num(info, 2);
  if (ch < 1 || ch > kMaxChannels || !(len >= 1) || len > 1e9 || rate < kMinSampleRate || rate > kMaxSampleRate) {
    iso->ThrowException(v8::Exception::RangeError(str(iso, "invalid AudioBuffer options")));
    return;
  }
  if (len * ch * sizeof(float) > static_cast<double>(BufferData::kMaxBytes)) {
    iso->ThrowException(v8::Exception::RangeError(str(iso, "AudioBuffer exceeds the 1 GiB limit")));
    return;
  }
  BufferData* b = BufferData::create(ch, static_cast<size_t>(len), static_cast<float>(rate));
  if (!b) {
    throwError(iso, "iwn.audio: out of memory");
    return;
  }
  uint32_t id = BufferRegistry::get().add(b);
  info.GetReturnValue().Set(bufferArray(iso, iso->GetCurrentContext(), id, b, false));
}

// takeBuffer(bufferId) -> [bufferId, channels, length, sampleRate, ...Float32Array]
void TakeBuffer(const FunctionCallbackInfo<Value>& info) {
  Isolate* iso = info.GetIsolate();
  uint32_t id = static_cast<uint32_t>(num(info, 0));
  BufferData* b = BufferRegistry::get().find(id);
  if (!b) {
    info.GetReturnValue().SetNull();
    return;
  }
  info.GetReturnValue().Set(bufferArray(iso, iso->GetCurrentContext(), id, b, true));
}

void ReleaseBuffer(const FunctionCallbackInfo<Value>& info) {
  BufferRegistry::get().remove(static_cast<uint32_t>(num(info, 0)));
}

// decode(ctxId, ArrayBuffer, requestId, targetRate): detaches the buffer (as browsers do) and
// decodes on a worker thread; completion arrives as an event.
void Decode(const FunctionCallbackInfo<Value>& info) {
  Isolate* iso = info.GetIsolate();
  if (info.Length() < 2 || !info[1]->IsArrayBuffer()) {
    throwType(iso, "iwn.audio.decode: expected ArrayBuffer");
    return;
  }
  Local<ArrayBuffer> ab = info[1].As<ArrayBuffer>();
  std::shared_ptr<BackingStore> bs = ab->GetBackingStore();
  DecodeJob job;
  job.ctx = static_cast<uint32_t>(num(info, 0));
  job.requestId = num(info, 2);
  job.targetRate = static_cast<float>(num(info, 3));
  if (ab->IsDetachable()) {
    job.data = static_cast<const uint8_t*>(bs->Data());
    job.size = bs->ByteLength();
    job.keepAlive = std::shared_ptr<void>(bs, bs->Data());
    if (ab->Detach(Local<Value>()).IsNothing()) return;
  } else {
    auto copy = std::make_shared<std::vector<uint8_t>>(static_cast<const uint8_t*>(bs->Data()),
                                                        static_cast<const uint8_t*>(bs->Data()) + bs->ByteLength());
    job.data = copy->data();
    job.size = copy->size();
    job.keepAlive = copy;
  }
  submitDecode(std::move(job));
}

Local<Value> buildEvents(Isolate* iso, Local<v8::Context> ctx) {
  std::vector<OutEvent> ev;
  collectAllEvents(ev);
  if (ev.empty()) return v8::Undefined(iso);
  Local<Array> a = Array::New(iso, static_cast<int>(ev.size() * 5));
  uint32_t k = 0;
  for (const OutEvent& e : ev) {
    a->Set(ctx, k++, Number::New(iso, e.type)).Check();
    a->Set(ctx, k++, Number::New(iso, e.ctx)).Check();
    a->Set(ctx, k++, Number::New(iso, e.a)).Check();
    a->Set(ctx, k++, Number::New(iso, e.b)).Check();
    a->Set(ctx, k++, e.message.empty() ? Local<Value>(v8::Null(iso)) : Local<Value>(str(iso, e.message.c_str()))).Check();
  }
  return a;
}

// poll() -> flat [type, ctx, a, b, message|null, ...] or undefined
void Poll(const FunctionCallbackInfo<Value>& info) {
  Isolate* iso = info.GetIsolate();
  info.GetReturnValue().Set(buildEvents(iso, iso->GetCurrentContext()));
}

void PendingWork(const FunctionCallbackInfo<Value>& info) { info.GetReturnValue().Set(anyPendingWork()); }

// Runs on the main thread as a task posted through the host hooks.
void drainOnMain(void*) {
  BindingState* s = g_state;
  if (!s || s->handler.IsEmpty()) return;
  Isolate* iso = s->isolate;
  HandleScope hs(iso);
  Local<v8::Context> ctx = s->context.Get(iso);
  v8::Context::Scope cs(ctx);
  Local<Value> ev = buildEvents(iso, ctx);
  if (ev->IsUndefined()) return;
  Local<Function> fn = s->handler.Get(iso);
  v8::TryCatch tc(iso);
  Local<Value> argv[] = {ev};
  if (fn->Call(ctx, v8::Undefined(iso), 1, argv).IsEmpty()) {
    // The JS handler reports its own errors; nothing to do here.
  }
}

// setEventHandler(fn) -> true when native will post event tasks (push), false = JS must poll
void SetEventHandler(const FunctionCallbackInfo<Value>& info) {
  Isolate* iso = info.GetIsolate();
  if (!g_state) return;
  if (info.Length() > 0 && info[0]->IsFunction()) g_state->handler.Reset(iso, info[0].As<Function>());
  else g_state->handler.Reset();
  info.GetReturnValue().Set(Notifier::get().hasHooks());
}

AnalyserNode* analyserArg(const FunctionCallbackInfo<Value>& info) {
  iwn::audio::Context* c = findContext(static_cast<uint32_t>(num(info, 0)));
  if (!c) return nullptr;
  Node* n = c->graph().mainNode(static_cast<uint32_t>(num(info, 1)));
  if (!n || n->type() != proto::kAnalyser) return nullptr;
  return static_cast<AnalyserNode*>(n);
}

// analyserTime(ctx, node, out: Float32Array|Uint8Array, fftSize)
void AnalyserTime(const FunctionCallbackInfo<Value>& info) {
  AnalyserNode* a = analyserArg(info);
  if (!a || info.Length() < 4) return;
  int fftSize = static_cast<int>(num(info, 3, 2048));
  std::vector<float> td(static_cast<size_t>(std::max(32, std::min(fftSize, AnalyserNode::kRing))));
  a->timeDomain(td.data(), static_cast<int>(td.size()));
  if (info[2]->IsFloat32Array()) {
    Local<Float32Array> o = info[2].As<Float32Array>();
    size_t n = std::min(o->Length(), td.size());
    float* dst = static_cast<float*>(o->Buffer()->Data()) + o->ByteOffset() / sizeof(float);
    std::memcpy(dst, td.data(), n * sizeof(float));
  } else if (info[2]->IsUint8Array()) {
    Local<Uint8Array> o = info[2].As<Uint8Array>();
    size_t n = std::min(o->Length(), td.size());
    uint8_t* dst = static_cast<uint8_t*>(o->Buffer()->Data()) + o->ByteOffset();
    for (size_t i = 0; i < n; ++i) {
      double v = 128 * (1 + td[i]);
      dst[i] = static_cast<uint8_t>(std::max(0.0, std::min(255.0, std::floor(v))));
    }
  }
}

// analyserFreq(ctx, node, out: Float32Array|Uint8Array, fftSize, smoothing, minDb, maxDb, frame)
void AnalyserFreq(const FunctionCallbackInfo<Value>& info) {
  AnalyserNode* a = analyserArg(info);
  if (!a || info.Length() < 8) return;
  int fftSize = static_cast<int>(num(info, 3, 2048));
  double smoothing = num(info, 4, 0.8), minDb = num(info, 5, -100), maxDb = num(info, 6, -30);
  uint64_t frame = static_cast<uint64_t>(num(info, 7));
  int bins = fftSize / 2;
  std::vector<float> db(static_cast<size_t>(std::max(bins, 1)));
  a->frequency(db.data(), bins, fftSize, smoothing, frame);
  if (info[2]->IsFloat32Array()) {
    Local<Float32Array> o = info[2].As<Float32Array>();
    size_t n = std::min(o->Length(), db.size());
    float* dst = static_cast<float*>(o->Buffer()->Data()) + o->ByteOffset() / sizeof(float);
    std::memcpy(dst, db.data(), n * sizeof(float));
  } else if (info[2]->IsUint8Array()) {
    Local<Uint8Array> o = info[2].As<Uint8Array>();
    size_t n = std::min(o->Length(), db.size());
    uint8_t* dst = static_cast<uint8_t*>(o->Buffer()->Data()) + o->ByteOffset();
    double scale = 255.0 / (maxDb - minDb);
    for (size_t i = 0; i < n; ++i) {
      double v = scale * (db[i] - minDb);
      dst[i] = static_cast<uint8_t>(std::max(0.0, std::min(255.0, std::isfinite(v) ? std::floor(v) : 0.0)));
    }
  }
}

// biquadResponse(type, sampleRate, frequency, detune, Q, gain, freqs, mag, phase)
void BiquadResponse(const FunctionCallbackInfo<Value>& info) {
  if (info.Length() < 9 || !info[6]->IsFloat32Array() || !info[7]->IsFloat32Array() || !info[8]->IsFloat32Array())
    return;
  auto ptr = [](Local<Value> v) {
    Local<Float32Array> a = v.As<Float32Array>();
    return std::make_pair(static_cast<float*>(a->Buffer()->Data()) + a->ByteOffset() / sizeof(float), a->Length());
  };
  auto f = ptr(info[6]);
  auto m = ptr(info[7]);
  auto p = ptr(info[8]);
  size_t n = std::min({f.second, m.second, p.second});
  BiquadFilterNode::frequencyResponse(static_cast<int>(num(info, 0)), num(info, 1), num(info, 2), num(info, 3),
                                      num(info, 4), num(info, 5), f.first, m.first, p.first, static_cast<int>(n));
}

// outputTimestamp(ctx) -> [contextTime, monotonicMs] | null
void OutputTimestamp(const FunctionCallbackInfo<Value>& info) {
  Isolate* iso = info.GetIsolate();
  iwn::audio::Context* c = findContext(static_cast<uint32_t>(num(info, 0)));
  double t = 0, ms = 0;
  if (!c || !c->outputTimestamp(t, ms)) {
    info.GetReturnValue().SetNull();
    return;
  }
  Local<v8::Context> ctx = iso->GetCurrentContext();
  Local<Array> a = Array::New(iso, 2);
  a->Set(ctx, 0, Number::New(iso, t)).Check();
  a->Set(ctx, 1, Number::New(iso, ms)).Check();
  info.GetReturnValue().Set(a);
}

void NowMs(const FunctionCallbackInfo<Value>& info) {
  info.GetReturnValue().Set(static_cast<double>(monotonicNanos()) / 1e6);
}

void StatsFn(const FunctionCallbackInfo<Value>& info) {
  Isolate* iso = info.GetIsolate();
  Local<v8::Context> ctx = iso->GetCurrentContext();
  Stats s = stats();
  Local<Object> o = Object::New(iso);
  set(iso, ctx, o, "realtimeContexts", Number::New(iso, s.realtimeContexts));
  set(iso, ctx, o, "offlineContexts", Number::New(iso, s.offlineContexts));
  set(iso, ctx, o, "xruns", Number::New(iso, static_cast<double>(s.xruns)));
  set(iso, ctx, o, "renderLoad", Number::New(iso, s.renderLoad));
  set(iso, ctx, o, "liveNodes", Number::New(iso, s.liveNodes));
  set(iso, ctx, o, "liveBuffers", Number::New(iso, s.liveBuffers));
  set(iso, ctx, o, "pendingDecodes", Number::New(iso, s.pendingDecodes));
  set(iso, ctx, o, "pausedReasons", Number::New(iso, outputPausedReasons()));
  set(iso, ctx, o, "rtAllocations", Number::New(iso, static_cast<double>(s.rtAllocations)));
  set(iso, ctx, o, "paramEventsMerged", Number::New(iso, static_cast<double>(s.paramEventsMerged)));
  info.GetReturnValue().Set(o);
}

void SetOutputPausedFn(const FunctionCallbackInfo<Value>& info) {
  setOutputPaused(static_cast<uint32_t>(num(info, 0)), info.Length() > 1 && info[1]->BooleanValue(info.GetIsolate()));
}

// Drops the binding's V8 handles. JS thread of g_state->isolate, with that isolate still alive.
void releaseBindingState() {
  Notifier::get().setDrain(nullptr, nullptr);
  if (!g_state) return;
  g_state->handler.Reset();
  g_state->context.Reset();
  delete g_state;
  g_state = nullptr;
}

// A new page (location.reload, PROC-8) or a new runtime: contexts made by the previous page are
// unreachable from JS; stop and free them. Buffers the previous page registered (decoded,
// rendered, created) and decodes still in flight belong to it: drop them so they neither leak per
// reload nor resolve the new page's requests (its request ids start over at 1).
int liveContextCount() {
  int n = 0;
  forEachContext([](iwn::audio::Context*, void* arg) { ++*static_cast<int*>(arg); }, &n);
  return n;
}

void forgetPreviousPage() {
  destroyAllContexts();
  BufferRegistry::get().clear();
  beginDecodeGeneration();
}

#ifdef IWN_AUDIO_WITH_CORE
// The runtime whose shutdown hook and stats provider are installed (cleared by the hook).
iwn::Runtime* g_runtime = nullptr;
Isolate* g_runtimeIsolate = nullptr;

// Runtime integration (the core): completions as JS tasks (PROC-2), devices stopped and
// threads joined at exit (PROC-7), an `audio` section in the debug endpoint's stats (DBG-STATS).
void attachRuntime(iwn::Runtime* rt, Isolate* isolate) {
  HostHooks hooks;
  hooks.user = rt;
  hooks.postToMain = [](void* user, void (*fn)(void*), void* arg) {
    static_cast<iwn::Runtime*>(user)->post_task([fn, arg] { fn(arg); });
    return true;
  };
  setHostHooks(hooks);
  if (g_runtime == rt && g_runtimeIsolate == isolate) return;  // a reload in the same runtime
  g_runtime = rt;
  g_runtimeIsolate = isolate;
  // Runs on the JS thread before the context and isolate are disposed (runtime.h), so the V8
  // handles can still be released. The process may outlive this runtime (Android keeps it cached
  // and a new activity builds a new Runtime and isolate): leave nothing that points at either.
  rt->add_shutdown_hook([] {
    releaseBindingState();
    iwn::audio::shutdown();
    g_runtime = nullptr;
    g_runtimeIsolate = nullptr;
  });
  rt->add_stats_provider("audio", [] {
    Stats s = stats();
    iwn::Json o = iwn::Json::object();
    o.set("realtimeContexts", iwn::Json(static_cast<int>(s.realtimeContexts)));
    o.set("offlineContexts", iwn::Json(static_cast<int>(s.offlineContexts)));
    o.set("xruns", iwn::Json(static_cast<uint64_t>(s.xruns)));
    o.set("renderLoad", iwn::Json(s.renderLoad));
    o.set("liveNodes", iwn::Json(static_cast<int>(s.liveNodes)));
    o.set("liveBuffers", iwn::Json(static_cast<int>(s.liveBuffers)));
    o.set("pendingDecodes", iwn::Json(static_cast<int>(s.pendingDecodes)));
    o.set("pausedReasons", iwn::Json(static_cast<int>(outputPausedReasons())));
    o.set("rtAllocations", iwn::Json(static_cast<uint64_t>(s.rtAllocations)));
    o.set("paramEventsMerged", iwn::Json(static_cast<uint64_t>(s.paramEventsMerged)));
    return o;
  });
}
#endif

}  // namespace

#ifdef IWN_NODE_ADDON
// Host Node addon only: what the runtime's shutdown hook does, so tests can exercise
// shutdown -> new registration in one process.
void iwn_audio_binding_shutdown_for_test() {
  releaseBindingState();
  iwn::audio::shutdown();
}
#endif

void iwn_register_audio(Isolate* isolate, Local<v8::Context> ctx, Local<Object> natives) {
#ifdef IWN_AUDIO_WITH_CORE
  // Web Audio is main-thread only (PROC-1): worker isolates (no Runtime) get no audio natives.
  iwn::Runtime* rt = iwn::Runtime::From(isolate);
  if (!rt) return;
#endif
  // A new runtime after the previous one shut the module down (PROC-7 then a relaunch into the
  // cached process): start again.
  rearmAfterShutdown();
#ifdef IWN_AUDIO_WITH_CORE
  attachRuntime(rt, isolate);
#endif
  if (g_state && g_state->isolate != isolate) {
    // State left by another isolate whose shutdown hook never ran. That isolate may be disposed,
    // so its handles cannot be reset (V8 would abort): abandon them (a few bytes) and free the
    // native side.
    g_state = nullptr;
    forgetPreviousPage();
  } else if (g_state && g_state->context != ctx) {
    accountContexts(isolate, -liveContextCount());  // same isolate: undo their accounting
    forgetPreviousPage();
    releaseBindingState();
  }
  if (!g_state) {
    g_state = new BindingState();
    g_state->isolate = isolate;
  }
  g_state->context.Reset(isolate, ctx);
  Notifier::get().setDrain(drainOnMain, nullptr);

  Local<Object> audio = Object::New(isolate);
  struct Fn {
    const char* name;
    v8::FunctionCallback cb;
  };
  const Fn fns[] = {
      {"createContext", CreateContext},   {"releaseContext", ReleaseContext},
      {"submit", Submit},                 {"startRendering", StartRendering},
      {"createBuffer", CreateBuffer},     {"takeBuffer", TakeBuffer},
      {"releaseBuffer", ReleaseBuffer},   {"decode", Decode},
      {"poll", Poll},                     {"pendingWork", PendingWork},
      {"setEventHandler", SetEventHandler}, {"analyserTime", AnalyserTime},
      {"analyserFreq", AnalyserFreq},     {"biquadResponse", BiquadResponse},
      {"outputTimestamp", OutputTimestamp}, {"nowMs", NowMs},
      {"stats", StatsFn},                 {"setOutputPaused", SetOutputPausedFn},
  };
  for (const Fn& f : fns) {
    Local<Function> fn = FunctionTemplate::New(isolate, f.cb)->GetFunction(ctx).ToLocalChecked();
    fn->SetName(str(isolate, f.name));
    set(isolate, ctx, audio, f.name, fn);
  }
  set(isolate, ctx, audio, "protocolVersion", Number::New(isolate, proto::kVersion));
  set(isolate, ctx, natives, "audio", audio);
}
