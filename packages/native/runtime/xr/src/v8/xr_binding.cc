// V8 binding of the XR module: globalThis.__iwn.xr, the FramePump the core's event loop runs on the main JS thread,
// the `shot` debug method (DBG-SHOT) and the `xr` stats section (DBG-STATS). Written from the V8 embedder headers
// (v8-function-callback.h, v8-array-buffer.h, v8-json.h) and runtime/core's runtime.h contract.
//
// JS API (web/xr is the only caller):
//   info() -> object                    capabilities (blocks until OpenXR initialised, at most 10 s)
//   record() -> ArrayBuffer             the frame record (external backing store, the same memory every frame)
//   layoutVersion                       the native writer's record layout version (XRF-4)
//   setFrameHandler(fn(kind, events))   kind 1: XR frame (record filled), 2: window-rAF tick, 3: events only
//   beginSwapchain(arraySize, scale, format, foveation, passthrough, unpremultiplied) -> object | null
//   endSession()  requestFrameRate(hz) -> bool  setFoveation(level)  setPassthroughVisible(bool)
//   haptic(hand 0|1, intensity, durationMs, frequencyHz)
//   sessionStarted(ar, handTracking, planes, meshes)  offered()  offerRejected()  entryEvaluated()
//   runWindowFrame()                    inside a frame/tick: window rAF callbacks with the frame's start time
//   endFrameGL()                        inside a frame, the session's GL context current: fence + flush
//   layers() -> ArrayBuffer             quad and cylinder layers: the buffer shared with the XR thread
//                                       (iwn/xr/layers.h; external backing store, the same memory for the process)
//   beginLayerSwapchain(kind 2|3, width, height, arraySize, format, isStatic, mipLevels, textureArray) -> object | null
//   destroyLayerSwapchain(id)  acquireLayerImage(id) -> GL name | 0
//   requestPermissions(names) -> Promise<{name: bool}>   XR-PERM-1: system dialog for the ones not held, then
//                                       whether each is held (xr_permissions.h)
//   checkPermissions(names) -> {name: bool}             checkSelfPermission, no dialog
//   declaredPermissions() -> string[] | null            the manifest's permissions (null: unknown)
//   sceneData(knownVersion) -> object | null   the room's entities when their version differs (starts the query)
//   scenePoses() -> ArrayBuffer         entity poses, 8 floats per slot, written before each frame (xr_scene.h)
//   sceneStatus() -> object             the scene model's state (diagnostics)
//   anchor*()                           spatial anchors (xr_anchors_binding.cc)
//   startDepth(handRemoval)             the session enabled 'depth-sensing': environment depth runs (XR-DEPTH-2)
//   depthRecord() -> ArrayBuffer        the depth record (iwn/xr/depth_record.h; doubles, the same memory every frame)
//   depthRecordVersion                  its layout version (depth_layout::kDepthVersion)
#include <v8.h>

#include <cmath>
#include <cstring>
#include <functional>
#include <string>
#include <unordered_map>
#include <vector>

#include "android/xr_permissions.h"
#include "android/xr_scene.h"
#include "android/xr_system.h"
#include "iwn/core/clock.h"
#include "iwn/core/event_loop.h"
#include "iwn/core/log.h"
#include "iwn/core/runtime.h"
#include "iwn/xr/frame_record_layout.gen.h"
#include "iwn/xr/pacing.h"
#include "iwn/xr/xr_config.h"

