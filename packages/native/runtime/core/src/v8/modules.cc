/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// ES module loading (ECMA-262 module records, HTML "fetch a module script graph" and "resolve a module specifier")
// over the app's dist, data: and blob: URLs, with a V8 code cache (V8 ScriptCompiler::CachedData). MOD-1..6, CC-1..4.
#include <pthread.h>

#include <deque>
#include <thread>
#include <vector>

#include "iwn/core/clock.h"
#include "iwn/core/log.h"
#include "iwn/core/text.h"
#include "v8/runtime_impl.h"
#include "v8/v8_util.h"

namespace iwn {
namespace {

ModuleLoader& loader_of(v8::Isolate* isolate) {
  return static_cast<RuntimeImpl*>(Runtime::From(isolate))->modules();
}

// The URL page code sees for a module (inline modules report the document URL, HTML import.meta.url).
std::string meta_url_for(const std::string& url) {
  size_t hash = url.find("#inline-module-");
  return hash == std::string::npos ? url : url.substr(0, hash);
}

std::string strip_fragment(const std::string& url) {
  size_t hash = url.find('#');
  return hash == std::string::npos ? url : url.substr(0, hash);
}

std::string resolve_error_message(const std::string& spec, const std::string& referrer, SpecifierError err) {
  if (err == SpecifierError::kBare) {
    return "Failed to resolve module specifier \"" + spec + "\" imported from " + referrer +
           ": bare specifiers need an import map, which is not supported; use a relative or absolute URL";
  }
  return "Invalid module specifier \"" + spec + "\" imported from " + referrer;
}

}  // namespace

ModuleLoader::~ModuleLoader() {
  reader_.stop();
  reset();
}

void ModuleLoader::reset() {
  // Imports waiting on a read are dropped with the page (their completion task checks the generation).
  inflight_.clear();
  prefetched_.clear();
  by_hash_.clear();
  by_url_.clear();
  failed_.clear();
  scripts_.clear();
}

void ModuleLoader::install_isolate_callbacks(v8::Isolate* isolate) {
  isolate->SetHostImportModuleDynamicallyCallback(&ModuleLoader::dynamic_import_callback);
  isolate->SetHostInitializeImportMetaObjectCallback(&ModuleLoader::import_meta_callback);
}

bool ModuleLoader::fetch_source(const std::string& url, std::string* source, std::string* error) {
  auto u = parse_url(url);
  if (!u) {
    *error = "Failed to fetch " + url + ": invalid URL";
    return false;
  }
  if (u->scheme == "data") {
    auto d = decode_data_url(url);
    if (!d) {
      *error = "Failed to fetch " + url.substr(0, 64) + ": malformed data: URL";
      return false;
    }
    source->assign(d->body.begin(), d->body.end());
    return true;
  }
  if (u->scheme == "blob") {
    v8::Isolate* isolate = rt_.isolate();
    v8::Local<v8::Value> resolver = rt_.blob_resolver();
    if (resolver.IsEmpty() || !resolver->IsFunction()) {
      *error = "Failed to fetch " + url + ": no blob URL store is installed";
      return false;
    }
    v8::TryCatch tc(isolate);
    v8::Local<v8::Context> ctx = rt_.context();
    // File API "resolve a blob URL" ignores the fragment.
    v8::Local<v8::Value> argv[] = {v8u::str(isolate, strip_fragment(url))};
    v8::Local<v8::Value> r;
    if (!resolver.As<v8::Function>()->Call(ctx, v8::Undefined(isolate), 1, argv).ToLocal(&r) || !r->IsObject()) {
      *error = "Failed to fetch " + url + ": unknown or revoked blob URL";
      return false;
    }
    v8::Local<v8::Value> bytes;
    if (!r.As<v8::Object>()->Get(ctx, v8u::sym(isolate, "bytes")).ToLocal(&bytes) || !bytes->IsArrayBufferView()) {
      *error = "Failed to fetch " + url + ": blob store returned no bytes";
      return false;
    }
    auto view = bytes.As<v8::ArrayBufferView>();
    source->resize(view->ByteLength());
    view->CopyContents(source->data(), source->size());
    return true;
  }
  if (u->origin() == rt_.app_origin().origin()) {
    auto path = app_asset_path(*u, rt_.app_origin());
    if (!path) {
      *error = "Failed to fetch " + url + ": path is outside the app (404)";
      return false;
    }
    if (auto pf = prefetched_.find(strip_fragment(url)); pf != prefetched_.end() && pf->second.bytes) {
      source->assign(pf->second.bytes->view());  // read (and inflated) off the JS thread by prefetch_then
      return true;
    }
    auto bytes = rt_.read_app_file(*path);
    if (!bytes) {
      *error = "Failed to fetch " + url + ": not found in the app's assets (404)";
      return false;
    }
    source->assign(bytes->view());
    return true;
  }
  if (u->scheme == "http" || u->scheme == "https") {
    *error = "Failed to fetch " + url + ": origin " + u->origin() +
             " is not allowed (network modules need the network allowlist, NET-5; not available in M1)";
    return false;
  }
  *error = "Failed to fetch " + url + ": unsupported URL scheme \"" + u->scheme + ":\"";
  return false;
}

std::unique_ptr<v8::ScriptCompiler::CachedData> ModuleLoader::lookup_cache(const std::string& url,
                                                                          const CodeCacheStore::SourceHash& hash,
                                                                          std::vector<uint8_t>* storage) {
  auto store = rt_.code_cache();
  if (!store) return nullptr;
  CodeCacheStore::Result r;
  auto pf = prefetched_.find(strip_fragment(url));
  if (pf != prefetched_.end() && pf->second.cache_looked_up && pf->second.hash == hash) {
    r = pf->second.cache_result;  // looked up off the JS thread for these exact bytes
    if (r == CodeCacheStore::Result::kHit) *storage = pf->second.cache;
  } else {
    r = store->lookup(strip_fragment(url), hash, v8::ScriptCompiler::CachedDataVersionTag(), storage);
  }
  if (r != CodeCacheStore::Result::kHit) {
    stats_.cache_miss++;
    log(LogLevel::kInfo, "code cache %s: %s", CodeCacheStore::result_name(r), url.c_str());
    return nullptr;
  }
  return std::make_unique<v8::ScriptCompiler::CachedData>(storage->data(), static_cast<int>(storage->size()),
                                                         v8::ScriptCompiler::CachedData::BufferNotOwned);
}

v8::MaybeLocal<v8::Module> ModuleLoader::compile_module(const std::string& url, const std::string& source) {
  v8::Isolate* isolate = rt_.isolate();
  auto hash = CodeCacheStore::hash_source(source);
  std::vector<uint8_t> storage;
  auto cached = lookup_cache(url, hash, &storage);
  bool consume = cached != nullptr;
  v8::ScriptOrigin origin(v8u::str(isolate, url), 0, 0, false, -1, v8::Local<v8::Value>(), false, false,
                          /*is_module=*/true);
  v8::ScriptCompiler::Source src(v8u::str(isolate, source), origin, cached.release());
  double t0 = now_ms();
  v8::MaybeLocal<v8::Module> result = v8::ScriptCompiler::CompileModule(
      isolate, &src, consume ? v8::ScriptCompiler::kConsumeCodeCache : v8::ScriptCompiler::kNoCompileOptions);
  stats_.compile_ms += now_ms() - t0;
  v8::Local<v8::Module> module;
  if (!result.ToLocal(&module)) return {};
  stats_.modules++;
  auto rec = std::make_unique<ModuleRecord>();
  rec->module.Reset(isolate, module);
  rec->url = url;
  rec->hash = hash;
  if (consume) {
    if (src.GetCachedData()->rejected) {
      stats_.cache_rejected++;
      log(LogLevel::kInfo, "code cache rejected by V8: %s", url.c_str());
      if (auto store = rt_.code_cache()) store->remove(strip_fragment(url));
    } else {
      stats_.cache_consumed++;
      rec->cache_accepted = true;
      log(LogLevel::kInfo, "code cache consumed: %s", url.c_str());
    }
  }
  if (!rec->cache_accepted && url.find("#inline-module-") == std::string::npos) rt_.note_uncached_script();
  ModuleRecord* raw = rec.get();
  by_url_[url] = std::move(rec);
  by_hash_.emplace(module->GetIdentityHash(), raw);
  return module;
}

ModuleLoader::ModuleRecord* ModuleLoader::record_for(v8::Local<v8::Module> module) {
  v8::Isolate* isolate = rt_.isolate();
  auto range = by_hash_.equal_range(module->GetIdentityHash());
  for (auto it = range.first; it != range.second; ++it) {
    if (it->second->module.Get(isolate) == module) return it->second;
  }
  return nullptr;
}

v8::MaybeLocal<v8::Module> ModuleLoader::load_graph(const std::string& url, const std::string* inline_source) {
  v8::Isolate* isolate = rt_.isolate();

  if (auto f = failed_.find(url); f != failed_.end()) {
    isolate->ThrowException(f->second.Get(isolate));
    return {};
  }
  if (auto it = by_url_.find(url); it != by_url_.end()) return it->second->module.Get(isolate);

  v8::TryCatch tc(isolate);
  v8::Local<v8::Module> module;
  {
    std::string source, error;
    bool ok = true;
    if (inline_source) {
      source = *inline_source;
    } else if (!fetch_source(url, &source, &error)) {
      ok = false;
    } else {
      // HTML: a module script needs a JavaScript MIME type (data: URLs carry theirs; assets map by extension).
      auto u = parse_url(url);
      std::string mime;
      if (u->scheme == "data") {
        if (auto d = decode_data_url(url)) mime = d->mime_type;
      } else if (u->scheme != "blob") {
        mime = std::string(mime_type_for_path(u->path));
      }
      if (!mime.empty() && !is_javascript_mime(mime)) {
        error = "Failed to load module script " + url + ": MIME type \"" + mime +
                "\" is not JavaScript (JSON/CSS modules are not supported)";
        ok = false;
      }
    }
    if (!ok) {
      isolate->ThrowException(v8::Exception::TypeError(v8u::str(isolate, error)));
    } else if (!compile_module(url, source).ToLocal(&module)) {
      // SyntaxError pending (MOD-6: V8's message carries the URL, line and column).
    }
  }
  if (module.IsEmpty()) {
    if (tc.HasCaught()) {
      failed_[url].Reset(isolate, tc.Exception());
      tc.ReThrow();
    }
    return {};
  }

  v8::Local<v8::FixedArray> requests = module->GetModuleRequests();
  auto referrer = parse_url(url);
  for (int i = 0; i < requests->Length(); ++i) {
    v8::Local<v8::ModuleRequest> req = requests->Get(i).As<v8::ModuleRequest>();
    std::string spec = v8u::to_utf8(isolate, req->GetSpecifier());
    SpecifierError err;
    auto child = referrer ? resolve_module_specifier(spec, *referrer, &err) : std::nullopt;
    if (!child) {
      std::string msg = resolve_error_message(spec, meta_url_for(url), referrer ? err : SpecifierError::kInvalid);
      isolate->ThrowException(v8::Exception::TypeError(v8u::str(isolate, msg)));
      failed_[url].Reset(isolate, tc.Exception());
      tc.ReThrow();
      return {};
    }
    // The module map is keyed by the full URL, fragment included (HTML "module map"; MOD-4).
    std::string child_url = child->href();
    if (load_graph(child_url, nullptr).IsEmpty()) {
      // The importer fails with its dependency's error from now on (MOD-4).
      if (tc.HasCaught()) {
        failed_[url].Reset(isolate, tc.Exception());
        tc.ReThrow();
      }
      return {};
    }
  }
  return module;
}

v8::MaybeLocal<v8::Value> ModuleLoader::run_module(const std::string& url, const std::string* inline_source) {
  v8::Isolate* isolate = rt_.isolate();
  v8::Local<v8::Context> ctx = rt_.context();
  v8::Local<v8::Module> module;
  if (!load_graph(url, inline_source).ToLocal(&module)) return {};
  if (module->GetStatus() == v8::Module::kUninstantiated) {
    if (!module->InstantiateModule(ctx, &ModuleLoader::resolve_callback).FromMaybe(false)) return {};
  }
  if (module->GetStatus() == v8::Module::kErrored) {
    isolate->ThrowException(module->GetException());
    return {};
  }
  return module->Evaluate(ctx);
}

v8::MaybeLocal<v8::Value> ModuleLoader::run_classic(const std::string& url, const std::string& source,
                                                    int line_offset) {
  v8::Isolate* isolate = rt_.isolate();
  v8::Local<v8::Context> ctx = rt_.context();
  // Inline scripts (line_offset > 0 or the document URL) are not cached: they are tiny and share a URL.
  // Runtime preludes (iwn-runtime:///..., the web glue and the IWER bundle) are cached like app scripts (CC-1).
  bool cacheable = line_offset == 0 && url.find("index.html") == std::string::npos;
  auto hash = CodeCacheStore::hash_source(source);
  std::vector<uint8_t> storage;
  std::unique_ptr<v8::ScriptCompiler::CachedData> cached;
  if (cacheable) cached = lookup_cache(url, hash, &storage);
  bool consume = cached != nullptr;
  v8::ScriptOrigin origin(v8u::str(isolate, url), line_offset, 0);
  v8::ScriptCompiler::Source src(v8u::str(isolate, source), origin, cached.release());
  double t0 = now_ms();
  v8::Local<v8::UnboundScript> unbound;
  bool ok = v8::ScriptCompiler::CompileUnboundScript(
                isolate, &src, consume ? v8::ScriptCompiler::kConsumeCodeCache : v8::ScriptCompiler::kNoCompileOptions)
                .ToLocal(&unbound);
  stats_.compile_ms += now_ms() - t0;
  if (!ok) return {};
  stats_.scripts++;
  if (cacheable) {
    auto rec = std::make_unique<ScriptRecord>();
    rec->script.Reset(isolate, unbound);
    rec->url = url;
    rec->hash = hash;
    if (consume) {
      if (src.GetCachedData()->rejected) {
        stats_.cache_rejected++;
        log(LogLevel::kInfo, "code cache rejected by V8: %s", url.c_str());
        if (auto store = rt_.code_cache()) store->remove(strip_fragment(url));
      } else {
        stats_.cache_consumed++;
        rec->cache_accepted = true;
        log(LogLevel::kInfo, "code cache consumed: %s", url.c_str());
      }
    }
    if (!rec->cache_accepted) rt_.note_uncached_script();
    scripts_.push_back(std::move(rec));
  }
  return unbound->BindToCurrentContext()->Run(ctx);
}

void ModuleLoader::produce_code_caches() {
  auto store = rt_.code_cache();
  if (!store) return;
  v8::Isolate* isolate = rt_.isolate();
  v8::HandleScope hs(isolate);
  struct Job {
    std::string url;
    CodeCacheStore::SourceHash hash;
    std::vector<uint8_t> data;
  };
  auto jobs = std::make_shared<std::vector<Job>>();
  double t0 = now_ms();
  for (auto& kv : by_url_) {
    ModuleRecord& r = *kv.second;
    if (r.cache_accepted || r.cache_written || r.url.find("#inline-module-") != std::string::npos) continue;
    v8::Local<v8::Module> m = r.module.Get(isolate);
    if (m->GetStatus() == v8::Module::kErrored || m->GetStatus() < v8::Module::kInstantiated) continue;
    r.cache_written = true;
    std::unique_ptr<v8::ScriptCompiler::CachedData> cd(
        v8::ScriptCompiler::CreateCodeCache(m->GetUnboundModuleScript()));
    if (!cd || cd->length <= 0) continue;
    jobs->push_back({strip_fragment(r.url), r.hash, std::vector<uint8_t>(cd->data, cd->data + cd->length)});
  }
  for (auto& s : scripts_) {
    if (s->cache_accepted || s->cache_written) continue;
    s->cache_written = true;
    std::unique_ptr<v8::ScriptCompiler::CachedData> cd(v8::ScriptCompiler::CreateCodeCache(s->script.Get(isolate)));
    if (!cd || cd->length <= 0) continue;
    jobs->push_back({s->url, s->hash, std::vector<uint8_t>(cd->data, cd->data + cd->length)});
  }
  if (jobs->empty()) return;
  stats_.cache_produced += jobs->size();
  double create_ms = now_ms() - t0;
  uint32_t tag = v8::ScriptCompiler::CachedDataVersionTag();
  // File writes happen off the JS thread (CC-2).
  std::thread([store, jobs, tag, create_ms] {
    pthread_setname_np(pthread_self(), "iwn-cache-write");
    size_t bytes = 0;
    for (auto& j : *jobs) {
      if (store->store(j.url, j.hash, tag, j.data.data(), j.data.size())) bytes += j.data.size();
    }
    log(LogLevel::kInfo, "code cache written: %zu entries, %.1f KB (created in %.1f ms on the JS thread)",
        jobs->size(), bytes / 1024.0, create_ms);
  }).detach();
}

void ModuleLoader::prefetch_then(const std::string& url, std::function<void()> then) {
  auto u = parse_url(url);
  const Url origin = rt_.app_origin();
  if (url.empty() || !u || u->origin() != origin.origin() || by_url_.count(url) || failed_.count(url)) {
    rt_.post_task(std::move(then));
    return;
  }
  const std::string key = strip_fragment(url);
  const uint64_t gen = rt_.context_generation();
  // HTML module map "fetching": a second import of a URL whose read is in flight waits for that read.
  if (auto it = inflight_.find(key); it != inflight_.end() && it->second.generation == gen) {
    it->second.waiters.push_back(std::move(then));
    stats_.import_reads_joined++;
    return;
  }
  // Snapshot of what is loaded already (by URL without fragment), so the reader skips those files.
  auto known = std::make_shared<std::unordered_map<std::string, bool>>();
  for (auto& kv : by_url_) (*known)[strip_fragment(kv.first)] = true;
  auto store = rt_.code_cache();
  uint32_t tag = v8::ScriptCompiler::CachedDataVersionTag();
  RuntimeImpl* rt = &rt_;
  // The job captures only plain data (no v8::Global): SerialWorker may destroy it on either thread.
  SerialWorker::Job job = [rt, this, key, origin, known, store, tag, gen](const std::atomic<bool>& stop) {
    if (reader_generation_ != gen) {
      reader_sent_.clear();
      reader_generation_ = gen;
    }
    auto results = std::make_shared<std::unordered_map<std::string, Prefetched>>();
    std::deque<std::string> queue{key};
    (*known)[key] = true;
    double t0 = now_ms();
    size_t bytes_read = 0;
    constexpr size_t kMaxFiles = 256;
    while (!queue.empty() && results->size() < kMaxFiles && !stop.load()) {
      std::string next = std::move(queue.front());
      queue.pop_front();
      auto nu = parse_url(next);
      if (!nu || nu->origin() != origin.origin()) continue;
      auto path = app_asset_path(*nu, origin);
      if (!path || !is_javascript_mime(mime_type_for_path(nu->path))) continue;
      auto bytes = rt->read_app_file(*path);  // AAssetManager is thread-safe; config is immutable after boot
      if (!bytes) continue;
      bytes_read += bytes->size();
      Prefetched pf;
      pf.bytes = bytes;
      if (store) {
        pf.hash = CodeCacheStore::hash_source(bytes->view());
        pf.cache_result = store->lookup(next, pf.hash, tag, &pf.cache);
        pf.cache_looked_up = true;
      }
      for (const std::string& spec : scan_static_import_specifiers(bytes->view())) {
        SpecifierError err;
        auto child = resolve_module_specifier(spec, *nu, &err);
        if (!child) continue;
        std::string ckey = strip_fragment(child->href());
        // A dependency an earlier batch already delivered is loaded by now (batches run in order) or failed.
        if (!(*known)[ckey] && !reader_sent_.count(ckey)) {
          (*known)[ckey] = true;
          queue.push_back(std::move(ckey));
        }
      }
      if (next != key) reader_sent_[next] = true;
      results->emplace(next, std::move(pf));
    }
    if (stop.load()) return;
    log(LogLevel::kInfo, "import(%s): read %zu files (%.1f KB) off the JS thread in %.1f ms", key.c_str(),
        results->size(), bytes_read / 1024.0, now_ms() - t0);
    rt->post_task([rt, this, gen, key, results] {
      if (gen != rt->context_generation()) return;
      auto it = inflight_.find(key);
      if (it == inflight_.end() || it->second.generation != gen) return;
      std::vector<std::function<void()>> waiters = std::move(it->second.waiters);
      inflight_.erase(it);
      for (auto& kv : *results) prefetched_.insert_or_assign(kv.first, std::move(kv.second));
      // Each waiting import loads (and settles its promise) in turn, with a checkpoint between them, as if each
      // had its own task. A later waiter for the same URL finds the module in the map.
      for (size_t i = 0; i < waiters.size(); ++i) {
        if (i > 0) rt->run_microtasks();
        v8::HandleScope hs(rt->isolate());
        waiters[i]();
        if (rt->isolate()->IsExecutionTerminating()) break;
      }
      // The bytes stay available until every waiter ran (imports of the same file with different fragments are
      // separate module records that share them), then go: the module records own what they need.
      for (auto& kv : *results) prefetched_.erase(kv.first);
    });
  };
  InFlight& entry = inflight_[key];
  entry.generation = gen;
  entry.waiters.clear();
  entry.waiters.push_back(std::move(then));
  if (reader_.post(job)) {
    stats_.import_reads++;
  } else {
    stats_.import_reads_sync++;
    // Reader stopped, queue full or no thread: load synchronously in a task instead (fetch_source reads the files).
    std::vector<std::function<void()>> waiters = std::move(entry.waiters);
    inflight_.erase(key);
    for (auto& w : waiters) rt_.post_task(std::move(w));
  }
}

void ModuleLoader::stop_reader() { reader_.stop(); }

// --- V8 host callbacks ------------------------------------------------------------------------------------------

v8::MaybeLocal<v8::Module> ModuleLoader::resolve_callback(v8::Local<v8::Context> context,
                                                          v8::Local<v8::String> specifier,
                                                          v8::Local<v8::FixedArray>, v8::Local<v8::Module> referrer) {
  v8::Isolate* isolate = v8::Isolate::GetCurrent();
  ModuleLoader& self = loader_of(isolate);
  ModuleRecord* rec = self.record_for(referrer);
  std::string spec = v8u::to_utf8(isolate, specifier);
  if (!rec) {
    v8u::throw_type_error(isolate, "internal: unknown referrer module for \"" + spec + "\"");
    return {};
  }
  auto base = parse_url(rec->url);
  SpecifierError err;
  auto u = base ? resolve_module_specifier(spec, *base, &err) : std::nullopt;
  if (!u) {
    v8u::throw_type_error(isolate, resolve_error_message(spec, meta_url_for(rec->url), err));
    return {};
  }
  std::string url = u->href();  // fragment kept: it is part of the module map key
  auto it = self.by_url_.find(url);
  if (it == self.by_url_.end()) {
    v8u::throw_type_error(isolate, "Module " + url + " was not loaded");
    return {};
  }
  return it->second->module.Get(isolate);
}

v8::MaybeLocal<v8::Promise> ModuleLoader::dynamic_import_callback(v8::Local<v8::Context> context,
                                                                  v8::Local<v8::Data>,
                                                                  v8::Local<v8::Value> resource_name,
                                                                  v8::Local<v8::String> specifier,
                                                                  v8::Local<v8::FixedArray>) {
  v8::Isolate* isolate = v8::Isolate::GetCurrent();
  auto* rt = static_cast<RuntimeImpl*>(Runtime::From(isolate));
  v8::Local<v8::Promise::Resolver> resolver;
  if (!v8::Promise::Resolver::New(context).ToLocal(&resolver)) return {};
  // Referrer (MOD-5): the calling script's or module's URL; eval'd code and runtime scripts use the document URL.
  std::string referrer = resource_name->IsString() ? v8u::to_utf8(isolate, resource_name) : "";
  auto ref = parse_url(referrer);
  if (!ref || ref->scheme == "iwn-runtime" || ref->scheme == "iwn-debug") {
    referrer = rt->document_url().href();
  } else {
    referrer = meta_url_for(referrer);
  }
  std::string spec = v8u::to_utf8(isolate, specifier);
  auto shared_resolver = std::make_shared<v8::Global<v8::Promise::Resolver>>(isolate, resolver);
  // import() never evaluates synchronously: the graph is fetched and evaluated in a later task, after the files it
  // needs were read off the JS thread (prefetch_then, PROC-2).
  std::string target;
  {
    auto base = parse_url(referrer);
    SpecifierError err;
    if (auto u = base ? resolve_module_specifier(spec, *base, &err) : std::nullopt) target = u->href();
  }
  loader_of(isolate).prefetch_then(target, [rt, shared_resolver, referrer, spec] {
    v8::Isolate* isolate = rt->isolate();
    v8::Local<v8::Context> ctx = rt->context();
    v8::Local<v8::Promise::Resolver> resolver = shared_resolver->Get(isolate);
    v8::TryCatch tc(isolate);
    auto base = parse_url(referrer);
    SpecifierError err;
    auto u = base ? resolve_module_specifier(spec, *base, &err) : std::nullopt;
    if (!u) {
      (void)resolver->Reject(
          ctx, v8::Exception::TypeError(v8u::str(isolate, resolve_error_message(spec, referrer, err))));
      return;
    }
    std::string url = u->href();  // fragment kept (module map key, import.meta.url)
    ModuleLoader& self = rt->modules();
    v8::Local<v8::Value> eval_result;
    if (!self.run_module(url, nullptr).ToLocal(&eval_result)) {
      v8::Local<v8::Value> ex = tc.HasCaught() ? tc.Exception()
                                               : v8::Exception::TypeError(v8u::str(isolate, "import failed")).As<v8::Value>();
      tc.Reset();
      (void)resolver->Reject(ctx, ex);
      return;
    }
    v8::Local<v8::Module> module = self.by_url_[url]->module.Get(isolate);
    v8::Local<v8::Value> pair[] = {resolver, module->GetModuleNamespace()};
    v8::Local<v8::Array> data = v8::Array::New(isolate, pair, 2);
    auto on_ok = [](const v8::FunctionCallbackInfo<v8::Value>& info) {
      v8::Local<v8::Context> c = info.GetIsolate()->GetCurrentContext();
      auto arr = info.Data().As<v8::Array>();
      auto res = arr->Get(c, 0).ToLocalChecked().As<v8::Promise::Resolver>();
      (void)res->Resolve(c, arr->Get(c, 1).ToLocalChecked());
    };
    auto on_err = [](const v8::FunctionCallbackInfo<v8::Value>& info) {
      v8::Local<v8::Context> c = info.GetIsolate()->GetCurrentContext();
      auto arr = info.Data().As<v8::Array>();
      auto res = arr->Get(c, 0).ToLocalChecked().As<v8::Promise::Resolver>();
      (void)res->Reject(c, info.Length() > 0 ? info[0] : v8::Undefined(info.GetIsolate()).As<v8::Value>());
    };
    if (eval_result->IsPromise()) {
      v8::Local<v8::Function> ok_fn = v8::Function::New(ctx, on_ok, data).ToLocalChecked();
      v8::Local<v8::Function> err_fn = v8::Function::New(ctx, on_err, data).ToLocalChecked();
      (void)eval_result.As<v8::Promise>()->Then(ctx, ok_fn, err_fn);
    } else {
      (void)resolver->Resolve(ctx, module->GetModuleNamespace());
    }
  });
  return resolver->GetPromise();
}

void ModuleLoader::import_meta_callback(v8::Local<v8::Context> context, v8::Local<v8::Module> module,
                                        v8::Local<v8::Object> meta) {
  v8::Isolate* isolate = v8::Isolate::GetCurrent();
  ModuleLoader& self = loader_of(isolate);
  ModuleRecord* rec = self.record_for(module);
  std::string url = rec ? meta_url_for(rec->url) : "";
  meta->CreateDataProperty(context, v8u::sym(isolate, "url"), v8u::str(isolate, url)).Check();
  // import.meta.resolve(specifier) -> string (MOD-3); throws TypeError for bare specifiers.
  auto resolve = [](const v8::FunctionCallbackInfo<v8::Value>& info) {
    v8::Isolate* iso = info.GetIsolate();
    std::string base_url = v8u::to_utf8(iso, info.Data());
    std::string spec = info.Length() > 0 ? v8u::safe_to_string(iso, info[0]) : "undefined";
    auto base = parse_url(base_url);
    SpecifierError err;
    auto u = base ? resolve_module_specifier(spec, *base, &err) : std::nullopt;
    if (!u) {
      v8u::throw_type_error(iso, resolve_error_message(spec, base_url, err));
      return;
    }
    info.GetReturnValue().Set(v8u::str(iso, u->href()));
  };
  v8::Local<v8::Function> fn = v8::Function::New(context, resolve, v8u::str(isolate, url), 1,
                                                 v8::ConstructorBehavior::kThrow)
                                   .ToLocalChecked();
  meta->CreateDataProperty(context, v8u::sym(isolate, "resolve"), fn).Check();
}

}  // namespace iwn
