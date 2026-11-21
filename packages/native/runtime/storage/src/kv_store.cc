// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.

#include "iwn/storage/kv_store.h"

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#include <zlib.h>

#include <cerrno>
#include <chrono>
#include <cstring>

#include "iwn/storage/fs_util.h"

namespace iwn::storage {

namespace {

constexpr char kMagic[8] = {'I', 'W', 'N', 'K', 'V', '0', '0', '1'};
constexpr uint8_t kOpSet = 1, kOpRemove = 2, kOpClear = 3;
constexpr uint32_t kMaxUnits = 64u << 20;  // sanity bound per string

int64_t NowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

void PutU32(std::string* out, uint32_t v) {
  for (int i = 0; i < 4; ++i) out->push_back(static_cast<char>(v >> (8 * i)));
}
uint32_t GetU32(const uint8_t* p) { return p[0] | (p[1] << 8) | (p[2] << 16) | (uint32_t(p[3]) << 24); }

void PutUtf16(std::string* out, const std::u16string& s) {
  for (char16_t c : s) {
    out->push_back(static_cast<char>(c & 0xFF));
    out->push_back(static_cast<char>(c >> 8));
  }
}
std::u16string GetUtf16(const uint8_t* p, uint32_t units) {
  std::u16string s(units, u'\0');
  for (uint32_t i = 0; i < units; ++i) s[i] = static_cast<char16_t>(p[2 * i] | (p[2 * i + 1] << 8));
  return s;
}

}  // namespace

KvStore::KvStore(Options options) : options_(std::move(options)) {}

KvStore::~KvStore() {
  if (started_) {
    Flush(true);
    {
      std::lock_guard<std::mutex> lock(mu_);
      stop_ = true;
    }
    cv_.notify_all();
    writer_.join();
  }
  if (fd_ >= 0) close(fd_);
}

void KvStore::EncodeOp(const Op& op, std::string* out) {
  size_t start = out->size();
  out->push_back(static_cast<char>(op.kind));
  PutU32(out, static_cast<uint32_t>(op.key.size()));
  PutU32(out, static_cast<uint32_t>(op.value.size()));
  PutUtf16(out, op.key);
  PutUtf16(out, op.value);
  uLong crc = crc32(0L, reinterpret_cast<const Bytef*>(out->data() + start), static_cast<uInt>(out->size() - start));
  PutU32(out, static_cast<uint32_t>(crc));
}

void KvStore::Apply(const Op& op) {
  switch (op.kind) {
    case kOpSet: {
      auto it = replica_.find(op.key);
      if (it != replica_.end()) live_bytes_ -= 2 * (it->first.size() + it->second.size());
      live_bytes_ += 2 * (op.key.size() + op.value.size());
      replica_[op.key] = op.value;
      break;
    }
    case kOpRemove: {
      auto it = replica_.find(op.key);
      if (it != replica_.end()) {
        live_bytes_ -= 2 * (it->first.size() + it->second.size());
        replica_.erase(it);
      }
      break;
    }
    case kOpClear:
      replica_.clear();
      live_bytes_ = 0;
      break;
  }
}

bool KvStore::Load(KvEntries* out, std::string* warning) {
  if (out) out->clear();
  if (!EnsureParentDirs(options_.path)) {
    if (warning) *warning = "cannot create directory for " + options_.path;
    return false;
  }
  std::string data;
  bool missing = false;
  bool exists = ReadWholeFile(options_.path, &data, &missing);
  if (!exists && !missing) {
    // Present but unreadable: never truncate it (the data may still be fine).
    if (warning) *warning = std::string("cannot read ") + options_.path + ": " + std::strerror(errno);
    return false;
  }
  size_t good = 0;
  bool corrupt_header = false;
  std::unique_lock<std::mutex> replica_lock(replica_mu_);  // order: mu_ before replica_mu_
  if (exists && !data.empty()) {
    const uint8_t* p = reinterpret_cast<const uint8_t*>(data.data());
    if (data.size() < sizeof kMagic || std::memcmp(p, kMagic, sizeof kMagic) != 0) {
      corrupt_header = true;
    } else {
      size_t pos = sizeof kMagic;
      good = pos;
      while (pos + 9 <= data.size()) {
        uint8_t kind = p[pos];
        uint32_t ku = GetU32(p + pos + 1), vu = GetU32(p + pos + 5);
        if ((kind != kOpSet && kind != kOpRemove && kind != kOpClear) || ku > kMaxUnits || vu > kMaxUnits) break;
        size_t len = 9 + 2 * size_t(ku) + 2 * size_t(vu);
        if (pos + len + 4 > data.size()) break;
        uLong crc = crc32(0L, p + pos, static_cast<uInt>(len));
        if (static_cast<uint32_t>(crc) != GetU32(p + pos + len)) break;
        Op op{kind, GetUtf16(p + pos + 9, ku), GetUtf16(p + pos + 9 + 2 * ku, vu)};
        Apply(op);
        pos += len + 4;
        good = pos;
      }
      if (good != data.size() && warning) {
        *warning = "dropped " + std::to_string(data.size() - good) + " bytes of torn/corrupt log tail";
      }
    }
  }
  if (corrupt_header) {
    std::string aside = options_.path + ".corrupt";
    rename(options_.path.c_str(), aside.c_str());
    if (warning) *warning = "unreadable storage file moved to " + aside;
    replica_.clear();
    live_bytes_ = 0;
    exists = false;
  }
  fd_ = open(options_.path.c_str(), O_RDWR | O_CREAT | O_CLOEXEC, 0600);
  if (fd_ < 0) {
    if (warning) *warning = std::string("cannot open ") + options_.path + ": " + std::strerror(errno);
    return false;
  }
  if (!exists || data.empty() || corrupt_header) {
    if (ftruncate(fd_, 0) != 0 || pwrite(fd_, kMagic, sizeof kMagic, 0) != static_cast<ssize_t>(sizeof kMagic)) {
      if (warning) *warning = "cannot initialise " + options_.path;
      close(fd_);
      fd_ = -1;
      return false;
    }
    fdatasync(fd_);
    FsyncDir(options_.path);
    good = sizeof kMagic;
  } else if (good != data.size()) {
    if (ftruncate(fd_, static_cast<off_t>(good)) == 0) fdatasync(fd_);
  }
  log_bytes_ = good;
  lseek(fd_, static_cast<off_t>(good), SEEK_SET);
  if (out) {
    for (const auto& kv : replica_) out->emplace_back(kv.first, kv.second);
  }
  replica_lock.unlock();
  {
    std::lock_guard<std::mutex> lock(mu_);
    started_ = true;
  }
  writer_ = std::thread([this] { WriterMain(); });
  return true;
}

void KvStore::NoteMutation() {
  if (pending_.empty() && !pending_clear_) first_pending_ms_ = NowMs();
  ++enqueued_seq_;
}

void KvStore::Set(std::u16string key, std::u16string value) {
  {
    std::lock_guard<std::mutex> lock(mu_);
    NoteMutation();
    pending_[std::move(key)] = std::move(value);  // coalesced per key
  }
  cv_.notify_all();
}

void KvStore::Remove(std::u16string key) {
  {
    std::lock_guard<std::mutex> lock(mu_);
    NoteMutation();
    pending_[std::move(key)] = std::nullopt;
  }
  cv_.notify_all();
}

void KvStore::Clear() {
  {
    std::lock_guard<std::mutex> lock(mu_);
    NoteMutation();
    // Everything queued before a clear is moot.
    pending_.clear();
    pending_clear_ = true;
  }
  cv_.notify_all();
}

bool KvStore::Flush(bool wait) {
  std::unique_lock<std::mutex> lock(mu_);
  if (!started_) return false;
  uint64_t target = enqueued_seq_;
  flush_now_ = true;
  cv_.notify_all();
  if (!wait) return true;
  durable_cv_.wait_for(lock, std::chrono::seconds(10), [&] { return durable_seq_ >= target || stop_; });
  return durable_seq_ >= target;
}

KvEntries KvStore::Snapshot() {
  std::lock_guard<std::mutex> lock(mu_);
  std::lock_guard<std::mutex> replica_lock(replica_mu_);
  std::map<std::u16string, std::u16string> merged;
  if (!pending_clear_) merged = replica_;
  for (const auto& [k, v] : pending_) {
    if (v) merged[k] = *v;
    else merged.erase(k);
  }
  KvEntries out;
  out.reserve(merged.size());
  for (auto& kv : merged) out.emplace_back(kv.first, std::move(kv.second));
  return out;
}

KvStore::Stats KvStore::stats() {
  std::lock_guard<std::mutex> lock(mu_);
  return stats_;
}

bool KvStore::AppendOps(bool clear, const PendingMap& ops, std::string* error) {
  std::string buf;
  if (clear) EncodeOp(Op{kOpClear, {}, {}}, &buf);
  for (const auto& [k, v] : ops) EncodeOp(v ? Op{kOpSet, k, *v} : Op{kOpRemove, k, {}}, &buf);
  uint64_t start = log_bytes_;
  size_t done = 0;
  bool ok = true;
  while (done < buf.size()) {
    ssize_t n = write(fd_, buf.data() + done, buf.size() - done);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) {
      ok = false;
      break;
    }
    done += static_cast<size_t>(n);
  }
  if (ok && fdatasync(fd_) != 0) ok = false;
  if (!ok) {
    *error = std::string("append failed: ") + std::strerror(errno);
    // Cut a partial record off again so later appends never follow it.
    if (ftruncate(fd_, static_cast<off_t>(start)) == 0) fdatasync(fd_);
    lseek(fd_, static_cast<off_t>(start), SEEK_SET);
    return false;
  }
  log_bytes_ += buf.size();
  std::lock_guard<std::mutex> lock(mu_);
  stats_.records_written += ops.size() + (clear ? 1 : 0);
  stats_.bytes_written += buf.size();
  return true;
}

