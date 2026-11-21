// The core's natives on globalThis.__iwn (NATIVE MODULE CONTRACT): core (console sink, timers, rAF, hooks,
// microtasks, error reporting, lifecycle state), clock, loop, clone, crypto, app, device, config. The JS side is
// core/js/bootstrap.js (and the web glue reads clock/loop/clone/app/device/config, web/glue/src/natives.ts).
#include <errno.h>
#include <stdlib.h>
#if !defined(__ANDROID__)
#include <sys/random.h>
#endif

#include <thread>

#include "iwn/core/clock.h"
#include "iwn/core/log.h"
#include "v8/runtime_impl.h"
#include "v8/v8_util.h"

#ifndef IWN_RUNTIME_VERSION
#define IWN_RUNTIME_VERSION "0.0.0"
#endif

namespace iwn {

void install_clone_natives(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Object> natives);

namespace {

RuntimeImpl& rt_of(const v8::FunctionCallbackInfo<v8::Value>& info) {
  return *static_cast<RuntimeImpl*>(Runtime::From(info.GetIsolate()));
}

double number_arg(const v8::FunctionCallbackInfo<v8::Value>& info, int i, double def = 0) {
  if (info.Length() <= i) return def;
  return info[i]->NumberValue(info.GetIsolate()->GetCurrentContext()).FromMaybe(def);
}

// crypto.random(bytes): fills an ArrayBufferView in place from the OS CSPRNG (NET-STORE-4; the glue's
// crypto.getRandomValues/randomUUID sit on top and enforce the 64 KB quota).
void crypto_random(const v8::FunctionCallbackInfo<v8::Value>& info) {
  if (info.Length() < 1 || !info[0]->IsArrayBufferView()) {
    v8u::throw_type_error(info.GetIsolate(), "crypto.random(ArrayBufferView)");
    return;
  }
  auto view = info[0].As<v8::ArrayBufferView>();
  size_t len = view->ByteLength();
  if (len == 0) return;
  auto* base = static_cast<uint8_t*>(view->Buffer()->Data());
  if (!base) {
    v8u::throw_type_error(info.GetIsolate(), "crypto.random: detached buffer");
    return;
  }
  uint8_t* p = base + view->ByteOffset();
#if defined(__ANDROID__)
  arc4random_buf(p, len);  // bionic: seeded from getrandom(2), never fails
#else
  size_t done = 0;
  while (done < len) {
    ssize_t n = getrandom(p + done, len - done, 0);
    if (n < 0) {
      if (errno == EINTR) continue;
      v8u::throw_type_error(info.GetIsolate(), "crypto.random: getrandom failed");
      return;
    }
    done += static_cast<size_t>(n);
  }
#endif
}

// core.log(level, text): level 0 debug, 1 info, 2 warn, 3 error (CON-2).
void core_log(const v8::FunctionCallbackInfo<v8::Value>& info) {
  int level = static_cast<int>(number_arg(info, 0, 1));
  if (level < 0 || level > 3) level = 1;
  std::string text = info.Length() > 1 ? v8u::to_utf8(info.GetIsolate(), info[1]) : "";
  log_js(static_cast<LogLevel>(level), text);
}

void core_timer_add(const v8::FunctionCallbackInfo<v8::Value>& info) {
  RuntimeImpl& rt = rt_of(info);
  double timeout = number_arg(info, 0, 0);
  bool repeat = info.Length() > 1 && info[1]->BooleanValue(info.GetIsolate());
  int id = rt.loop().timers().add(timeout, repeat, now_ms());
  info.GetReturnValue().Set(id);
}

void core_timer_clear(const v8::FunctionCallbackInfo<v8::Value>& info) {
  RuntimeImpl& rt = rt_of(info);
  rt.loop().timers().clear(static_cast<int>(number_arg(info, 0, 0)));
}

void core_request_frame(const v8::FunctionCallbackInfo<v8::Value>& info) { rt_of(info).loop().request_animation_frame(); }

void core_set_hooks(const v8::FunctionCallbackInfo<v8::Value>& info) {
  if (info.Length() < 1 || !info[0]->IsObject()) {
    v8u::throw_type_error(info.GetIsolate(), "setHooks(object)");
    return;
  }
  rt_of(info).set_hooks(info[0].As<v8::Object>());
}

void core_set_blob_resolver(const v8::FunctionCallbackInfo<v8::Value>& info) {
  if (info.Length() < 1 || !info[0]->IsFunction()) {
    v8u::throw_type_error(info.GetIsolate(), "setBlobResolver(function)");
    return;
  }
  rt_of(info).set_blob_resolver(info[0]);
}

// core.invokeCallback(fn, thisArg, ...args): calls a page callback from glue JS the way the runtime calls its own
// (Web IDL "invoke a callback function" + HTML "report an exception"): under a PageCallScope, so an exception is
// reported once as uncaught (error event, logcat, DevTools) and "pause on uncaught exceptions" stops at the throw
// (CDP-5), which a JS try/catch in the glue would prevent. Returns fn's result, or undefined if it threw. No
// microtask checkpoint: JS is on the stack (HTML "clean up after running script" only checkpoints when it is not).
// (There is deliberately no core.runMicrotasks: a checkpoint requested from JS would run with JS on the stack.)
void core_invoke_callback(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* isolate = info.GetIsolate();
  if (info.Length() < 1 || !info[0]->IsFunction()) {
    v8u::throw_type_error(isolate, "invokeCallback(fn, thisArg, ...args): fn is not a function");
    return;
  }
  RuntimeImpl& rt = rt_of(info);
  v8::Local<v8::Context> ctx = isolate->GetCurrentContext();
  std::vector<v8::Local<v8::Value>> argv;
  for (int i = 2; i < info.Length(); ++i) argv.push_back(info[i]);
  v8::Local<v8::Value> recv = info.Length() > 1 ? info[1] : v8::Undefined(isolate).As<v8::Value>();
  v8::Local<v8::Value> result;
  {
    PageCallScope scope(rt);
    if (!info[0].As<v8::Function>()
             ->Call(ctx, recv, static_cast<int>(argv.size()), argv.empty() ? nullptr : argv.data())
             .ToLocal(&result)) {
      return;  // reported by the scope (a termination is not reported and keeps unwinding the callers)
    }
  }
  info.GetReturnValue().Set(result);
}

// queueMicrotask's callback runs from a native microtask under a PageCallScope (Chrome's model): an exception
// is reported once with its location and DevTools "pause on uncaught exceptions" stops at the throw (CDP-5,
// LOOP-4). A JS try/catch wrapper would make V8 predict every such exception as caught.
// The microtask's data is the callback itself (MicrotaskCallbackWithData), so nothing outlives a discarded queue.
void run_native_microtask(v8::Local<v8::Data> data) {
  v8::Isolate* isolate = v8::Isolate::GetCurrent();
  auto* rt = static_cast<RuntimeImpl*>(Runtime::From(isolate));
  if (!rt || data.IsEmpty() || !data->IsValue()) return;
  v8::Local<v8::Value> value = data.As<v8::Value>();
  if (!value->IsFunction()) return;
  v8::HandleScope hs(isolate);
  v8::Local<v8::Context> ctx = rt->context();
  if (ctx.IsEmpty()) return;
  v8::Local<v8::Function> fn = value.As<v8::Function>();
  v8::Local<v8::Context> created;
  if (fn->GetCreationContext(isolate).ToLocal(&created) && created != ctx) return;  // from a page since reloaded
  v8::Context::Scope cs(ctx);
  PageCallScope scope(*rt);
  (void)fn->Call(ctx, v8::Undefined(isolate), 0, nullptr);
}

void core_enqueue_microtask(const v8::FunctionCallbackInfo<v8::Value>& info) {
  if (info.Length() < 1 || !info[0]->IsFunction()) {
    v8u::throw_type_error(info.GetIsolate(), "The callback provided as parameter 1 is not a function.");
    return;
  }
  v8::Isolate* isolate = info.GetIsolate();
  isolate->GetCurrentContext()->GetMicrotaskQueue()->EnqueueMicrotask(isolate, &run_native_microtask,
                                                                     info[0].As<v8::Data>());
}

// core.reportError(error): HTML "report an exception" for the page's reportError(): the error event (with the
// error's own location, from its stack), then logcat and DevTools unless cancelled (LOOP-4).
void core_report_error(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* isolate = info.GetIsolate();
  v8::Local<v8::Value> error = info.Length() > 0 ? info[0] : v8::Undefined(isolate).As<v8::Value>();
  rt_of(info).report_exception_value(error, v8::Exception::CreateMessage(isolate, error));
}

// core.reportException(error): log + DevTools, without dispatching the error event again (the JS caller did).
void core_report_exception(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* isolate = info.GetIsolate();
  RuntimeImpl& rt = rt_of(info);
  v8::Local<v8::Value> error = info.Length() > 0 ? info[0] : v8::Undefined(isolate).As<v8::Value>();
  v8::Local<v8::Context> ctx = isolate->GetCurrentContext();
  std::string text = v8u::exception_text(isolate, ctx, error);
  rt.counter_uncaught++;
  log_js(LogLevel::kError, "Uncaught " + text);
  rt.devtools().exception_thrown(ctx, error, v8::Exception::CreateMessage(isolate, error), "Uncaught");
}

void core_lifecycle_state(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* isolate = info.GetIsolate();
  RuntimeImpl& rt = rt_of(info);
  v8::Local<v8::Context> ctx = isolate->GetCurrentContext();
  v8::Local<v8::Object> o = v8::Object::New(isolate);
  v8u::set_value(isolate, ctx, o, "visibilityState", v8u::str(isolate, rt.lifecycle().visibility_state()));
  v8u::set_value(isolate, ctx, o, "focused", v8::Boolean::New(isolate, rt.lifecycle().focused()));
  v8u::set_value(isolate, ctx, o, "readyState", v8u::str(isolate, rt.ready_state()));
  info.GetReturnValue().Set(o);
}

// reload([url]): restart the page, with `url` (same origin) as the new document URL when given (DOM-5).
void core_reload(const v8::FunctionCallbackInfo<v8::Value>& info) {
  std::string url;
  if (info.Length() > 0 && info[0]->IsString()) url = v8u::to_utf8(info.GetIsolate(), info[0]);
  rt_of(info).request_reload(url);
}

void core_close(const v8::FunctionCallbackInfo<v8::Value>& info) { rt_of(info).request_exit(); }

void core_inspector_sessions(const v8::FunctionCallbackInfo<v8::Value>& info) {
  info.GetReturnValue().Set(static_cast<uint32_t>(rt_of(info).devtools().session_count()));
}

// core.documentSource(): the text of the app's entry document (config "index", default index.html) or null. The DOM
// stand-ins (web/dom) build the initial element tree from it at boot (DOM-7); the core runs its scripts itself.
void core_document_source(const v8::FunctionCallbackInfo<v8::Value>& info) {
  RuntimeImpl& rt = rt_of(info);
  auto bytes = rt.read_app_file(rt.config().index);
  if (!bytes || bytes->size() > (8u << 20)) {
    info.GetReturnValue().SetNull();
    return;
  }
  info.GetReturnValue().Set(v8u::str(info.GetIsolate(), bytes->view()));
}

void clock_now(const v8::FunctionCallbackInfo<v8::Value>& info) { info.GetReturnValue().Set(now_ms()); }
void clock_time_origin(const v8::FunctionCallbackInfo<v8::Value>& info) {
  info.GetReturnValue().Set(time_origin_ms());
}

void device_info(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* isolate = info.GetIsolate();
  v8::Local<v8::Context> ctx = isolate->GetCurrentContext();
  const DeviceFacts& d = rt_of(info).options().device;
  v8::Local<v8::Object> o = v8::Object::New(isolate);
  v8u::set_value(isolate, ctx, o, "model", v8u::str(isolate, d.model));
  v8u::set_value(isolate, ctx, o, "androidRelease", v8u::str(isolate, d.android_release));
  v8::Local<v8::Value> langs[] = {v8u::str(isolate, d.locale.empty() ? "en-US" : d.locale)};
  v8u::set_value(isolate, ctx, o, "languages", v8::Array::New(isolate, langs, 1));
  int cores = d.cpu_count > 0 ? d.cpu_count : static_cast<int>(std::thread::hardware_concurrency());
  v8u::set_value(isolate, ctx, o, "hardwareConcurrency", v8::Integer::New(isolate, cores));
  if (d.memory_gib > 0) v8u::set_value(isolate, ctx, o, "deviceMemory", v8::Number::New(isolate, d.memory_gib));
  v8u::set_value(isolate, ctx, o, "onLine", v8::True(isolate));
  info.GetReturnValue().Set(o);
}

}  // namespace

void install_core_natives(RuntimeImpl& rt, v8::Local<v8::Context> ctx, v8::Local<v8::Object> natives) {
  v8::Isolate* isolate = rt.isolate();

  v8::Local<v8::Object> core = v8::Object::New(isolate);
  v8u::set_function(isolate, ctx, core, "log", core_log);
  v8u::set_function(isolate, ctx, core, "timerAdd", core_timer_add);
  v8u::set_function(isolate, ctx, core, "timerClear", core_timer_clear);
  v8u::set_function(isolate, ctx, core, "requestFrame", core_request_frame);
  v8u::set_function(isolate, ctx, core, "setHooks", core_set_hooks);
  v8u::set_function(isolate, ctx, core, "setBlobResolver", core_set_blob_resolver);
  v8u::set_function(isolate, ctx, core, "invokeCallback", core_invoke_callback);
  v8u::set_function(isolate, ctx, core, "enqueueMicrotask", core_enqueue_microtask);
  v8u::set_function(isolate, ctx, core, "reportException", core_report_exception);
  v8u::set_function(isolate, ctx, core, "reportError", core_report_error);
  v8u::set_function(isolate, ctx, core, "lifecycleState", core_lifecycle_state);
  v8u::set_function(isolate, ctx, core, "reload", core_reload);
  v8u::set_function(isolate, ctx, core, "close", core_close);
  v8u::set_function(isolate, ctx, core, "inspectorSessions", core_inspector_sessions);
  v8u::set_function(isolate, ctx, core, "documentSource", core_document_source);
  v8u::set_value(isolate, ctx, core, "runtimeVersion", v8u::str(isolate, IWN_RUNTIME_VERSION));
  v8u::set_value(isolate, ctx, core, "v8Version", v8u::str(isolate, v8::V8::GetVersion()));
  v8u::set_value(isolate, ctx, core, "origin", v8u::str(isolate, rt.app_origin().origin()));
  v8u::set_value(isolate, ctx, core, "documentUrl", v8u::str(isolate, rt.document_url().href()));
  v8u::set_value(isolate, ctx, core, "isWorker", v8::False(isolate));
  v8u::set_value(isolate, ctx, natives, "core", core);

  v8::Local<v8::Object> clock = v8::Object::New(isolate);
  v8u::set_function(isolate, ctx, clock, "now", clock_now);
  v8u::set_function(isolate, ctx, clock, "timeOrigin", clock_time_origin);
  v8u::set_value(isolate, ctx, natives, "clock", clock);

  v8::Local<v8::Object> loop = v8::Object::New(isolate);
  v8u::set_function(isolate, ctx, loop, "queueMicrotask", core_enqueue_microtask);
  v8u::set_value(isolate, ctx, natives, "loop", loop);

  install_clone_natives(isolate, ctx, natives);

  v8::Local<v8::Object> crypto = v8::Object::New(isolate);
  v8u::set_function(isolate, ctx, crypto, "random", crypto_random);
  v8u::set_value(isolate, ctx, natives, "crypto", crypto);

  v8::Local<v8::Object> app = v8::Object::New(isolate);
  v8u::set_function(isolate, ctx, app, "reload", core_reload);
  v8u::set_function(isolate, ctx, app, "close", core_close);
  v8u::set_value(isolate, ctx, natives, "app", app);

  v8::Local<v8::Object> device = v8::Object::New(isolate);
  v8u::set_function(isolate, ctx, device, "info", device_info);
  v8u::set_value(isolate, ctx, natives, "device", device);

  // __iwn.config: the glue section of the generated config, with the page URL and runtime version filled in.
  Json glue = rt.config().glue.is_object() ? rt.config().glue : Json::object();
  if (!glue.has("url")) glue.set("url", rt.document_url().href());
  if (!glue.has("runtimeVersion")) glue.set("runtimeVersion", IWN_RUNTIME_VERSION);
  v8::Local<v8::Value> config;
  if (v8::JSON::Parse(ctx, v8u::str(isolate, glue.dump())).ToLocal(&config)) {
    v8u::set_value(isolate, ctx, natives, "config", config);
  }
}

}  // namespace iwn
