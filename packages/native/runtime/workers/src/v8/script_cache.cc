// In-process V8 code cache for worker isolates (CC-5). Worker pools start several isolates that compile the same
// runtime preludes (web glue, net, image, ...) and the same worker script (three's KTX2/Draco/MSDF workers are blob:
// scripts posted to 2-4 workers). The first isolate produces V8's code cache right after compiling; later isolates
// consume it (V8 ScriptCompiler::CachedData, v8-script.h). Entries are keyed by URL and checked against a content
// hash and the length of the source; LRU-bounded by bytes. Process lifetime only: the page's on-disk cache (CC-1)
// belongs to the core and is not shared with worker threads.
#include <algorithm>

#include "iwn/core/log.h"
#include "iwn/core/text.h"
#include "v8/internal.h"

namespace iwn::workers {

ScriptCache& ScriptCache::shared() {
  static ScriptCache* cache = new ScriptCache();  // never destroyed (worker threads)
  return *cache;
}

void ScriptCache::set_limit(size_t bytes) {
  std::lock_guard<std::mutex> lock(mu_);
  limit_ = bytes;
}

std::shared_ptr<const std::vector<uint8_t>> ScriptCache::lookup(const std::string& url, const std::string& source) {
  if (limit_ == 0) return nullptr;
  auto hash = fast_hash128(source.data(), source.size());
  std::lock_guard<std::mutex> lock(mu_);
  auto it = entries_.find(url);
  if (it == entries_.end() || it->second.hash != hash || it->second.length != source.size()) {
    stats_.misses++;
    return nullptr;
  }
  it->second.last_use = ++clock_;
  stats_.hits++;
  return it->second.data;
}

void ScriptCache::store(const std::string& url, const std::string& source, const uint8_t* data, size_t len) {
  if (limit_ == 0 || len == 0 || len > limit_) return;
  auto hash = fast_hash128(source.data(), source.size());
  auto bytes = std::make_shared<std::vector<uint8_t>>(data, data + len);
  std::lock_guard<std::mutex> lock(mu_);
  auto& e = entries_[url];
  if (e.data) bytes_ -= e.data->size();
  e.hash = hash;
  e.length = source.size();
  e.data = std::move(bytes);
  e.last_use = ++clock_;
  bytes_ += len;
  stats_.stored++;
  while (bytes_ > limit_ && !entries_.empty()) {
    auto oldest = std::min_element(entries_.begin(), entries_.end(),
                                   [](const auto& a, const auto& b) { return a.second.last_use < b.second.last_use; });
    bytes_ -= oldest->second.data ? oldest->second.data->size() : 0;
    entries_.erase(oldest);
  }
}

void ScriptCache::reject(const std::string& url) {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = entries_.find(url);
  if (it == entries_.end()) return;
  bytes_ -= it->second.data ? it->second.data->size() : 0;
  entries_.erase(it);
  stats_.rejected++;
}

ScriptCache::Stats ScriptCache::stats() {
  std::lock_guard<std::mutex> lock(mu_);
  Stats s = stats_;
  s.bytes = bytes_;
  s.entries = entries_.size();
  return s;
}

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
    cache.reject(url);
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
    cache.reject(url);
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