namespace {

using iwn::Json;
using iwn::LogLevel;
using iwn::Runtime;
using iwn::xr::XrEvent;
using iwn::xr::XrSystem;
namespace L = iwn::xr::layout;

enum HandlerKind { kKindFrame = 1, kKindTick = 2, kKindEvents = 3 };

struct BindingState {
  Runtime* rt = nullptr;
  bool installed = false;
  uint64_t generation = ~0ull;
  v8::Global<v8::Function> handler;
  v8::Global<v8::ArrayBuffer> record_buffer;
  v8::Global<v8::ArrayBuffer> layer_buffer;
  v8::Global<v8::ArrayBuffer> pose_buffer;
  v8::Global<v8::ArrayBuffer> depth_buffer;
  const std::function<void(double)>* window_frame = nullptr;
  double window_time = 0;
  bool fence_created = false;
  bool in_frame = false;
  std::vector<XrEvent> events;
  // requestPermissions promises of the current page, by request id
  uint64_t next_permission_request = 0;
  std::unordered_map<uint64_t, v8::Global<v8::Promise::Resolver>> permission_requests;
};

BindingState& G() {
  static BindingState* g = new BindingState();
  return *g;
}

v8::Local<v8::String> str(v8::Isolate* iso, const char* s) {
  return v8::String::NewFromUtf8(iso, s, v8::NewStringType::kInternalized).ToLocalChecked();
}

v8::Local<v8::Value> json_to_v8(v8::Isolate* iso, v8::Local<v8::Context> ctx, const Json& j) {
  std::string text = j.dump();
  v8::Local<v8::String> s =
      v8::String::NewFromUtf8(iso, text.data(), v8::NewStringType::kNormal, static_cast<int>(text.size()))
          .ToLocalChecked();
  v8::Local<v8::Value> out;
  if (!v8::JSON::Parse(ctx, s).ToLocal(&out)) return v8::Null(iso);
  return out;
}

double num(const v8::FunctionCallbackInfo<v8::Value>& info, int i, double def = 0) {
  if (info.Length() <= i) return def;
  return info[i]->NumberValue(info.GetIsolate()->GetCurrentContext()).FromMaybe(def);
}

// A JS number within [lo, hi], else `def` (NaN, infinities and out-of-range values never reach an integer or float
// conversion, which would be undefined behaviour in C++).
double num_in(const v8::FunctionCallbackInfo<v8::Value>& info, int i, double lo, double hi, double def) {
  const double v = num(info, i, def);
  return std::isfinite(v) && v >= lo && v <= hi ? v : def;
}

bool flag(const v8::FunctionCallbackInfo<v8::Value>& info, int i) {
  return info.Length() > i && info[i]->BooleanValue(info.GetIsolate());
}

v8::Local<v8::Value> events_array(v8::Isolate* iso, v8::Local<v8::Context> ctx, const std::vector<XrEvent>& events) {
  v8::Local<v8::Array> arr = v8::Array::New(iso, static_cast<int>(events.size()));
  uint32_t i = 0;
  for (const XrEvent& e : events) {
    v8::Local<v8::Object> o = v8::Object::New(iso);
    switch (e.type) {
      case XrEvent::kVisibility:
        o->Set(ctx, str(iso, "type"), str(iso, "visibilitychange")).Check();
        o->Set(ctx, str(iso, "visible"), v8::Boolean::New(iso, e.visible)).Check();
        o->Set(ctx, str(iso, "focused"), v8::Boolean::New(iso, e.focused)).Check();
        break;
      case XrEvent::kFrameRate:
        o->Set(ctx, str(iso, "type"), str(iso, "frameratechange")).Check();
        o->Set(ctx, str(iso, "rate"), v8::Number::New(iso, e.rate)).Check();
        break;
      case XrEvent::kReferenceSpaceReset:
        o->Set(ctx, str(iso, "type"), str(iso, "referencespacereset")).Check();
        break;
      case XrEvent::kSessionEnd:
        o->Set(ctx, str(iso, "type"), str(iso, "end")).Check();
        break;
      case XrEvent::kRunning:
        o->Set(ctx, str(iso, "type"), str(iso, "running")).Check();
        o->Set(ctx, str(iso, "running"), v8::Boolean::New(iso, e.running)).Check();
        break;
    }
    arr->Set(ctx, i++, o).Check();
  }
  return arr;
}

void call_handler(Runtime* rt, int kind, const std::vector<XrEvent>* events) {
  BindingState& g = G();
  if (g.handler.IsEmpty()) return;
  v8::Isolate* iso = rt->isolate();
  v8::Local<v8::Context> ctx = rt->context();
  v8::Local<v8::Value> argv[2] = {v8::Integer::New(iso, kind),
                                  events && !events->empty() ? events_array(iso, ctx, *events)
                                                             : v8::Undefined(iso).As<v8::Value>()};
  (void)rt->call_function(g.handler.Get(iso), v8::Undefined(iso), 2, argv);
}

// The event loop's policy while OpenXR drives frames (TMR-5, PERF-JS-3): window rAF only from OpenXR's frames, and
// a between-frame task budget of the predicted slack minus 1 ms; the defaults again when OpenXR stops.
void apply_running(Runtime* rt, const std::vector<XrEvent>& events) {
  for (const XrEvent& e : events) {
    if (e.type != XrEvent::kRunning) continue;
    if (e.running) {
      rt->loop().set_fallback_frame_interval_ms(0);
    } else {
      rt->loop().set_fallback_frame_interval_ms(1000.0 / 60.0);
      rt->loop().set_task_budget_ms(8.0, 50.0);
    }
  }
}

class XrPump : public iwn::FramePump {
 public:
  bool active() override {
    BindingState& g = G();
    XrSystem& xr = XrSystem::get();
    if (g.rt) xr.set_want_ticks(g.rt->loop().animation_frame_requested());
    return xr.js_work_pending();
  }

