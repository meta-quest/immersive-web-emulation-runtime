/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// A small PNG writer for the eye-buffer screenshot (DBG-SHOT), V8-free: 8-bit RGBA, filter type 1 (Sub) on every
// row, one zlib stream (the system zlib: NDK libz / the host's). Written from the PNG specification (W3C, 3rd ed.).
#pragma once

#include <cstdint>
#include <vector>

namespace iwn::xr {

// `rgba` points at the first (top) row; `stride` is the byte distance between rows. Returns an empty vector on
// failure. `level` is the zlib level (1 = fast).
std::vector<uint8_t> encode_png_rgba(const uint8_t* rgba, uint32_t width, uint32_t height, uint32_t stride,
                                     int level = 1);

}  // namespace iwn::xr
