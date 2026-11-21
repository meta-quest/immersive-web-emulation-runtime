/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// CC-1, CC-4: hit/miss/stale/corrupt, version stamp wipe, LRU bound.
#include <sys/stat.h>
#include <unistd.h>

#include <cstdio>
#include <string>
#include <thread>

#include "iwn/core/code_cache_store.h"
#include "iwn_test.h"

using namespace iwn;

namespace {
std::string temp_dir() {
  char tmpl[] = "/tmp/iwn-cc-XXXXXX";
  return mkdtemp(tmpl);
}
}  // namespace

IWN_TEST(CodeCacheStore, HitMissStale) {
  std::string dir = temp_dir();
  CodeCacheStore s(dir, "v1");
  auto h = CodeCacheStore::hash_source("export default 1");
  std::vector<uint8_t> out;
  IWN_CHECK(s.lookup("https://app.local/a.js", h, 7, &out) == CodeCacheStore::Result::kMiss);
  std::vector<uint8_t> data(1000, 0xAB);
  IWN_CHECK(s.store("https://app.local/a.js", h, 7, data.data(), data.size()));
  IWN_CHECK(s.lookup("https://app.local/a.js", h, 7, &out) == CodeCacheStore::Result::kHit);
  IWN_CHECK(out == data);
  // Different V8 tag (version/flags) -> stale and deleted.
  IWN_CHECK(s.lookup("https://app.local/a.js", h, 8, &out) == CodeCacheStore::Result::kStale);
  IWN_CHECK(s.lookup("https://app.local/a.js", h, 7, &out) == CodeCacheStore::Result::kMiss);
  // Different source -> stale.
  s.store("https://app.local/a.js", h, 7, data.data(), data.size());
  auto h2 = CodeCacheStore::hash_source("export default 2");
  IWN_CHECK(s.lookup("https://app.local/a.js", h2, 7, &out) == CodeCacheStore::Result::kStale);
}

IWN_TEST(CodeCacheStore, TruncatedFileIsCorrupt) {
  std::string dir = temp_dir();
  CodeCacheStore s(dir, "v1");
  auto h = CodeCacheStore::hash_source("x");
  std::vector<uint8_t> data(5000, 1);
  s.store("u", h, 1, data.data(), data.size());
  // Truncate the single .cc file.
  std::string cmd = "for f in " + dir + "/*.cc; do truncate -s 100 \"$f\"; done";
  IWN_CHECK(system(cmd.c_str()) == 0);
  std::vector<uint8_t> out;
  IWN_CHECK(s.lookup("u", h, 1, &out) == CodeCacheStore::Result::kCorrupt);
  IWN_CHECK(s.lookup("u", h, 1, &out) == CodeCacheStore::Result::kMiss);
  // Flip a payload byte -> checksum mismatch.
  s.store("u", h, 1, data.data(), data.size());
  std::string flip = "for f in " + dir + "/*.cc; do printf '\\x07' | dd of=\"$f\" bs=1 seek=200 conv=notrunc 2>/dev/null; done";
  IWN_CHECK(system(flip.c_str()) == 0);
  IWN_CHECK(s.lookup("u", h, 1, &out) == CodeCacheStore::Result::kCorrupt);
}

IWN_TEST(CodeCacheStore, StampChangeWipes) {
  std::string dir = temp_dir();
  auto h = CodeCacheStore::hash_source("x");
  std::vector<uint8_t> data(10, 1), out;
  {
    CodeCacheStore s(dir, "versionCode=1");
    s.store("u", h, 1, data.data(), data.size());
  }
  {
    CodeCacheStore s(dir, "versionCode=1");
    IWN_CHECK(s.lookup("u", h, 1, &out) == CodeCacheStore::Result::kHit);
  }
  {
    CodeCacheStore s(dir, "versionCode=2");
    IWN_CHECK(s.lookup("u", h, 1, &out) == CodeCacheStore::Result::kMiss);
  }
}

IWN_TEST(CodeCacheStore, LruBound) {
  std::string dir = temp_dir();
  CodeCacheStore s(dir, "v", /*max_bytes=*/3000);
  auto h = CodeCacheStore::hash_source("x");
  std::vector<uint8_t> data(900, 1), out;
  s.store("a", h, 1, data.data(), data.size());
  std::this_thread::sleep_for(std::chrono::milliseconds(20));
  s.store("b", h, 1, data.data(), data.size());
  std::this_thread::sleep_for(std::chrono::milliseconds(20));
  s.store("c", h, 1, data.data(), data.size());
  std::this_thread::sleep_for(std::chrono::milliseconds(20));
  IWN_CHECK(s.lookup("a", h, 1, &out) == CodeCacheStore::Result::kHit);  // touch a: now b is oldest
  std::this_thread::sleep_for(std::chrono::milliseconds(20));
  s.store("d", h, 1, data.data(), data.size());
  IWN_CHECK(s.total_bytes() <= 3000);
  IWN_CHECK(s.lookup("b", h, 1, &out) == CodeCacheStore::Result::kMiss);
  IWN_CHECK(s.lookup("a", h, 1, &out) == CodeCacheStore::Result::kHit);
  IWN_CHECK(s.lookup("d", h, 1, &out) == CodeCacheStore::Result::kHit);
}
