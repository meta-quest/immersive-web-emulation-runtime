// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.
//
// Host tests for the storage core: KV log (NET-STORE-1/2), SQLite service
// (IndexedDB / Cache API backend: batches, read-only refusal, durability).

#include <fcntl.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <fstream>
#include <future>
#include <thread>

#include "iwn/storage/fs_util.h"
#include "iwn/storage/kv_store.h"
#include "iwn/storage/sql_database.h"
#include "iwn_test.h"

using namespace iwn::storage;

static std::string TempDir() {
  char tmpl[] = "/tmp/iwn-storage-test-XXXXXX";
  return mkdtemp(tmpl);
}

static std::u16string U(const std::string& s) { return std::u16string(s.begin(), s.end()); }
static size_t CountKeys(const std::string& path);

TEST(KvRoundTripAndReplay) {
  std::string dir = TempDir();
  KvStore::Options o;
  o.path = dir + "/sub/local.kv";
  {
    KvStore s(o);
    KvEntries e;
    std::string w;
    CHECK(s.Load(&e, &w));
    CHECK(e.empty());
    s.Set(U("a"), U("1"));
    s.Set(U("b"), U("2"));
    s.Set(U("a"), U("3"));
    s.Remove(U("b"));
    std::u16string lone = u"x";
    lone.push_back(static_cast<char16_t>(0xD800));  // lone surrogate survives
    s.Set(U("s"), lone);
  }  // destructor flushes
  KvStore s2(o);
  KvEntries e;
  std::string w;
  CHECK(s2.Load(&e, &w));
  CHECK_EQ(e.size(), size_t(2));
  CHECK(e[0].first == U("a") && e[0].second == U("3"));
  CHECK(e[1].first == U("s") && e[1].second.size() == 2 && e[1].second[1] == 0xD800);
}

TEST(KvClearAndTornTail) {
  std::string dir = TempDir();
  KvStore::Options o;
  o.path = dir + "/local.kv";
  {
    KvStore s(o);
    KvEntries e;
    s.Load(&e, nullptr);
    s.Set(U("gone"), U("x"));
    s.Flush(true);
    s.Clear();
    s.Set(U("kept"), U("y"));
  }
  // Append garbage (a torn record) to the log.
  {
    std::ofstream f(o.path, std::ios::app | std::ios::binary);
    f.write("\x01\x05\x00\x00", 4);
  }
  KvStore s(o);
  KvEntries e;
  std::string w;
  CHECK(s.Load(&e, &w));
  CHECK_EQ(e.size(), size_t(1));
  CHECK(e[0].first == U("kept"));
  CHECK(w.find("torn") != std::string::npos);
  struct stat st;
  stat(o.path.c_str(), &st);
  std::string data;
  ReadWholeFile(o.path, &data);
  CHECK(data.size() % 1 == 0 && data.find("\x01\x05\x00\x00", data.size() - 4) == std::string::npos);
}

TEST(KvCorruptHeaderMovedAside) {
  std::string dir = TempDir();
  KvStore::Options o;
  o.path = dir + "/local.kv";
  std::ofstream(o.path) << "not a kv file";
  KvStore s(o);
  KvEntries e;
  std::string w;
  CHECK(s.Load(&e, &w));
  CHECK(e.empty());
  CHECK(access((o.path + ".corrupt").c_str(), F_OK) == 0);
}

TEST(KvCoalescingAndCompaction) {
  std::string dir = TempDir();
  KvStore::Options o;
  o.path = dir + "/local.kv";
  o.compact_min_bytes = 64 * 1024;
  KvStore s(o);
  KvEntries e;
  s.Load(&e, nullptr);
  // 1,000 writes in one "frame": the call must be cheap and coalesce into
  // one flush (NET-STORE-2).
  auto t0 = std::chrono::steady_clock::now();
  for (int i = 0; i < 1000; ++i) s.Set(U("counter"), U(std::to_string(i)));
  auto us = std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now() - t0).count();
  CHECK(us < 20000);
  std::this_thread::sleep_for(std::chrono::milliseconds(400));
  auto st = s.stats();
  CHECK_EQ(st.flushes, uint64_t(1));
  // Overwrite a big value repeatedly: the log must compact.
  std::u16string big(20000, u'x');
  for (int i = 0; i < 20; ++i) {
    s.Set(U("big"), big);
    s.Flush(true);
  }
  st = s.stats();
  CHECK(st.compactions >= 1);
  CHECK(st.log_bytes < 4 * st.live_bytes + 64 * 1024);
}

