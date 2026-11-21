// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.

#include "iwn/storage/fs_util.h"

#include <dirent.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <unistd.h>

#include <cerrno>

namespace iwn::storage {

bool EnsureDir(const std::string& dir) {
  if (dir.empty()) return true;
  struct stat st;
  if (stat(dir.c_str(), &st) == 0) return S_ISDIR(st.st_mode);
  size_t slash = dir.rfind('/');
  if (slash != std::string::npos && slash > 0 && !EnsureDir(dir.substr(0, slash))) return false;
  return mkdir(dir.c_str(), 0700) == 0 || errno == EEXIST;
}

bool EnsureParentDirs(const std::string& file_path) {
  size_t slash = file_path.rfind('/');
  if (slash == std::string::npos || slash == 0) return true;
  return EnsureDir(file_path.substr(0, slash));
}

bool ReadWholeFile(const std::string& path, std::string* out, bool* missing) {
  out->clear();
  if (missing) *missing = false;
  int fd = open(path.c_str(), O_RDONLY | O_CLOEXEC);
  if (fd < 0) {
    if (missing) *missing = errno == ENOENT;
    return false;
  }
  char buf[64 * 1024];
  bool ok = true;
  for (;;) {
    ssize_t n = read(fd, buf, sizeof buf);
    if (n < 0 && errno == EINTR) continue;
    if (n < 0) {
      ok = false;
      break;
    }
    if (n == 0) break;
    out->append(buf, static_cast<size_t>(n));
  }
  close(fd);
  return ok;
}

bool WriteFileDurably(const std::string& path, const std::string& data) {
  int fd = open(path.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (fd < 0) return false;
  size_t done = 0;
  while (done < data.size()) {
    ssize_t n = write(fd, data.data() + done, data.size() - done);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) {
      close(fd);
      return false;
    }
    done += static_cast<size_t>(n);
  }
  bool ok = fsync(fd) == 0;
  return close(fd) == 0 && ok;
}

void FsyncDir(const std::string& file_path) {
  size_t slash = file_path.rfind('/');
  std::string dir = slash == std::string::npos ? "." : slash == 0 ? "/" : file_path.substr(0, slash);
  int fd = open(dir.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (fd < 0) return;
  fsync(fd);
  close(fd);
}

uint64_t DirectorySize(const std::string& dir) {
  uint64_t total = 0;
  DIR* d = opendir(dir.c_str());
  if (!d) return 0;
  while (dirent* e = readdir(d)) {
    std::string p = dir + "/" + e->d_name;
    struct stat st;
    if (stat(p.c_str(), &st) == 0 && S_ISREG(st.st_mode)) total += static_cast<uint64_t>(st.st_size);
  }
  closedir(d);
  return total;
}

uint64_t FreeBytes(const std::string& dir) {
  struct statvfs vfs;
  if (statvfs(dir.c_str(), &vfs) != 0) return 0;
  return static_cast<uint64_t>(vfs.f_bavail) * vfs.f_frsize;
}

}  // namespace iwn::storage
