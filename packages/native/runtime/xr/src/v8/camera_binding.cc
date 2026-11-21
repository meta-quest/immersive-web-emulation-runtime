// V8 binding of the passthrough cameras (XR-CAM-1): globalThis.__iwn.camera, the natives web/xr's getUserMedia
// (src/camera.ts) uses. Registered as its own module from the XR module's library (runtime/xr/CMakeLists.txt). The
// camera itself is src/android/xr_camera.cc; frames reach JS as image-module handles (runtime/image INTEROP.md), so
// texImage2D and drawImage take them like a decoded image.
//
// JS API (web/xr/src/camera.ts is the only caller):
//   declared                            the app declared the camera (config xr.features.camera): no other call works
//                                       without it
//   permitted() -> bool                 the camera permissions are held (CameraService::permitted); until then
//                                       devices() is empty and open() rejects with NotAllowedError
//   devices() -> [{ deviceId, label, position, facing, sizes: [[w, h]...], frameRates: [[min, max]...] }]
//   hidden() -> bool                    the cameras are withheld (the camera permissions are not granted)
//   open(deviceId, width, height, frameRate) -> Promise<{ stream, width, height, frameRate }>
//                                       rejects with { name, message } (name: a DOMException name)
//   frame(stream) -> { handle, width, height, serial, timestampNs } | null   the newest frame (one handle per frame)
//   close(stream)
//   setFrameHandler(fn(stream, ended))  a task per new frame (coalesced: at most one queued per stream) and one when a
//                                       stream ends by itself
#include <v8.h>

#include <atomic>
#include <cmath>
#include <map>
#include <mutex>

#include "android/xr_camera.h"
#include "iwn/core/log.h"
#include "iwn/core/runtime.h"
#include "iwn/image/v8_binding.h"

