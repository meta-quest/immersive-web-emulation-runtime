// Worker policy (WRK-1, WRK-4, WRK-9, WRK-12, PROC-4): config parsing, the live-worker limit, URL checks, script
// fetching from a directory asset source and data: URLs, thread names.
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <thread>
#include <vector>

#include "iwn/workers/policy.h"
#include "iwn_test.h"

using namespace iwn;
using namespace iwn::workers;

IWN_TEST(WorkersConfig, Defaults) {
  std::vector<std::string> warnings;
  WorkersConfig c = parse_workers_config(Json(), &warnings);
  IWN_CHECK(warnings.empty());
  IWN_CHECK_EQ(c.max_workers, 32);
  IWN_CHECK_EQ(c.heap_limit_bytes, 256ull << 20);
  IWN_CHECK_EQ(c.hardware_concurrency, 4);
  IWN_CHECK(c.cross_origin_isolated);
  IWN_CHECK(!c.preludes.has_value());
  IWN_CHECK_EQ(c.exclude_modules.size(), 4u);
  IWN_CHECK_EQ(c.message_log, -1);
}

IWN_TEST(WorkersConfig, ParsesAndWarns) {
  std::vector<std::string> warnings;
  auto j = Json::parse(R"({"maxWorkers": 4, "heapLimitMB": 64, "crossOriginIsolated": false, "preludes": ["a.js"],
      "excludeModules": [], "hardwareConcurrency": 2, "nice": 99, "bogus": 1, "stackKB": "x"})");
  IWN_CHECK(j.has_value());
  WorkersConfig c = parse_workers_config(*j, &warnings);
  IWN_CHECK_EQ(c.max_workers, 4);
  IWN_CHECK_EQ(c.heap_limit_bytes, 64ull << 20);
  IWN_CHECK(!c.cross_origin_isolated);
  IWN_CHECK(c.preludes.has_value());
  IWN_CHECK_EQ(c.preludes->size(), 1u);
  IWN_CHECK(c.exclude_modules.empty());
  IWN_CHECK_EQ(c.hardware_concurrency, 2);
  IWN_CHECK_EQ(c.nice, 10);  // 99 rejected
  IWN_CHECK_EQ(warnings.size(), 3u);  // nice, bogus, stackKB
}

IWN_TEST(WorkersConfig, CappedConcurrency) {
  IWN_CHECK_EQ(capped_concurrency(8, 4), 4);
  IWN_CHECK_EQ(capped_concurrency(2, 4), 2);
  IWN_CHECK_EQ(capped_concurrency(0, 4), 1);
}

IWN_TEST(WorkerLimiter, CapAndRelease) {
  WorkerLimiter lim(3);
  IWN_CHECK(lim.try_acquire());
  IWN_CHECK(lim.try_acquire());
  IWN_CHECK(lim.try_acquire());
  IWN_CHECK(!lim.try_acquire());
  IWN_CHECK_EQ(lim.live(), 3);
  lim.release();
  IWN_CHECK(lim.try_acquire());
  for (int i = 0; i < 10; ++i) lim.release();  // never below zero
  IWN_CHECK_EQ(lim.live(), 0);
  IWN_CHECK_EQ(lim.created(), 4u);
}

IWN_TEST(WorkerLimiter, ConcurrentAcquireNeverExceedsCap) {
  WorkerLimiter lim(32);
  std::atomic<int> got{0};
  std::vector<std::thread> ts;
  for (int t = 0; t < 8; ++t) {
    ts.emplace_back([&] {
      for (int i = 0; i < 1000; ++i) {
        if (lim.try_acquire()) got++;
      }
    });
  }
  for (auto& t : ts) t.join();
  IWN_CHECK_EQ(got.load(), 32);
}

