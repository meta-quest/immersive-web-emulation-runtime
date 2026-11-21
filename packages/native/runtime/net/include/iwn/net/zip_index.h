// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.
//
// Read-only index of a ZIP file's central directory (PKWARE APPNOTE.TXT
// 6.3.x: end of central directory record, ZIP64 locator/record, central
// directory file headers, local file headers). Used to map entries that the
// APK stores uncompressed straight from base.apk (NET-3) when the runtime's
// asset reader only offers read-only bytes. Host-testable (no Android APIs).

#ifndef IWN_NET_ZIP_INDEX_H_
#define IWN_NET_ZIP_INDEX_H_

#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <string>

namespace iwn::net {

class ZipIndex {
 public:
  struct Entry {
    uint64_t data_offset = 0;  // file offset of the entry's first data byte
    uint64_t size = 0;         // uncompressed size
    bool stored = false;       // method 0: the bytes are in the file as-is
  };

  ~ZipIndex();
  // Indexes entries whose names start with `prefix` ("" = all). Returns null
  // (and sets *error) if the file is not a readable ZIP.
  static std::unique_ptr<ZipIndex> Open(const std::string& path, const std::string& prefix, std::string* error);

  // Thread-safe. Resolves the local header lazily (one pread per entry).
  bool Find(const std::string& name, Entry* out);
  int fd() const { return fd_; }
  size_t entry_count() const { return entries_.size(); }

 private:
  struct CdEntry {
    uint64_t local_offset = 0;
    uint64_t compressed = 0;
    uint64_t size = 0;
    uint16_t method = 0;
    bool resolved = false;
    uint64_t data_offset = 0;
  };
  ZipIndex() = default;
  int fd_ = -1;
  uint64_t file_size_ = 0;
  std::mutex mu_;
  std::map<std::string, CdEntry> entries_;
};

// The APK this process runs from (the "/base.apk" mapping in
// /proc/self/maps); empty if none is found (host builds).
std::string FindOwnApkPath();

}  // namespace iwn::net

#endif  // IWN_NET_ZIP_INDEX_H_
