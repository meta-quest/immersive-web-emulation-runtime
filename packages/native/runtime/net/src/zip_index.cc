// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.

#include "iwn/net/zip_index.h"

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <cstring>
#include <fstream>
#include <vector>

namespace iwn::net {

namespace {

constexpr uint32_t kEocdSig = 0x06054b50;
constexpr uint32_t kZip64LocatorSig = 0x07064b50;
constexpr uint32_t kZip64EocdSig = 0x06064b50;
constexpr uint32_t kCdSig = 0x02014b50;
constexpr uint32_t kLocalSig = 0x04034b50;

uint16_t U16(const uint8_t* p) { return static_cast<uint16_t>(p[0] | (p[1] << 8)); }
uint32_t U32(const uint8_t* p) { return p[0] | (p[1] << 8) | (p[2] << 16) | (uint32_t(p[3]) << 24); }
uint64_t U64(const uint8_t* p) { return U32(p) | (uint64_t(U32(p + 4)) << 32); }

bool ReadAt(int fd, uint64_t offset, void* buf, size_t len) {
  size_t done = 0;
  while (done < len) {
    ssize_t n = pread(fd, static_cast<uint8_t*>(buf) + done, len - done, static_cast<off_t>(offset + done));
    if (n <= 0) return false;
    done += static_cast<size_t>(n);
  }
  return true;
}

}  // namespace

ZipIndex::~ZipIndex() {
  if (fd_ >= 0) close(fd_);
}

std::unique_ptr<ZipIndex> ZipIndex::Open(const std::string& path, const std::string& prefix, std::string* error) {
  auto fail = [&](const char* why) -> std::unique_ptr<ZipIndex> {
    if (error) *error = why;
    return nullptr;
  };
  std::unique_ptr<ZipIndex> z(new ZipIndex());
  z->fd_ = open(path.c_str(), O_RDONLY | O_CLOEXEC);
  if (z->fd_ < 0) return fail("cannot open file");
  struct stat st;
  if (fstat(z->fd_, &st) != 0 || st.st_size < 22) return fail("not a zip file");
  z->file_size_ = static_cast<uint64_t>(st.st_size);
  // The EOCD record is the last 22 bytes plus a comment of up to 65535 bytes.
  size_t tail_len = static_cast<size_t>(std::min<uint64_t>(z->file_size_, 22 + 65535));
  std::vector<uint8_t> tail(tail_len);
  uint64_t tail_start = z->file_size_ - tail_len;
  if (!ReadAt(z->fd_, tail_start, tail.data(), tail_len)) return fail("read error");
  long eocd = -1;
  for (long i = static_cast<long>(tail_len) - 22; i >= 0; --i) {
    if (U32(&tail[static_cast<size_t>(i)]) == kEocdSig &&
        static_cast<size_t>(i) + 22 + U16(&tail[static_cast<size_t>(i) + 20]) == tail_len) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return fail("no end of central directory record");
  const uint8_t* e = &tail[static_cast<size_t>(eocd)];
  uint64_t count = U16(e + 10);
  uint64_t cd_size = U32(e + 12);
  uint64_t cd_offset = U32(e + 16);
  if (count == 0xFFFF || cd_size == 0xFFFFFFFFu || cd_offset == 0xFFFFFFFFu) {
    // ZIP64: the locator sits right before the EOCD record.
    uint64_t eocd_pos = tail_start + static_cast<uint64_t>(eocd);
    if (eocd_pos < 20) return fail("bad zip64 locator");
    uint8_t loc[20];
    if (!ReadAt(z->fd_, eocd_pos - 20, loc, sizeof loc) || U32(loc) != kZip64LocatorSig) return fail("bad zip64 locator");
    uint64_t rec_pos = U64(loc + 8);
    uint8_t rec[56];
    if (!ReadAt(z->fd_, rec_pos, rec, sizeof rec) || U32(rec) != kZip64EocdSig) return fail("bad zip64 record");
    count = U64(rec + 32);
    cd_size = U64(rec + 40);
    cd_offset = U64(rec + 48);
  }
  if (cd_offset + cd_size > z->file_size_) return fail("central directory out of range");
  std::vector<uint8_t> cd(static_cast<size_t>(cd_size));
  if (!ReadAt(z->fd_, cd_offset, cd.data(), cd.size())) return fail("read error");
  size_t pos = 0;
  for (uint64_t i = 0; i < count; ++i) {
    if (pos + 46 > cd.size() || U32(&cd[pos]) != kCdSig) return fail("bad central directory entry");
    const uint8_t* h = &cd[pos];
    uint16_t method = U16(h + 10);
    uint64_t compressed = U32(h + 20);
    uint64_t size = U32(h + 24);
    uint16_t name_len = U16(h + 28), extra_len = U16(h + 30), comment_len = U16(h + 32);
    uint64_t local = U32(h + 42);
    if (pos + 46 + name_len + extra_len + comment_len > cd.size()) return fail("bad central directory entry");
    std::string name(reinterpret_cast<const char*>(h + 46), name_len);
    // ZIP64 extended information extra field (0x0001): present fields follow
    // in a fixed order for the values that are 0xFFFFFFFF above.
    const uint8_t* x = h + 46 + name_len;
    for (size_t xp = 0; xp + 4 <= extra_len;) {
      uint16_t id = U16(x + xp), len = U16(x + xp + 2);
      if (xp + 4 + len > extra_len) break;
      if (id == 0x0001) {
        const uint8_t* f = x + xp + 4;
        size_t fp = 0;
        if (size == 0xFFFFFFFFu && fp + 8 <= len) size = U64(f + fp), fp += 8;
        if (compressed == 0xFFFFFFFFu && fp + 8 <= len) compressed = U64(f + fp), fp += 8;
        if (local == 0xFFFFFFFFu && fp + 8 <= len) local = U64(f + fp), fp += 8;
      }
      xp += 4 + len;
    }
    pos += 46 + name_len + extra_len + comment_len;
    if (!prefix.empty() && name.compare(0, prefix.size(), prefix) != 0) continue;
    if (name.empty() || name.back() == '/') continue;  // directories
    CdEntry ce;
    ce.local_offset = local;
    ce.compressed = compressed;
    ce.size = size;
    ce.method = method;
    z->entries_[std::move(name)] = ce;
  }
  return z;
}

bool ZipIndex::Find(const std::string& name, Entry* out) {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = entries_.find(name);
  if (it == entries_.end()) return false;
  CdEntry& ce = it->second;
  if (!ce.resolved) {
    uint8_t lh[30];
    if (!ReadAt(fd_, ce.local_offset, lh, sizeof lh) || U32(lh) != kLocalSig) return false;
    ce.data_offset = ce.local_offset + 30 + U16(lh + 26) + U16(lh + 28);
    if (ce.data_offset + ce.compressed > file_size_) return false;
    ce.resolved = true;
  }
  out->data_offset = ce.data_offset;
  out->size = ce.size;
  out->stored = ce.method == 0 && ce.compressed == ce.size;
  return true;
}

std::string FindOwnApkPath() {
  std::ifstream maps("/proc/self/maps");
  std::string line;
  while (std::getline(maps, line)) {
    size_t slash = line.find('/');
    if (slash == std::string::npos) continue;
    std::string path = line.substr(slash);
    static const char kSuffix[] = "/base.apk";
    if (path.size() > sizeof kSuffix - 1 && path.compare(path.size() - (sizeof kSuffix - 1), sizeof kSuffix - 1, kSuffix) == 0) {
      return path;
    }
  }
  return std::string();
}

}  // namespace iwn::net
