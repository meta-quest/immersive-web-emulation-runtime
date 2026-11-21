/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Uploads from runtime/image handles (ImageBitmap, HTMLImageElement): runtime/image/INTEROP.md §3. The JS side
// (web/webgl/tex-source.ts) only calls imageUpload for RGBA/UNSIGNED_BYTE uploads of the whole image; every other
// format reads the pixels once with imageRead and converts in JS. Built with the image module when the runtime
// has it (IWN_GL_WITH_IMAGE, set by CMake when the iwn_image_v8 target exists); otherwise no handle exists and
// both natives return false.
//
// AHardwareBuffer-backed stores (the passthrough camera's frames, XR-CAM-1; INTEROP.md's zero-copy path) are copied
// on the GPU into RGBA8 TEXTURE_2D levels: the buffer is imported once as an EGLImage texture
// (EGL_ANDROID_get_native_client_buffer, EGL_ANDROID_image_native_buffer, GL_OES_EGL_image) and blitted into the app's
// texture, flipped by the blit when UNPACK_FLIP_Y_WEBGL asks. A 1280x1080 camera frame then costs the JS thread
// about 0.1 ms instead of 2-3 ms (a CPU flip plus the driver's copy). The app's texture keeps its own storage
// (WebGL semantics: it may respecify it or generate mipmaps), the copy is ordered like any GL command, and the
// producer rewrites a buffer only once no JS handle holds it, and then the one released longest ago (about three camera
// frames later: runtime/xr xr_camera.cc), so a copy queued from it normally ran long before. There is no fence between
// them: a frame whose GL work is still queued that long after (a GPU stall of ~100 ms) could read a newer frame.

#include <v8-isolate.h>
#include <v8-local-handle.h>
#include <v8-value.h>

#include <cstring>
#include <vector>

#include "composites.h"
#include "log.h"

#if defined(IWN_GL_WITH_IMAGE) && defined(__ANDROID__)
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2ext.h>
#include <android/hardware_buffer.h>

#include <list>
#define IWN_GL_GPU_IMAGE_COPY 1
#endif

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

#if defined(IWN_GL_GPU_IMAGE_COPY)
// One imported buffer: the EGLImage and a texture of the share group bound to it. As many are kept as a camera
// stream cycles through (four), each holding a reference on its buffer; the least recently used goes first. They
// stay until newer buffers replace them (after a stream stops: up to four frames' memory, 22 MB at 1280x1080).
struct Imported {
  AHardwareBuffer* buffer = nullptr;
  EGLImageKHR image = EGL_NO_IMAGE_KHR;
  GLuint texture = 0;
};
constexpr size_t kMaxImported = 4;

struct EglImageApi {
  bool ok = false;
  PFNEGLGETNATIVECLIENTBUFFERANDROIDPROC get_client_buffer = nullptr;
  PFNEGLCREATEIMAGEKHRPROC create_image = nullptr;
  PFNEGLDESTROYIMAGEKHRPROC destroy_image = nullptr;
  PFNGLEGLIMAGETARGETTEXTURE2DOESPROC target_texture = nullptr;
};

const EglImageApi& ImageApi() {
  static const EglImageApi api = [] {
    EglImageApi a;
    a.get_client_buffer = reinterpret_cast<PFNEGLGETNATIVECLIENTBUFFERANDROIDPROC>(
        eglGetProcAddress("eglGetNativeClientBufferANDROID"));
    a.create_image = reinterpret_cast<PFNEGLCREATEIMAGEKHRPROC>(eglGetProcAddress("eglCreateImageKHR"));
    a.destroy_image = reinterpret_cast<PFNEGLDESTROYIMAGEKHRPROC>(eglGetProcAddress("eglDestroyImageKHR"));
    a.target_texture =
        reinterpret_cast<PFNGLEGLIMAGETARGETTEXTURE2DOESPROC>(eglGetProcAddress("glEGLImageTargetTexture2DOES"));
    a.ok = a.get_client_buffer && a.create_image && a.destroy_image && a.target_texture;
    return a;
  }();
  return api;
}

