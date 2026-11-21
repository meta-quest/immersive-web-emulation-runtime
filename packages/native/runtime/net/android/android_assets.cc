// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.

#include "android_assets.h"

#include <android/asset_manager.h>
#include <unistd.h>

#include <cstring>

namespace iwn::net {

AndroidAssetSource::AndroidAssetSource(AAssetManager* manager, std::string prefix)
    : manager_(manager), prefix_(std::move(prefix)) {
  while (!prefix_.empty() && prefix_.back() == '/') prefix_.pop_back();
}

std::string AndroidAssetSource::Full(const std::string& rel) const {
  return prefix_.empty() ? rel : prefix_ + "/" + rel;
}

AssetStatus AndroidAssetSource::Stat(const std::string& rel, uint64_t* size) {
  AAsset* asset = AAssetManager_open(manager_, Full(rel).c_str(), AASSET_MODE_UNKNOWN);
  if (!asset) return AssetStatus::kNotFound;
  *size = static_cast<uint64_t>(AAsset_getLength64(asset));
  AAsset_close(asset);
  return AssetStatus::kOk;
}

AssetStatus AndroidAssetSource::Open(const std::string& rel, std::unique_ptr<AssetBlob>* out) {
  // AASSET_MODE_STREAMING: we either map via the fd or read sequentially once.
  AAsset* asset = AAssetManager_open(manager_, Full(rel).c_str(), AASSET_MODE_STREAMING);
  if (!asset) return AssetStatus::kNotFound;
  off64_t length = AAsset_getLength64(asset);
  size_t size = static_cast<size_t>(length);
  if (size >= kAssetMapThreshold) {
    off64_t start = 0, len = 0;
    // Succeeds only for entries stored uncompressed in the APK.
    int fd = AAsset_openFileDescriptor64(asset, &start, &len);
    if (fd >= 0) {
      *out = MapFileRange(fd, static_cast<uint64_t>(start), static_cast<size_t>(len));
      close(fd);
      if (*out) {
        AAsset_close(asset);
        return AssetStatus::kOk;
      }
    }
  }
  auto blob = MakeHeapBlob(size);
  size_t done = 0;
  while (done < size) {
    int n = AAsset_read(asset, blob->data() + done, size - done);
    if (n <= 0) {
      AAsset_close(asset);
      return AssetStatus::kIoError;
    }
    done += static_cast<size_t>(n);
  }
  AAsset_close(asset);
  *out = std::move(blob);
  return AssetStatus::kOk;
}

}  // namespace iwn::net
