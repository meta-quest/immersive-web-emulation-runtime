/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// On-disk store for V8 code caches (CC-1, CC-4), V8-free. One file per script URL in the app's private cache
// directory. Each entry carries the source hash and V8's CachedDataVersionTag (version + flags), so any change to
// either is a miss, plus a checksum of the payload so a truncated or corrupted file is detected and removed. The
// store is bounded (LRU by mtime; lookups touch the file) and wiped when the app version stamp changes.
#pragma once

#include <array>
#include <cstdint>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace iwn {

class CodeCacheStore {
 public:
  enum class Result { kHit, kMiss, kStale, kCorrupt };

  // dir is created if missing. stamp identifies the app build (version code + runtime build id); a different
  // stamp from the last run wipes the store.
  CodeCacheStore(std::string dir, std::string stamp, uint64_t max_bytes = 64ull << 20);

  using SourceHash = std::array<uint8_t, 32>;
  static SourceHash hash_source(std::string_view source);

  // Looks up the entry for url. kStale: present but for another source/V8 (deleted). kCorrupt: unreadable (deleted).
  Result lookup(std::string_view url, const SourceHash& source_hash, uint32_t v8_tag, std::vector<uint8_t>* out);
  // Writes the entry atomically (temp file + rename) and enforces the size bound. Thread-safe.
  bool store(std::string_view url, const SourceHash& source_hash, uint32_t v8_tag, const uint8_t* data, size_t len);
  // Deletes an entry (e.g. after V8 rejected it).
  void remove(std::string_view url);

  const std::string& dir() const { return dir_; }
  uint64_t total_bytes();
  static const char* result_name(Result r);

 private:
  std::string path_for(std::string_view url) const;
  void enforce_bound_locked();
  std::string dir_;
  uint64_t max_bytes_;
  std::mutex mu_;
};

}  // namespace iwn