  void run_frame(const std::function<void(double now_ms)>& run_window_frame) override {
    BindingState& g = G();
    Runtime* rt = g.rt;
    if (!rt) return;
    XrSystem& xr = XrSystem::get();
    v8::Isolate* iso = rt->isolate();
    v8::HandleScope hs(iso);
    v8::Local<v8::Context> ctx = rt->context();
    if (ctx.IsEmpty()) return;
    v8::Context::Scope cs(ctx);

    g.events.clear();
    const bool has_events = xr.take_events(&g.events);
    if (has_events) apply_running(rt, g.events);
    double start = 0, period = 0;
    const XrSystem::Pending p = xr.take_pending(&start, &period);
    if (p == XrSystem::Pending::kXrFrame) {
      if (!xr.slot().begin()) {  // the XR thread gave up on it (deadline): nothing to run
        if (has_events) call_handler(rt, kKindEvents, &g.events);
        return;
      }
      xr.js_frame_begun();
      const iwn::xr::FrameRecord& rec = xr.record();
      start = rec.f64(L::kFrameStartTime);
      period = rec.f64(L::kDisplayPeriod);
      g.window_frame = &run_window_frame;
      g.window_time = start;
      g.fence_created = false;
      g.in_frame = true;
      rt->set_in_frame_callbacks(true);
      const double t0 = iwn::now_ms();
      if (!g.handler.IsEmpty()) call_handler(rt, kKindFrame, has_events ? &g.events : nullptr);
      const double js = iwn::now_ms() - t0;
      rt->set_in_frame_callbacks(false);
      g.in_frame = false;
      g.window_frame = nullptr;
      xr.js_frame_finished(js, g.fence_created);
      budget(rt, start, period);
    } else if (p == XrSystem::Pending::kTick) {
      g.window_frame = &run_window_frame;
      g.window_time = start;
      if (!g.handler.IsEmpty()) {
        call_handler(rt, kKindTick, has_events ? &g.events : nullptr);
      } else {
        run_window_frame(start);
      }
      g.window_frame = nullptr;
      budget(rt, start, period);
    } else if (has_events) {
      call_handler(rt, kKindEvents, &g.events);
    }
  }

