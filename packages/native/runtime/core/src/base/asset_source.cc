/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "iwn/core/asset_source.h"

#include <sys/stat.h>

#include <cstdio>

namespace iwn {
namespace {

class OwnedBytes : public AssetBytes {
 public:
  explicit OwnedBytes(std::string d) : data_(std::move(d)) {}
  const uint8_t* data() const override { return reinterpret_cast<const uint8_t*>(data_.data()); }
  size_t size() const override { return data_.size(); }

 private:
  std::string data_;
};

bool safe_relative(std::string_view p) {
  if (p.empty() || p[0] == '/') return false;
  size_t start = 0;
  while (start <= p.size()) {
    size_t end = p.find('/', start);
    if (end == std::string_view::npos) end = p.size();
    if (p.substr(start, end - start) == "..") return false;
    start = end + 1;
  }
  return true;
}

class DirectorySource : public AssetSource {
 public:
  explicit DirectorySource(std::string root) : root_(std::move(root)) {}
  std::shared_ptr<AssetBytes> read(std::string_view path) override {
    if (!safe_relative(path)) return nullptr;
    std::string full = root_ + "/" + std::string(path);
    struct stat st{};
    if (stat(full.c_str(), &st) != 0 || !S_ISREG(st.st_mode)) return nullptr;
    FILE* f = fopen(full.c_str(), "rb");
    if (!f) return nullptr;
    std::string data(static_cast<size_t>(st.st_size), '\0');
    size_t n = data.empty() ? 0 : fread(data.data(), 1, data.size(), f);
    fclose(f);
    data.resize(n);
    return std::make_shared<OwnedBytes>(std::move(data));
  }
  bool exists(std::string_view path) override {
    if (!safe_relative(path)) return false;
    struct stat st{};
    return stat((root_ + "/" + std::string(path)).c_str(), &st) == 0 && S_ISREG(st.st_mode);
  }

 private:
  std::string root_;
};

}  // namespace

std::unique_ptr<AssetSource> make_directory_asset_source(std::string root) {
  return std::make_unique<DirectorySource>(std::move(root));
}

std::shared_ptr<AssetBytes> make_owned_bytes(std::string data) { return std::make_shared<OwnedBytes>(std::move(data)); }

}  // namespace iwn
