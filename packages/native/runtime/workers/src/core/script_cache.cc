/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Worker code cache (CC-5): memory tier shared by the worker isolates of a process, plus the optional disk tier that
// carries entries to the next launch. See iwn/workers/script_cache.h.
#include "iwn/workers/script_cache.h"

#include <algorithm>

#include "iwn/core/text.h"

namespace iwn::workers {

ScriptCache& ScriptCache::shared() {
  static ScriptCache* cache = new ScriptCache();  // never destroyed (worker threads)
  return *cache;
}

void ScriptCache::set_limit(size_t bytes) {
  std::lock_guard<std::mutex> lock(mu_);
  limit_ = bytes;
}

void ScriptCache::set_disk(std::shared_ptr<CodeCacheStore> store, uint32_t v8_tag) {
  std::lock_guard<std::mutex> lock(mu_);
  if (disk_ || !store) return;
  disk_ = std::move(store);
  v8_tag_ = v8_tag;
}

bool ScriptCache::has_disk() {
  std::lock_guard<std::mutex> lock(mu_);
  return disk_ != nullptr;
}

std::string ScriptCache::key_for(std::string_view url, std::string_view source) {
  auto starts = [&](std::string_view p) { return url.size() >= p.size() && url.substr(0, p.size()) == p; };
  if (!starts("blob:") && !starts("data:")) return std::string(url);
  return "source:" + to_hex(fast_hash128(source.data(), source.size())) + ":" + std::to_string(source.size());
}

void ScriptCache::insert_locked(const std::string& key, const std::array<uint8_t, 16>& hash, size_t length,
                                std::shared_ptr<const std::vector<uint8_t>> data) {
  const size_t len = data->size();
  auto& e = entries_[key];
  if (e.data) bytes_ -= e.data->size();
  e.hash = hash;
  e.length = length;
  e.data = std::move(data);
  e.last_use = ++clock_;
  bytes_ += len;
  while (bytes_ > limit_ && !entries_.empty()) {
    auto oldest = std::min_element(entries_.begin(), entries_.end(),
                                   [](const auto& a, const auto& b) { return a.second.last_use < b.second.last_use; });
    bytes_ -= oldest->second.data ? oldest->second.data->size() : 0;
    entries_.erase(oldest);
  }
}

std::shared_ptr<const std::vector<uint8_t>> ScriptCache::lookup(const std::string& url, const std::string& source) {
  const std::string key = key_for(url, source);
  const auto hash = fast_hash128(source.data(), source.size());
  std::shared_ptr<CodeCacheStore> disk;
  uint32_t tag = 0;
  {
    std::lock_guard<std::mutex> lock(mu_);
    if (limit_ == 0) return nullptr;
    auto it = entries_.find(key);
    if (it != entries_.end() && it->second.hash == hash && it->second.length == source.size()) {
      it->second.last_use = ++clock_;
      stats_.hits++;
      return it->second.data;
    }
    disk = disk_;
    tag = v8_tag_;
  }
  // Disk tier, outside the lock (file I/O; other worker threads keep using the memory tier).
  if (disk) {
    auto bytes = std::make_shared<std::vector<uint8_t>>();
    if (disk->lookup(key, CodeCacheStore::hash_source(source), tag, bytes.get()) == CodeCacheStore::Result::kHit &&
        !bytes->empty()) {
      std::lock_guard<std::mutex> lock(mu_);
      if (limit_ == 0) return nullptr;
      stats_.hits++;
      stats_.disk_hits++;
      if (bytes->size() <= limit_) insert_locked(key, hash, source.size(), bytes);
      return bytes;
    }
  }
  std::lock_guard<std::mutex> lock(mu_);
  stats_.misses++;
  return nullptr;
}

void ScriptCache::store(const std::string& url, const std::string& source, const uint8_t* data, size_t len) {
  if (len == 0) return;
  const std::string key = key_for(url, source);
  const auto hash = fast_hash128(source.data(), source.size());
  std::shared_ptr<CodeCacheStore> disk;
  uint32_t tag = 0;
  {
    std::lock_guard<std::mutex> lock(mu_);
    if (limit_ == 0 || len > limit_) return;
    insert_locked(key, hash, source.size(), std::make_shared<std::vector<uint8_t>>(data, data + len));
    stats_.stored++;
    disk = disk_;
    tag = v8_tag_;
  }
  if (disk && disk->store(key, CodeCacheStore::hash_source(source), tag, data, len)) {
    std::lock_guard<std::mutex> lock(mu_);
    stats_.disk_writes++;
  }
}

void ScriptCache::reject(const std::string& url, const std::string& source) {
  const std::string key = key_for(url, source);
  std::shared_ptr<CodeCacheStore> disk;
  {
    std::lock_guard<std::mutex> lock(mu_);
    stats_.rejected++;
    auto it = entries_.find(key);
    if (it != entries_.end()) {
      bytes_ -= it->second.data ? it->second.data->size() : 0;
      entries_.erase(it);
    }
    disk = disk_;
  }
  if (disk) disk->remove(key);
}

ScriptCache::Stats ScriptCache::stats() {
  std::lock_guard<std::mutex> lock(mu_);
  Stats s = stats_;
  s.bytes = bytes_;
  s.entries = entries_.size();
  return s;
}

}  // namespace iwn::workers
