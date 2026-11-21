/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Bundled fonts from APK assets (Android NDK AAssetManager).
#include <android/asset_manager.h>

#include "canvas2d_v8.h"
#include "iwn/canvas2d/text.h"

namespace iwn::canvas2d {

void InstallAndroidAssetReader(AAssetManager* manager) {
  FontRegistry::Get().SetAssetReader([manager](const std::string& name) -> std::shared_ptr<FontBytes> {
    AAsset* asset = AAssetManager_open(manager, name.c_str(), AASSET_MODE_BUFFER);
    if (!asset) return nullptr;
    const void* data = AAsset_getBuffer(asset);
    off_t len = AAsset_getLength(asset);
    std::shared_ptr<FontBytes> bytes = (data && len > 0) ? FontBytes::Copy(static_cast<const uint8_t*>(data), static_cast<size_t>(len)) : nullptr;
    AAsset_close(asset);
    return bytes;
  });
}

}  // namespace iwn::canvas2d