TEST(KvPerKeyCoalescing) {
  // 360 rewrites of one 100 KB value inside one window (5 s of 72 Hz frames
  // squeezed together) are written as one record, not 360.
  std::string dir = TempDir();
  KvStore::Options o;
  o.path = dir + "/local.kv";
  o.flush_delay_ms = 200;
  KvStore s(o);
  s.Load(nullptr, nullptr);
  std::u16string value(50000, u'v');  // 100 KB as UTF-16
  for (int i = 0; i < 360; ++i) {
    value[0] = static_cast<char16_t>(u'a' + i % 26);
    s.Set(U("big"), value);
  }
  s.Remove(U("never"));
  CHECK(s.Flush(true));
  auto st = s.stats();
  CHECK_EQ(st.flushes, uint64_t(1));
  CHECK_EQ(st.records_written, uint64_t(2));
  CHECK(st.bytes_written < 120 * 1024);
  CHECK_EQ(st.compactions, uint64_t(0));
}

TEST(KvSnapshotIncludesPendingWrites) {
  // What a reloaded page (new context, same process) must see.
  std::string dir = TempDir();
  KvStore::Options o;
  o.path = dir + "/local.kv";
  o.flush_delay_ms = 60000;  // keep mutations pending
  KvStore s(o);
  KvEntries e;
  s.Load(&e, nullptr);
  s.Set(U("a"), U("1"));
  CHECK(s.Flush(true));
  s.Set(U("b"), U("2"));
  s.Remove(U("a"));
  KvEntries snap = s.Snapshot();
  CHECK_EQ(snap.size(), size_t(1));
  CHECK(snap[0].first == U("b") && snap[0].second == U("2"));
  s.Clear();
  s.Set(U("c"), U("3"));
  snap = s.Snapshot();
  CHECK_EQ(snap.size(), size_t(1));
  CHECK(snap[0].first == U("c"));
  CHECK(s.Flush(true));
  snap = s.Snapshot();
  CHECK_EQ(snap.size(), size_t(1));
  CHECK(snap[0].first == U("c"));
}

TEST(KvUnreadableFileIsNotTruncated) {
  if (geteuid() == 0) return;  // root reads anything
  std::string dir = TempDir();
  KvStore::Options o;
  o.path = dir + "/local.kv";
  {
    KvStore s(o);
    s.Load(nullptr, nullptr);
    s.Set(U("keep"), U("me"));
  }
  struct stat before;
  stat(o.path.c_str(), &before);
  chmod(o.path.c_str(), 0);
  {
    KvStore s(o);
    std::string w;
    CHECK(!s.Load(nullptr, &w));
    CHECK(w.find("cannot read") != std::string::npos);
  }
  chmod(o.path.c_str(), 0600);
  struct stat after;
  stat(o.path.c_str(), &after);
  CHECK_EQ(after.st_size, before.st_size);
  CHECK_EQ(CountKeys(o.path), size_t(1));
}

static int RunHelper(const std::string& path, int n, const char* mode) {
  std::string cmd = std::string(IWN_KV_CRASH_HELPER) + " " + path + " " + std::to_string(n) + " " + mode;
  return std::system(cmd.c_str());
}

static size_t CountKeys(const std::string& path) {
  KvStore::Options o;
  o.path = path;
  KvStore s(o);
  KvEntries e;
  s.Load(&e, nullptr);
  return e.size();
}

TEST(KvFailedWriteIsNotDurableAndRecovers) {
  std::string dir = TempDir();
  std::string path = dir + "/f.kv";
  // 50 keys, then a write that cannot fit (append and snapshot both fail),
  // then the limit is lifted: everything must be there after a "restart",
  // with no torn tail.
  CHECK_EQ(RunHelper(path, 50, "fsize"), 0);
  KvStore::Options o;
  o.path = path;
  KvStore s(o);
  KvEntries e;
  std::string w;
  CHECK(s.Load(&e, &w));
  CHECK_EQ(e.size(), size_t(53));  // k0..k49, big, small, after
  CHECK(w.empty());
}

