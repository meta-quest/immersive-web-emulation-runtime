// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.

#include "iwn/net/assets.h"

#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <vector>

#include "iwn/net/util.h"

namespace iwn::net {

bool AssetPathFromUrlPath(std::string_view url_path, std::string* rel) {
  size_t q = url_path.find_first_of("?#");
  if (q != std::string_view::npos) url_path = url_path.substr(0, q);
  if (url_path.empty() || url_path.front() != '/') return false;
  std::string out;
  std::string seg;
  size_t pos = 1;
  bool trailing_slash = url_path.back() == '/';
  while (pos <= url_path.size()) {
    size_t next = url_path.find('/', pos);
    if (next == std::string_view::npos) next = url_path.size();
    std::string_view raw = url_path.substr(pos, next - pos);
    pos = next + 1;
    if (raw.empty()) continue;  // "//" or the trailing slash
    if (!PercentDecode(raw, &seg)) return false;
    if (seg == "." || seg == "..") return false;
    if (seg.find('/') != std::string::npos || seg.find('\\') != std::string::npos ||
        seg.find('\0') != std::string::npos) {
      return false;
    }
    if (!out.empty()) out.push_back('/');
    out += seg;
  }
  if (out.empty() || trailing_slash) {
    if (!out.empty()) out.push_back('/');
    out += "index.html";
  }
  *rel = std::move(out);
  return true;
}

const char* MimeTypeForPath(std::string_view path) {
  struct Entry {
    const char* ext;
    const char* type;
  };
  static const Entry kTable[] = {
      {"html", "text/html"},
      {"htm", "text/html"},
      {"js", "text/javascript"},
      {"mjs", "text/javascript"},
      {"cjs", "text/javascript"},
      {"css", "text/css"},
      {"json", "application/json"},
      {"map", "application/json"},
      {"wasm", "application/wasm"},
      {"png", "image/png"},
      {"jpg", "image/jpeg"},
      {"jpeg", "image/jpeg"},
      {"webp", "image/webp"},
      {"gif", "image/gif"},
      {"svg", "image/svg+xml"},
      {"avif", "image/avif"},
      {"ktx2", "image/ktx2"},
      {"basis", "application/octet-stream"},
      {"glb", "model/gltf-binary"},
      {"gltf", "model/gltf+json"},
      {"bin", "application/octet-stream"},
      {"hdr", "image/vnd.radiance"},
      {"exr", "image/x-exr"},
      {"mp3", "audio/mpeg"},
      {"ogg", "audio/ogg"},
      {"wav", "audio/wav"},
      {"m4a", "audio/mp4"},
      {"mp4", "video/mp4"},
      {"ttf", "font/ttf"},
      {"otf", "font/otf"},
      {"woff", "font/woff"},
      {"woff2", "font/woff2"},
      {"txt", "text/plain"},
      {"xml", "application/xml"},
  };
  size_t slash = path.rfind('/');
  std::string_view name = slash == std::string_view::npos ? path : path.substr(slash + 1);
  size_t dot = name.rfind('.');
  if (dot == std::string_view::npos || dot + 1 == name.size()) return "application/octet-stream";
  std::string ext = AsciiLowerStr(name.substr(dot + 1));
  for (const Entry& e : kTable) {
    if (ext == e.ext) return e.type;
  }
  return "application/octet-stream";
}

namespace {

class HeapBlob : public AssetBlob {
 public:
  explicit HeapBlob(size_t size) : size_(size), data_(static_cast<uint8_t*>(std::malloc(size ? size : 1))) {
    if (!data_) std::abort();
  }
  ~HeapBlob() override { std::free(data_); }
  uint8_t* data() override { return data_; }
  size_t size() const override { return size_; }
  bool mapped() const override { return false; }

 private:
  size_t size_;
  uint8_t* data_;
};

class MappedBlob : public AssetBlob {
 public:
  MappedBlob(void* base, size_t map_len, size_t delta, size_t size)
      : base_(base), map_len_(map_len), delta_(delta), size_(size) {}
  ~MappedBlob() override { munmap(base_, map_len_); }
  uint8_t* data() override { return static_cast<uint8_t*>(base_) + delta_; }
  size_t size() const override { return size_; }
  bool mapped() const override { return true; }

 private:
  void* base_;
  size_t map_len_;
  size_t delta_;
  size_t size_;
};

}  // namespace

std::unique_ptr<AssetBlob> MakeHeapBlob(size_t size) { return std::make_unique<HeapBlob>(size); }

std::unique_ptr<AssetBlob> MapFileRange(int fd, uint64_t offset, size_t size) {
  if (size == 0) return nullptr;
  long page = sysconf(_SC_PAGESIZE);
  uint64_t aligned = offset - offset % static_cast<uint64_t>(page);
  size_t delta = static_cast<size_t>(offset - aligned);
  size_t map_len = size + delta;
  // MAP_PRIVATE + PROT_WRITE: JS may write into the ArrayBuffer; writes go to
  // private copy-on-write pages and never reach the file.
  void* base = mmap(nullptr, map_len, PROT_READ | PROT_WRITE, MAP_PRIVATE, fd, static_cast<off_t>(aligned));
  if (base == MAP_FAILED) return nullptr;
  madvise(base, map_len, MADV_SEQUENTIAL);
  return std::make_unique<MappedBlob>(base, map_len, delta, size);
}

DirAssetSource::DirAssetSource(std::string root) : root_(std::move(root)) {
  while (root_.size() > 1 && root_.back() == '/') root_.pop_back();
}

AssetStatus DirAssetSource::Stat(const std::string& rel, uint64_t* size) {
  struct stat st;
  std::string path = root_ + "/" + rel;
  if (stat(path.c_str(), &st) != 0) return errno == ENOENT || errno == ENOTDIR ? AssetStatus::kNotFound : AssetStatus::kIoError;
  if (!S_ISREG(st.st_mode)) return AssetStatus::kNotFound;
  *size = static_cast<uint64_t>(st.st_size);
  return AssetStatus::kOk;
}

AssetStatus DirAssetSource::Open(const std::string& rel, std::unique_ptr<AssetBlob>* out) {
  std::string path = root_ + "/" + rel;
  int fd = open(path.c_str(), O_RDONLY | O_CLOEXEC);
  if (fd < 0) return errno == ENOENT || errno == ENOTDIR ? AssetStatus::kNotFound : AssetStatus::kIoError;
  struct stat st;
  if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode)) {
    close(fd);
    return AssetStatus::kNotFound;
  }
  size_t size = static_cast<size_t>(st.st_size);
  if (size >= kAssetMapThreshold) {
    *out = MapFileRange(fd, 0, size);
    if (*out) {
      close(fd);
      return AssetStatus::kOk;
    }
  }
  auto blob = MakeHeapBlob(size);
  size_t done = 0;
  while (done < size) {
    ssize_t n = read(fd, blob->data() + done, size - done);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) {
      close(fd);
      return AssetStatus::kIoError;
    }
    done += static_cast<size_t>(n);
  }
  close(fd);
  *out = std::move(blob);
  return AssetStatus::kOk;
}

}  // namespace iwn::net
