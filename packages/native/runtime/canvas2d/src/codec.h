// Small image codec wrappers over stb (public domain / MIT): PNG + JPEG encode for toBlob/toDataURL, PNG decode for
// colour emoji strikes (CBDT). All stb symbols are file-static in codec.cc, so they cannot clash with another
// module's copy of stb in the same binary.
#pragma once

#include <cstdint>
#include <vector>

namespace iwn::canvas2d {

bool EncodePng(const uint8_t* rgba, int width, int height, std::vector<uint8_t>* out);
bool EncodeJpeg(const uint8_t* rgb, int width, int height, int quality, std::vector<uint8_t>* out);
// Decodes to premultiplied RGBA8. Images wider or taller than max_dim are rejected before any pixel is decoded.
bool DecodePngPremultiplied(const uint8_t* data, size_t size, int* width, int* height, std::vector<uint8_t>* out,
                            int max_dim);

}  // namespace iwn::canvas2d