TEST(KvCrashLosesAtMostTheWindow) {
  std::string dir = TempDir();
  // Killed 600 ms after the writes: past the 250 ms window, so all durable.
  CHECK_EQ(RunHelper(dir + "/a.kv", 1000, "wait"), 0);
  CHECK_EQ(CountKeys(dir + "/a.kv"), size_t(1000));
  // Explicit flush (pause/exit path) then kill.
  CHECK_EQ(RunHelper(dir + "/b.kv", 500, "flush"), 0);
  CHECK_EQ(CountKeys(dir + "/b.kv"), size_t(500));
  // Killed at once: may lose the window, but the file stays loadable.
  CHECK_EQ(RunHelper(dir + "/c.kv", 100, "now"), 0);
  size_t n = CountKeys(dir + "/c.kv");
  CHECK(n == 0 || n == 100);
}

static std::vector<SqlResult> ExecSync(SqlService& svc, int h, std::vector<SqlStatement> batch, bool ro = false) {
  std::promise<std::vector<SqlResult>> p;
  auto f = p.get_future();
  svc.Exec(h, std::move(batch), ro, [&](std::vector<SqlResult> r) { p.set_value(std::move(r)); });
  return f.get();
}

TEST(SqlBatchesTypesAndReadOnly) {
  std::string dir = TempDir();
  SqlService svc(dir + "/idb");
  std::string err;
  int h = svc.Open("D_test.sqlite", &err);
  CHECK(h > 0);
  auto r = ExecSync(svc, h,
                    {{"CREATE TABLE t (k TEXT PRIMARY KEY, n INTEGER, d REAL, b BLOB)", {}},
                     {"INSERT INTO t VALUES (?, ?, ?, ?)",
                      {std::string("a"), int64_t(42), 1.5, std::vector<uint8_t>{0, 1, 255}}},
                     {"INSERT INTO t VALUES (?, ?, ?, ?)", {std::string("b"), std::monostate{}, 2.0, std::monostate{}}},
                     {"SELECT k, n, d, b FROM t ORDER BY k", {}},
                     {"INSERT INTO t VALUES ('a', 1, 1, NULL)", {}}});
  CHECK_EQ(r.size(), size_t(5));
  CHECK(r[0].error.empty());
  CHECK(r[1].error.empty() && r[1].rows_affected == 1 && r[1].insert_id == 1);
  CHECK(r[3].has_rows && r[3].rows.size() == 2);
  CHECK(std::get<std::string>(r[3].rows[0][0]) == "a");
  CHECK(std::get<int64_t>(r[3].rows[0][1]) == 42);
  CHECK(std::get<double>(r[3].rows[0][2]) == 1.5);
  CHECK((std::get<std::vector<uint8_t>>(r[3].rows[0][3]) == std::vector<uint8_t>{0, 1, 255}));
  CHECK(std::holds_alternative<std::monostate>(r[3].rows[1][1]));
  CHECK_EQ(r[3].columns[2], std::string("d"));
  CHECK(!r[4].error.empty());  // UNIQUE constraint
  auto ro = ExecSync(svc, h, {{"SELECT count(*) FROM t", {}}, {"DELETE FROM t", {}}}, true);
  CHECK(ro[0].error.empty() && std::get<int64_t>(ro[0].rows[0][0]) == 2);
  CHECK_EQ(ro[1].error, std::string("could not prepare statement (23 not authorized)"));
  auto bad = ExecSync(svc, h, {{"SELEKT", {}}});
  CHECK(bad[0].error.find("could not prepare statement") == 0);
}

TEST(SqlTransactionsAreDurable) {
  std::string dir = TempDir();
  {
    SqlService svc(dir);
    std::string err;
    int h = svc.Open("x.sqlite", &err);
    ExecSync(svc, h, {{"CREATE TABLE t (v)", {}}});
    ExecSync(svc, h, {{"BEGIN", {}}, {"INSERT INTO t VALUES (1)", {}}, {"END", {}}});
    // An uncommitted transaction is rolled back when the service shuts down.
    ExecSync(svc, h, {{"BEGIN", {}}, {"INSERT INTO t VALUES (2)", {}}});
  }
  SqlService svc(dir);
  std::string err;
  int h = svc.Open("x.sqlite", &err);
  auto r = ExecSync(svc, h, {{"SELECT v FROM t", {}}, {"PRAGMA journal_mode", {}}, {"PRAGMA synchronous", {}}});
  CHECK_EQ(r[0].rows.size(), size_t(1));
  CHECK(std::get<std::string>(r[1].rows[0][0]) == "wal");
  CHECK(std::get<int64_t>(r[2].rows[0][0]) == 2);  // FULL
  std::promise<std::string> closed;
  svc.Close(h, [&](std::string e) { closed.set_value(e); });
  CHECK(closed.get_future().get().empty());
  auto after = ExecSync(svc, h, {{"SELECT 1", {}}});
  CHECK_EQ(after[0].error, std::string("database is closed"));
}

