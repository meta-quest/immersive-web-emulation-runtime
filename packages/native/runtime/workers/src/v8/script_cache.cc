/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Compiling worker scripts with the worker code cache (CC-5, iwn/workers/script_cache.h): a hit is consumed (V8
// ScriptCompiler::CachedData, v8-script.h); after a miss or a rejected entry the code cache is produced right after
// compiling and stored (in memory, and on disk when the page set up the disk tier: the next launch consumes it).
#include "iwn/core/log.h"
#include "iwn/core/text.h"
#include "v8/internal.h"

namespace iwn::workers {

namespace {
// Inline-ish scripts (tiny) are not worth caching.
constexpr size_t kMinCacheableSource = 1024;
}  // namespace

v8::MaybeLocal<v8::Script> compile_classic(v8::Isolate* isolate, v8::Local<v8::Context> ctx, const std::string& url,
                                           const std::string& source) {
  v8::EscapableHandleScope scope(isolate);
  ScriptCache& cache = ScriptCache::shared();
  bool cacheable = source.size() >= kMinCacheableSource;
  auto hit = cacheable ? cache.lookup(url, source) : nullptr;
  v8::ScriptOrigin origin(v8str(isolate, url));
  v8::ScriptCompiler::CachedData* cd =
      hit ? new v8::ScriptCompiler::CachedData(hit->data(), static_cast<int>(hit->size()),
                                               v8::ScriptCompiler::CachedData::BufferNotOwned)
          : nullptr;
  v8::ScriptCompiler::Source src(v8str(isolate, source), origin, cd);  // takes ownership of cd
  v8::Local<v8::Script> script;
  if (!v8::ScriptCompiler::Compile(ctx, &src,
                                   hit ? v8::ScriptCompiler::kConsumeCodeCache : v8::ScriptCompiler::kNoCompileOptions)
           .ToLocal(&script)) {
    return {};
  }
  if (hit && src.GetCachedData()->rejected) {
    cache.reject(url, source);
    hit = nullptr;
  }
  if (cacheable && !hit) {
    std::unique_ptr<v8::ScriptCompiler::CachedData> produced(
        v8::ScriptCompiler::CreateCodeCache(script->GetUnboundScript()));
    if (produced && produced->length > 0) cache.store(url, source, produced->data, produced->length);
  }
  return scope.Escape(script);
}

v8::MaybeLocal<v8::Module> compile_module(v8::Isolate* isolate, const std::string& url, const std::string& source) {
  v8::EscapableHandleScope scope(isolate);
  ScriptCache& cache = ScriptCache::shared();
  bool cacheable = source.size() >= kMinCacheableSource;
  auto hit = cacheable ? cache.lookup(url, source) : nullptr;
  v8::ScriptOrigin origin(v8str(isolate, url), 0, 0, false, -1, v8::Local<v8::Value>(), false, false,
                          /*is_module=*/true);
  v8::ScriptCompiler::CachedData* cd =
      hit ? new v8::ScriptCompiler::CachedData(hit->data(), static_cast<int>(hit->size()),
                                               v8::ScriptCompiler::CachedData::BufferNotOwned)
          : nullptr;
  v8::ScriptCompiler::Source src(v8str(isolate, source), origin, cd);
  v8::Local<v8::Module> module;
  if (!v8::ScriptCompiler::CompileModule(
           isolate, &src, hit ? v8::ScriptCompiler::kConsumeCodeCache : v8::ScriptCompiler::kNoCompileOptions)
           .ToLocal(&module)) {
    return {};
  }
  if (hit && src.GetCachedData()->rejected) {
    cache.reject(url, source);
    hit = nullptr;
  }
  if (cacheable && !hit) {
    std::unique_ptr<v8::ScriptCompiler::CachedData> produced(
        v8::ScriptCompiler::CreateCodeCache(module->GetUnboundModuleScript()));
    if (produced && produced->length > 0) cache.store(url, source, produced->data, produced->length);
  }
  return scope.Escape(module);
}

}  // namespace iwn::workers
