#pragma once

#include <android/asset_manager.h>
#include <android/asset_manager_jni.h>

#include <memory>

#include "iwn/core/asset_source.h"

namespace iwn {
// The AAssetManager must stay valid for the source's lifetime (the shell holds a global ref to the Java object).
std::shared_ptr<AssetSource> make_apk_asset_source(AAssetManager* mgr);
}  // namespace iwn
