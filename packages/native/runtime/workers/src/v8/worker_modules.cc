// ES modules inside workers (WRK-3, MOD-2..5): module workers, static imports, dynamic import() in classic and
// module workers, import.meta.url / import.meta.resolve(). Written from ECMA-262 §16.2 (module records, HostLoad...),
// HTML §8.1.5 (resolve a module specifier, the module map keyed by URL, import.meta) and V8's module API.
//
// Workers may block on file reads (PROC-2 concerns only the page's JS thread), so the graph is fetched synchronously
// on the worker thread: same-origin assets, data: URLs, and blob: URLs from the worker's own store.
#include "iwn/core/log.h"
#include "iwn/core/text.h"
#include "v8/internal.h"

namespace iwn::workers {

namespace {

std::string resolve_error(const std::string& spec, const std::string& referrer, SpecifierError err) {
  if (err == SpecifierError::kBare) {
    return "Failed to resolve module specifier \"" + spec + "\" from " + referrer +
           ": relative references must start with \"/\", \"./\" or \"../\" (bare specifiers need a bundler)";
  }
  return "Failed to resolve module specifier \"" + spec + "\" from " + referrer + ": invalid URL";
}

}  // namespace

WorkerRuntime::ModuleRecord* WorkerRuntime::record_for(v8::Local<v8::Module> module) {
  auto range = modules_by_hash_.equal_range(module->GetIdentityHash());
  for (auto it = range.first; it != range.second; ++it) {
    if (it->second->module.Get(isolate_) == module) return it->second;
  }
  return nullptr;
}

v8::MaybeLocal<v8::Module> WorkerRuntime::load_graph(const std::string& url, const std::string* inline_source) {
  v8::EscapableHandleScope hs(isolate_);
  if (auto f = failed_modules_.find(url); f != failed_modules_.end()) {
    isolate_->ThrowException(f->second.Get(isolate_));
    return {};
  }
  if (auto it = modules_.find(url); it != modules_.end()) return hs.Escape(it->second->module.Get(isolate_));

  v8::TryCatch tc(isolate_);
  v8::Local<v8::Module> module;
  {
    std::string source, error;
    bool ok = true;
    if (inline_source) {
      source = *inline_source;
    } else if (!fetch(url, /*module=*/true, &source, &error)) {
      ok = false;
    }
    if (!ok) {
      isolate_->ThrowException(
          v8::Exception::TypeError(v8str(isolate_, "Failed to load module script " + url + ": " + error)));
    } else if (compile_module(isolate_, url, source).ToLocal(&module)) {
      auto rec = std::make_unique<ModuleRecord>();
      rec->module.Reset(isolate_, module);
      rec->url = url;
      modules_by_hash_.emplace(module->GetIdentityHash(), rec.get());
      modules_[url] = std::move(rec);
    }
  }
  if (module.IsEmpty()) {
    if (tc.HasCaught()) {
      failed_modules_[url].Reset(isolate_, tc.Exception());
      tc.ReThrow();
    }
    return {};
  }
  v8::Local<v8::FixedArray> requests = module->GetModuleRequests();
  auto referrer = parse_url(url);
  for (int i = 0; i < requests->Length(); ++i) {
    v8::Local<v8::ModuleRequest> req = requests->Get(i).As<v8::ModuleRequest>();
    std::string spec = utf8(isolate_, req->GetSpecifier());
    SpecifierError err = SpecifierError::kInvalid;
    auto child = referrer ? resolve_module_specifier(spec, *referrer, &err) : std::nullopt;
    if (!child) {
      isolate_->ThrowException(v8::Exception::TypeError(v8str(isolate_, resolve_error(spec, url, err))));
      failed_modules_[url].Reset(isolate_, tc.Exception());
      tc.ReThrow();
      return {};
    }
    if (load_graph(child->href(), nullptr).IsEmpty()) {
      if (tc.HasCaught()) {
        failed_modules_[url].Reset(isolate_, tc.Exception());
        tc.ReThrow();
      }
      return {};
    }
  }
  return hs.Escape(module);
}

v8::MaybeLocal<v8::Value> WorkerRuntime::run_module(const std::string& url, const std::string* inline_source) {
  v8::EscapableHandleScope hs(isolate_);
  v8::Local<v8::Context> ctx = context();
  v8::Local<v8::Module> module;
  if (!load_graph(url, inline_source).ToLocal(&module)) return {};
  if (module->GetStatus() == v8::Module::kUninstantiated) {
    if (!module->InstantiateModule(ctx, &WorkerRuntime::resolve_callback).FromMaybe(false)) return {};
  }
  if (module->GetStatus() == v8::Module::kErrored) {
    isolate_->ThrowException(module->GetException());
    return {};
  }
  v8::Local<v8::Value> result;
  if (!module->Evaluate(ctx).ToLocal(&result)) return {};
  return hs.Escape(result);
}

v8::MaybeLocal<v8::Module> WorkerRuntime::resolve_callback(v8::Local<v8::Context>, v8::Local<v8::String> specifier,
                                                           v8::Local<v8::FixedArray>, v8::Local<v8::Module> referrer) {
  WorkerRuntime* rt = current();
  v8::Isolate* isolate = rt->isolate_;
  ModuleRecord* rec = rt->record_for(referrer);
  std::string spec = utf8(isolate, specifier);
  if (!rec) {
    throw_type_error(isolate, "internal: unknown referrer module for \"" + spec + "\"");
    return {};
  }
  auto base = parse_url(rec->url);
  SpecifierError err = SpecifierError::kInvalid;
  auto u = base ? resolve_module_specifier(spec, *base, &err) : std::nullopt;
  if (!u) {
    throw_type_error(isolate, resolve_error(spec, rec->url, err));
    return {};
  }
  auto it = rt->modules_.find(u->href());
  if (it == rt->modules_.end()) {
    throw_type_error(isolate, "Module " + u->href() + " was not loaded");
    return {};
  }
  return it->second->module.Get(isolate);
}

v8::MaybeLocal<v8::Promise> WorkerRuntime::dynamic_import(v8::Local<v8::Context> context, v8::Local<v8::Data>,
                                                          v8::Local<v8::Value> resource_name,
                                                          v8::Local<v8::String> specifier, v8::Local<v8::FixedArray>) {
  WorkerRuntime* rt = current();
  v8::Isolate* isolate = rt->isolate_;
  v8::Local<v8::Promise::Resolver> resolver;
  if (!v8::Promise::Resolver::New(context).ToLocal(&resolver)) return {};
  // Referrer (MOD-5): the calling script's or module's URL; runtime preludes and eval'd code use the worker's URL.
  std::string referrer = resource_name->IsString() ? utf8(isolate, resource_name) : "";
  auto ref = parse_url(referrer);
  if (!ref || ref->scheme == "iwn-runtime" || ref->scheme == "iwn-debug") referrer = rt->handle().url;
  std::string spec = utf8(isolate, specifier);
  auto shared = std::make_shared<v8::Global<v8::Promise::Resolver>>(isolate, resolver);
  // import() never evaluates synchronously: the graph loads and evaluates in a later task.
  EventLoop::Task task = [rt, shared, referrer, spec] {
    v8::Isolate* isolate = rt->isolate_;
    v8::HandleScope hs(isolate);
    v8::Local<v8::Context> ctx = rt->context();
    v8::Local<v8::Promise::Resolver> resolver = shared->Get(isolate);
    shared->Reset();
    v8::TryCatch tc(isolate);
    auto base = parse_url(referrer);
    SpecifierError err = SpecifierError::kInvalid;
    auto u = base ? resolve_module_specifier(spec, *base, &err) : std::nullopt;
    if (!u) {
      (void)resolver->Reject(ctx, v8::Exception::TypeError(v8str(isolate, resolve_error(spec, referrer, err))));
      return;
    }
    std::string url = u->href();
    v8::Local<v8::Value> eval;
    if (!rt->run_module(url, nullptr).ToLocal(&eval)) {
      if (tc.HasTerminated()) return;
      v8::Local<v8::Value> ex = tc.HasCaught() ? tc.Exception()
                                               : v8::Exception::TypeError(v8str(isolate, "import failed")).As<v8::Value>();
      tc.Reset();
      (void)resolver->Reject(ctx, ex);
      return;
    }
    v8::Local<v8::Module> module = rt->modules_[url]->module.Get(isolate);
    v8::Local<v8::Value> pair[] = {resolver, module->GetModuleNamespace()};
    v8::Local<v8::Array> data = v8::Array::New(isolate, pair, 2);
    auto on_ok = [](const v8::FunctionCallbackInfo<v8::Value>& info) {
      v8::Local<v8::Context> c = info.GetIsolate()->GetCurrentContext();
      auto arr = info.Data().As<v8::Array>();
      (void)arr->Get(c, 0).ToLocalChecked().As<v8::Promise::Resolver>()->Resolve(c, arr->Get(c, 1).ToLocalChecked());
    };
    auto on_err = [](const v8::FunctionCallbackInfo<v8::Value>& info) {
      v8::Local<v8::Context> c = info.GetIsolate()->GetCurrentContext();
      auto arr = info.Data().As<v8::Array>();
      (void)arr->Get(c, 0).ToLocalChecked().As<v8::Promise::Resolver>()->Reject(
          c, info.Length() > 0 ? info[0] : v8::Undefined(info.GetIsolate()).As<v8::Value>());
    };
    if (eval->IsPromise()) {
      (void)eval.As<v8::Promise>()->Then(ctx, v8::Function::New(ctx, on_ok, data).ToLocalChecked(),
                                         v8::Function::New(ctx, on_err, data).ToLocalChecked());
    } else {
      (void)resolver->Resolve(ctx, module->GetModuleNamespace());
    }
  };
  if (!rt->loop_.try_post(task)) {
    // Closing: the promise stays pending (the worker is ending). Drop the handle on this thread.
    shared->Reset();
  }
  return resolver->GetPromise();
}

void WorkerRuntime::import_meta(v8::Local<v8::Context> context, v8::Local<v8::Module> module,
                                v8::Local<v8::Object> meta) {
  WorkerRuntime* rt = current();
  v8::Isolate* isolate = rt->isolate_;
  ModuleRecord* rec = rt->record_for(module);
  std::string url = rec ? rec->url : "";
  meta->CreateDataProperty(context, v8str(isolate, "url"), v8str(isolate, url)).Check();
  auto resolve = [](const v8::FunctionCallbackInfo<v8::Value>& info) {
    v8::Isolate* iso = info.GetIsolate();
    std::string base_url = utf8(iso, info.Data());
    std::string spec = info.Length() > 0 ? utf8(iso, info[0]) : "undefined";
    auto base = parse_url(base_url);
    SpecifierError err = SpecifierError::kInvalid;
    auto u = base ? resolve_module_specifier(spec, *base, &err) : std::nullopt;
    if (!u) return throw_type_error(iso, resolve_error(spec, base_url, err));
    info.GetReturnValue().Set(v8str(iso, u->href()));
  };
  v8::Local<v8::Function> fn =
      v8::Function::New(context, resolve, v8str(isolate, url), 1, v8::ConstructorBehavior::kThrow).ToLocalChecked();
  meta->CreateDataProperty(context, v8str(isolate, "resolve"), fn).Check();
}

}  // namespace iwn::workers
