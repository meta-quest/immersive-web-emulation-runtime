/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/* FreeType options for @iwer/native's Canvas 2D text: FreeType's defaults, then overrides.
 * We only load outlines (unhinted; canvas text is drawn through our own rasterizer), so the bytecode interpreter,
 * the autohinter, PNG/SVG glyphs (colour strikes are decoded by us), and legacy formats are left out. */
#ifndef IWN_FTOPTION_H_
#define IWN_FTOPTION_H_

#include <freetype/config/ftoption.h>

#undef FT_CONFIG_OPTION_USE_PNG
#undef FT_CONFIG_OPTION_USE_HARFBUZZ
#undef FT_CONFIG_OPTION_USE_HARFBUZZ_DYNAMIC
#undef FT_CONFIG_OPTION_USE_BZIP2
#undef FT_CONFIG_OPTION_USE_LZW
#undef FT_CONFIG_OPTION_SVG
#undef FT_CONFIG_OPTION_MAC_FONTS
#undef FT_CONFIG_OPTION_GUESSING_EMBEDDED_RFORK
#undef FT_CONFIG_OPTION_INCREMENTAL
#undef FT_CONFIG_OPTION_ENVIRONMENT_PROPERTIES
#undef FT_CONFIG_OPTION_SYSTEM_ZLIB
#undef TT_CONFIG_OPTION_BYTECODE_INTERPRETER
#undef TT_CONFIG_OPTION_SUBPIXEL_HINTING
#undef TT_USE_BYTECODE_INTERPRETER
#undef TT_SUPPORT_SUBPIXEL_HINTING_MINIMAL
#undef TT_CONFIG_OPTION_BDF
#undef AF_CONFIG_OPTION_CJK
#undef AF_CONFIG_OPTION_INDIC

/* WOFF 1.0 needs zlib (FreeType's bundled copy in src/gzip). */
#ifndef FT_CONFIG_OPTION_USE_ZLIB
#define FT_CONFIG_OPTION_USE_ZLIB
#endif

/* WOFF 2.0 needs the Brotli decoder (CMake option IWN_CANVAS2D_WOFF2). */
#ifdef IWN_FT_USE_BROTLI
#define FT_CONFIG_OPTION_USE_BROTLI
#endif

#endif /* IWN_FTOPTION_H_ */
