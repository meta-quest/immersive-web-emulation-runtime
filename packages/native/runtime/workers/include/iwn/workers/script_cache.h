/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The worker code cache (CC-5), V8-free so it can be tested on the host. Worker isolates compile the same runtime
// preludes (web glue, net, image, ...) and the same worker scripts. Two tiers:
//   * in memory, process-wide: the first isolate that compiles a script stores V8's code cache, later isolates of
//     the same process consume it (LRU, bounded by bytes);
//   * on disk (set_disk): entries are also written to a CodeCacheStore in the app's cache directory, so the next
//     launch consumes them too (CC-5: "second launch logs consumed entries for worker scripts"). The store checks
//     the source hash and V8's CachedDataVersionTag (version + flags), detects corrupt files, is LRU-bounded and is
//     wiped when its stamp (app version code, runtime version, V8 version) changes.
// Entries are keyed by URL, except blob: and data: URLs, which are keyed by the source's hash only (a blob: URL is
// new on every launch; a data: URL is the source itself).
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "iwn/core/code_cache_store.h"

namespace iwn::workers {

class ScriptCache {
 public:
  ScriptCache() = default;
  // The process-wide instance shared by every worker isolate.
  static ScriptCache& shared();

  // Bound of the memory tier (0 turns the whole cache off).
  void set_limit(size_t bytes);
  // Adds the disk tier (keeps the first store set; later calls are ignored). `v8_tag` is
  // v8::ScriptCompiler::CachedDataVersionTag().
  void set_disk(std::shared_ptr<CodeCacheStore> store, uint32_t v8_tag);
  bool has_disk();

  // The cache key of a script: its URL, or "source:<hash>:<length>" for blob: and data: URLs.
  static std::string key_for(std::string_view url, std::string_view source);

  // The cached data for (url, source) from memory, else from disk (then kept in memory too), or null.
  std::shared_ptr<const std::vector<uint8_t>> lookup(const std::string& url, const std::string& source);
  // Stores freshly produced data in memory and on disk.
  void store(const std::string& url, const std::string& source, const uint8_t* data, size_t len);
  // V8 rejected the entry: drops it from both tiers.
  void reject(const std::string& url, const std::string& source);

  struct Stats {
    uint64_t hits = 0, misses = 0, rejected = 0, stored = 0;
    uint64_t disk_hits = 0, disk_writes = 0;  // hits served from disk (included in hits), entries written
    size_t bytes = 0, entries = 0;
  };
  Stats stats();

 private:
  struct Entry {
    std::array<uint8_t, 16> hash{};
    size_t length = 0;
    std::shared_ptr<const std::vector<uint8_t>> data;
    uint64_t last_use = 0;
  };
  void insert_locked(const std::string& key, const std::array<uint8_t, 16>& hash, size_t length,
                     std::shared_ptr<const std::vector<uint8_t>> data);

  std::mutex mu_;
  std::unordered_map<std::string, Entry> entries_;
  size_t limit_ = 32u << 20;
  size_t bytes_ = 0;
  uint64_t clock_ = 0;
  Stats stats_;
  std::shared_ptr<CodeCacheStore> disk_;
  uint32_t v8_tag_ = 0;
};

}  // namespace iwn::workers