namespace {

using iwn::Json;
using iwn::LogLevel;
using iwn::Runtime;
using iwn::xr::CameraService;

struct CameraBinding {
  Runtime* rt = nullptr;
  bool installed = false;
  bool declared = false;
  uint64_t generation = ~0ull;
  std::atomic<uint64_t> live_generation{~0ull};  // read by the worker and reader threads
  v8::Global<v8::Function> handler;
  // JS thread only: pending open() promises by request id, and the streams this page opened.
  std::map<uint32_t, v8::Global<v8::Promise::Resolver>> opens;
  uint32_t next_request = 1;
  std::map<int, uint64_t> streams;  // stream -> serial of the last frame handed out
  // Any thread: streams with a frame notification queued.
  std::mutex mu;
  std::map<int, bool> queued;
};

CameraBinding& B() {
  static CameraBinding* b = new CameraBinding();
  return *b;
}

v8::Local<v8::String> str(v8::Isolate* iso, const char* s) {
  return v8::String::NewFromUtf8(iso, s, v8::NewStringType::kInternalized).ToLocalChecked();
}
v8::Local<v8::String> str(v8::Isolate* iso, const std::string& s) {
  return v8::String::NewFromUtf8(iso, s.data(), v8::NewStringType::kNormal, static_cast<int>(s.size()))
      .ToLocalChecked();
}

int int_arg(const v8::FunctionCallbackInfo<v8::Value>& info, int i, int lo, int hi, int def) {
  if (info.Length() <= i) return def;
  const double v = info[i]->NumberValue(info.GetIsolate()->GetCurrentContext()).FromMaybe(NAN);
  return std::isfinite(v) && v >= lo && v <= hi ? static_cast<int>(v) : def;
}

v8::Local<v8::Array> pairs(v8::Isolate* iso, v8::Local<v8::Context> ctx, const std::vector<std::pair<int, int>>& v) {
  v8::Local<v8::Array> a = v8::Array::New(iso, static_cast<int>(v.size()));
  for (uint32_t i = 0; i < v.size(); ++i) {
    v8::Local<v8::Array> p = v8::Array::New(iso, 2);
    p->Set(ctx, 0, v8::Integer::New(iso, v[i].first)).Check();
    p->Set(ctx, 1, v8::Integer::New(iso, v[i].second)).Check();
    a->Set(ctx, i, p).Check();
  }
  return a;
}

bool require_declared(const v8::FunctionCallbackInfo<v8::Value>& info) {
  if (B().declared) return true;
  info.GetIsolate()->ThrowException(v8::Exception::TypeError(
      str(info.GetIsolate(), "camera: the app does not declare the camera (native.features.camera)")));
  return false;
}

void Permitted(const v8::FunctionCallbackInfo<v8::Value>& info) {
  if (!require_declared(info)) return;
  info.GetReturnValue().Set(CameraService::get().permitted());
}

void Devices(const v8::FunctionCallbackInfo<v8::Value>& info) {
  if (!require_declared(info)) return;
  v8::Isolate* iso = info.GetIsolate();
  v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  const std::vector<iwn::xr::CameraDeviceInfo> list = CameraService::get().devices();
  v8::Local<v8::Array> out = v8::Array::New(iso, static_cast<int>(list.size()));
  for (uint32_t i = 0; i < list.size(); ++i) {
    const auto& d = list[i];
    v8::Local<v8::Object> o = v8::Object::New(iso);
    o->Set(ctx, str(iso, "deviceId"), str(iso, d.id)).Check();
    o->Set(ctx, str(iso, "label"), str(iso, d.label)).Check();
    o->Set(ctx, str(iso, "position"), v8::Integer::New(iso, d.position)).Check();
    // MediaTrackSettings.facingMode: the passthrough cameras look where the wearer looks ('environment').
    const char* facing = d.facing == iwn::xr::LensFacing::kFront   ? "user"
                         : d.facing == iwn::xr::LensFacing::kBack ? "environment"
                                                                  : "";
    o->Set(ctx, str(iso, "facing"), str(iso, facing)).Check();
    o->Set(ctx, str(iso, "sizes"), pairs(iso, ctx, d.sizes)).Check();
    o->Set(ctx, str(iso, "frameRates"), pairs(iso, ctx, d.frame_rates)).Check();
    out->Set(ctx, i, o).Check();
  }
  info.GetReturnValue().Set(out);
}

void Hidden(const v8::FunctionCallbackInfo<v8::Value>& info) {
  if (!require_declared(info)) return;
  bool hidden = false;
  (void)CameraService::get().devices(&hidden);
  info.GetReturnValue().Set(hidden);
}

void Open(const v8::FunctionCallbackInfo<v8::Value>& info) {
  if (!require_declared(info)) return;
  v8::Isolate* iso = info.GetIsolate();
  v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  CameraBinding& b = B();
  v8::Local<v8::Promise::Resolver> resolver = v8::Promise::Resolver::New(ctx).ToLocalChecked();
  info.GetReturnValue().Set(resolver->GetPromise());
  v8::String::Utf8Value id(iso, info.Length() > 0 ? info[0] : v8::Undefined(iso).As<v8::Value>());
  const int w = int_arg(info, 1, 1, 8192, 0);
  const int h = int_arg(info, 2, 1, 8192, 0);
  const int fps = int_arg(info, 3, 1, 240, 0);
  const uint32_t req = b.next_request++;
  b.opens[req].Reset(iso, resolver);
  Runtime* rt = b.rt;
  const uint64_t gen = b.generation;
  CameraService::get().open(*id ? *id : "", w, h, fps, [rt, req, gen](iwn::xr::CameraOpenResult r) {
    // Worker thread. A page that went away (reload) gets nothing: its stream is closed at once.
    if (B().live_generation.load() != gen) {
      if (r.stream > 0) CameraService::get().close(r.stream);
      return;
    }
    rt->post_task([req, gen, r = std::move(r)] {
      CameraBinding& b = B();
      auto it = b.opens.find(req);
      if (it == b.opens.end() || b.generation != gen) {
        if (r.stream > 0) CameraService::get().close(r.stream);
        return;
      }
      v8::Isolate* iso = b.rt->isolate();
      v8::Local<v8::Context> ctx = b.rt->context();
      v8::Local<v8::Promise::Resolver> resolver = it->second.Get(iso);
      b.opens.erase(it);
      v8::Local<v8::Object> o = v8::Object::New(iso);
      if (r.stream > 0) {
        b.streams[r.stream] = 0;
        o->Set(ctx, str(iso, "stream"), v8::Integer::New(iso, r.stream)).Check();
        o->Set(ctx, str(iso, "width"), v8::Integer::New(iso, r.width)).Check();
        o->Set(ctx, str(iso, "height"), v8::Integer::New(iso, r.height)).Check();
        o->Set(ctx, str(iso, "frameRate"), v8::Integer::New(iso, r.frame_rate)).Check();
        resolver->Resolve(ctx, o).Check();
      } else {
        o->Set(ctx, str(iso, "name"), str(iso, r.error)).Check();
        o->Set(ctx, str(iso, "message"), str(iso, r.message)).Check();
        resolver->Reject(ctx, o).Check();
      }
    });
  });
}

void Frame(const v8::FunctionCallbackInfo<v8::Value>& info) {
  if (!require_declared(info)) return;
  v8::Isolate* iso = info.GetIsolate();
  v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  CameraBinding& b = B();
  const int stream = int_arg(info, 0, 1, 1 << 30, 0);
  auto it = b.streams.find(stream);
  iwn::xr::CameraFrame f;
  if (it == b.streams.end() || !CameraService::get().latest(stream, &f)) {
    info.GetReturnValue().SetNull();
    return;
  }
  v8::Local<v8::Object> handle = iwn::image::WrapPixelStore(iso, ctx, f.store);
  if (handle.IsEmpty()) {
    info.GetReturnValue().SetNull();  // no image module in this context
    return;
  }
  it->second = f.serial;
  v8::Local<v8::Object> o = v8::Object::New(iso);
  o->Set(ctx, str(iso, "handle"), handle).Check();
  o->Set(ctx, str(iso, "width"), v8::Integer::NewFromUnsigned(iso, f.store->width())).Check();
  o->Set(ctx, str(iso, "height"), v8::Integer::NewFromUnsigned(iso, f.store->height())).Check();
  o->Set(ctx, str(iso, "serial"), v8::Number::New(iso, static_cast<double>(f.serial))).Check();
  o->Set(ctx, str(iso, "timestampNs"), v8::Number::New(iso, static_cast<double>(f.timestamp_ns))).Check();
  info.GetReturnValue().Set(o);
}

void Close(const v8::FunctionCallbackInfo<v8::Value>& info) {
  CameraBinding& b = B();
  const int stream = int_arg(info, 0, 1, 1 << 30, 0);
  if (b.streams.erase(stream) == 0) return;
  {
    std::lock_guard<std::mutex> lock(b.mu);
    b.queued.erase(stream);
  }
  CameraService::get().close(stream);
}

void SetFrameHandler(const v8::FunctionCallbackInfo<v8::Value>& info) {
  CameraBinding& b = B();
  if (info.Length() < 1 || !info[0]->IsFunction()) {
    b.handler.Reset();
    return;
  }
  b.handler.Reset(info.GetIsolate(), info[0].As<v8::Function>());
}

// Reader thread: queue one task per stream until JS has run it.
void on_frame(int stream, bool ended) {
  CameraBinding& b = B();
  {
    std::lock_guard<std::mutex> lock(b.mu);
    bool& q = b.queued[stream];
    if (q && !ended) return;
    q = true;
  }
  Runtime* rt = b.rt;
  if (!rt) return;
  rt->post_task([stream, ended] {
    CameraBinding& b = B();
    {
      std::lock_guard<std::mutex> lock(b.mu);
      b.queued.erase(stream);
    }
    if (b.handler.IsEmpty() || !b.streams.count(stream)) return;
    v8::Isolate* iso = b.rt->isolate();
    v8::Local<v8::Value> argv[2] = {v8::Integer::New(iso, stream), v8::Boolean::New(iso, ended)};
    (void)b.rt->call_function(b.handler.Get(iso), v8::Undefined(iso), 2, argv);
  });
}

void close_page_streams() {
  CameraBinding& b = B();
  for (const auto& [stream, serial] : b.streams) CameraService::get().close(stream);
  b.streams.clear();
  b.opens.clear();
  b.handler.Reset();
  std::lock_guard<std::mutex> lock(b.mu);
  b.queued.clear();
}

void set_fn(v8::Isolate* iso, v8::Local<v8::Context> ctx, v8::Local<v8::Object> o, const char* name,
            v8::FunctionCallback cb) {
  v8::Local<v8::Function> fn = v8::Function::New(ctx, cb).ToLocalChecked();
  fn->SetName(str(iso, name));
  o->Set(ctx, str(iso, name), fn).Check();
}

// The camera is opt-in (XR-CAM-1): the packer writes the declared feature into the runtime config.
bool read_declared(Runtime* rt) {
  if (auto bytes = rt->assets().read("iwn/config.json")) {
    if (auto json = Json::parse(bytes->view())) {
      const Json& f = (*json)["xr"]["features"]["camera"];
      return f.is_string() || f.as_bool(false);
    }
  }
  return false;
}

}  // namespace