IWN_TEST(WorkerUrl, Checks) {
  auto same = parse_url("https://app.local/w.js");
  auto other = parse_url("https://cdn.example/w.js");
  auto data = parse_url("data:text/javascript,1");
  auto blob = parse_url("blob:https://app.local/1234");
  auto file = parse_url("file:///w.js");
  IWN_CHECK(check_worker_url(*same, "https://app.local") == WorkerUrlCheck::kOk);
  IWN_CHECK(check_worker_url(*other, "https://app.local") == WorkerUrlCheck::kCrossOrigin);
  IWN_CHECK(check_worker_url(*data, "https://app.local") == WorkerUrlCheck::kOk);
  IWN_CHECK(check_worker_url(*blob, "null") == WorkerUrlCheck::kOk);
  IWN_CHECK(check_worker_url(*file, "https://app.local") == WorkerUrlCheck::kUnsupportedScheme);
}

namespace {
struct TempDir {
  TempDir() {
    char tmpl[] = "/tmp/iwn-workers-test-XXXXXX";
    path = mkdtemp(tmpl);
    std::filesystem::create_directories(path + "/app/assets");
  }
  ~TempDir() { std::filesystem::remove_all(path); }
  void write(const std::string& rel, const std::string& text) {
    std::ofstream(path + "/" + rel, std::ios::binary) << text;
  }
  std::string path;
};
}  // namespace

IWN_TEST(FetchScript, AssetsDataAndErrors) {
  TempDir dir;
  dir.write("app/assets/w.js", "postMessage(1)");
  dir.write("app/assets/data.json", "{}");
  auto assets = make_directory_asset_source(dir.path);
  ScriptSource src{*parse_url("https://app.local/"), "app", assets.get()};

  auto r = fetch_script("https://app.local/assets/w.js", src, true);
  IWN_CHECK(r.ok);
  IWN_CHECK_EQ(r.source, std::string("postMessage(1)"));
  IWN_CHECK_EQ(r.mime, std::string("text/javascript"));

  r = fetch_script("https://app.local/assets/w.js?v=2#x", src, true);  // query/fragment ignored for assets
  IWN_CHECK(r.ok);

  r = fetch_script("https://app.local/assets/missing.js", src, false);
  IWN_CHECK(!r.ok);
  IWN_CHECK(r.error.find("404") != std::string::npos);

  r = fetch_script("https://app.local/assets/data.json", src, true);  // module scripts need a JS MIME type
  IWN_CHECK(!r.ok);
  r = fetch_script("https://app.local/assets/data.json", src, false);
  IWN_CHECK(r.ok);

  r = fetch_script("https://app.local/../../etc/passwd", src, false);  // cannot leave the dist (NET-4)
  IWN_CHECK(!r.ok);

  r = fetch_script("https://cdn.example/x.js", src, false);
  IWN_CHECK(!r.ok);
  IWN_CHECK(r.error.find("cross-origin") != std::string::npos);

  r = fetch_script("data:text/javascript;base64,cG9zdE1lc3NhZ2UoMik=", src, true);
  IWN_CHECK(r.ok);
  IWN_CHECK_EQ(r.source, std::string("postMessage(2)"));
  r = fetch_script("data:text/javascript,self.x%3D1", src, true);
  IWN_CHECK(r.ok);
  IWN_CHECK_EQ(r.source, std::string("self.x=1"));
  r = fetch_script("data:application/json,{}", src, true);
  IWN_CHECK(!r.ok);

  r = fetch_script("ftp://x/y.js", src, false);
  IWN_CHECK(!r.ok);
}

IWN_TEST(WorkerNames, ThreadAndLabel) {
  IWN_CHECK_EQ(worker_thread_name(3, ""), std::string("iwn-w3"));
  IWN_CHECK_EQ(worker_thread_name(3, "ktx2"), std::string("iwn-w3-ktx2"));
  IWN_CHECK_EQ(worker_thread_name(12, "very long name!"), std::string("iwn-w12-very_lo"));
  IWN_CHECK(worker_thread_name(123456789, "x").size() <= 15);
  IWN_CHECK_EQ(worker_label(2, "msdf", "https://app.local/m.js"), std::string("worker 2 'msdf'"));
  IWN_CHECK_EQ(worker_label(2, "", "https://app.local/m.js"), std::string("worker 2 https://app.local/m.js"));
}
