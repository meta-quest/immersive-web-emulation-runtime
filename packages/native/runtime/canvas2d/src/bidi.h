/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Bidirectional text for canvas (HTML "text preparation algorithm" applies the Unicode Bidirectional Algorithm,
// UAX #9, with the paragraph direction taken from ctx.direction). Implemented from UAX #9 for a single paragraph
// without explicit embeddings: rules W1-W7, N0 (bracket pairs, BD16), N1-N2, I1-I2 and L1 are applied; explicit
// embedding/override/isolate controls (U+202A-202E, U+2066-2069) are treated as boundary neutrals (X9) instead of
// opening embeddings. Bidi classes come from a compact table of the characters that matter for labels (digits,
// separators, terminators, spaces, controls) plus the script and general category from HarfBuzz's Unicode data
// for everything else (letters of right-to-left scripts are R/AL, marks are NSM, other letters L, the rest ON).
#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

#include <hb.h>

namespace iwn::canvas2d {

enum class BidiClass : uint8_t { kL, kR, kAL, kEN, kES, kET, kAN, kCS, kNSM, kBN, kB, kS, kWS, kON };

BidiClass BidiClassOf(uint32_t cp, hb_unicode_funcs_t* uf);

// Resolves embedding levels for one paragraph of code points. para_level: 0 (LTR) or 1 (RTL). levels gets one entry
// per code point.
void ResolveBidiLevels(const uint32_t* cps, size_t n, int para_level, hb_unicode_funcs_t* uf, std::vector<uint8_t>* levels);

}  // namespace iwn::canvas2d