TEST(SqlAtomicBatchRollsBackOnError) {
  std::string dir = TempDir();
  SqlService svc(dir);
  std::string err;
  int h = svc.Open("atomic.sqlite", &err);
  ExecSync(svc, h, {{"CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT NOT NULL)", {}},
                    {"INSERT INTO t VALUES ('old', 'x')", {}}});
  // Replace 'old' with a row whose INSERT fails: nothing may change.
  std::promise<std::vector<SqlResult>> p;
  svc.Exec(h,
           {{"DELETE FROM t WHERE k = 'old'", {}},
            {"INSERT INTO t VALUES ('new', NULL)", {}},
            {"INSERT INTO t VALUES ('later', 'y')", {}}},
           false, [&](std::vector<SqlResult> r) { p.set_value(std::move(r)); }, /*atomic=*/true);
  auto r = p.get_future().get();
  CHECK_EQ(r.size(), size_t(3));
  CHECK(r[0].error.empty());
  CHECK(r[1].error.find("NOT NULL") != std::string::npos);
  CHECK(r[2].error.find("rolled back") != std::string::npos);
  auto rows = ExecSync(svc, h, {{"SELECT k FROM t ORDER BY k", {}}});
  CHECK_EQ(rows[0].rows.size(), size_t(1));
  CHECK(std::get<std::string>(rows[0].rows[0][0]) == "old");
  // No transaction left open: a plain statement autocommits.
  auto again = ExecSync(svc, h, {{"INSERT INTO t VALUES ('b', 'z')", {}}, {"SELECT count(*) FROM t", {}}});
  CHECK(again[0].error.empty());
  CHECK(std::get<int64_t>(again[1].rows[0][0]) == 2);
  // A successful atomic batch commits.
  std::promise<std::vector<SqlResult>> q;
  svc.Exec(h, {{"DELETE FROM t WHERE k = 'b'", {}}, {"INSERT INTO t VALUES ('c', 'w')", {}}}, false,
           [&](std::vector<SqlResult> r2) { q.set_value(std::move(r2)); }, true);
  auto ok = q.get_future().get();
  CHECK(ok[0].error.empty() && ok[1].error.empty());
  auto final_rows = ExecSync(svc, h, {{"SELECT k FROM t ORDER BY k", {}}});
  CHECK_EQ(final_rows[0].rows.size(), size_t(2));
}

TEST(SqlNamesAndDelete) {
  CHECK(!IsSafeDatabaseName("../x"));
  CHECK(!IsSafeDatabaseName("a/b"));
  CHECK(!IsSafeDatabaseName(""));
  CHECK(IsSafeDatabaseName("D_my^2Edb.sqlite"));
  std::string dir = TempDir();
  SqlService svc(dir);
  std::string err;
  CHECK_EQ(svc.Open("../escape", &err), 0);
  int h = svc.Open("del.sqlite", &err);
  ExecSync(svc, h, {{"CREATE TABLE t (v)", {}}});
  std::promise<std::string> p1;
  svc.Delete("del.sqlite", [&](std::string e) { p1.set_value(e); });
  CHECK_EQ(p1.get_future().get(), std::string("database is open"));
  std::promise<std::string> c;
  svc.Close(h, [&](std::string e) { c.set_value(e); });
  c.get_future().get();
  std::promise<std::string> p2;
  svc.Delete("del.sqlite", [&](std::string e) { p2.set_value(e); });
  CHECK(p2.get_future().get().empty());
  CHECK(access((dir + "/del.sqlite").c_str(), F_OK) != 0);
  CHECK(svc.UsageBytes() == 0);
}

TEST_MAIN()
