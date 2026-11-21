// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.
//
// AssetSource over the APK's AAssetManager. Uncompressed entries (the packer
// stores big binary types uncompressed, PKG-4) are mapped from the APK file
// descriptor (NET-3); compressed entries are inflated into one heap buffer.

#ifndef IWN_NET_ANDROID_ASSETS_H_
#define IWN_NET_ANDROID_ASSETS_H_

#include <string>

#include "iwn/net/assets.h"

struct AAssetManager;

namespace iwn::net {

class AndroidAssetSource : public AssetSource {
 public:
  // `prefix` is the folder inside assets/ that holds the dist ("" or "app").
  AndroidAssetSource(AAssetManager* manager, std::string prefix);
  AssetStatus Open(const std::string& rel, std::unique_ptr<AssetBlob>* out) override;
  AssetStatus Stat(const std::string& rel, uint64_t* size) override;

 private:
  std::string Full(const std::string& rel) const;
  AAssetManager* manager_;
  std::string prefix_;
};

}  // namespace iwn::net

#endif  // IWN_NET_ANDROID_ASSETS_H_
