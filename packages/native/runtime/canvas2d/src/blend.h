/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Compositing of a premultiplied source span onto a premultiplied destination span.
// Formulas: W3C Compositing and Blending Level 1 (Porter-Duff operators, separable and non-separable blend modes),
// which HTML's globalCompositeOperation refers to.
#pragma once

#include <cstdint>

#include "iwn/canvas2d/types.h"

namespace iwn::canvas2d {

// For each pixel i in [0, n):
//   s = src[i] * coverage[i]/255 * alpha      (src == nullptr: the constant `solid` colour)
//   r = op(s, dst[i])
//   dst[i] = dst[i] + (r - dst[i]) * clip[i]/255   (clip == nullptr: no clip)
// coverage == nullptr means full coverage. Pixels are RGBA8 premultiplied.
void CompositeSpan(CompositeOp op, uint8_t* dst, const uint8_t* src, const uint8_t solid[4], const uint8_t* coverage,
                   const uint8_t* clip, float alpha, int n);

inline uint32_t Div255(uint32_t x) { return (x + 128 + ((x + 128) >> 8)) >> 8; }

}  // namespace iwn::canvas2d