void iwn_register_camera(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Object> natives) {
  Runtime* rt = Runtime::From(isolate);
  if (!rt) return;  // workers have no camera
  CameraBinding& b = B();
  if (!b.installed) {
    b.installed = true;
    b.rt = rt;
    b.declared = read_declared(rt);
    if (b.declared) iwn::log(LogLevel::kInfo, "camera: declared by the app (getUserMedia over the passthrough cameras)");
    CameraService::get().set_listener(on_frame);
    rt->add_stats_provider("camera", [] {
      Json j = CameraService::get().stats();
      j.set("declared", B().declared);
      return j;
    });
    rt->add_shutdown_hook([] {
      CameraBinding& st = B();
      close_page_streams();
      CameraService::get().shutdown();
      st.installed = false;
      st.rt = nullptr;
      st.generation = ~0ull;
      st.live_generation = ~0ull;
    });
  }
  if (b.generation != rt->context_generation()) {
    // A new page context (location.reload()): the old page's streams stop, its promises are dropped.
    close_page_streams();
    b.generation = rt->context_generation();
    b.live_generation = b.generation;
  }
  v8::Local<v8::Object> o = v8::Object::New(isolate);
  o->Set(ctx, str(isolate, "declared"), v8::Boolean::New(isolate, b.declared)).Check();
  set_fn(isolate, ctx, o, "permitted", Permitted);
  set_fn(isolate, ctx, o, "devices", Devices);
  set_fn(isolate, ctx, o, "hidden", Hidden);
  set_fn(isolate, ctx, o, "open", Open);
  set_fn(isolate, ctx, o, "frame", Frame);
  set_fn(isolate, ctx, o, "close", Close);
  set_fn(isolate, ctx, o, "setFrameHandler", SetFrameHandler);
  natives->Set(ctx, str(isolate, "camera"), o).Check();
}
