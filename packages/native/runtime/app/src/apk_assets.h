/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#pragma once

#include <android/asset_manager.h>
#include <android/asset_manager_jni.h>

#include <memory>

#include "iwn/core/asset_source.h"

namespace iwn {
// The AAssetManager must stay valid for the source's lifetime (the shell holds a global ref to the Java object).
std::shared_ptr<AssetSource> make_apk_asset_source(AAssetManager* mgr);
}  // namespace iwn