bool KvStore::Compact(std::string* error) {
  std::string tmp = options_.path + ".tmp";
  std::string buf(kMagic, sizeof kMagic);
  {
    std::lock_guard<std::mutex> replica_lock(replica_mu_);
    for (const auto& kv : replica_) EncodeOp(Op{kOpSet, kv.first, kv.second}, &buf);
  }
  if (!WriteFileDurably(tmp, buf)) {
    *error = std::string("snapshot write failed: ") + std::strerror(errno);
    unlink(tmp.c_str());
    return false;
  }
  // Open the new file before the rename: once renamed, appends must go to it
  // (never to the old, unlinked inode).
  int fd = open(tmp.c_str(), O_RDWR | O_CLOEXEC);
  if (fd < 0) {
    *error = std::string("cannot reopen snapshot: ") + std::strerror(errno);
    unlink(tmp.c_str());
    return false;
  }
  if (rename(tmp.c_str(), options_.path.c_str()) != 0) {
    *error = std::string("rename failed: ") + std::strerror(errno);
    close(fd);
    unlink(tmp.c_str());
    return false;
  }
  FsyncDir(options_.path);
  if (fd_ >= 0) close(fd_);
  fd_ = fd;
  lseek(fd_, 0, SEEK_END);
  log_bytes_ = buf.size();
  std::lock_guard<std::mutex> lock(mu_);
  stats_.bytes_written += buf.size();
  return true;
}

