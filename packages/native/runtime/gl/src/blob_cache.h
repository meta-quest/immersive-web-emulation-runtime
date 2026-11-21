/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Persistent program-binary cache behind EGL_ANDROID_blob_cache (spec GL-22): the driver hands us opaque
// key/value blobs (compiled shaders / program binaries) and asks for them on later compiles. We keep them
// in memory and in one file in the app's cache directory, bounded (default 32 MB, least recently used
// evicted), and invalidated as a whole when the cache key (driver/OS build + APK version code) changes.
//
// V8- and EGL-independent so it can be tested on the host. File format (little endian):
//   "IWNBLOB1" | u32 keyLen | key bytes | repeated { u32 k | u32 v | k bytes | v bytes } | end
#pragma once

#include <cstddef>
#include <cstdint>
#include <list>
#include <mutex>
#include <utility>
#include <string>
#include <unordered_map>
#include <vector>

namespace iwn::gl {

class BlobCache {
 public:
  BlobCache(std::string path, std::string invalidationKey, uint64_t maxBytes);

  // Loads the file if its key matches; otherwise starts empty (and the next Flush rewrites it).
  void Load();
  // Writes the cache if it changed since the last Load/Flush. Atomic (write temp + rename).
  bool Flush();
  bool dirty();

  // EGL_ANDROID_blob_cache semantics. Get returns the value size (copying min(size, valueSize) bytes
  // when value is non-null), 0 if absent. Thread-safe: drivers may call from compiler threads.
  void Set(const void* key, size_t keySize, const void* value, size_t valueSize);
  size_t Get(const void* key, size_t keySize, void* value, size_t valueSize);

  uint64_t bytes() const { return bytes_; }
  size_t entries() const { return map_.size(); }
  uint64_t hits() const { return hits_; }
  uint64_t misses() const { return misses_; }

  // Installs this cache as the process-wide target of the EGL callbacks below.
  static void SetGlobal(BlobCache* cache);
  static void EglSet(const void* key, long keySize, const void* value, long valueSize);
  static long EglGet(const void* key, long keySize, void* value, long valueSize);

 private:
  struct Entry {
    std::string key;
    std::vector<uint8_t> value;
  };
  void EvictLocked();

  std::string path_;
  std::string invalidation_key_;
  uint64_t max_bytes_;
  uint64_t bytes_ = 0;
  uint64_t hits_ = 0, misses_ = 0;
  bool dirty_ = false;
  std::list<Entry> lru_;  // front = most recent
  std::unordered_map<std::string, std::list<Entry>::iterator> map_;
  std::mutex mu_;
};

}  // namespace iwn::gl
