// Host debug endpoint (docs/spec/14): {"method","params","id"?} over WebSocket path /host; each reply is the
// method's result object (plus "id" when given) or {"error": "..."}, sent as one unfragmented text frame.
// Built-in methods: eval (DBG-EVAL), stats (DBG-STATS), info (DBG-6); modules add more (shot: XR module, M3).
#include "iwn/core/log.h"
#include "v8/runtime_impl.h"
#include "v8/v8_util.h"

namespace iwn {

void DevTools::handle_debug(uint64_t conn, const std::string& text) {
  std::string err;
  auto req = Json::parse(text, &err);
  std::weak_ptr<LoopbackServer> weak = server_;
  Json id = req && req->is_object() ? (*req)["id"] : Json();
  bool has_id = req && req->is_object() && req->has("id");
  Runtime::DebugReply reply = [weak, conn, id, has_id](Json result) {
    auto server = weak.lock();
    if (!server) return;
    if (!result.is_object()) {
      Json wrapped = Json::object();
      wrapped.set("result", std::move(result));
      result = std::move(wrapped);
    }
    if (has_id) result.set("id", id);
    server->send_text(conn, result.dump());
  };
  auto error = [&](const std::string& message) {
    Json e = Json::object();
    e.set("error", message);
    reply(std::move(e));
  };
  if (!req || !req->is_object()) {
    error("invalid request: " + (req ? std::string("not an object") : err));
    return;
  }
  std::string method = (*req)["method"].string_or("");
  const Json& params = (*req)["params"];
  if (method == "eval") {
    run_eval(params, reply);
  } else if (method == "stats") {
    reply(rt_.stats_json());
  } else if (method == "info") {
    reply(rt_.info_json());
  } else if (auto it = methods_.find(method); it != methods_.end()) {
    v8::TryCatch tc(rt_.isolate());
    it->second(params, reply);
  } else if (method == "shot") {
    error("shot is not available: no XR module provides eye-buffer capture yet (M3)");
  } else {
    error("unknown method '" + method + "'");
  }
}

namespace {

// JSON-serialisable value as a Json fragment; String(value) when JSON.stringify cannot represent it (DBG-EVAL).
Json serialize_value(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Value> value) {
  if (value.IsEmpty() || value->IsUndefined()) return Json(nullptr);
  if (!value->IsFunction() && !value->IsSymbol() && !value->IsBigInt()) {
    v8::TryCatch tc(isolate);
    v8::Local<v8::String> json;
    if (v8::JSON::Stringify(ctx, value).ToLocal(&json)) {
      std::string s = v8u::to_utf8(isolate, json);
      if (!s.empty() && s != "undefined") return Json::raw(s);
    }
  }
  return Json(v8u::safe_to_string(isolate, value));
}

}  // namespace

void DevTools::run_eval(const Json& params, Runtime::DebugReply reply) {
  v8::Isolate* isolate = rt_.isolate();
  v8::Local<v8::Context> ctx = rt_.context();
  auto fail = [&](const std::string& message) {
    Json e = Json::object();
    e.set("error", message);
    reply(std::move(e));
  };
  if (ctx.IsEmpty()) {
    fail("no page context");
    return;
  }
  if (!params["expression"].is_string()) {
    fail("eval needs params.expression (string)");
    return;
  }
  bool await_promise = params.has("awaitPromise") ? params["awaitPromise"].as_bool(true) : true;
  double timeout_ms = params["timeoutMs"].as_number(30000);
  v8::TryCatch tc(isolate);
  v8::ScriptOrigin origin(v8u::str(isolate, "iwn-debug:///eval"));
  v8::Local<v8::Script> script;
  v8::Local<v8::Value> result;
  if (!v8::Script::Compile(ctx, v8u::str(isolate, params["expression"].as_string()), &origin).ToLocal(&script) ||
      !script->Run(ctx).ToLocal(&result)) {
    fail(tc.HasTerminated() ? "terminated" : v8u::exception_text(isolate, ctx, tc.Exception()));
    return;
  }
  if (!await_promise || !result->IsPromise()) {
    Json r = Json::object();
    r.set("result", serialize_value(isolate, ctx, result));
    reply(std::move(r));
    return;
  }
  auto promise = result.As<v8::Promise>();
  if (promise->State() == v8::Promise::kFulfilled) {
    Json r = Json::object();
    r.set("result", serialize_value(isolate, ctx, promise->Result()));
    reply(std::move(r));
    return;
  }
  if (promise->State() == v8::Promise::kRejected) {
    promise->MarkAsHandled();
    fail(v8u::exception_text(isolate, ctx, promise->Result()));
    return;
  }
  // Pending: settle later from the outer loop; frames and tasks keep running meanwhile (LOOP-5).
  int rid = next_eval_id_++;
  auto req = std::make_shared<EvalRequest>();
  req->reply = std::move(reply);
  evals_[rid] = req;
  auto settle = [](const v8::FunctionCallbackInfo<v8::Value>& info) {
    auto* rt = static_cast<RuntimeImpl*>(Runtime::From(info.GetIsolate()));
    v8::Local<v8::Context> c = info.GetIsolate()->GetCurrentContext();
    auto data = info.Data().As<v8::Array>();
    int id = data->Get(c, 0).ToLocalChecked().As<v8::Int32>()->Value();
    bool ok = data->Get(c, 1).ToLocalChecked()->IsTrue();
    rt->devtools().finish_eval(id, ok, info.Length() > 0 ? info[0] : v8::Undefined(info.GetIsolate()).As<v8::Value>());
  };
  v8::Local<v8::Value> ok_data[] = {v8::Integer::New(isolate, rid), v8::True(isolate)};
  v8::Local<v8::Value> err_data[] = {v8::Integer::New(isolate, rid), v8::False(isolate)};
  auto ok_fn = v8::Function::New(ctx, settle, v8::Array::New(isolate, ok_data, 2)).ToLocalChecked();
  auto err_fn = v8::Function::New(ctx, settle, v8::Array::New(isolate, err_data, 2)).ToLocalChecked();
  (void)promise->Then(ctx, ok_fn, err_fn);
  rt_.loop().post_delayed(
      [this, rid, timeout_ms] {
        auto it = evals_.find(rid);
        if (it == evals_.end()) return;
        auto r = it->second;
        evals_.erase(it);
        if (r->done) return;
        r->done = true;
        Json e = Json::object();
        e.set("error", "eval timed out after " + std::to_string(static_cast<int>(timeout_ms)) + " ms");
        r->reply(std::move(e));
      },
      timeout_ms);
}

void DevTools::finish_eval(int request_id, bool ok, v8::Local<v8::Value> value) {
  auto it = evals_.find(request_id);
  if (it == evals_.end()) return;
  auto r = it->second;
  evals_.erase(it);
  if (r->done) return;
  r->done = true;
  v8::Isolate* isolate = rt_.isolate();
  v8::Local<v8::Context> ctx = rt_.context();
  Json out = Json::object();
  if (ok) {
    out.set("result", serialize_value(isolate, ctx, value));
  } else {
    out.set("error", v8u::exception_text(isolate, ctx, value));
  }
  r->reply(std::move(out));
}

}  // namespace iwn