std::list<Imported>& ImportedList() {
  static std::list<Imported>* list = new std::list<Imported>();
  return *list;
}

void Release(const Imported& e) {
  if (e.texture) Api().DeleteTextures(1, &e.texture);
  if (e.image != EGL_NO_IMAGE_KHR) ImageApi().destroy_image(eglGetCurrentDisplay(), e.image);
  AHardwareBuffer_release(e.buffer);
}

// The texture bound to `buffer`'s EGLImage, imported on first use. 0 when the import fails. Restores the app's
// TEXTURE_2D binding.
GLuint ImportedTexture(AHardwareBuffer* buffer) {
  auto& list = ImportedList();
  for (auto it = list.begin(); it != list.end(); ++it) {
    if (it->buffer == buffer) {
      list.splice(list.begin(), list, it);
      return list.front().texture;
    }
  }
  const EglImageApi& api = ImageApi();
  if (!api.ok) return 0;
  EGLDisplay display = eglGetCurrentDisplay();
  EGLClientBuffer client = api.get_client_buffer(buffer);
  const EGLint attrs[] = {EGL_IMAGE_PRESERVED_KHR, EGL_TRUE, EGL_NONE};
  EGLImageKHR image = client ? api.create_image(display, EGL_NO_CONTEXT, EGL_NATIVE_BUFFER_ANDROID, client, attrs)
                             : EGL_NO_IMAGE_KHR;
  if (image == EGL_NO_IMAGE_KHR) {
    static bool logged = false;
    if (!logged) IWN_GL_LOG_WARN("image upload: cannot import an AHardwareBuffer (EGL error 0x%x): CPU uploads", eglGetError());
    logged = true;
    return 0;
  }
  GLint bound = 0;
  Api().GetIntegerv(GL_TEXTURE_BINDING_2D, &bound);
  GLuint texture = 0;
  Api().GenTextures(1, &texture);
  Api().BindTexture(GL_TEXTURE_2D, texture);
  api.target_texture(GL_TEXTURE_2D, static_cast<GLeglImageOES>(image));
  Api().BindTexture(GL_TEXTURE_2D, GLuint(bound));
  AHardwareBuffer_acquire(buffer);
  list.push_front(Imported{buffer, image, texture});
  while (list.size() > kMaxImported) {
    Release(list.back());
    list.pop_back();
  }
  return texture;
}

