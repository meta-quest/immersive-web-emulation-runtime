// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.
//
// Test helper: `kv_crash_helper <path> <n> <mode>` sets n keys, then
//   mode "wait":  sleeps 600 ms (past the 250 ms window) and _exit(0)s
//   mode "now":   _exit(0)s immediately (simulated force-stop)
//   mode "flush": Flush(true) then _exit(0)
//   mode "fsize": the file-size limit (RLIMIT_FSIZE, standing in for a full
//                 disk) is lowered so the next append and the snapshot
//                 rewrite both fail; Flush(true) must report "not durable"
//                 (exit 10 otherwise). The limit is lifted again; the next
//                 Flush(true) must succeed (exit 11 otherwise). Then key
//                 "after" is written and flushed.
// _exit skips destructors, like a killed process.

#include <signal.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <unistd.h>

#include <chrono>
#include <cstdlib>
#include <string>
#include <thread>

#include "iwn/storage/kv_store.h"

int main(int argc, char** argv) {
  if (argc < 4) return 2;
  iwn::storage::KvStore::Options o;
  o.path = argv[1];
  auto* store = new iwn::storage::KvStore(o);  // leaked on purpose
  iwn::storage::KvEntries entries;
  std::string warning;
  if (!store->Load(&entries, &warning)) return 3;
  int n = std::atoi(argv[2]);
  for (int i = 0; i < n; ++i) {
    std::string k = "k" + std::to_string(i);
    store->Set(std::u16string(k.begin(), k.end()), u"v");
  }
  std::string mode = argv[3];
  if (mode == "fsize") {
    store->Flush(true);
    signal(SIGXFSZ, SIG_IGN);  // writes fail with EFBIG instead of killing us
    struct stat st;
    if (stat(o.path.c_str(), &st) != 0) return 4;
    rlimit old;
    getrlimit(RLIMIT_FSIZE, &old);
    rlimit low = old;
    low.rlim_cur = static_cast<rlim_t>(st.st_size) + 40;
    setrlimit(RLIMIT_FSIZE, &low);
    store->Set(u"big", std::u16string(1000, u'x'));  // 2 KB record: cannot fit
    store->Set(u"small", u"y");
    if (store->Flush(true)) _exit(10);
    if (!store->stats().unsynced) _exit(12);
    setrlimit(RLIMIT_FSIZE, &old);
    if (!store->Flush(true)) _exit(11);
    store->Set(u"after", u"z");
    if (!store->Flush(true)) _exit(13);
    _exit(0);
  }
  if (mode == "wait") std::this_thread::sleep_for(std::chrono::milliseconds(600));
  if (mode == "flush") store->Flush(true);
  _exit(0);
}
