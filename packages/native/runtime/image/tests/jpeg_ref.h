// Reference JPEG decodes with libjpeg-turbo (test-only), for IMG-1's "within ±1 of libjpeg-turbo" check.
#pragma once

#include <cstdint>
#include <vector>

#include "test_images.h"

namespace iwn::image::test {

// False when the tests were built without libjpeg-turbo (IWN_LIBJPEG_TURBO_DIR missing); the tests then skip.
bool HaveLibjpegReference();
// libjpeg-turbo with JDCT_ISLOW and fancy upsampling (Skia's and Chromium's settings), RGBA8 output.
bool LibjpegDecodeRgba(const Bytes& jpeg, Img* out);
// The stored CMYK samples (Adobe files store them inverted: 255 = no ink), no colour conversion.
bool LibjpegDecodeCmyk(const Bytes& jpeg, uint32_t* w, uint32_t* h, std::vector<uint8_t>* cmyk);
// A 4-component JPEG with an Adobe APP14 marker, stored as CMYK (transform 0) or YCCK (transform 2); 4:4:4.
Bytes LibjpegEncodeCmyk(uint32_t w, uint32_t h, const std::vector<uint8_t>& cmyk, int quality, bool ycck);
// A flat (single-value) image, the best case for compression: grey (1 component) or YCbCr 4:2:0 (3), baseline or
// progressive, with optimised Huffman tables (1-bit codes where possible). Used to check the JPEG size lower bound.
Bytes LibjpegEncodeFlat(uint32_t w, uint32_t h, int components, uint8_t value, int quality, bool progressive);

}  // namespace iwn::image::test