// Copies the whole store into level `level` of the TEXTURE_2D bound on the active unit (mode 0 allocates the level
// first). False when this path does not apply; the caller then uploads through the CPU.
bool GpuCopy(const image::PixelStore& store, uint32_t target, int32_t level, int32_t internalformat, int32_t xoffset,
             int32_t yoffset, int32_t mode, bool flipY) {
  if (target != GL_TEXTURE_2D || mode > 1 || !store.hardware_buffer()) return false;
  GLint dst = 0;
  Api().GetIntegerv(GL_TEXTURE_BINDING_2D, &dst);
  if (dst == 0) return false;
  // RGBA8 levels only: a blit into an sRGB level would encode the colours.
  if (mode == 0 && internalformat != GL_RGBA && internalformat != GL_RGBA8) return false;
  const GLsizei w = GLsizei(store.width());
  const GLsizei h = GLsizei(store.height());
  if (mode == 1) {
    GLint format = 0, red = 0, alpha = 0, type = 0, lw = 0, lh = 0;
    Api().GetTexLevelParameteriv(target, level, GL_TEXTURE_INTERNAL_FORMAT, &format);
    if (format == GL_RGBA) {
      // unsized RGBA (WebGL 1, or internalformat RGBA): 8-bit normalized components when its type was UNSIGNED_BYTE
      Api().GetTexLevelParameteriv(target, level, GL_TEXTURE_RED_SIZE, &red);
      Api().GetTexLevelParameteriv(target, level, GL_TEXTURE_ALPHA_SIZE, &alpha);
      Api().GetTexLevelParameteriv(target, level, GL_TEXTURE_RED_TYPE, &type);
    }
    if (format != GL_RGBA8 && !(format == GL_RGBA && red == 8 && alpha == 8 && type == GL_UNSIGNED_NORMALIZED)) {
      return false;
    }
    // A blit clips what falls outside the level, without an error: a rectangle glTexSubImage2D refuses
    // (INVALID_VALUE) takes the CPU path, which raises it.
    Api().GetTexLevelParameteriv(target, level, GL_TEXTURE_WIDTH, &lw);
    Api().GetTexLevelParameteriv(target, level, GL_TEXTURE_HEIGHT, &lh);
    if (xoffset < 0 || yoffset < 0 || xoffset + w > lw || yoffset + h > lh) return false;
  }
  const GLuint src = ImportedTexture(store.hardware_buffer());
  if (!src) return false;
  if (mode == 0) Api().TexImage2D(target, level, internalformat, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
  // The blit's state, restored after: both framebuffer bindings and the scissor test (blits bypass the rest of the
  // fragment pipeline, GLES 3.2 §16.2.1).
  GLint read_fb = 0, draw_fb = 0;
  Api().GetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &read_fb);
  Api().GetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &draw_fb);
  const bool scissor = Api().IsEnabled(GL_SCISSOR_TEST);
  if (scissor) Api().Disable(GL_SCISSOR_TEST);
  GLuint fbs[2] = {0, 0};
  Api().GenFramebuffers(2, fbs);
  Api().BindFramebuffer(GL_READ_FRAMEBUFFER, fbs[0]);
  Api().FramebufferTexture2D(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, src, 0);
  Api().BindFramebuffer(GL_DRAW_FRAMEBUFFER, fbs[1]);
  Api().FramebufferTexture2D(GL_DRAW_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, GLuint(dst), level);
  const bool complete = Api().CheckFramebufferStatus(GL_READ_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE &&
                        Api().CheckFramebufferStatus(GL_DRAW_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE;
  if (complete) {
    // The buffer's first row is the image's top row, which a plain upload puts at t = 0; flipY reverses the rows.
    const GLint y0 = flipY ? yoffset + h : yoffset;
    const GLint y1 = flipY ? yoffset : yoffset + h;
    Api().BlitFramebuffer(0, 0, w, h, xoffset, y0, xoffset + w, y1, GL_COLOR_BUFFER_BIT, GL_NEAREST);
  }
  static int logged = 0;  // the first outcome, and the first failure after successes
  if (logged == 0 || (logged == 1 && !complete)) {
    IWN_GL_LOG_INFO("image upload: GPU copy of a %dx%d AHardwareBuffer store (blit%s): %s", w, h, flipY ? ", flipped" : "",
                    complete ? "ok" : "framebuffer incomplete, CPU uploads");
    logged = complete ? 1 : 2;
  }
  Api().BindFramebuffer(GL_READ_FRAMEBUFFER, GLuint(read_fb));
  Api().BindFramebuffer(GL_DRAW_FRAMEBUFFER, GLuint(draw_fb));
  Api().DeleteFramebuffers(2, fbs);
  if (scissor) Api().Enable(GL_SCISSOR_TEST);
  return complete;
}
#endif

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
#if defined(IWN_GL_GPU_IMAGE_COPY)
  // Opaque or no alpha conversion wanted: the GPU copy keeps the bytes as they are.
  if (store->backing() == image::PixelStore::Backing::kHardwareBuffer &&
      (store->opaque() || alphaMode < 0 ||
       (alphaMode == 1) == (store->alpha() == image::AlphaMode::kPremultiplied)) &&
      GpuCopy(*store, target, level, internalformat, xoffset, yoffset, mode, flipY)) {
    return true;
  }
#endif
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
