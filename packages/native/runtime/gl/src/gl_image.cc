// Uploads from runtime/image handles (ImageBitmap, HTMLImageElement): runtime/image/INTEROP.md §3. The JS side
// (web/webgl/tex-source.ts) only calls imageUpload for RGBA/UNSIGNED_BYTE uploads of the whole image; every other
// format reads the pixels once with imageRead and converts in JS. Built with the image module when the runtime
// has it (IWN_GL_WITH_IMAGE, set by CMake when the iwn_image_v8 target exists); otherwise no handle exists and
// both natives return false.

#include <v8-isolate.h>
#include <v8-local-handle.h>
#include <v8-value.h>

#include <cstring>
#include <vector>

#include "composites.h"

#if defined(IWN_GL_WITH_IMAGE)
#include "iwn/image/transform.h"
#include "iwn/image/v8_binding.h"
#endif

namespace iwn::gl::v8c {

#if defined(IWN_GL_WITH_IMAGE)
namespace {

// alphaMode: -1 keep the store's mode, 0 straight, 1 premultiplied. Returns the `premultiply` argument of
// CopyForUpload, and whether any alpha work is needed.
bool WantPremultiplied(const image::PixelView& v, int32_t alphaMode, bool* alphaWork) {
  const bool srcPremul = v.alpha == image::AlphaMode::kPremultiplied;
  const bool want = alphaMode < 0 ? srcPremul : alphaMode == 1;
  *alphaWork = !v.opaque && want != srcPremul;
  return want;
}

std::vector<uint8_t>& Scratch() {
  static thread_local std::vector<uint8_t> buf;
  return buf;
}

}  // namespace
#endif

// mode 0 texImage2D, 1 texSubImage2D, 2 texSubImage3D of one layer at zoffset. The caller leaves the app's unpack
// state "tight" (alignment 1, row length / skips / image height 0, no PIXEL_UNPACK_BUFFER); restored to that.
bool imageUpload(v8::Isolate* isolate, v8::Local<v8::Value> handle, uint32_t target, int32_t level,
                 int32_t internalformat, int32_t xoffset, int32_t yoffset, int32_t zoffset, int32_t mode, bool flipY,
                 int32_t alphaMode) {
#if defined(IWN_GL_WITH_IMAGE)
  auto store = image::GetPixelStore(isolate, handle);
  if (!store) return false;
  image::ScopedPixels px = store->Read();
  if (!px.ok()) return false;
  const image::PixelView& v = px.view();
  bool alphaWork = false;
  const bool premul = WantPremultiplied(v, alphaMode, &alphaWork);
  const uint8_t* data = v.data;
  bool strided = v.stride != size_t(v.width) * 4;
  if (flipY || alphaWork) {
    auto& buf = Scratch();
    const size_t size = size_t(v.width) * v.height * 4;
    buf.resize(size);
    if (!image::CopyForUpload(v, flipY, premul, buf.data(), size)) return false;
    data = buf.data();
    strided = false;
  } else if (strided) {
    Api().PixelStorei(GL_UNPACK_ROW_LENGTH, GLint(v.stride / 4));
    Api().PixelStorei(GL_UNPACK_ALIGNMENT, 4);
  }
  const GLsizei w = GLsizei(v.width);
  const GLsizei h = GLsizei(v.height);
  if (mode == 0) {
    Api().TexImage2D(target, level, internalformat, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, data);
  } else if (mode == 1) {
    Api().TexSubImage2D(target, level, xoffset, yoffset, w, h, GL_RGBA, GL_UNSIGNED_BYTE, data);
  } else {
    Api().TexSubImage3D(target, level, xoffset, yoffset, zoffset, w, h, 1, GL_RGBA, GL_UNSIGNED_BYTE, data);
  }
  if (strided) {
    Api().PixelStorei(GL_UNPACK_ROW_LENGTH, 0);
    Api().PixelStorei(GL_UNPACK_ALIGNMENT, 1);
  }
  return true;
#else
  return false;
#endif
}

// Tight RGBA8 copy of the whole image into dst (dst_bytes >= width * height * 4).
bool imageRead(v8::Isolate* isolate, v8::Local<v8::Value> handle, uint8_t* dst, uint32_t dst_bytes, bool flipY,
               int32_t alphaMode) {
#if defined(IWN_GL_WITH_IMAGE)
  auto store = image::GetPixelStore(isolate, handle);
  if (!store) return false;
  image::ScopedPixels px = store->Read();
  if (!px.ok()) return false;
  const image::PixelView& v = px.view();
  const size_t row = size_t(v.width) * 4;
  if (dst_bytes < row * v.height) return false;
  bool alphaWork = false;
  const bool premul = WantPremultiplied(v, alphaMode, &alphaWork);
  if (flipY || alphaWork) return image::CopyForUpload(v, flipY, premul, dst, dst_bytes);
  for (uint32_t y = 0; y < v.height; y++) std::memcpy(dst + y * row, v.data + y * v.stride, row);
  return true;
#else
  return false;
#endif
}

}  // namespace iwn::gl::v8c
