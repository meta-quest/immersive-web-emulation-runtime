#include "codec.h"

#include <climits>
#include <cstring>

#define STB_IMAGE_WRITE_STATIC
#define STB_IMAGE_WRITE_IMPLEMENTATION
#define STBI_WRITE_NO_STDIO
#if defined(__GNUC__)
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wunused-function"
#pragma GCC diagnostic ignored "-Wmissing-field-initializers"
#pragma GCC diagnostic ignored "-Wsign-compare"
#endif
#include "stb_image_write.h"

#define STB_IMAGE_STATIC
#define STB_IMAGE_IMPLEMENTATION
#define STBI_ONLY_PNG
#define STBI_NO_STDIO
#define STBI_NO_LINEAR
#define STBI_NO_HDR
#define STBI_MAX_DIMENSIONS 16384  // backstop for the header check in DecodePngPremultiplied
#include "stb_image.h"
#if defined(__GNUC__)
#pragma GCC diagnostic pop
#endif

namespace iwn::canvas2d {

namespace {
void Append(void* ctx, void* data, int size) {
  auto* out = static_cast<std::vector<uint8_t>*>(ctx);
  const uint8_t* p = static_cast<const uint8_t*>(data);
  out->insert(out->end(), p, p + size);
}
}  // namespace

bool EncodePng(const uint8_t* rgba, int width, int height, std::vector<uint8_t>* out) {
  out->clear();
  return stbi_write_png_to_func(Append, out, width, height, 4, rgba, width * 4) != 0;
}

bool EncodeJpeg(const uint8_t* rgb, int width, int height, int quality, std::vector<uint8_t>* out) {
  out->clear();
  return stbi_write_jpg_to_func(Append, out, width, height, 3, rgb, quality) != 0;
}

bool DecodePngPremultiplied(const uint8_t* data, size_t size, int* width, int* height, std::vector<uint8_t>* out,
                            int max_dim) {
  if (size > INT_MAX) return false;
  int w = 0, h = 0, comp = 0;
  // Size from the header first: a crafted image must not make the decoder allocate width x height x 4 bytes.
  if (!stbi_info_from_memory(data, static_cast<int>(size), &w, &h, &comp)) return false;
  if (w <= 0 || h <= 0 || w > max_dim || h > max_dim) return false;
  unsigned char* px = stbi_load_from_memory(data, static_cast<int>(size), &w, &h, &comp, 4);
  if (!px) return false;
  out->resize(static_cast<size_t>(w) * h * 4);
  for (size_t i = 0, n = static_cast<size_t>(w) * h; i < n; i++) {
    uint32_t a = px[4 * i + 3];
    for (int c = 0; c < 3; c++) {
      uint32_t v = px[4 * i + c] * a + 128;
      (*out)[4 * i + c] = static_cast<uint8_t>((v + (v >> 8)) >> 8);
    }
    (*out)[4 * i + 3] = static_cast<uint8_t>(a);
  }
  stbi_image_free(px);
  *width = w;
  *height = h;
  return true;
}

}  // namespace iwn::canvas2d