 private:
  static void budget(Runtime* rt, double start, double period) {
    if (!(period > 0)) return;
    const double b = iwn::xr::task_budget_ms(iwn::now_ms(), start + period);
    rt->loop().set_task_budget_ms(b, b);
  }
};

XrPump& Pump() {
  static XrPump* p = new XrPump();
  return *p;
}

// --- natives --------------------------------------------------------------------------------------------------------

void Info(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* iso = info.GetIsolate();
  info.GetReturnValue().Set(json_to_v8(iso, iso->GetCurrentContext(), XrSystem::get().info()));
}

void Record(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* iso = info.GetIsolate();
  BindingState& g = G();
  if (g.record_buffer.IsEmpty()) {
    iwn::xr::FrameRecord& rec = XrSystem::get().record();
    std::shared_ptr<v8::BackingStore> store = v8::ArrayBuffer::NewBackingStore(
        rec.data(), iwn::xr::FrameRecord::size(), v8::BackingStore::EmptyDeleter, nullptr);
    g.record_buffer.Reset(iso, v8::ArrayBuffer::New(iso, std::move(store)));
  }
  info.GetReturnValue().Set(g.record_buffer.Get(iso));
}

void Layers(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* iso = info.GetIsolate();
  BindingState& g = G();
  if (g.layer_buffer.IsEmpty()) {
    std::shared_ptr<v8::BackingStore> store =
        v8::ArrayBuffer::NewBackingStore(XrSystem::get().layer_words(), iwn::xr::layers::kWords * sizeof(uint32_t),
                                         v8::BackingStore::EmptyDeleter, nullptr);
    g.layer_buffer.Reset(iso, v8::ArrayBuffer::New(iso, std::move(store)));
  }
  info.GetReturnValue().Set(g.layer_buffer.Get(iso));
}

void BeginLayerSwapchain(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* iso = info.GetIsolate();
  v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  iwn::xr::LayerSwapchainRequest req;
  req.kind = num_in(info, 0, 2, 3, 2) == 3 ? iwn::xr::layers::kCylinder : iwn::xr::layers::kQuad;
  // sizes beyond the system's limits are refused by the XR thread (with the limits in the error)
  req.width = static_cast<uint32_t>(num_in(info, 1, 0, 65536, 0));
  req.height = static_cast<uint32_t>(num_in(info, 2, 0, 65536, 0));
  req.array_size = static_cast<uint32_t>(num_in(info, 3, 1, 2, 1));
  req.format = static_cast<uint32_t>(num_in(info, 4, 0, 0xFFFFFFFF, 0x8058));
  req.is_static = flag(info, 5);
  req.mip_levels = static_cast<uint32_t>(num_in(info, 6, 1, 16, 1));
  req.texture_array = flag(info, 7);
  iwn::xr::LayerSwapchainAnswer a = XrSystem::get().begin_layer_swapchain(req);
  if (!a.ok) {
    iwn::log(LogLevel::kError, "xr: beginLayerSwapchain failed: %s", a.error.c_str());
    info.GetReturnValue().SetNull();
    return;
  }
  v8::Local<v8::Object> o = v8::Object::New(iso);
  o->Set(ctx, str(iso, "id"), v8::Integer::NewFromUnsigned(iso, a.id)).Check();
  o->Set(ctx, str(iso, "width"), v8::Integer::NewFromUnsigned(iso, a.width)).Check();
  o->Set(ctx, str(iso, "height"), v8::Integer::NewFromUnsigned(iso, a.height)).Check();
  o->Set(ctx, str(iso, "arraySize"), v8::Integer::NewFromUnsigned(iso, a.array_size)).Check();
  info.GetReturnValue().Set(o);
}

void DestroyLayerSwapchain(const v8::FunctionCallbackInfo<v8::Value>& info) {
  XrSystem::get().destroy_layer_swapchain(static_cast<uint32_t>(num_in(info, 0, 0, 1024, 0)));
}

void AcquireLayerImage(const v8::FunctionCallbackInfo<v8::Value>& info) {
  info.GetReturnValue().Set(
      v8::Integer::NewFromUnsigned(info.GetIsolate(), XrSystem::get().acquire_layer_image(
                                                          static_cast<uint32_t>(num_in(info, 0, 0, 1024, 0)))));
}

void DepthRecord(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* iso = info.GetIsolate();
  BindingState& g = G();
  if (g.depth_buffer.IsEmpty()) {
    std::shared_ptr<v8::BackingStore> store =
        v8::ArrayBuffer::NewBackingStore(XrSystem::get().depth_record(), iwn::xr::depth_layout::kCount * sizeof(double),
                                         v8::BackingStore::EmptyDeleter, nullptr);
    g.depth_buffer.Reset(iso, v8::ArrayBuffer::New(iso, std::move(store)));
  }
  info.GetReturnValue().Set(g.depth_buffer.Get(iso));
}

void StartDepth(const v8::FunctionCallbackInfo<v8::Value>& info) { XrSystem::get().start_depth(flag(info, 0)); }

void SetFrameHandler(const v8::FunctionCallbackInfo<v8::Value>& info) {
  BindingState& g = G();
  if (info.Length() < 1 || !info[0]->IsFunction()) {
    g.handler.Reset();
    return;
  }
  g.handler.Reset(info.GetIsolate(), info[0].As<v8::Function>());
}

void BeginSwapchain(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* iso = info.GetIsolate();
  v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  iwn::xr::SwapchainRequest req;
  req.array_size = static_cast<uint32_t>(num_in(info, 0, 1, 2, 2));
  req.scale = num_in(info, 1, -1e9, 1e9, 1);  // finite; the XR thread clamps it to the supported range (XR-SC-1)
  req.format = static_cast<uint32_t>(num_in(info, 2, 0, 0xFFFFFFFF, 0x8058));
  req.foveation = num_in(info, 3, 0, 1, -1);
  req.passthrough = flag(info, 4);
  req.unpremultiplied = flag(info, 5);
  iwn::xr::SwapchainAnswer a = XrSystem::get().begin_swapchain(req);
  if (!a.ok) {
    iwn::log(LogLevel::kError, "xr: beginSwapchain failed: %s", a.error.c_str());
    info.GetReturnValue().SetNull();
    return;
  }
  v8::Local<v8::Object> o = v8::Object::New(iso);
  o->Set(ctx, str(iso, "width"), v8::Integer::NewFromUnsigned(iso, a.width)).Check();
  o->Set(ctx, str(iso, "height"), v8::Integer::NewFromUnsigned(iso, a.height)).Check();
  o->Set(ctx, str(iso, "arraySize"), v8::Integer::NewFromUnsigned(iso, a.array_size)).Check();
  v8::Local<v8::Array> rates = v8::Array::New(iso, static_cast<int>(a.rates.size()));
  for (uint32_t i = 0; i < a.rates.size(); ++i) rates->Set(ctx, i, v8::Number::New(iso, a.rates[i])).Check();
  o->Set(ctx, str(iso, "rates"), rates).Check();
  o->Set(ctx, str(iso, "rate"), v8::Number::New(iso, a.rate)).Check();
  o->Set(ctx, str(iso, "hasStage"), v8::Boolean::New(iso, a.has_stage)).Check();
  o->Set(ctx, str(iso, "stageWidth"), v8::Number::New(iso, a.stage_width)).Check();
  o->Set(ctx, str(iso, "stageDepth"), v8::Number::New(iso, a.stage_depth)).Check();
  if (a.foveation >= 0) o->Set(ctx, str(iso, "foveation"), v8::Number::New(iso, a.foveation)).Check();
  info.GetReturnValue().Set(o);
}

void EndSession(const v8::FunctionCallbackInfo<v8::Value>&) { XrSystem::get().end_webxr_session(); }

void RequestFrameRate(const v8::FunctionCallbackInfo<v8::Value>& info) {
  // 0 is never in the display's list, so a non-number or absurd rate is refused (false).
  info.GetReturnValue().Set(XrSystem::get().request_frame_rate(static_cast<float>(num_in(info, 0, 0, 1000, 0))));
}

void SetFoveation(const v8::FunctionCallbackInfo<v8::Value>& info) {
  XrSystem::get().set_foveation(num_in(info, 0, 0, 1, 0));
}

void SetPassthroughVisible(const v8::FunctionCallbackInfo<v8::Value>& info) {
  XrSystem::get().set_passthrough_visible(flag(info, 0));
}

void Haptic(const v8::FunctionCallbackInfo<v8::Value>& info) {
  // hand 0 left, 1 right (anything else is ignored), intensity 0..1, duration up to a minute, frequency in Hz.
  XrSystem::get().haptic(static_cast<int>(num_in(info, 0, 0, 1, -1)), static_cast<float>(num_in(info, 1, 0, 1, 0)),
                         num_in(info, 2, 0, 60000, 0), static_cast<float>(num_in(info, 3, 0, 100000, 0)));
}

void SessionStarted(const v8::FunctionCallbackInfo<v8::Value>& info) {
  XrSystem::get().notify_session_started(flag(info, 0), flag(info, 1), flag(info, 2), flag(info, 3));
}

void Offered(const v8::FunctionCallbackInfo<v8::Value>&) { XrSystem::get().notify_offered(); }

void OfferRejected(const v8::FunctionCallbackInfo<v8::Value>&) { XrSystem::get().notify_offer_rejected(); }

void EntryEvaluated(const v8::FunctionCallbackInfo<v8::Value>&) { XrSystem::get().notify_entry_evaluated(); }

void RunWindowFrame(const v8::FunctionCallbackInfo<v8::Value>&) {
  BindingState& g = G();
  if (g.window_frame) (*g.window_frame)(g.window_time);
}

void EndFrameGL(const v8::FunctionCallbackInfo<v8::Value>&) {
  BindingState& g = G();
  if (!g.in_frame || g.fence_created) return;
  XrSystem::get().js_fence_frame();
  g.fence_created = true;
}

// An array of strings (anything else: empty).
std::vector<std::string> string_list(const v8::FunctionCallbackInfo<v8::Value>& info, int i) {
  std::vector<std::string> out;
  if (info.Length() <= i || !info[i]->IsArray()) return out;
  v8::Isolate* iso = info.GetIsolate();
  v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  v8::Local<v8::Array> arr = info[i].As<v8::Array>();
  for (uint32_t k = 0; k < arr->Length() && k < 64; ++k) {
    v8::Local<v8::Value> v;
    if (!arr->Get(ctx, k).ToLocal(&v) || !v->IsString()) continue;
    v8::String::Utf8Value s(iso, v);
    if (*s) out.emplace_back(*s, s.length());
  }
  return out;
}

v8::Local<v8::Object> permission_map(v8::Isolate* iso, v8::Local<v8::Context> ctx, const std::vector<std::string>& names,
                                     const std::vector<bool>& held) {
  v8::Local<v8::Object> o = v8::Object::New(iso);
  for (size_t i = 0; i < names.size(); ++i) {
    v8::Local<v8::String> key;
    if (!v8::String::NewFromUtf8(iso, names[i].data(), v8::NewStringType::kNormal, static_cast<int>(names[i].size()))
             .ToLocal(&key)) {
      continue;
    }
    o->Set(ctx, key, v8::Boolean::New(iso, i < held.size() && held[i])).Check();
  }
  return o;
}

void RequestPermissions(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* iso = info.GetIsolate();
  v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  v8::Local<v8::Promise::Resolver> resolver;
  if (!v8::Promise::Resolver::New(ctx).ToLocal(&resolver)) return;
  info.GetReturnValue().Set(resolver->GetPromise());
  BindingState& g = G();
  std::vector<std::string> names = string_list(info, 0);
  if (!g.rt || names.empty()) {
    (void)resolver->Resolve(ctx, v8::Object::New(iso)).FromMaybe(false);
    return;
  }
  const uint64_t id = ++g.next_permission_request;
  Runtime* rt = g.rt;
  const bool queued = iwn::xr::PermissionBroker::get().request(
      names, [] { return XrSystem::get().focused(); },
      [rt, id, names](std::vector<bool> held) {
        // the broker's worker is joined in the shutdown hook, before the runtime goes away
        rt->post_task([rt, id, names, held = std::move(held)] {
          BindingState& st = G();
          auto it = st.permission_requests.find(id);
          if (it == st.permission_requests.end()) return;  // the page was replaced meanwhile
          v8::Isolate* iso = rt->isolate();
          v8::Local<v8::Context> ctx = rt->context();
          v8::Local<v8::Promise::Resolver> resolver = it->second.Get(iso);
          st.permission_requests.erase(it);
          (void)resolver->Resolve(ctx, permission_map(iso, ctx, names, held)).FromMaybe(false);
        });
      });
  if (!queued) {
    // the runtime is shutting down (the page's last `end` listener asked): the state now, no dialog
    (void)resolver->Resolve(ctx, permission_map(iso, ctx, names, iwn::xr::PermissionBroker::get().check(names)))
        .FromMaybe(false);
    return;
  }
  g.permission_requests.emplace(id, v8::Global<v8::Promise::Resolver>(iso, resolver));
}

void DeclaredPermissions(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* iso = info.GetIsolate();
  const auto declared = iwn::xr::PermissionBroker::get().declared();
  if (!declared) {
    info.GetReturnValue().SetNull();
    return;
  }
  v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  v8::Local<v8::Array> arr = v8::Array::New(iso, static_cast<int>(declared->size()));
  uint32_t i = 0;
  for (const std::string& name : *declared) arr->Set(ctx, i++, str(iso, name.c_str())).Check();
  info.GetReturnValue().Set(arr);
}

void CheckPermissions(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* iso = info.GetIsolate();
  const std::vector<std::string> names = string_list(info, 0);
  info.GetReturnValue().Set(permission_map(iso, iso->GetCurrentContext(), names,
                                           iwn::xr::PermissionBroker::get().check(names)));
}

// A typed array over a copy of `data` (geometry is read once per scene version).
template <typename T, typename Array>
v8::Local<Array> typed_copy(v8::Isolate* iso, const std::vector<T>& data) {
  v8::Local<v8::ArrayBuffer> buf = v8::ArrayBuffer::New(iso, data.size() * sizeof(T));
  if (!data.empty()) std::memcpy(buf->Data(), data.data(), data.size() * sizeof(T));
  return Array::New(buf, 0, data.size());
}

void SceneData(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* iso = info.GetIsolate();
  v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  XrSystem& xr = XrSystem::get();
  xr.want_scene();
  iwn::xr::XrScene* scene = xr.scene();
  std::shared_ptr<const iwn::xr::SceneSnapshot> snap = scene ? scene->snapshot() : nullptr;
  const double known = num(info, 0, -1);
  if (!snap || static_cast<double>(snap->version) == known) {
    info.GetReturnValue().SetNull();
    return;
  }
  v8::Local<v8::Object> o = v8::Object::New(iso);
  o->Set(ctx, str(iso, "version"), v8::Integer::NewFromUnsigned(iso, snap->version)).Check();
  v8::Local<v8::Array> list = v8::Array::New(iso, static_cast<int>(snap->entities.size()));
  uint32_t i = 0;
  for (const iwn::xr::SceneEntity& e : snap->entities) {
    v8::Local<v8::Object> eo = v8::Object::New(iso);
    eo->Set(ctx, str(iso, "id"), v8::String::NewFromUtf8(iso, e.id.c_str()).ToLocalChecked()).Check();
    eo->Set(ctx, str(iso, "slot"), v8::Integer::NewFromUnsigned(iso, e.slot)).Check();
    eo->Set(ctx, str(iso, "labels"), v8::String::NewFromUtf8(iso, e.labels.c_str()).ToLocalChecked()).Check();
    if (!e.polygon.empty()) {
      eo->Set(ctx, str(iso, "polygon"), typed_copy<float, v8::Float32Array>(iso, e.polygon)).Check();
    }
    if (e.has_box) {
      std::vector<float> box(e.box, e.box + 6);
      eo->Set(ctx, str(iso, "box"), typed_copy<float, v8::Float32Array>(iso, box)).Check();
    }
    if (!e.indices.empty()) {
      eo->Set(ctx, str(iso, "vertices"), typed_copy<float, v8::Float32Array>(iso, e.vertices)).Check();
      eo->Set(ctx, str(iso, "indices"), typed_copy<uint32_t, v8::Uint32Array>(iso, e.indices)).Check();
    }
    list->Set(ctx, i++, eo).Check();
  }
  o->Set(ctx, str(iso, "entities"), list).Check();
  info.GetReturnValue().Set(o);
}

void ScenePoses(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* iso = info.GetIsolate();
  BindingState& g = G();
  if (g.pose_buffer.IsEmpty()) {
    constexpr size_t bytes = iwn::xr::XrScene::kMaxSlots * iwn::xr::XrScene::kSlotFloats * sizeof(float);
    std::shared_ptr<v8::BackingStore> store =
        v8::ArrayBuffer::NewBackingStore(iwn::xr::XrScene::poses(), bytes, v8::BackingStore::EmptyDeleter, nullptr);
    g.pose_buffer.Reset(iso, v8::ArrayBuffer::New(iso, std::move(store)));
  }
  info.GetReturnValue().Set(g.pose_buffer.Get(iso));
}

void SceneStatus(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* iso = info.GetIsolate();
  iwn::xr::XrScene* scene = XrSystem::get().scene();
  Json j = scene ? scene->status() : Json::object();
  if (!scene) j.set("phase", "unavailable");
  info.GetReturnValue().Set(json_to_v8(iso, iso->GetCurrentContext(), j));
}

void DebugFoveation(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* iso = info.GetIsolate();
  info.GetReturnValue().Set(json_to_v8(iso, iso->GetCurrentContext(), XrSystem::get().debug_foveation()));
}

void set_fn(v8::Isolate* iso, v8::Local<v8::Context> ctx, v8::Local<v8::Object> o, const char* name,
            v8::FunctionCallback cb) {
  v8::Local<v8::Function> fn = v8::Function::New(ctx, cb).ToLocalChecked();
  fn->SetName(str(iso, name));
  o->Set(ctx, str(iso, name), fn).Check();
}

iwn::xr::XrConfig read_config(Runtime* rt) {
  std::vector<std::string> warnings;
  iwn::xr::XrConfig cfg;
  if (auto bytes = rt->assets().read("iwn/config.json")) {
    if (auto json = Json::parse(bytes->view())) cfg = iwn::xr::parse_xr_config(*json, &warnings);
  }
  for (const auto& w : warnings) iwn::log(LogLevel::kWarn, "config: %s", w.c_str());
  return cfg;
}

}  // namespace

