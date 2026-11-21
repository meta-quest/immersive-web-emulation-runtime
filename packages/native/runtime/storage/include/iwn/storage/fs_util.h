// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.
//
// Durable file helpers (POSIX): write temp + fsync + rename + fsync(dir).

#ifndef IWN_STORAGE_FS_UTIL_H_
#define IWN_STORAGE_FS_UTIL_H_

#include <cstdint>
#include <string>

namespace iwn::storage {

bool EnsureDir(const std::string& dir);
bool EnsureParentDirs(const std::string& file_path);
// Reads the whole file. Returns false if it cannot be opened or a read
// fails; *missing (optional) is then true only when the file does not exist
// (ENOENT), so callers can tell "absent" from "unreadable".
bool ReadWholeFile(const std::string& path, std::string* out, bool* missing = nullptr);
// Writes `data` to `path` and fsyncs it (does not rename).
bool WriteFileDurably(const std::string& path, const std::string& data);
// fsync of the directory containing `file_path` (makes a rename durable).
void FsyncDir(const std::string& file_path);
// Sum of regular file sizes under `dir` (non-recursive).
uint64_t DirectorySize(const std::string& dir);
// Free bytes on the filesystem holding `dir`.
uint64_t FreeBytes(const std::string& dir);

}  // namespace iwn::storage

#endif  // IWN_STORAGE_FS_UTIL_H_
