/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// CC-5: the worker code cache. Memory tier within a process, disk tier across launches (a new ScriptCache over the
// same directory stands for the next process), blob:/data: keys by source, rejection, V8 tag and stamp changes.
#include <stdlib.h>

#include <memory>
#include <string>
#include <vector>

#include "iwn/workers/script_cache.h"
#include "iwn_test.h"

using namespace iwn;
using namespace iwn::workers;

namespace {
std::string temp_dir() {
  const char* base = getenv("TMPDIR");
  std::string tmpl = std::string(base && *base ? base : "/tmp") + "/iwn-wcc-XXXXXX";
  std::vector<char> buf(tmpl.begin(), tmpl.end());
  buf.push_back('\0');
  return mkdtemp(buf.data());
}

std::shared_ptr<CodeCacheStore> store_in(const std::string& dir, const std::string& stamp = "s1") {
  return std::make_shared<CodeCacheStore>(dir + "/iwn-worker-code-cache", stamp);
}

const std::string kUrl = "iwn-runtime:///iwn/prelude/glue.min.js";
const std::string kSource(4096, 'x');
const std::vector<uint8_t> kData(2000, 0x5A);
}  // namespace

IWN_TEST(ScriptCache, MemoryTierWithinOneProcess) {
  ScriptCache c;
  IWN_CHECK(c.lookup(kUrl, kSource) == nullptr);
  c.store(kUrl, kSource, kData.data(), kData.size());
  auto hit = c.lookup(kUrl, kSource);
  IWN_CHECK(hit != nullptr);
  IWN_CHECK(*hit == kData);
  // Same URL, other source: a miss.
  IWN_CHECK(c.lookup(kUrl, kSource + "y") == nullptr);
  auto s = c.stats();
  IWN_CHECK_EQ(s.hits, 1u);
  IWN_CHECK_EQ(s.misses, 2u);
  IWN_CHECK_EQ(s.disk_hits, 0u);
}

IWN_TEST(ScriptCache, WarmLaunchHitsFromDisk) {
  std::string dir = temp_dir();
  {
    ScriptCache first;  // cold launch
    first.set_disk(store_in(dir), 7);
    IWN_CHECK(first.lookup(kUrl, kSource) == nullptr);
    first.store(kUrl, kSource, kData.data(), kData.size());
    IWN_CHECK_EQ(first.stats().disk_writes, 1u);
  }
  ScriptCache second;  // warm launch: a new process, same directory and stamp
  second.set_disk(store_in(dir), 7);
  auto hit = second.lookup(kUrl, kSource);
  IWN_CHECK(hit != nullptr);
  IWN_CHECK(*hit == kData);
  // The second worker of this process is served from memory.
  IWN_CHECK(second.lookup(kUrl, kSource) != nullptr);
  auto s = second.stats();
  IWN_CHECK_EQ(s.hits, 2u);
  IWN_CHECK_EQ(s.disk_hits, 1u);
  IWN_CHECK_EQ(s.misses, 0u);
  IWN_CHECK_EQ(s.entries, 1u);
}

IWN_TEST(ScriptCache, WithoutDiskTierEveryLaunchMisses) {
  ScriptCache first;
  first.store(kUrl, kSource, kData.data(), kData.size());
  ScriptCache second;
  IWN_CHECK(second.lookup(kUrl, kSource) == nullptr);
}

IWN_TEST(ScriptCache, ChangedSourceOrV8IsAMiss) {
  std::string dir = temp_dir();
  {
    ScriptCache first;
    first.set_disk(store_in(dir), 7);
    first.store(kUrl, kSource, kData.data(), kData.size());
  }
  {
    ScriptCache other_v8;  // another V8 version or flag set
    other_v8.set_disk(store_in(dir), 8);
    IWN_CHECK(other_v8.lookup(kUrl, kSource) == nullptr);
  }
  {
    ScriptCache first;
    first.set_disk(store_in(dir), 7);
    first.store(kUrl, kSource, kData.data(), kData.size());
  }
  ScriptCache changed;  // the prelude changed (new runtime build)
  changed.set_disk(store_in(dir), 7);
  IWN_CHECK(changed.lookup(kUrl, kSource + "!") == nullptr);
}

IWN_TEST(ScriptCache, NewStampWipesTheDiskTier) {
  std::string dir = temp_dir();
  {
    ScriptCache first;
    first.set_disk(store_in(dir, "versionCode=1"), 7);
    first.store(kUrl, kSource, kData.data(), kData.size());
  }
  ScriptCache upgraded;
  upgraded.set_disk(store_in(dir, "versionCode=2"), 7);
  IWN_CHECK(upgraded.lookup(kUrl, kSource) == nullptr);
}

IWN_TEST(ScriptCache, BlobAndDataUrlsAreKeyedBySource) {
  // A blob: URL is new on every launch: the next launch's URL differs, the source does not.
  IWN_CHECK(ScriptCache::key_for("blob:https://app.local/1111", kSource) ==
            ScriptCache::key_for("blob:https://app.local/2222", kSource));
  IWN_CHECK(ScriptCache::key_for("blob:https://app.local/1111", kSource) !=
            ScriptCache::key_for("blob:https://app.local/1111", kSource + "y"));
  IWN_CHECK(ScriptCache::key_for("data:application/javascript;base64,AAAA", kSource).rfind("source:", 0) == 0);
  IWN_CHECK(ScriptCache::key_for(kUrl, kSource) == kUrl);
  std::string dir = temp_dir();
  {
    ScriptCache first;
    first.set_disk(store_in(dir), 7);
    first.store("blob:https://app.local/1111", kSource, kData.data(), kData.size());
  }
  ScriptCache second;
  second.set_disk(store_in(dir), 7);
  IWN_CHECK(second.lookup("blob:https://app.local/2222", kSource) != nullptr);
}

IWN_TEST(ScriptCache, RejectDropsBothTiers) {
  std::string dir = temp_dir();
  {
    ScriptCache first;
    first.set_disk(store_in(dir), 7);
    first.store(kUrl, kSource, kData.data(), kData.size());
    first.reject(kUrl, kSource);
    IWN_CHECK(first.lookup(kUrl, kSource) == nullptr);
    IWN_CHECK_EQ(first.stats().rejected, 1u);
  }
  ScriptCache second;
  second.set_disk(store_in(dir), 7);
  IWN_CHECK(second.lookup(kUrl, kSource) == nullptr);
}

IWN_TEST(ScriptCache, LimitZeroTurnsItOff) {
  std::string dir = temp_dir();
  ScriptCache c;
  c.set_disk(store_in(dir), 7);
  c.set_limit(0);
  c.store(kUrl, kSource, kData.data(), kData.size());
  IWN_CHECK(c.lookup(kUrl, kSource) == nullptr);
  IWN_CHECK_EQ(c.stats().disk_writes, 0u);
}