void iwn_register_xr_anchors(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Object> xr);

void iwn_register_xr(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Object> natives) {
  Runtime* rt = Runtime::From(isolate);
  if (!rt) return;  // workers and other isolates the core did not create have no XR
  BindingState& g = G();
  XrSystem& xr = XrSystem::get();
  if (!g.installed) {
    g.installed = true;
    g.rt = rt;
    const bool debug = rt->config().inspector_enabled || rt->config().debug_enabled;
    xr.set_js_wake([rt] { rt->loop().wake(); });
    const iwn::xr::XrConfig cfg = read_config(rt);
    // The loading screen's image (the APK's system splash, assets/vr_splash.png by default): read here, decoded on
    // its own thread while OpenXR starts.
    std::shared_ptr<iwn::AssetBytes> splash;
    if (cfg.loading.enabled && !cfg.loading.image.empty()) splash = rt->assets().read(cfg.loading.image);
    xr.start(rt, cfg, debug, debug, std::move(splash));
    rt->set_frame_pump(&Pump());
    rt->add_debug_method("shot", [](const Json& params, Runtime::DebugReply reply) {
      XrSystem::get().request_shot(params["eye"].string_or("both"), params["scale"].as_number(1.0), std::move(reply));
    });
    rt->add_stats_provider("xr", [] { return XrSystem::get().stats(); });
    iwn::xr::PermissionBroker::get().start();
    rt->add_shutdown_hook([] {
      BindingState& st = G();
      // PROC-7: the page's WebXR session ends first (its `end` event fires), then OpenXR is torn down.
      if (st.rt && !st.handler.IsEmpty()) {
        std::vector<XrEvent> end_event{XrEvent{XrEvent::kSessionEnd}};
        call_handler(st.rt, kKindEvents, &end_event);
      }
      // After the page's last JS (an `end` listener may still ask) and before the XR system its wait asks for the
      // focus: the broker refuses requests until the next registration, and no promise of this isolate stays.
      iwn::xr::PermissionBroker::get().stop();
      st.permission_requests.clear();
      XrSystem::get().stop();
      if (st.rt) st.rt->set_frame_pump(nullptr);
      st.handler.Reset();
      st.record_buffer.Reset();
      st.layer_buffer.Reset();
      st.pose_buffer.Reset();
      st.depth_buffer.Reset();
      // The activity can be relaunched in this process (a new Runtime after onDestroy): the next registration must
      // start the XR system again.
      st.installed = false;
      st.rt = nullptr;
      st.generation = ~0ull;
      st.window_frame = nullptr;
      st.in_frame = false;
      st.events.clear();
    });
  }
  if (g.generation != rt->context_generation()) {
    // A new page context (first boot or location.reload()): the old page's handler and record view are gone, and
    // so is any WebXR session it had (the OpenXR session itself keeps running: XR-IDLE-3). The new page is still
    // booting: XR-LIFE-5's grace period must not run for it, XR-LIFE-7 applies from its load (PROC-8, PROC-9).
    if (g.generation != ~0ull) {
      xr.end_webxr_session();
      xr.notify_page_started();
    }
    g.generation = rt->context_generation();
    g.permission_requests.clear();
    g.handler.Reset();
    g.record_buffer.Reset();
    g.layer_buffer.Reset();
    g.pose_buffer.Reset();
    g.depth_buffer.Reset();
  }

  v8::Local<v8::Object> o = v8::Object::New(isolate);
  set_fn(isolate, ctx, o, "info", Info);
  set_fn(isolate, ctx, o, "record", Record);
  set_fn(isolate, ctx, o, "setFrameHandler", SetFrameHandler);
  set_fn(isolate, ctx, o, "beginSwapchain", BeginSwapchain);
  set_fn(isolate, ctx, o, "endSession", EndSession);
  set_fn(isolate, ctx, o, "requestFrameRate", RequestFrameRate);
  set_fn(isolate, ctx, o, "setFoveation", SetFoveation);
  set_fn(isolate, ctx, o, "setPassthroughVisible", SetPassthroughVisible);
  set_fn(isolate, ctx, o, "haptic", Haptic);
  set_fn(isolate, ctx, o, "sessionStarted", SessionStarted);
  set_fn(isolate, ctx, o, "offered", Offered);
  set_fn(isolate, ctx, o, "offerRejected", OfferRejected);
  set_fn(isolate, ctx, o, "entryEvaluated", EntryEvaluated);
  set_fn(isolate, ctx, o, "runWindowFrame", RunWindowFrame);
  set_fn(isolate, ctx, o, "endFrameGL", EndFrameGL);
  set_fn(isolate, ctx, o, "debugFoveation", DebugFoveation);
  set_fn(isolate, ctx, o, "layers", Layers);
  set_fn(isolate, ctx, o, "beginLayerSwapchain", BeginLayerSwapchain);
  set_fn(isolate, ctx, o, "destroyLayerSwapchain", DestroyLayerSwapchain);
  set_fn(isolate, ctx, o, "acquireLayerImage", AcquireLayerImage);
  set_fn(isolate, ctx, o, "requestPermissions", RequestPermissions);
  set_fn(isolate, ctx, o, "checkPermissions", CheckPermissions);
  set_fn(isolate, ctx, o, "declaredPermissions", DeclaredPermissions);
  set_fn(isolate, ctx, o, "sceneData", SceneData);
  set_fn(isolate, ctx, o, "scenePoses", ScenePoses);
  set_fn(isolate, ctx, o, "sceneStatus", SceneStatus);
  set_fn(isolate, ctx, o, "startDepth", StartDepth);
  set_fn(isolate, ctx, o, "depthRecord", DepthRecord);
  o->Set(ctx, str(isolate, "depthRecordVersion"),
         v8::Integer::NewFromUnsigned(isolate, iwn::xr::depth_layout::kDepthVersion))
      .Check();
  o->Set(ctx, str(isolate, "layoutVersion"), v8::Integer::NewFromUnsigned(isolate, L::kVersion)).Check();
  iwn_register_xr_anchors(isolate, ctx, o);
  natives->Set(ctx, str(isolate, "xr"), o).Check();
}