void KvStore::WriterMain() {
  std::unique_lock<std::mutex> lock(mu_);
  for (;;) {
    bool have_pending = pending_clear_ || !pending_.empty();
    if (!have_pending && !unsynced_) {
      if (stop_) break;
      flush_now_ = false;
      cv_.wait(lock, [&] { return stop_ || pending_clear_ || !pending_.empty(); });
      continue;
    }
    if (!flush_now_ && !stop_) {
      int64_t at = unsynced_ ? retry_at_ms_ : first_pending_ms_ + options_.flush_delay_ms;
      auto deadline = std::chrono::steady_clock::time_point(std::chrono::milliseconds(at));
      cv_.wait_until(lock, deadline, [&] { return flush_now_ || stop_; });
    }
    bool clear = pending_clear_;
    PendingMap ops;
    ops.swap(pending_);
    pending_clear_ = false;
    uint64_t seq = enqueued_seq_;
    bool rewrite = unsynced_;
    flush_now_ = false;
    {
      // Applied while mu_ is held so Snapshot() always sees either the
      // pending ops or their effect on the replica.
      std::lock_guard<std::mutex> replica_lock(replica_mu_);
      if (clear) Apply(Op{kOpClear, {}, {}});
      for (const auto& [k, v] : ops) Apply(v ? Op{kOpSet, k, *v} : Op{kOpRemove, k, {}});
    }
    lock.unlock();
    std::string error;
    bool ok;
    bool compacted = false;
    if (rewrite) {
      // The log may end in a torn record from the failed attempt: rewrite it.
      ok = Compact(&error);
      compacted = ok;
    } else {
      ok = AppendOps(clear, ops, &error);
      if (ok && log_bytes_ > options_.compact_min_bytes && log_bytes_ > 2 * live_bytes_ + 4096) {
        std::string compact_error;
        compacted = Compact(&compact_error);  // optional; the append is durable already
      }
      if (!ok) {
        std::string compact_error;
        ok = Compact(&compact_error);  // disk full? a snapshot may still fit
        compacted = ok;
        if (!ok) error += "; " + compact_error;
      }
    }
    lock.lock();
    ++stats_.flushes;
    if (compacted) ++stats_.compactions;
    stats_.log_bytes = log_bytes_;
    stats_.live_bytes = live_bytes_;
    if (ok) {
      unsynced_ = false;
      durable_seq_ = seq;
    } else {
      unsynced_ = true;
      retry_at_ms_ = NowMs() + options_.retry_delay_ms;
      ++stats_.failed_writes;
      stats_.last_error = error;
    }
    stats_.unsynced = unsynced_;
    durable_cv_.notify_all();
    if (!ok && stop_) break;  // shutting down: one last attempt only
  }
  durable_cv_.notify_all();
}

}  // namespace iwn::storage
