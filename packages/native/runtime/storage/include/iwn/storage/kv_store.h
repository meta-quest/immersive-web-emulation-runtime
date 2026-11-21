// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.
//
// Durable key/value file behind `localStorage` (spec NET-STORE-1,
// NET-STORE-2, PROC-* exit flush).
//
// The JS side keeps the live map (reads never cross into native code); every
// mutation is mirrored here. Mutations are coalesced per key (NET-STORE-2): a
// key set 100 times inside one window is written once, and clear() drops
// everything queued before it. A writer thread owns the file: the first
// pending mutation starts a deadline (default 250 ms), then the coalesced
// records are appended to a log file and fdatasync'd. The writer keeps its
// own replica of the map, so compaction (rewrite of the snapshot to a temp
// file, fsync, rename, fsync of the directory) never touches the JS thread.
// A crash loses at most the window since the first unflushed mutation;
// Flush(true) on pause/exit makes everything durable.
//
// Write failures (disk full, I/O error): a failed append is cut off again
// (ftruncate) and the snapshot is rewritten instead; if that fails too, the
// data is not reported durable, the store stays "unsynced" and the next
// attempt (retry_delay_ms later, or at the next Flush) rewrites the whole
// snapshot rather than appending behind a possibly torn record.
//
// File format (little-endian): "IWNKV001", then records
//   u8 op (1 set, 2 remove, 3 clear) | u32 key_units | u32 value_units |
//   key (UTF-16LE) | value (UTF-16LE) | u32 crc32(op..value)
// Strings are UTF-16 code units so lone surrogates survive (DOMString).
// A torn or corrupt tail is truncated on load.

#ifndef IWN_STORAGE_KV_STORE_H_
#define IWN_STORAGE_KV_STORE_H_

#include <condition_variable>
#include <cstdint>
#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace iwn::storage {

using KvEntries = std::vector<std::pair<std::u16string, std::u16string>>;

class KvStore {
 public:
  struct Options {
    std::string path;               // e.g. <filesDir>/iwn/local-storage.kv
    int flush_delay_ms = 250;       // NET-STORE-2 coalescing window
    size_t compact_min_bytes = 1 << 20;
    int retry_delay_ms = 1000;      // after a failed write
  };

  explicit KvStore(Options options);
  ~KvStore();  // Flush(true) and stop the writer

  // Reads the file (blocking: run it off the JS thread, see the binding) and
  // starts the writer. `out` (optional) receives the entries in key order
  // (UTF-16 code unit order). Corrupt files are moved aside (<path>.corrupt)
  // and start empty; *warning says so. A file that exists but cannot be read
  // is left untouched and Load returns false.
  bool Load(KvEntries* out, std::string* warning);

  void Set(std::u16string key, std::u16string value);
  void Remove(std::u16string key);
  void Clear();

  // Writes everything pending now. With wait=true, blocks (at most 10 s)
  // until it is durable and returns whether it is.
  bool Flush(bool wait);

  // The current contents including mutations not yet written (any thread).
  // Used when a page context is recreated in the same process (reload).
  KvEntries Snapshot();

  struct Stats {
    uint64_t flushes = 0;
    uint64_t compactions = 0;
    uint64_t records_written = 0;
    uint64_t bytes_written = 0;
    uint64_t log_bytes = 0;
    uint64_t live_bytes = 0;
    uint64_t failed_writes = 0;
    bool unsynced = false;  // the last write failed; data not durable yet
    std::string last_error;
  };
  Stats stats();

 private:
  struct Op {
    uint8_t kind;
    std::u16string key;
    std::u16string value;
  };
  // Pending per-key mutation: a value (set) or nullopt (remove).
  using PendingMap = std::map<std::u16string, std::optional<std::u16string>>;
  void WriterMain();
  bool AppendOps(bool clear, const PendingMap& ops, std::string* error);
  bool Compact(std::string* error);
  void Apply(const Op& op);  // replica_mu_ held
  static void EncodeOp(const Op& op, std::string* out);
  void NoteMutation();       // mu_ held

  Options options_;
  std::mutex mu_;
  std::condition_variable cv_;
  bool pending_clear_ = false;
  PendingMap pending_;
  int64_t first_pending_ms_ = 0;
  bool flush_now_ = false;
  bool stop_ = false;
  bool unsynced_ = false;      // last write failed (guarded by mu_)
  int64_t retry_at_ms_ = 0;
  uint64_t enqueued_seq_ = 0;
  uint64_t durable_seq_ = 0;
  std::condition_variable durable_cv_;
  std::thread writer_;
  bool started_ = false;
  Stats stats_;

  // Replica of the map: written by the writer thread under replica_mu_,
  // read by Snapshot().
  std::mutex replica_mu_;
  std::map<std::u16string, std::u16string> replica_;
  uint64_t live_bytes_ = 0;

  // Writer-thread state.
  int fd_ = -1;
  uint64_t log_bytes_ = 0;
};

}  // namespace iwn::storage

#endif  // IWN_STORAGE_KV_STORE_H_
